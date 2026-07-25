# Tasks: OctoAlly MCP Server

**Input**: Design documents from `/specs/002-octoally-mcp-server/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Included per TDD requirement in project CLAUDE.md.

**Organization**: Tasks grouped by phase, then by user story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 to US5)
- Include exact file paths in descriptions

## Path Conventions

- **Backend**: `server/src/` (Fastify + SQLite)
- **Shared client**: `integration-client/` (renamed from `openclaw-skills/`)
- **MCP server**: `mcp-server/`
- **Tests**: `bun test`, using `bun:sqlite` for database tests

## Blocking Prerequisite

- [ ] T000 Merge or push branch `001-openclaw-session-bridge`. Every task below depends on its lock, controller metadata, and lifecycle logging. Do not stack this feature on unpushed work.

---

## Phase 1: Groundwork (no behaviour change)

- [ ] T001 Add `"test": "bun test"` to `server/package.json` scripts
- [ ] T002 Add root `"test"` script in `package.json` running the server, dashboard, and integration-client suites
- [ ] T003 Verify the existing 66 server tests pass through the new script before any other change
- [ ] T004 Rename directory `openclaw-skills/` to `integration-client/`
- [ ] T005 Update every import of the renamed module across the repository, verified by a word-boundary grep for `openclaw-skills` with each hit inspected
- [ ] T006 [P] Update `specs/001-openclaw-session-bridge/plan.md` structure block to note the rename, without rewriting closed 001 tasks
- [ ] T007 Fix base URL resolution in `integration-client/octoally_research_session.ts:201`: resolve `OCTOALLY_BASE_URL`, then `PORT`, then `http://127.0.0.1:42010`. The current `http://localhost:3000` default cannot reach a server whose default port is 42010.
- [ ] T008 Add a unit test for base URL resolution precedence in `integration-client/tests/`
- [ ] T009 Consolidate the duplicate `SessionControllerMetadata` declarations at `server/src/services/session-records.ts:15` and `server/src/services/session-manager.ts:125` into one exported type
- [ ] T010 Re-run the full suite. Groundwork is complete only when the pre-existing tests pass unchanged.

**Checkpoint**: Repository state is behaviourally identical, with a runnable test command and a reachable default base URL.

---

## Phase 2: Server enforcement

### Controller attribution (US1)

- [ ] T011 [US1] Widen `CreateSessionRecordInput.requestedBy` at `server/src/services/session-records.ts:52` to include `'mcp'`
- [ ] T012 [US1] Enforce in `createSessionRecord` that `requestedBy === 'mcp'` requires a non-empty `controller.kind`, rejecting before any row is written
- [ ] T013 [US1] Surface that rejection at the session create route as HTTP 400 with `controller_kind_required`
- [ ] T014 [P] [US1] Test: create with `requested_by` `mcp` and no controller kind is rejected and writes no row
- [ ] T015 [P] [US1] Test: create with `requested_by` `mcp` and a controller kind persists both fields
- [ ] T016 [P] [US1] Test: existing `requested_by` `openclaw` path is unchanged, proving backward compatibility

### Destructive guard (US4)

- [ ] T017 [US4] Create `server/src/services/prompt-destructiveness.ts`, moving the keyword pattern from `integration-client/octoally_research_session.ts:209` and the affirmative pattern beside it
- [ ] T018 [US4] Classify the active prompt in the execute path at `server/src/routes/agent.ts:185`
- [ ] T019 [US4] Reject with HTTP 409 `destructive_confirmation_required` when the input answers a destructive prompt affirmatively and `confirm_destructive` is absent or false, leaving session state unchanged
- [ ] T020 [US4] Accept `confirm_destructive` in the execute request body and pass it through the decision table in `contracts/destructive-guard.md`
- [ ] T021 [US4] **Test called through the HTTP API directly, with no MCP server and no client in the path**: answering a destructive prompt without the flag returns 409 and does not deliver input. This is the test that distinguishes an enforced rule from a documented one.
- [ ] T022 [P] [US4] Test: same call with `confirm_destructive` true delivers the input
- [ ] T023 [P] [US4] Test: affirmative answer to a non-destructive prompt is delivered
- [ ] T024 [P] [US4] Test: non-affirmative answer, for example Cancel, to a destructive prompt is delivered
- [ ] T025 [P] [US4] Unit tests for classification over prompt text and over choices
- [ ] T026 [US4] Mark the client-side guard in `integration-client/` as advisory in comments, and keep its behaviour so the OpenClaw skill still refuses early

### Observability

- [ ] T027 Extend `server/src/services/session-lifecycle-log.ts` emissions to carry `controller_kind` on execute, cancel, and destructive rejection events
- [ ] T028 [P] Test: a destructive rejection emits a lifecycle log line with the correlation ID and controller kind

**Checkpoint**: Feature 001 FR-014 is enforced by the server, verifiable without any MCP code.

---

## Phase 3: MCP package

