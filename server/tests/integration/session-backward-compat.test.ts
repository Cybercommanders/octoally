import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testDir = mkdtempSync(join(tmpdir(), 'octoally-legacy-http-'));
const projectPath = join(testDir, 'project');
const db = new Database(join(testDir, 'test.db'));
db.run('PRAGMA foreign_keys = ON');
db.run(`
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
    session_prompt TEXT, openclaw_prompt TEXT
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), task TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', pid INTEGER, started_at TEXT,
    completed_at TEXT, exit_code INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    claude_session_id TEXT, cli_type TEXT DEFAULT 'claude', requested_by TEXT DEFAULT 'ui',
    controller_kind TEXT, controller_meta_json TEXT, lock_key TEXT,
    write_capable INTEGER DEFAULT 1, prompt_context TEXT,
    applied_project_prompts INTEGER DEFAULT 0, correlation_id TEXT,
    terminal_cols INTEGER DEFAULT 120
  );
  CREATE INDEX idx_sessions_lock_key ON sessions(lock_key);
`);

// Exercise real HTTP routes, record transactions and locks; never launch a CLI or PTY.
const pendingSpawns = new Map<string, Record<string, unknown>>();
mock.module('../../src/db/index.js', () => ({ getDb: () => db }));
mock.module('../../src/services/session-manager.js', () => ({
  RESIZE_MARKER: '__TEST_RESIZE__',
  registerPendingSpawn: (id: string, options: Record<string, unknown>) => {
    pendingSpawns.set(id, options);
  },
  getSessionTmuxServer: () => undefined,
  getSession: (id: string) => db.prepare('SELECT * FROM sessions WHERE id = ?').get(id),
  listSessions: () => db.prepare('SELECT * FROM sessions ORDER BY created_at').all(),
}));

const { default: Fastify } = await import('fastify');
const { sessionRoutes } = await import('../../src/routes/sessions.js');
const app = Fastify();
await app.register(sessionRoutes, { prefix: '/api' });
await app.ready();

beforeEach(() => {
  pendingSpawns.clear();
  db.run('DELETE FROM sessions');
  db.run('DELETE FROM projects');
  db.prepare(`
    INSERT INTO projects (id, name, path, session_prompt, openclaw_prompt)
    VALUES (?, ?, ?, ?, ?)
  `).run('legacy-project', 'Legacy project', projectPath, 'Stored Ruflo instructions', 'Stored OpenClaw instructions');
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(testDir, { recursive: true, force: true });
});

function expectLegacyDefaults(session: Record<string, unknown>) {
  expect(session.requested_by).toBe('ui');
  expect(session.controller_kind).toBeNull();
  expect(session.controller_meta_json).toBeNull();
  expect(session.prompt_context).toBe('default');
  expect(session.applied_project_prompts).toBe(0);
  expect(session.status).toBe('pending');
  expect(session.pid).toBeNull();
  expect(session.correlation_id).toEqual(expect.any(String));
}

async function createLegacySession(payload: Record<string, unknown>) {
  const response = await app.inject({ method: 'POST', url: '/api/sessions', payload });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.ok).toBe(true);
  const session = body.session as Record<string, unknown> & { id: string };
  const stored = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id);
  expect(stored).toEqual(session);
  const read = await app.inject({ method: 'GET', url: `/api/sessions/${session.id}` });
  expect(read.statusCode).toBe(200);
  expect(read.json().session).toEqual(session);
  expectLegacyDefaults(session);
  return session;
}

