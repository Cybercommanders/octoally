import type Database from 'better-sqlite3';
import { getDb } from '../db/index.js';

export type LifecycleEvent =
  | 'session_create_requested'
  | 'session_created'
  | 'lock_acquired'
  | 'lock_rejected'
  | 'lock_stale_released'
  | 'session_running'
  | 'session_completed'
  | 'session_failed'
  | 'session_cancelled'
  | 'waiting_for_input'
  | 'session_detached';

export interface LifecycleLogFields {
  event: LifecycleEvent;
  correlation_id?: string | null;
  session_id?: string | null;
  lock_key?: string | null;
  requested_by?: string | null;
  controller_kind?: string | null;
  cli_type?: string | null;
  status?: string | null;
  exit_code?: number | null;
  reason?: string | null;
  detail?: Record<string, unknown>;
}

function resolveCorrelationFromDb(sessionId: string, db?: Database.Database): string | null {
  try {
    const conn = db ?? getDb();
    const row = conn
      .prepare('SELECT correlation_id FROM sessions WHERE id = ?')
      .get(sessionId) as { correlation_id?: string | null } | undefined;
    return row?.correlation_id ?? null;
  } catch {
    return null;
  }
}

export function logLifecycleEvent(fields: LifecycleLogFields, db?: Database.Database): void {
  const payload: LifecycleLogFields = { ...fields };
  if (!payload.correlation_id && payload.session_id) {
    payload.correlation_id = resolveCorrelationFromDb(payload.session_id, db);
  }
  try {
    console.log(`[session-event] ${JSON.stringify(payload)}`);
  } catch {
    // never let a log failure break a request path
  }
}
