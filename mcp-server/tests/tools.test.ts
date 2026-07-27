import { describe, expect, test } from 'bun:test';
import { OctoAllyClient } from '@octoally/integration-client';

import * as tools from '../src/tools.ts';
import type { ToolContext } from '../src/tools.ts';

const BASE_URL = 'http://127.0.0.1:42010';

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeContext(handler: Handler, controllerKind: string | null = 'hermes') {
  const calls: { url: URL; init: RequestInit }[] = [];
  const logged: Record<string, unknown>[] = [];

  const fetchImpl = (async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const url = input instanceof URL ? input : new URL(String(input));
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;

  const ctx: ToolContext = {
    client: new OctoAllyClient({ baseUrl: BASE_URL, fetchImpl }),
    baseUrl: BASE_URL,
    defaultControllerKind: controllerKind,
    log: (fields) => logged.push(fields),
  };

  return { ctx, calls, logged };
}

function body(result: { structuredContent?: Record<string, unknown> }) {
  return result.structuredContent!;
}

describe('octoally_launch_session', () => {
  test('always sends requested_by mcp and never takes it from the caller', async () => {
    const { ctx, calls } = makeContext((url) => {
      if (url.pathname === '/api/sessions') {
        return json(200, { session: { id: 'sess-1', status: 'pending', lock_key: '/tmp/p' } });
      }
      return json(200, { sessionId: 'sess-1', processState: 'busy', output: '', cursor: 0, truncated: false, promptType: null, choices: null });
    });

    const result = await tools.launch(ctx, {
      project_path: '/tmp/p',
      task: 'do the thing',
      // A caller trying to disguise its own traffic as UI-originated.
      requested_by: 'ui',
    } as unknown as tools.LaunchArgs);

    expect(body(result).ok).toBe(true);

    const create = calls.find((c) => c.url.pathname === '/api/sessions' && c.init.method === 'POST')!;
    const payload = JSON.parse(String(create.init.body));
    expect(payload.requested_by).toBe('mcp');
    expect(payload.controller.kind).toBe('hermes');
  });

  test('refuses when no controller kind is configured or supplied', async () => {
    const { ctx, calls } = makeContext(() => json(200, {}), null);

    const result = await tools.launch(ctx, { project_path: '/tmp/p', task: 't' });

    expect(body(result)).toMatchObject({ ok: false, reason: 'controller_kind_required' });
    // Nothing was attempted against the server.
    expect(calls).toHaveLength(0);
  });

  test('an explicit controller_kind overrides the environment default', async () => {
    const { ctx, calls } = makeContext((url) => {
      if (url.pathname === '/api/sessions') {
        return json(200, { session: { id: 'sess-1', status: 'pending' } });
      }
      return json(200, { sessionId: 'sess-1', processState: 'busy', output: '', cursor: 0, truncated: false, promptType: null, choices: null });
    });

    await tools.launch(ctx, { project_path: '/tmp/p', task: 't', controller_kind: 'codex' });

    const create = calls.find((c) => c.init.method === 'POST')!;
    expect(JSON.parse(String(create.init.body)).controller.kind).toBe('codex');
  });

  test('a locked workspace is a structured result, not a protocol error', async () => {
    const { ctx } = makeContext(() =>
      json(409, {
        error: 'workspace_locked',
        message: 'A write-capable session is already active for this workspace.',
        lock: {
          session_id: 'sess-owner',
          requested_by: 'openclaw',
          controller_kind: 'openclaw',
          started_at: '2026-07-26T00:00:00Z',
        },
      }),
    );

    const result = await tools.launch(ctx, { project_path: '/tmp/p', task: 't' });

    expect(result.isError).toBeUndefined();
    expect(body(result)).toMatchObject({
      ok: false,
      reason: 'workspace_locked',
      existing: { session_id: 'sess-owner', controller_kind: 'openclaw' },
      remediation: { monitor: { session_id: 'sess-owner' }, cancel: { session_id: 'sess-owner' } },
    });
  });
});

describe('octoally_session_continue', () => {
  test('passes confirm_destructive through to the server', async () => {
    const { ctx, calls } = makeContext(() => json(200, { output: 'ok' }));

    await tools.sendInput(ctx, { session_id: 'sess-1', input: 'y', confirm_destructive: true });

    const payload = JSON.parse(String(calls[0].init.body));
    expect(payload.confirm_destructive).toBe(true);
  });

  test('omits the flag when it was not set', async () => {
    const { ctx, calls } = makeContext(() => json(200, { output: 'ok' }));

    await tools.sendInput(ctx, { session_id: 'sess-1', input: 'y' });

    expect(JSON.parse(String(calls[0].init.body))).not.toHaveProperty('confirm_destructive');
  });

  test('a server refusal becomes a structured result that does not suggest a bypass', async () => {
    const { ctx } = makeContext(() =>
      json(409, {
        error: 'destructive_confirmation_required',
        message: 'Operator approval is required to confirm a destructive prompt.',
        prompt: { prompt_type: 'confirmation', is_destructive: true, destructive_choices: ['Yes, delete'] },
      }),
    );

    const result = await tools.sendInput(ctx, { session_id: 'sess-1', input: 'y' });

    expect(result.isError).toBeUndefined();
    const payload = body(result);
    expect(payload).toMatchObject({ ok: false, reason: 'destructive_confirmation_required' });
    expect(String(payload.message)).toContain('do not retry with confirm_destructive');
  });
});

describe('octoally_session_monitor', () => {
  test('clamps an oversized wait budget and says so', async () => {
    const { ctx } = makeContext(() =>
      json(200, {
        sessionId: 'sess-1',
        processState: 'busy',
        output: 'some output',
        cursor: 42,
        truncated: false,
        promptType: null,
        choices: null,
      }),
    );

    const result = await tools.monitor(ctx, { session_id: 'sess-1', max_wait_ms: 10 * 60 * 1000 });

    expect(body(result)).toMatchObject({ ok: true, wait_clamped: true, cursor: '42' });
  });

  test('passes the cursor through as `since` so only new output returns', async () => {
    const { ctx, calls } = makeContext(() =>
      json(200, {
        sessionId: 'sess-1',
        processState: 'busy',
        output: 'newer',
        cursor: 99,
        truncated: false,
        promptType: null,
        choices: null,
      }),
    );

    await tools.monitor(ctx, { session_id: 'sess-1', cursor: '42' });

    expect(calls[0].url.searchParams.get('since')).toBe('42');
  });

  test('rejects a cursor that was not produced by a previous call', async () => {
    const { ctx, calls } = makeContext(() => json(200, {}));

    const result = await tools.monitor(ctx, { session_id: 'sess-1', cursor: 'not-a-cursor' });

    expect(body(result)).toMatchObject({ ok: false, reason: 'invalid_cursor' });
    expect(calls).toHaveLength(0);
  });

  test('a quiet session polls a bounded number of times and then returns', async () => {
    let polls = 0;
    const { ctx } = makeContext(() => {
      polls += 1;
      return json(200, {
        sessionId: 'sess-1',
        processState: 'idle',
        output: '',
        cursor: 7,
        truncated: false,
        promptType: null,
        choices: null,
      });
    });

    // An instant sleep means wall-clock never advances. The loop must still
    // terminate: a poll budget bounds it independently of the clock.
    const result = await tools.monitor(
      ctx,
      { session_id: 'sess-1', max_wait_ms: 5_000 },
      async () => {},
    );

    expect(body(result).ok).toBe(true);
    expect(polls).toBeLessThanOrEqual(Math.ceil(5_000 / 500) + 1);
  });

  test('a terminal session returns on the first poll', async () => {
    let polls = 0;
    const { ctx } = makeContext((url) => {
      polls += 1;
      if (url.pathname.endsWith('/display')) {
        return json(200, {
          sessionId: 'sess-1',
          processState: 'idle',
          output: '',
          cursor: 7,
          truncated: false,
          promptType: null,
          choices: null,
        });
      }
      return json(200, { session: { id: 'sess-1', status: 'completed' } });
    });

    await tools.monitor(ctx, { session_id: 'sess-1', max_wait_ms: 5_000 }, async () => {});
    expect(polls).toBeGreaterThan(0);
  });
});

describe('structured failures (T043, T044)', () => {
  test('an unreachable OctoAlly is reported, not thrown', async () => {
    const { ctx } = makeContext(() => {
      throw new TypeError('fetch failed');
    });

    const result = await tools.listProjects(ctx);

    expect(result.isError).toBeUndefined();
    expect(body(result)).toMatchObject({ ok: false, reason: 'octoally_unreachable', base_url: BASE_URL });
  });

  test('an unknown session id is reported, not thrown', async () => {
    const { ctx } = makeContext(() => json(404, { error: 'Session not found' }));

    const result = await tools.status(ctx, { session_id: 'ghost' });

    expect(result.isError).toBeUndefined();
    expect(body(result)).toMatchObject({ ok: false, reason: 'session_not_found', session_id: 'ghost' });
  });
});

describe('octoally_list_projects', () => {
  test('reports lock state from the sessions holding a workspace', async () => {
    const { ctx } = makeContext((url) => {
      if (url.pathname === '/api/projects') {
        return json(200, {
          projects: [
            { id: 'p1', name: 'locked-one', path: '/tmp/locked' },
            { id: 'p2', name: 'free-one', path: '/tmp/free' },
          ],
        });
      }
      return json(200, {
        sessions: [
          { id: 'sess-owner', status: 'running', lock_key: '/tmp/locked', write_capable: 1 },
          { id: 'sess-done', status: 'completed', lock_key: '/tmp/free', write_capable: 1 },
        ],
      });
    });

    const result = await tools.listProjects(ctx);
    const projects = body(result).projects as Record<string, unknown>[];

    expect(projects[0]).toMatchObject({ path: '/tmp/locked', locked: true, lock_session_id: 'sess-owner' });
    expect(projects[1]).toMatchObject({ path: '/tmp/free', locked: false, lock_session_id: null });
  });
});