describe('T049 legacy UI session launch over HTTP', () => {
  test('minimal old payload keeps its exact task and defaults through persistence and readback', async () => {
    const task = 'Legacy launch\n\nAdditional Instructions already assembled by the old client';
    const session = await createLegacySession({ project_path: projectPath, task });
    expect(session.task).toBe(task);
    expect(session.project_id).toBeNull();
    expect(session.cli_type).toBe('claude');
    expect(session.lock_key).toBe(projectPath);
    expect(session.write_capable).toBe(1);
    expect(pendingSpawns.get(session.id)).toEqual({
      projectPath, task, mode: 'session', projectId: undefined, cliType: 'claude',
    });
  });

  test('the existing UI session payload preserves the selected project and Codex CLI', async () => {
    const session = await createLegacySession({
      project_path: projectPath, project_id: 'legacy-project', task: 'Review the feature',
      mode: 'session', cli_type: 'codex',
    });
    expect(session.project_id).toBe('legacy-project');
    expect(session.task).toBe('Review the feature');
    expect(session.cli_type).toBe('codex');
    expect(pendingSpawns.get(session.id)).toEqual({
      projectPath, task: 'Review the feature', mode: 'session',
      projectId: 'legacy-project', cliType: 'codex',
    });
    const listed = await app.inject({ method: 'GET', url: '/api/sessions' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().sessions).toEqual([session]);
  });

  test('the existing specialist payload keeps agent metadata and the uncomposed task', async () => {
    const session = await createLegacySession({
      project_path: projectPath, project_id: 'legacy-project', task: 'Find the failing assertion',
      mode: 'agent', agent_type: 'tester', cli_type: 'claude',
    });
    expect(session.task).toBe('Agent (tester): Find the failing assertion');
    expect(session.write_capable).toBe(1);
    expect(pendingSpawns.get(session.id)).toEqual({
      projectPath, task: 'Find the failing assertion', mode: 'agent', agentType: 'tester',
      projectId: 'legacy-project', cliType: 'claude',
    });
  });

  test('the existing terminal payload still accepts no task and reserves no writer lock', async () => {
    const session = await createLegacySession({
      project_path: projectPath, project_id: 'legacy-project', mode: 'terminal',
    });
    expect(session.task).toBe('Terminal');
    expect(session.lock_key).toBeNull();
    expect(session.write_capable).toBe(0);
    expect(pendingSpawns.get(session.id)).toEqual({
      projectPath, task: 'Terminal', mode: 'terminal',
      projectId: 'legacy-project', cliType: 'claude',
    });
  });

  test('a conflicting old UI writer receives 409 without another spawn or row', async () => {
    const first = await createLegacySession({ project_path: projectPath, task: 'First launch' });
    const rejected = await app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { project_path: projectPath, task: 'Second launch' },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error).toBe('workspace_locked');
    expect(rejected.json().lock.session_id).toBe(first.id);
    expect(pendingSpawns.size).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 1 });
  });
});


describe('T051 server-side UI prompt composition', () => {
  test.each([
    { label: 'an explicit override replaces the stored prompt', override: 'Custom instructions', expected: '\n\n---\nAdditional Instructions (Ruflo):\nCustom instructions' },
    { label: 'an empty override suppresses the stored prompt', override: '', expected: '' },
    { label: 'an omitted override uses the stored prompt', override: undefined, expected: '\n\n---\nAdditional Instructions (Ruflo):\nStored Ruflo instructions' },
  ])('$label', async ({ override, expected }) => {
    const task = 'Keep my goal\nexactly as supplied';
    const response = await app.inject({
      method: 'POST', url: '/api/sessions',
      payload: {
        project_path: projectPath, project_id: 'legacy-project', task,
        apply_project_prompts: true, session_prompt_override: override,
      },
    });
    expect(response.statusCode).toBe(200);
    const session = response.json().session;
    expect(session.task).toBe(task + expected);
    expect(session.applied_project_prompts).toBe(1);
    expect(session.prompt_context).toBe('default');
    expect(pendingSpawns.get(session.id)?.task).toBe(task + expected);
    expect(db.prepare('SELECT session_prompt FROM projects WHERE id = ?').get('legacy-project')).toEqual({
      session_prompt: 'Stored Ruflo instructions',
    });
  });

  test('a per-launch Ruflo override preserves the independent OpenClaw instructions', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/sessions',
      payload: {
        project_path: projectPath, project_id: 'legacy-project', task: 'My goal',
        apply_project_prompts: true, session_prompt_override: 'Custom instructions',
        prompt_context: 'openclaw',
      },
    });
    expect(response.statusCode).toBe(200);
    const session = response.json().session;
    const expected = 'My goal\n\n---\nAdditional Instructions (Ruflo):\nCustom instructions'
      + '\n\n---\nAdditional Instructions (OpenClaw):\nStored OpenClaw instructions';
    expect(session.task).toBe(expected);
    expect(session.prompt_context).toBe('openclaw');
    expect(pendingSpawns.get(session.id)?.task).toBe(expected);
  });

  test.each([null, 123, { prompt: 'Not a string' }])(
    'rejects invalid prompt override %j without persistence or a launch', async (override) => {
      const response = await app.inject({
        method: 'POST', url: '/api/sessions',
        payload: {
          project_path: projectPath, task: 'My goal',
          apply_project_prompts: true, session_prompt_override: override,
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/session_prompt_override/);
      expect(pendingSpawns.size).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    },
  );

  test.each([undefined, false])(
    'rejects an override without opt-in apply_project_prompts=%j', async (apply) => {
      const response = await app.inject({
        method: 'POST', url: '/api/sessions',
        payload: {
          project_path: projectPath, task: 'My goal',
          apply_project_prompts: apply, session_prompt_override: 'Custom instructions',
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/apply_project_prompts/);
      expect(pendingSpawns.size).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    },
  );
});
