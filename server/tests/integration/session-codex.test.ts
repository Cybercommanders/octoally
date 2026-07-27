import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testDir = mkdtempSync(join(tmpdir(), 'octoally-session-codex-'));
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

describe('POST /api/sessions cli_type codex parity', () => {
  test('T039: cli_type=codex persists codex and returns same contract shape as claude', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        project_path: '/tmp/test-project',
        project_id: 'project-1',
        task: 'Investigate via codex',
        cli_type: 'codex',
        requested_by: 'openclaw',
      },
    });
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      ok: boolean;
      session: {
        id: string;
        task: string;
        cli_type: string | null;
        lock_key: string | null;
        status: string;
        requested_by: string | null;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.session.task).toBe('Investigate via codex');
    expect(body.session.cli_type).toBe('codex');
    expect(body.session.status).toBe('pending');
    expect(body.session.lock_key).toBe('/tmp/test-project');
    expect(body.session.requested_by).toBe('openclaw');

    const stored = testDb.prepare(`
      SELECT project_id, cli_type, lock_key, write_capable, requested_by, prompt_context, applied_project_prompts
      FROM sessions
      WHERE id = ?
    `).get(body.session.id) as Record<string, unknown>;
    expect(stored.project_id).toBe('project-1');
    expect(stored.cli_type).toBe('codex');
    expect(stored.lock_key).toBe('/tmp/test-project');
    expect(stored.write_capable).toBe(1);
    expect(stored.requested_by).toBe('openclaw');
    expect(stored.prompt_context).toBe('default');
    expect(stored.applied_project_prompts).toBe(0);
  });

  test('T039: cli_type=codex with apply_project_prompts composes prompts identically to claude', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        project_path: '/tmp/test-project',
        project_id: 'project-1',
        task: 'Investigate the failing job',
        cli_type: 'codex',
        apply_project_prompts: true,
        prompt_context: 'openclaw',
        requested_by: 'openclaw',
      },
    });
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      ok: boolean;
      session: {
        id: string;
        task: string;
        cli_type: string | null;
        prompt_context: string | null;
        applied_project_prompts: number | null;
        requested_by: string | null;
        lock_key: string | null;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.session.task).toBe(
      'Investigate the failing job\n\n'
        + '---\nAdditional Instructions (Ruflo):\nAlways use TDD\n\n'
        + '---\nAdditional Instructions (OpenClaw):\nFollow OpenClaw handoff rules',
    );
    expect(body.session.cli_type).toBe('codex');
    expect(body.session.prompt_context).toBe('openclaw');
    expect(body.session.applied_project_prompts).toBe(1);
    expect(body.session.requested_by).toBe('openclaw');
    expect(body.session.lock_key).toBe('/tmp/test-project');

    const stored = testDb.prepare(`
      SELECT project_id, task, cli_type, prompt_context, applied_project_prompts, requested_by, lock_key
      FROM sessions
      WHERE id = ?
    `).get(body.session.id) as Record<string, unknown>;
    expect(stored.project_id).toBe('project-1');
    expect(stored.task).toBe(
      'Investigate the failing job\n\n'
        + '---\nAdditional Instructions (Ruflo):\nAlways use TDD\n\n'
        + '---\nAdditional Instructions (OpenClaw):\nFollow OpenClaw handoff rules',
    );
    expect(stored.cli_type).toBe('codex');
    expect(stored.prompt_context).toBe('openclaw');
    expect(stored.applied_project_prompts).toBe(1);
    expect(stored.requested_by).toBe('openclaw');
    expect(stored.lock_key).toBe('/tmp/test-project');
  });
});
