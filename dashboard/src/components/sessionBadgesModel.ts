import type { Session } from '../lib/api';

// Match workspace-lock.checkLock: released external writers still own their lock.
const TERMINAL_SESSION_STATUSES = new Set<Session['status']>(['completed', 'failed', 'cancelled']);

export function getSessionSourceLabel(
  session: Pick<Session, 'requested_by'>,
): 'OpenClaw' | 'UI' {
  return session.requested_by === 'openclaw' ? 'OpenClaw' : 'UI';
}

export function getSessionExecutorLabel(
  session: Pick<Session, 'cli_type'>,
): 'Claude' | 'Codex' {
  return session.cli_type === 'codex' ? 'Codex' : 'Claude';
}

export function isSessionLockActive(
  session: Pick<Session, 'write_capable' | 'status' | 'lock_key'>,
): boolean {
  return session.write_capable === 1 && session.lock_key != null &&
    !TERMINAL_SESSION_STATUSES.has(session.status);
}
