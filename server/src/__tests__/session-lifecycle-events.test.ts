import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';

const db = new Database(':memory:');
db.run(`CREATE TABLE sessions (
  id TEXT PRIMARY KEY, project_id TEXT, task TEXT NOT NULL, status TEXT,
  cli_type TEXT, requested_by TEXT, controller_kind TEXT, controller_meta_json TEXT,
  lock_key TEXT, write_capable INTEGER, prompt_context TEXT,
  applied_project_prompts INTEGER, correlation_id TEXT,
  started_at TEXT, completed_at TEXT, exit_code INTEGER,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
)`);
mock.module('../db/index.js', () => ({ getDb: () => db }));
const { createSessionRecord } = await import('../services/session-records.js?lifecycle-events');
const { getOrCreateTracker, removeTracker } = await import('../services/session-state.js?lifecycle-events');
let events: Record<string, unknown>[];
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  db.run('DELETE FROM sessions');
  events = [];
  logSpy = spyOn(console, 'log').mockImplementation((message: unknown) => {
    if (typeof message === 'string' && message.startsWith('[session-event] ')) {
      events.push(JSON.parse(message.slice('[session-event] '.length)));
    }
  });
});
afterEach(() => {
  removeTracker('waiting-session');
  logSpy.mockRestore();
});
afterAll(() => db.close());

describe('Phase 11 lifecycle events', () => {
  test('a committed writer logs its normalized workspace and request correlation', () => {
    const result = createSessionRecord(db as any, {
      projectPath: '/tmp/octoally-lifecycle-workspace/',
      task: 'private-body', correlationId: 'request-correlation',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected writer');
    expect(events).toEqual([expect.objectContaining({
      event: 'lock_acquired', session_id: result.session.id,
      correlation_id: 'request-correlation',
      lock_key: '/tmp/octoally-lifecycle-workspace', requested_by: 'ui',
    })]);
    expect(JSON.stringify(events)).not.toContain('private-body');
  });

  test('rejected writers and read-only sessions never report lock acquisition', () => {
    const input = { projectPath: '/tmp/octoally-lifecycle-workspace', task: 'private-body' };
    expect(createSessionRecord(db as any, input).ok).toBe(true);
    const firstEvents = events.slice();
    expect(createSessionRecord(db as any, input).ok).toBe(false);
    expect(createSessionRecord(db as any, { ...input, writeCapable: false }).ok).toBe(true);
    expect(firstEvents).toHaveLength(1);
    expect(events).toEqual(firstEvents);
  });

  test('a failed transaction never reports lock acquisition', () => {
    db.run(`CREATE TEMP TRIGGER refuse_insert BEFORE INSERT ON sessions
      BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
    try {
      expect(() => createSessionRecord(db as any, {
        projectPath: '/tmp/octoally-lifecycle-workspace', task: 'private-body',
      })).toThrow('fixture failure');
      expect(events).toEqual([]);
    } finally {
      db.run('DROP TRIGGER refuse_insert');
    }
  });

  test('legacy UI input still launches without bridge metadata or prompt changes', () => {
    const result = createSessionRecord(db as any, {
      projectPath: '/tmp/octoally-legacy-ui', task: 'Unmodified UI goal',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected legacy UI launch');
    expect(result.session).toMatchObject({
      task: 'Unmodified UI goal', requested_by: 'ui', cli_type: 'claude',
      controller_kind: null, controller_meta_json: null, write_capable: 1,
      applied_project_prompts: 0, prompt_context: null,
    });
  });

  test('detected waiting state logs correlation once even when the tracker is reused', async () => {
    db.run(`INSERT INTO sessions (id, task, status, correlation_id)
      VALUES ('waiting-session', 'private-body', 'running', 'waiting-correlation')`);
    const tracker = getOrCreateTracker('waiting-session');
    expect(getOrCreateTracker('waiting-session')).toBe(tracker);
    const waiting = new Promise<void>((resolve) => {
      tracker.onStateChange((state) => {
        if (state.processState === 'waiting_for_input') resolve();
      });
    });
    tracker.onData('Continue? (Y/n)');
    await waiting;
    expect(events).toEqual([expect.objectContaining({
      event: 'waiting_for_input', session_id: 'waiting-session',
      correlation_id: 'waiting-correlation',
    })]);
    expect(JSON.stringify(events)).not.toContain('Continue?');
    expect(JSON.stringify(events)).not.toContain('private-body');
  }, 10000);
});
