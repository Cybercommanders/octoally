# Requirements Checklist: OctoAlly MCP Server

**Purpose**: Verify that the specification is complete, internally consistent, and grounded in the code as it actually is rather than as it is described.
**Created**: 2026-07-24
**Feature**: [spec.md](../spec.md)

## Grounding in Verified Code

- [x] CHK001 Every REST endpoint named in the pack was located in the routes, not taken from feature 001's specification
- [x] CHK002 The `requested_by` type was read at `server/src/services/session-records.ts:52` before being widened
- [x] CHK003 Destructive-prompt handling was searched for in `server/src` before claiming it exists there. It does not; it is client-only at `octoally_research_session.ts:209`
- [x] CHK004 The default server port was read from `server/src/config.ts:96` rather than assumed
- [x] CHK005 The existing test count and runner were established by running the suite, not by trusting prior notes: 66 pass, 0 fail, under `bun test`
- [ ] CHK006 The `@modelcontextprotocol/sdk` API surface is confirmed against its current documentation before T031 is written

## Specification Completeness

- [x] CHK007 Every user story has an independent test and acceptance scenarios
- [x] CHK008 Every functional requirement maps to at least one task
- [x] CHK009 Every success criterion is measurable without reference to implementation
- [x] CHK010 Edge cases cover unreachable server, unknown session, missing attribution, oversized output, and clamped waits
- [x] CHK011 Assumptions state what is out of scope and why, not only what is in scope
- [x] CHK012 Clarifications record the decision and the reason, so a later reader can tell a choice from an accident

## Consistency With Feature 001

- [x] CHK013 Normalized status vocabulary is reused verbatim, not redefined
- [x] CHK014 Lock conflict result shape mirrors the existing `LaunchLockedResult`
- [x] CHK015 Controller metadata is reused rather than replaced
- [x] CHK016 The `openclaw` value of `requested_by` stays valid and is not backfilled
- [x] CHK017 No third naming vocabulary is introduced. Tool inputs use REST and database field names
- [x] CHK018 The OpenClaw skill keeps working, over the same shared client

## Safety

- [x] CHK019 Destructive-prompt enforcement is specified in the API layer, not only in a tool schema
- [x] CHK020 A test exists that bypasses the tool schema entirely and calls the API directly (T021)
- [x] CHK021 The refusal response does not describe a retry that would bypass the check
- [x] CHK022 `requested_by` is set by the server, so a caller cannot label its sessions as UI-originated
- [x] CHK023 No network transport is introduced, and the absence of enforced authentication is stated rather than implied
- [x] CHK024 `config.authToken` is documented as dead configuration so it is not mistaken for an auth mechanism

## Scope Discipline

- [x] CHK025 The `openclaw_prompt` rename is explicitly excluded with a stated reason
- [x] CHK026 The new dependency is flagged for approval and gated behind T029
- [x] CHK027 Groundwork changes are behaviour-neutral and land separately, so later diffs stay readable
- [x] CHK028 The duplicate `SessionControllerMetadata` is fixed only because this feature makes the type load-bearing, not as a drive-by

## Open Items

- [ ] CHK029 Confirm feature 001 is merged or pushed before Phase 1 begins (T000)
- [ ] CHK030 Obtain approval for `@modelcontextprotocol/sdk` (T029)
- [ ] CHK031 Decide whether the OpenClaw skill should eventually call the MCP server rather than the REST API directly. Not required by this feature; it would collapse the two paths into one.

## Notes

- Two defects were found in existing code while writing this pack, and both are folded into Phase 1 rather than reported and left: the base URL default mismatch (T007) and the missing test script (T001, T002).
- The claim in feature 001 that destructive prompts cannot be auto-confirmed was true for its own skill client and false for the API. That gap is the reason US4 exists.
