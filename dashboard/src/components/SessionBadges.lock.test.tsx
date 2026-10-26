import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Session } from '../lib/api';
import { SessionBadges } from './SessionBadges';
import { isSessionLockActive } from './sessionBadgesModel';
import { checkLock } from '../../../server/src/services/workspace-lock';

// Keep the actual persisted lock query and the displayed badge in agreement.
// An external terminal still owns its workspace after release; terminal history
// retains lock_key without retaining the effective lock.
describe('persisted workspace lock badges', () => {
  for (const status of ['pending', 'launching', 'running', 'detached', 'released', 'completed', 'failed', 'cancelled'] as const) {
    test(`${status}: rendered badge agrees with backend lock ownership`, () => {
      const db = new Database(':memory:');
      try {
        db.run(`CREATE TABLE sessions (
          id TEXT, project_id TEXT, task TEXT, status TEXT, lock_key TEXT,
          write_capable INTEGER, requested_by TEXT, controller_kind TEXT,
          started_at TEXT, created_at TEXT, updated_at TEXT
        )`);
        const session: Session = {
          id: 'writer', project_id: 'project', task: 'Research', status,
          lock_key: '/workspace', write_capable: 1, requested_by: 'openclaw',
          cli_type: 'codex', pid: null, started_at: null, completed_at: null,
          exit_code: null, created_at: '2026-10-26T00:00:00Z',
        };
        db.prepare(`INSERT INTO sessions (id, project_id, task, status, lock_key, write_capable)
          VALUES (?, ?, ?, ?, ?, ?)`).run(session.id, session.project_id, session.task,
            status, session.lock_key!, session.write_capable!);
        // bun:sqlite implements the prepare/get API used by checkLock.
        const locked = checkLock('/workspace', db as never).locked;
        expect(isSessionLockActive(session)).toBe(locked);
        const markup = renderToStaticMarkup(createElement(SessionBadges, { session }));
        expect(markup.includes('aria-label="Workspace locked"')).toBe(locked);
        expect(markup).toContain('OpenClaw');
        expect(markup).toContain('Codex');
      } finally {
        db.close();
      }
    });
  }

  test('read-only and unassociated writers do not display workspace locks', () => {
    expect(isSessionLockActive({ status: 'released', write_capable: 0, lock_key: '/workspace' })).toBe(false);
    expect(isSessionLockActive({ status: 'running', write_capable: 1, lock_key: null })).toBe(false);
    expect(isSessionLockActive({ status: 'running', write_capable: 1 })).toBe(false);
  });
});
