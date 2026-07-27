# Data Model: OctoAlly MCP Server

**Feature**: 002-octoally-mcp-server
**Date**: 2026-07-24

## Summary of change

No new tables.
No new columns.
No data migration.

The change set is one widened enum with a conditional requirement, one new in-memory classification, and one new transient value that is never persisted.

## Existing entities touched

### SessionRecord

Defined at `server/src/services/session-records.ts:23`.
Persisted columns relevant to this feature already exist from feature 001:

| Column | Type | Current use |
|---|---|---|
| `requested_by` | `TEXT` nullable | How the request reached OctoAlly |
| `controller_kind` | `TEXT` nullable | Which external system originated it |
| `controller_meta_json` | `TEXT` nullable | Serialized controller metadata |
| `lock_key` | `TEXT` nullable | Normalized workspace path for locking |
| `write_capable` | `INTEGER` nullable | Whether the session holds a write lock |
| `prompt_context` | `TEXT` nullable | Which prompt composition context applied |
| `correlation_id` | `TEXT` nullable | Ties lifecycle log lines to one request |

The database column is already free-form `TEXT`.
Only the TypeScript input type constrains the value.

**Change**: `CreateSessionRecordInput.requestedBy` at `session-records.ts:52` widens from
`'ui' | 'openclaw' | 'api'` to `'ui' | 'openclaw' | 'api' | 'mcp'`.

**New invariant**: when `requestedBy` is `mcp`, `controller.kind` MUST be present and non-empty.
A create with `requestedBy: 'mcp'` and no controller kind is rejected before any row is written.
This is validated in the record layer, not only at the route, so that the rule holds for every caller of `createSessionRecord`.

**Not changed**: `openclaw` remains an accepted value.
Rows already written with it keep their meaning.
The 001 skill continues to send it and requires no update.

### SessionControllerMetadata

Defined at `server/src/services/session-records.ts:15`.

```ts
interface SessionControllerMetadata {
  kind: string;
  skill_name?: string;
  channel_id?: string | null;
  message_id?: string | null;
  request_id?: string;
}
```

`kind` is already a free-form string, so `hermes`, `claude-code`, and `codex` need no type change.

**Known duplication**: the same interface is declared a second time at `server/src/services/session-manager.ts:125`.
Two declarations of one concept will drift.
Consolidating to a single exported type is in scope for the groundwork phase, since this feature makes the type load-bearing for validation.

**Vocabulary rule**: `kind` values are lowercase, hyphenated, and drawn from one list: `openclaw`, `hermes`, `claude-code`, `codex`.
The MCP server never invents a value; it passes through what the caller declares, and rejects an empty one.

### Project

No change.
`openclaw_prompt` keeps its name in this feature.
It describes a project-level prompt, not the identity of a launcher, so it is orthogonal to the attribution change above.
Renaming it is a separate migration and is deliberately not bundled here.

## New concepts

### PromptClassification

New, computed server-side, not persisted.

| Field | Type | Meaning |
|---|---|---|
| `prompt_type` | `'choice' \| 'confirmation' \| 'text' \| null` | Already produced by the state path |
| `choices` | `string[] \| null` | Already produced by the state path |
| `destructive_choices` | `string[]` | Choices matching the destructive pattern |
| `is_destructive` | `boolean` | True when the prompt text or any choice matches |

The classification rule is the keyword pattern currently living at `integration-client/octoally_research_session.ts:209`.
It moves into `server/src/services/prompt-destructiveness.ts` and becomes the single source of truth for enforcement.
The client keeps its own copy for display, so a harness sees the assessment before it acts, but the client copy is advisory.

### OutputCursor

Opaque to callers, never persisted.

It marks how much rendered output a caller has consumed, so that a repeated monitor call returns only what is new.
It is derived from the existing `cursor` field the display endpoint already returns at `server/src/routes/agent.ts:288`.
Callers MUST treat it as opaque and MUST NOT parse or arithmetic on it.

## State transitions

Unchanged from feature 001.
Normalized session status remains `pending`, `running`, `waiting_for_input`, `idle`, `completed`, `failed`, `cancelled`.
The MCP tools report these values verbatim; they do not define a parallel status vocabulary.

## Validation rules

| Rule | Enforced in | Failure |
|---|---|---|
| `requested_by` `mcp` requires non-empty `controller.kind` | record layer and route | 400, no row written |
| Answering a destructive prompt requires explicit confirmation | execute route | 409, session state unchanged |
| Monitor wait budget is clamped to the server maximum | display or monitor path | Clamped silently, reported in the result |
| Write-capable launch on a locked workspace | existing lock check, unchanged | Structured conflict, not an exception |
