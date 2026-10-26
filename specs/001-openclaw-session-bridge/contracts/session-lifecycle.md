# Contract: Session Lifecycle APIs

**Endpoints**: Existing OctoAlly session APIs — no changes required to existing contracts.

## GET /api/sessions/:id/state

Returns current session status and metadata. No changes to existing response shape.

**Skill usage**: Poll this to determine normalized session state (pending/running/waiting_for_input/idle/completed/failed/cancelled).

## GET /api/sessions/:id/display

Returns rendered session output. Supports cursor-based incremental reads.

**Query params**:
- `since`: cursor for incremental reads
- `lines`: max lines to return

**Skill usage**: Fetch output to summarize for operator. Use cursor for incremental polling.

## POST /api/sessions/:id/execute

Sends input to an active session.

**Request**:
```
{
  "input": string,
  "timeout": number (ms, default 30000),
  "quiescenceMs": number (ms, default 2000),
  "stripAnsi": boolean (default true)
}
```

**Response**: Rendered output + updated state.

**Skill usage**: Send follow-up instructions. Check response state for waiting_for_input transitions.

## DELETE /api/sessions/:id

Cancels an active session. Missing or already terminal sessions return 404.

**Response**: `{ "ok": true }`. Read `GET /api/sessions/:id` to confirm persisted `status = cancelled`; do not infer cancellation from request success alone.

**Side effect**: This session's effective workspace lock is released by terminal status. The historical `lock_key` remains stored. Another session may already hold a new lock.

**Skill usage**: Cancel stuck or unwanted sessions. A subsequent launch can acquire the workspace if no other writer has acquired it.

## POST /api/sessions/:id/cancel

Interrupts a stuck execute request only. It does not terminate the session or release its workspace lock. Existing execute-request semantics are unchanged.

## GET /api/sessions

Lists sessions. Existing endpoint.

**Skill usage**: Not directly used by skill. UI uses for session list with new badges.