- [ ] T029 **Approval gate**: confirm the `@modelcontextprotocol/sdk` dependency with the repository owner before installing. Do not proceed without it.
- [ ] T030 Scaffold `mcp-server/` with `package.json`, `tsconfig.json`, and a build producing `dist/index.js`
- [ ] T031 Implement `mcp-server/src/index.ts` as a stdio MCP server named `octoally`, reading `OCTOALLY_BASE_URL` and `OCTOALLY_CONTROLLER_KIND`
- [ ] T032 Implement `mcp-server/src/schemas.ts` using REST field names verbatim, per `contracts/mcp-tools.md`
- [ ] T033 Implement `mcp-server/src/results.ts` shaping structured results, including the lock conflict and the shared failure shapes
- [ ] T034 [P] [US5] Implement `octoally_list_projects` over `GET /api/projects`, including lock state per project
- [ ] T035 [US1] Implement `octoally_launch_session`, always setting `requested_by` to `mcp` and never accepting it from the caller
- [ ] T036 [US2] Return workspace lock conflicts as successful tool results with `ok: false` and remediation, never as protocol errors
- [ ] T037 [P] [US3] Implement `octoally_session_status` including the prompt classification block
- [ ] T038 [US3] Implement `octoally_session_monitor` with an opaque cursor, a clamped `max_wait_ms`, and a `wait_clamped` flag distinguishing a clamp from a timeout
- [ ] T039 [US4] Implement `octoally_session_continue` passing `confirm_destructive` through, and rendering the 409 as a structured refusal that does not suggest a bypass
- [ ] T040 [P] Implement `octoally_session_cancel`
- [ ] T041 Emit a lifecycle log line for every tool invocation with the calling controller kind
- [ ] T042 [P] Unit tests for tool schemas and for client mapping in `mcp-server/tests/tools.test.ts`
- [ ] T043 [P] Unit test: unreachable OctoAlly produces `octoally_unreachable` rather than a thrown protocol error
- [ ] T044 [P] Unit test: unknown session ID produces `session_not_found` rather than a thrown protocol error

**Checkpoint**: Six tools implemented against the shared client, with no second HTTP layer added.

---

## Phase 4: Integration proof

- [ ] T045 Add `mcp-server/tests/integration/mcp-stdio.test.ts` driving the built server with a real MCP client over stdio
- [ ] T046 [US1] Integration: launch a session and assert `requested_by` `mcp` plus controller kind in the database
- [ ] T047 [US2] Integration: two concurrent write-capable launches on one workspace, asserting the second is a structured conflict naming the first
- [ ] T048 [US3] Integration: monitor twice with a cursor and assert the second call returns only new output
- [ ] T049 [US4] Integration: destructive prompt refused through the tool, then accepted with the flag
- [ ] T050 [US5] Integration: project listing reports lock state matching the active session
- [ ] T051 Confirm the pre-existing 66 server tests and the 001 skill tests still pass

**Checkpoint**: The tool surface is proven end to end through a real MCP client, not only through unit mocks.

---

## Phase 5: Harness wiring and documentation

- [ ] T052 [P] Register with Hermes Agent in `~/.hermes/config.yaml` and verify tool discovery with `hermes mcp`
- [ ] T053 [P] Register with Claude Code via `.mcp.json` and verify tool discovery
- [ ] T054 [P] Register with Codex via `~/.codex/config.toml`, using the built entrypoint rather than `npx`, and verify tool discovery
- [ ] T055 Run the quickstart end to end against a real project from at least one harness, capturing the session row as evidence
- [ ] T056 Update `README.md` with the MCP server, its tools, and the registration pointer
- [ ] T057 Record in `specs/002-octoally-mcp-server/` which harnesses were verified, with dates, so a later reader knows what was proven rather than assumed

---

## Dependencies

- T000 blocks everything.
- Phase 1 blocks Phase 2, because the rename and the base URL fix change the files Phase 2 edits.
- T029 blocks all of Phase 3. No dependency is installed before approval.
- Phase 2 blocks T039 and T049, since the guard must exist server-side before a tool can surface it.
- Phase 3 blocks Phase 4.
- T021 is the acceptance gate for US4. Without it, the destructive guard is a claim rather than a control.

## Parallel Opportunities

- T014 to T016 after T012
- T022 to T025 after T019
- T034, T037, T040 after T033
- T042 to T044 alongside Phase 3 implementation
- T052 to T054 after T045

## Deliberate Non-Goals

- No rename of the `openclaw_prompt` project column. Orthogonal to launcher identity, and a data migration bundled into a new integration surface makes both harder to verify.
- No HTTP or SSE MCP transport. It would place session launch on a listening socket, and OctoAlly has no enforced authentication. Note that `config.authToken` is parsed at `server/src/config.ts:104` but is referenced nowhere in `server/src`, so it is currently dead configuration and must not be mistaken for an existing auth mechanism.
- No SKILL.md authored for Hermes. MCP is sufficient, and a skill would reintroduce the per-harness surface this feature removes.
- No removal of the OpenClaw skill. It keeps working over the same shared client.
