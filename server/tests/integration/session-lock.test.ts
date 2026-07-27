import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testDir = mkdtempSync(join(tmpdir(), 'octoally-session-lock-'));
const TEST_DB_PATH = join(testDir, 'octoally-test.db');

process.env.DB_PATH = TEST_DB_PATH;
process.env.OCTOALLY_USE_DTACH = 'false';
process.env.OCTOALLY_USE_TMUX = 'false';

let db: Database | null = null;

function getTestDb(): Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

function initTestDb(): void {
  db?.close();
  db = new Database(TEST_DB_PATH);
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');
  db.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      description TEXT,
      session_prompt TEXT,
      openclaw_prompt TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id),
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      pid INTEGER,
      started_at TEXT,
      completed_at TEXT,
      exit_code INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      claude_session_id TEXT,
      cli_type TEXT DEFAULT 'claude',
      requested_by TEXT DEFAULT 'ui',
      controller_kind TEXT,
      controller_meta_json TEXT,
      lock_key TEXT,
      write_capable INTEGER DEFAULT 1,
      prompt_context TEXT,
      applied_project_prompts INTEGER DEFAULT 0,
      correlation_id TEXT,
      terminal_cols INTEGER DEFAULT 120
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_sessions_lock_key ON sessions(lock_key)');
}

mock.module('../../src/db/index.js', () => ({
  getDb: () => getTestDb(),
  initDb: () => initTestDb(),
}));

const { default: Fastify } = await import('fastify');
const { initDb, getDb } = await import('../../src/db/index.js');
const { sessionRoutes } = await import('../../src/routes/sessions.js');

initDb();

const app = Fastify();
await app.register(sessionRoutes, { prefix: '/api' });
await app.ready();

const testDb = getDb();

