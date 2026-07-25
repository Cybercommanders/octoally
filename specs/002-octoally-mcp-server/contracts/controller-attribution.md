# Contract: Controller Attribution

**Feature**: 002-octoally-mcp-server

## The rule

Two fields, two different questions.

| Field | Question it answers | Values |
|---|---|---|
| `requested_by` | How did the request reach OctoAlly? | `ui`, `api`, `openclaw`, `mcp` |
| `controller_kind` | Which external system originated it? | `openclaw`, `hermes`, `claude-code`, `codex` |

`requested_by` is a small, closed set describing transport.
`controller_kind` is open and describes the harness.

Without this split, every new harness would add an enum value, a type change, and a migration risk, for no gain in what the audit trail can express.

## Invariants

1. Any session created through the MCP server has `requested_by` exactly `mcp`.
   The value is set by the server, not accepted from the caller.
   A caller therefore cannot label its sessions as UI-originated.

2. When `requested_by` is `mcp`, `controller_kind` MUST be present and non-empty.
   A create that violates this is rejected before any row is written, with `controller_kind_required`.

3. The rule is enforced in `createSessionRecord`, not only at the route.
   Route-level validation alone would leave the invariant unprotected for any future internal caller.

4. `openclaw` remains a valid `requested_by`.
   Feature 001's skill continues to send it unchanged, and stored rows keep their meaning.
   No backfill, no rewrite.

## Why `openclaw` is not remapped

Remapping existing `openclaw` rows to `requested_by: mcp, controller_kind: openclaw` would produce a tidier model and a false history.
Those sessions did not arrive over MCP.
Historical accuracy in an audit trail outranks uniformity, so the old value stays as it is and the two paths coexist.

If the OpenClaw skill is later rewritten to call the MCP server rather than the REST API directly, its new sessions will naturally carry `requested_by: mcp` with `controller_kind: openclaw`, and the split will resolve itself without touching old rows.

## Canonical `controller_kind` values

| Value | Harness |
|---|---|
| `openclaw` | OpenClaw gateway |
| `hermes` | Hermes Agent |
| `claude-code` | Claude Code |
| `codex` | Codex CLI |

Lowercase, hyphenated.
The MCP server passes through what the caller declares and rejects an empty value.
It does not maintain an allowlist, because rejecting an unrecognized-but-honest harness name would block a legitimate caller for no safety gain, and the field is descriptive rather than authorizing.

## Type consolidation

`SessionControllerMetadata` is currently declared twice:

- `server/src/services/session-records.ts:15`
- `server/src/services/session-manager.ts:125`

This feature makes the type load-bearing for validation, so the duplicate is removed and one exported declaration is imported by both.
Two declarations of one concept drift, and a validation rule attached to only one of them is not a rule.
