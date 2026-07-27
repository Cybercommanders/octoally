# Contract: MCP Tool Surface

**Feature**: 002-octoally-mcp-server
**Transport**: stdio only
**Server name**: `octoally`

## Naming and vocabulary rules

1. Tool names are prefixed `octoally_` so they stay distinguishable in a harness that has many servers registered.
2. Tool input fields use the field names the REST API and the database already use: `project_path`, `project_id`, `cli_type`, `prompt_context`, `apply_project_prompts`, `lock_behavior`, `requested_by`, `session_id`.
   The camelCase form used inside the shared client stays private to that module.
   No third vocabulary is introduced.
3. Status values are the normalized set from feature 001 and are reported verbatim: `pending`, `running`, `waiting_for_input`, `idle`, `completed`, `failed`, `cancelled`.

## Error policy

A tool call fails at the MCP protocol level only when the call itself is malformed, for example a missing required field.

Every expected operational outcome is a successful tool call carrying a structured payload with an `ok` discriminator.
This covers workspace lock conflicts, unknown session IDs, an unreachable OctoAlly server, and destructive-confirmation refusals.

Rationale: a protocol error is opaque to the calling model and reliably produces a retry loop.
A structured refusal carrying remediation lets the model choose the next action.

## Tools

### `octoally_list_projects`

Discovery. Maps to `GET /api/projects`.

**Input**: none.

**Output**:

```json
{
  "ok": true,
  "projects": [
    {
      "id": "string",
      "name": "string",
      "path": "string",
      "locked": true,
      "lock_session_id": "string | null"
    }
  ]
}
```

### `octoally_launch_session`

Maps to `POST /api/sessions`, followed by a best-effort `GET /api/sessions/:id/display` for the first output.

**Input**:

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `project_path` | string | yes | | Non-empty |
| `task` | string | yes | | Non-empty |
| `controller_kind` | string | yes | | `hermes`, `claude-code`, `codex`, `openclaw` |
| `project_id` | string | no | | |
| `cli_type` | `claude` \| `codex` | no | `claude` | Executor selection, the only difference between the 001 aliases |
| `mode` | string | no | `session` | Passed through unchanged |
| `agent_type` | string | no | | Passed through unchanged |
| `apply_project_prompts` | boolean | no | `true` | |
| `prompt_context` | string | no | `openclaw` | Composition context, see note below |
| `lock_behavior` | `reject` \| `ignore` | no | `reject` | |
| `first_output_lines` | integer | no | `40` | Clamped server-side |

`requested_by` is not an input.
The server always sets it to `mcp`, so a caller cannot misattribute its own sessions.

Note on `prompt_context`: the stored composition contexts are those defined by feature 001.
This feature does not add a context value, so the default remains the existing one until the prompt-field rename is done separately.

**Output, success**:

```json
{
  "ok": true,
  "session_id": "string",
  "status": "pending",
  "cli_type": "claude",
  "lock_key": "string | null",
  "requested_by": "mcp",
  "controller_kind": "string",
  "task": "string",
  "first_output": "string | null",
  "summary": "string"
}
```

**Output, workspace locked**:

```json
{
  "ok": false,
  "reason": "workspace_locked",
  "message": "string",
  "existing": {
    "session_id": "string",
    "requested_by": "string",
    "controller_kind": "string | null",
    "started_at": "string"
  },
  "remediation": {
    "monitor": { "session_id": "string" },
    "cancel": { "session_id": "string" }
  }
}
```

This mirrors `LaunchLockedResult` in the shared client, converted to the REST field naming.

### `octoally_session_status`

Maps to `GET /api/sessions/:id` plus `GET /api/sessions/:id/state`.

**Input**: `session_id` (required), `prompt_lines` (optional, default 40, clamped).

**Output**:

```json
{
  "ok": true,
  "session_id": "string",
  "status": "waiting_for_input",
  "prompt": {
    "prompt_type": "confirmation",
    "choices": ["string"],
    "destructive_choices": ["string"],
    "is_destructive": true
  },
  "last_activity": 0
}
```

`prompt` is null when the session is not waiting for input.

### `octoally_session_monitor`

Maps to `GET /api/sessions/:id/display`.

**Input**:

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `session_id` | string | yes | | |
| `cursor` | string | no | | Opaque. Omit for a full read. |
| `lines` | integer | no | `80` | Clamped |
| `max_wait_ms` | integer | no | `0` | Clamped to the server maximum |

**Output**:

```json
{
  "ok": true,
  "session_id": "string",
  "status": "running",
  "output": "string",
  "cursor": "string",
  "truncated": false,
  "waited_ms": 0,
  "wait_clamped": false
}
```

`wait_clamped` is true when the requested budget exceeded the server maximum, so the caller can tell a clamp from a timeout.

### `octoally_session_continue`

Maps to `POST /api/sessions/:id/execute`.

**Input**:

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `session_id` | string | yes | | |
| `input` | string | yes | | |
| `confirm_destructive` | boolean | no | `false` | See the destructive guard contract |

**Output, accepted**:

```json
{ "ok": true, "session_id": "string", "delivered": true }
```

**Output, refused**:

```json
{
  "ok": false,
  "reason": "destructive_confirmation_required",
  "message": "string",
  "prompt": {
    "prompt_type": "confirmation",
    "choices": ["string"],
    "destructive_choices": ["string"],
    "is_destructive": true
  }
}
```

The refusal names the requirement and does not describe a retry that would bypass it.
Setting `confirm_destructive` is an operator decision, not a recovery step for the model to take on its own.

### `octoally_session_cancel`

Maps to `POST /api/sessions/:id/cancel`.

**Input**: `session_id` (required).

**Output**:

```json
{ "ok": true, "session_id": "string", "status": "cancelled" }
```

Cancelling a session launched by another controller is permitted, matching existing dashboard behaviour, and is logged with the calling controller kind.

## Shared failure shapes

Applies to every tool.

```json
{ "ok": false, "reason": "session_not_found", "session_id": "string" }
```

```json
{ "ok": false, "reason": "octoally_unreachable", "base_url": "string", "message": "string" }
```

```json
{ "ok": false, "reason": "controller_kind_required", "message": "string" }
```

## Logging

Every tool invocation emits a session lifecycle log line through the existing logger, carrying the correlation ID and the calling `controller_kind`.
This keeps MCP-originated activity visible in the same stream as UI and OpenClaw activity, as required by feature 001 FR-015.