beforeEach(() => {
  testDb.run('DELETE FROM sessions');
  testDb.run('DELETE FROM projects');
  testDb.prepare(`
    INSERT INTO projects (id, name, path, session_prompt, openclaw_prompt)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    'project-1',
    'Test Project',
    '/tmp/test-project',
    'Always use TDD',
    'Follow OpenClaw handoff rules',
  );
});

afterAll(async () => {
  await app.close();
  db?.close();
  rmSync(testDir, { recursive: true, force: true });
});

describe('POST /api/sessions workspace lock', () => {
  test('T019: second write-capable session on same workspace returns 409 with existing session metadata', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        project_path: '/tmp/test-project',
        project_id: 'project-1',
        task: 'First task',
        requested_by: 'openclaw',
        controller: {
          kind: 'openclaw',
          skill_name: 'research_claude',
          request_id: 'req-1',
        },
      },
    });
    expect(first.statusCode).toBe(200);

    const firstBody = first.json() as {
      ok: boolean;
      session: {
        id: string;
        lock_key: string | null;
        requested_by: string | null;
        controller_kind: string | null;
        status: string;
      };
    };
    expect(firstBody.ok).toBe(true);
    expect(firstBody.session.lock_key).toBe('/tmp/test-project');
    expect(firstBody.session.requested_by).toBe('openclaw');
    expect(firstBody.session.controller_kind).toBe('openclaw');
    expect(firstBody.session.status).toBe('pending');

    const storedFirst = testDb.prepare(`
      SELECT project_id, task, status, cli_type, requested_by, controller_kind, controller_meta_json,
             lock_key, write_capable, prompt_context, applied_project_prompts
      FROM sessions
      WHERE id = ?
    `).get(firstBody.session.id) as Record<string, unknown>;
    expect(storedFirst.project_id).toBe('project-1');
    expect(storedFirst.task).toBe('First task');
    expect(storedFirst.status).toBe('pending');
    expect(storedFirst.cli_type).toBe('claude');
    expect(storedFirst.requested_by).toBe('openclaw');
    expect(storedFirst.controller_kind).toBe('openclaw');
    expect(storedFirst.controller_meta_json).toBe(
      JSON.stringify({
        kind: 'openclaw',
        skill_name: 'research_claude',
        channel_id: null,
        message_id: null,
        request_id: 'req-1',
      }),
    );
    expect(storedFirst.lock_key).toBe('/tmp/test-project');
    expect(storedFirst.write_capable).toBe(1);
    expect(storedFirst.prompt_context).toBe('default');
    expect(storedFirst.applied_project_prompts).toBe(0);

    testDb.prepare("UPDATE sessions SET started_at = datetime('now') WHERE id = ?").run(firstBody.session.id);

    const second = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        project_path: '/tmp/test-project',
        project_id: 'project-1',
        task: 'Second task',
      },
    });
    expect(second.statusCode).toBe(409);

    const conflict = second.json() as {
      error: string;
      message: string;
      lock: {
        session_id: string;
        requested_by: string;
        controller_kind: string | null;
        started_at: string;
      };
    };
    expect(conflict.error).toBe('workspace_locked');
    expect(conflict.message).toMatch(/already active/i);
    expect(conflict.lock.session_id).toBe(firstBody.session.id);
    expect(conflict.lock.requested_by).toBe('openclaw');
    expect(conflict.lock.controller_kind).toBe('openclaw');
    expect(typeof conflict.lock.started_at).toBe('string');
    expect(conflict.lock.started_at.length).toBeGreaterThan(0);

    const count = testDb.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
    expect(count.n).toBe(1);
  });

  test.each(['completed', 'failed', 'cancelled'] as const)(
    'T020: lock is released after first session reaches terminal status %s',
    async (terminalStatus) => {
      const first = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          project_path: '/tmp/test-project',
          project_id: 'project-1',
          task: 'first',
        },
      });
      expect(first.statusCode).toBe(200);

      const firstBody = first.json() as {
        ok: boolean;
        session: { id: string; status: string; lock_key: string | null };
      };
      expect(firstBody.ok).toBe(true);
      expect(firstBody.session.status).toBe('pending');
      expect(firstBody.session.lock_key).toBe('/tmp/test-project');

      testDb.prepare(`
        UPDATE sessions
        SET status = ?, completed_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `).run(terminalStatus, firstBody.session.id);

      const terminalRow = testDb.prepare(`
        SELECT status, completed_at, updated_at
        FROM sessions
        WHERE id = ?
      `).get(firstBody.session.id) as {
        status: string;
        completed_at: string | null;
        updated_at: string;
      };
      expect(terminalRow.status).toBe(terminalStatus);
      expect(typeof terminalRow.completed_at).toBe('string');
      expect((terminalRow.completed_at ?? '').length).toBeGreaterThan(0);
      expect(typeof terminalRow.updated_at).toBe('string');
      expect(terminalRow.updated_at.length).toBeGreaterThan(0);

      const second = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          project_path: '/tmp/test-project',
          project_id: 'project-1',
          task: 'second',
        },
      });
      expect(second.statusCode).toBe(200);

      const secondBody = second.json() as {
        ok: boolean;
        session: { id: string; lock_key: string | null; status: string };
      };
      expect(secondBody.ok).toBe(true);
      expect(secondBody.session.id).not.toBe(firstBody.session.id);
      expect(secondBody.session.lock_key).toBe('/tmp/test-project');
      expect(secondBody.session.status).toBe('pending');
    },
  );

  test('T021: stale lock (>30 min) is force-released on new launch and old session is failed', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        project_path: '/tmp/test-project',
        project_id: 'project-1',
        task: 'stale',
      },
    });
    expect(first.statusCode).toBe(200);

    const firstBody = first.json() as {
      ok: boolean;
      session: { id: string; status: string; lock_key: string | null };
    };
    expect(firstBody.ok).toBe(true);
    expect(firstBody.session.status).toBe('pending');
    expect(firstBody.session.lock_key).toBe('/tmp/test-project');

    testDb.prepare(`
      UPDATE sessions
      SET updated_at = datetime('now', '-31 minutes'),
          started_at = datetime('now', '-31 minutes'),
          created_at = datetime('now', '-31 minutes')
      WHERE id = ?
    `).run(firstBody.session.id);

    const second = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        project_path: '/tmp/test-project',
        project_id: 'project-1',
        task: 'fresh',
      },
    });
    expect(second.statusCode).toBe(200);

    const secondBody = second.json() as {
      ok: boolean;
      session: { id: string; status: string; lock_key: string | null };
    };
    expect(secondBody.ok).toBe(true);
    expect(secondBody.session.id).not.toBe(firstBody.session.id);
    expect(secondBody.session.status).toBe('pending');
    expect(secondBody.session.lock_key).toBe('/tmp/test-project');

    const oldRow = testDb.prepare(`
      SELECT status, completed_at, updated_at
      FROM sessions
      WHERE id = ?
    `).get(firstBody.session.id) as {
      status: string;
      completed_at: string | null;
      updated_at: string;
    };
    expect(oldRow.status).toBe('failed');
    expect(typeof oldRow.completed_at).toBe('string');
    expect((oldRow.completed_at ?? '').length).toBeGreaterThan(0);
    expect(typeof oldRow.updated_at).toBe('string');
    expect(oldRow.updated_at.length).toBeGreaterThan(0);
  });

  test('T037: DELETE /api/sessions/:id (cancel) releases the lock and new session succeeds', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        project_path: '/tmp/test-project',
        project_id: 'project-1',
        task: 'to be cancelled',
      },
    });
    expect(first.statusCode).toBe(200);

    const firstBody = first.json() as {
      ok: boolean;
      session: { id: string; status: string; lock_key: string | null };
    };
    expect(firstBody.ok).toBe(true);
    expect(firstBody.session.status).toBe('pending');
    expect(firstBody.session.lock_key).toBe('/tmp/test-project');

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        project_path: '/tmp/test-project',
        project_id: 'project-1',
        task: 'should be blocked',
      },
    });
    expect(blocked.statusCode).toBe(409);

    const cancel = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${firstBody.session.id}`,
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json()).toEqual({ ok: true });

    const cancelledRow = testDb.prepare(`
      SELECT status, completed_at, updated_at
      FROM sessions
      WHERE id = ?
    `).get(firstBody.session.id) as {
      status: string;
      completed_at: string | null;
      updated_at: string;
    };
    expect(cancelledRow.status).toBe('cancelled');
    expect(typeof cancelledRow.completed_at).toBe('string');
    expect((cancelledRow.completed_at ?? '').length).toBeGreaterThan(0);
    expect(typeof cancelledRow.updated_at).toBe('string');
    expect(cancelledRow.updated_at.length).toBeGreaterThan(0);

    const reborn = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        project_path: '/tmp/test-project',
        project_id: 'project-1',
        task: 'after cancel',
      },
    });
    expect(reborn.statusCode).toBe(200);

    const rebornBody = reborn.json() as {
      ok: boolean;
      session: { id: string; lock_key: string | null; status: string };
    };
    expect(rebornBody.ok).toBe(true);
    expect(rebornBody.session.id).not.toBe(firstBody.session.id);
    expect(rebornBody.session.lock_key).toBe('/tmp/test-project');
    expect(rebornBody.session.status).toBe('pending');
  });
});
