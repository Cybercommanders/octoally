/**
 * Phase 4: integration proof.
 *
 * Drives the BUILT server (`dist/index.js`) as a child process through a real
 * MCP client over real stdio. Nothing here imports the tool functions
 * directly: if the transport, the registration, or the schema validation is
 * wrong, these tests fail even though the unit tests pass.
 *
 * OctoAlly itself is a stub on an ephemeral port, so the tests can drive
 * lock conflicts and destructive refusals deterministically without spawning
 * real Claude sessions. The stub records what it received, which is how the
 * `requested_by` assertion is made against the actual wire payload.
 *
 * The other half of that chain - that OctoAlly persists these fields and
 * rejects an unattributed MCP launch - is covered against the real database
 * in server/src/__tests__/session-records.test.ts and session-routes.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = join(HERE, '..', '..', 'dist', 'index.js');

interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

type StubHandler = (req: IncomingMessage, url: URL, body: unknown) => { status: number; body: unknown };

let stub: Server;
let stubPort: number;
let recorded: RecordedRequest[] = [];
let handler: StubHandler = () => ({ status: 200, body: {} });

function setHandler(next: StubHandler): void {
  handler = next;
}

beforeAll(async () => {
  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(`Built server missing at ${SERVER_ENTRY}. Run \`npm run build\` in mcp-server first.`);
  }

  stub = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const parsed = raw ? JSON.parse(raw) : undefined;
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${stubPort}`);
      recorded.push({ method: req.method ?? 'GET', path: url.pathname, body: parsed });

      const result = handler(req, url, parsed);
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result.body));
    });
  });

  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  stubPort = (stub.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

afterEach(() => {
  recorded = [];
});

async function withClient<T>(
  env: Record<string, string>,
  body: (client: Client) => Promise<T>,
): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      PATH: process.env.PATH ?? '',
      OCTOALLY_BASE_URL: `http://127.0.0.1:${stubPort}`,
      ...env,
    },
    stderr: 'ignore',
  });

  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    return await body(client);
  } finally {
    await client.close();
  }
}

function payloadOf(result: unknown): Record<string, unknown> {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

describe('T045: the built server speaks MCP over stdio', () => {
  test('advertises exactly the six documented tools', async () => {
    const names = await withClient({ OCTOALLY_CONTROLLER_KIND: 'hermes' }, async (client) => {
      const { tools } = await client.listTools();
      return tools.map((t) => t.name).sort();
    });

    expect(names).toEqual([
      'octoally_launch_session',
      'octoally_list_projects',
      'octoally_session_cancel',
      'octoally_session_continue',
      'octoally_session_monitor',
      'octoally_session_status',
    ]);
  });

  test('rejects a malformed call at the protocol level, not as a silent success', async () => {
    setHandler(() => ({ status: 200, body: { projects: [] } }));

    const outcome = await withClient({ OCTOALLY_CONTROLLER_KIND: 'hermes' }, async (client) => {
      // task is required by the schema.
      const result = await client.callTool({
        name: 'octoally_launch_session',
        arguments: { project_path: '/tmp/p' },
      });
      return result;
    });

    expect(outcome.isError).toBe(true);
  });
});

describe('T046: launches are attributed on the wire', () => {
  test('requested_by is mcp and the harness is named, through the real transport', async () => {
    setHandler((_req, url) => {
      if (url.pathname === '/api/sessions') {
        return { status: 200, body: { session: { id: 'sess-int-1', status: 'pending', lock_key: '/tmp/p' } } };
      }
      return {
        status: 200,
        body: { sessionId: 'sess-int-1', processState: 'busy', output: 'starting', cursor: 3, truncated: false, promptType: null, choices: null },
      };
    });

    const payload = await withClient({ OCTOALLY_CONTROLLER_KIND: 'hermes' }, async (client) =>
      payloadOf(
        await client.callTool({
          name: 'octoally_launch_session',
          arguments: { project_path: '/tmp/p', task: 'do the thing' },
        }),
      ),
    );

    expect(payload).toMatchObject({ ok: true, session_id: 'sess-int-1' });

    const create = recorded.find((r) => r.method === 'POST' && r.path === '/api/sessions')!;
    const sent = create.body as Record<string, any>;
    expect(sent.requested_by).toBe('mcp');
    expect(sent.controller.kind).toBe('hermes');
  });

  test('a launch with no configured harness never reaches OctoAlly', async () => {
    setHandler(() => ({ status: 500, body: { error: 'should not be called' } }));

    const payload = await withClient({}, async (client) =>
      payloadOf(
        await client.callTool({
          name: 'octoally_launch_session',
          arguments: { project_path: '/tmp/p', task: 'unattributed' },
        }),
      ),
    );

    expect(payload).toMatchObject({ ok: false, reason: 'controller_kind_required' });
    expect(recorded).toHaveLength(0);
  });
});

describe('T047: a locked workspace is a usable result, not a failure', () => {
  test('the second launch names the owner and offers remediation', async () => {
    setHandler(() => ({
      status: 409,
      body: {
        error: 'workspace_locked',
        message: 'A write-capable session is already active for this workspace.',
        lock: {
          session_id: 'sess-owner',
          requested_by: 'openclaw',
          controller_kind: 'openclaw',
          started_at: '2026-07-26T00:00:00Z',
        },
      },
    }));

    const result = await withClient({ OCTOALLY_CONTROLLER_KIND: 'hermes' }, async (client) =>
      client.callTool({
        name: 'octoally_launch_session',
        arguments: { project_path: '/tmp/locked', task: 'second launch' },
      }),
    );

    // The decisive part: the call SUCCEEDED at the protocol level.
    expect(result.isError).toBeUndefined();

    expect(payloadOf(result)).toMatchObject({
      ok: false,
      reason: 'workspace_locked',
      existing: { session_id: 'sess-owner', controller_kind: 'openclaw' },
      remediation: { monitor: { session_id: 'sess-owner' }, cancel: { session_id: 'sess-owner' } },
    });
  });
});

describe('T048: monitoring returns only new output', () => {
  test('the cursor from one call scopes the next', async () => {
    setHandler((_req, url) => ({
      status: 200,
      body: {
        sessionId: 'sess-int-1',
        processState: 'busy',
        output: url.searchParams.get('since') === '10' ? 'second chunk' : 'first chunk',
        cursor: url.searchParams.get('since') === '10' ? 20 : 10,
        truncated: false,
        promptType: null,
        choices: null,
      },
    }));

    const { first, second } = await withClient({ OCTOALLY_CONTROLLER_KIND: 'hermes' }, async (client) => {
      const first = payloadOf(
        await client.callTool({ name: 'octoally_session_monitor', arguments: { session_id: 'sess-int-1' } }),
      );
      const second = payloadOf(
        await client.callTool({
          name: 'octoally_session_monitor',
          arguments: { session_id: 'sess-int-1', cursor: first.cursor as string },
        }),
      );
      return { first, second };
    });

    expect(first).toMatchObject({ ok: true, output: 'first chunk', cursor: '10' });
    expect(second).toMatchObject({ ok: true, output: 'second chunk', cursor: '20' });
  });
});

describe('T049: the destructive guard reaches the model as a refusal', () => {
  test('a 409 from OctoAlly becomes a structured refusal that discourages retry', async () => {
    setHandler(() => ({
      status: 409,
      body: {
        error: 'destructive_confirmation_required',
        message: 'Operator approval is required to confirm a destructive prompt.',
        prompt: {
          prompt_type: 'confirmation',
          choices: ['Yes', 'No'],
          destructive_choices: [],
          is_destructive: true,
        },
      },
    }));

    const result = await withClient({ OCTOALLY_CONTROLLER_KIND: 'hermes' }, async (client) =>
      client.callTool({
        name: 'octoally_session_continue',
        arguments: { session_id: 'sess-int-1', input: 'y' },
      }),
    );

    expect(result.isError).toBeUndefined();
    const payload = payloadOf(result);
    expect(payload).toMatchObject({ ok: false, reason: 'destructive_confirmation_required' });
    expect(String(payload.message)).toContain('do not retry with confirm_destructive');
  });

  test('with confirm_destructive set the flag reaches OctoAlly', async () => {
    setHandler(() => ({ status: 200, body: { output: 'deleted' } }));

    const payload = await withClient({ OCTOALLY_CONTROLLER_KIND: 'hermes' }, async (client) =>
      payloadOf(
        await client.callTool({
          name: 'octoally_session_continue',
          arguments: { session_id: 'sess-int-1', input: 'y', confirm_destructive: true },
        }),
      ),
    );

    expect(payload).toMatchObject({ ok: true, delivered: true });

    const execute = recorded.find((r) => r.path.endsWith('/execute'))!;
    expect((execute.body as Record<string, unknown>).confirm_destructive).toBe(true);
  });
});

describe('T050: project listing reports lock state', () => {
  test('a project held by an active session is reported locked', async () => {
    setHandler((_req, url) => {
      if (url.pathname === '/api/projects') {
        return {
          status: 200,
          body: {
            projects: [
              { id: 'p1', name: 'held', path: '/tmp/locked' },
              { id: 'p2', name: 'free', path: '/tmp/free' },
            ],
          },
        };
      }
      return {
        status: 200,
        body: {
          sessions: [{ id: 'sess-owner', status: 'running', lock_key: '/tmp/locked', write_capable: 1 }],
        },
      };
    });

    const payload = await withClient({ OCTOALLY_CONTROLLER_KIND: 'hermes' }, async (client) =>
      payloadOf(await client.callTool({ name: 'octoally_list_projects', arguments: {} })),
    );

    const projects = payload.projects as Record<string, unknown>[];
    expect(projects[0]).toMatchObject({ locked: true, lock_session_id: 'sess-owner' });
    expect(projects[1]).toMatchObject({ locked: false, lock_session_id: null });
  });
});

describe('an unreachable OctoAlly', () => {
  test('is reported as a structured failure over the real transport', async () => {
    const result = await withClient(
      { OCTOALLY_CONTROLLER_KIND: 'hermes', OCTOALLY_BASE_URL: 'http://127.0.0.1:1' },
      async (client) => client.callTool({ name: 'octoally_list_projects', arguments: {} }),
    );

    expect(result.isError).toBeUndefined();
    expect(payloadOf(result)).toMatchObject({ ok: false, reason: 'octoally_unreachable' });
  });
});
