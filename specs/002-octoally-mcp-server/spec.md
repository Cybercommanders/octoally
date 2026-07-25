# Feature Specification: OctoAlly MCP Server

**Feature Branch**: `002-octoally-mcp-server`
**Created**: 2026-07-24
**Status**: Draft
**Input**: MCP server exposing OctoAlly session control to any agent harness (Hermes, Claude Code, Codex, OpenClaw)

## Context

Feature 001 delivered the OpenClaw session bridge: workspace locking, server-side prompt composition, controller metadata, and a 702-line TypeScript skill client that OpenClaw invokes.
That skill is harness-specific.
Adopting a second harness (Hermes Agent, from Nous Research) under the same approach would mean porting the client again, and a third harness would mean a third port.

Every harness now in use supports the Model Context Protocol.
Hermes exposes `hermes mcp` for installing servers by local command or URL.
Claude Code and Codex both consume stdio MCP servers from configuration files.

This feature replaces the per-harness client strategy with a single MCP server over the session REST API that OctoAlly already exposes.
The existing OpenClaw skill is not deleted; it and the MCP server share one HTTP client so their behaviour cannot drift.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Launch an OctoAlly Session From Any MCP Harness (Priority: P1)

An operator working inside Hermes Agent states a coding or research goal against a known project.
The harness calls the OctoAlly MCP server, which launches a Claude Code session on that project and returns the session ID plus the first output.
No OctoAlly-specific skill was installed in that harness; only the MCP server was registered.

**Why this priority**: This is the entire value of the feature.
Without it, each new harness needs its own ported client.

**Independent Test**: Register the MCP server with a harness, call the launch tool with a project path and a task, and verify a session appears in OctoAlly with correct controller metadata.

**Acceptance Scenarios**:

1. **Given** a registered OctoAlly MCP server and a configured project, **When** the harness calls the launch tool with a project path and task, **Then** a session is created and the tool returns session ID, normalized status, and lock key within 2 seconds.
2. **Given** the session has started, **When** the harness reads the launch result, **Then** it contains a concise summary of the first output when output was available within the launch window.
3. **Given** the project has `session_prompt` and `openclaw_prompt` configured, **When** the launch tool is called with `apply_project_prompts` true, **Then** the server composes the final task using the same composition order as the 001 session bridge.
4. **Given** any launch through the MCP server, **When** the session record is written, **Then** `requested_by` is `mcp` and `controller_kind` records the calling harness.

---

### User Story 2 - Workspace Lock Conflicts Are Actionable, Not Fatal (Priority: P1)

A write-capable session is already running against a workspace.
A harness attempts a second write-capable launch on the same workspace.
The tool call succeeds at the protocol level and returns a structured refusal naming the lock owner and the actions available.

**Why this priority**: An LLM harness handles a structured result far better than a protocol-level error.
A thrown MCP error is opaque to the model and usually produces a retry loop.
Lock safety is also the safety-critical property inherited from feature 001.

**Independent Test**: Launch one write-capable session, call the launch tool again on the same workspace, and verify a non-error tool result carrying `ok: false`, `reason: workspace_locked`, the owning session ID, and the remediation options.

**Acceptance Scenarios**:

1. **Given** an active write-capable session on a workspace, **When** a second write-capable launch is requested for that workspace, **Then** the tool returns a successful MCP result whose payload is `ok: false` with `reason` `workspace_locked`.
2. **Given** a lock conflict result, **When** the harness inspects it, **Then** it contains the existing session ID, its `requested_by`, its `controller_kind`, and its start time.
3. **Given** a lock conflict result, **When** the harness inspects remediation, **Then** it names the monitor and cancel tools with the existing session ID pre-filled.
4. **Given** the first session terminates, **When** the launch is retried, **Then** it succeeds.

---

### User Story 3 - Monitor a Running Session and Send Follow-Up Input (Priority: P2)

The operator's harness watches a running session, receives incremental output, and sends follow-up instructions when the session is idle or waiting for input.

**Why this priority**: Monitoring is essential to the operator workflow but depends on launch (Story 1) working first.

**Independent Test**: Launch a session, call the monitor tool repeatedly with the returned cursor, then call the continue tool and verify the input reached the session.

**Acceptance Scenarios**:

1. **Given** a running session, **When** the monitor tool is called with no cursor, **Then** it returns current output, a cursor, a normalized status, and a truncation flag.
2. **Given** a prior monitor result, **When** the monitor tool is called again with that cursor, **Then** it returns only output produced after the cursor.
3. **Given** a session waiting for input, **When** the status tool is called, **Then** it returns `waiting_for_input` along with the prompt type and any detected choices.
4. **Given** a session that produces no new output, **When** the monitor tool is called with a wait budget, **Then** it returns after at most that budget, clamped to the server maximum, rather than blocking indefinitely.

---

### User Story 4 - Destructive Prompts Cannot Be Auto-Confirmed (Priority: P1)

A session presents a destructive confirmation prompt.
The harness attempts to answer it automatically.
The server refuses unless the call carries an explicit destructive-confirmation flag that only an operator-approved path sets.

**Why this priority**: Feature 001 FR-014 requires operator approval for destructive prompts.
An autonomous harness will answer prompts on its own by default, so this protection has to be enforced by the server, not by the tool schema.

**Independent Test**: Drive a session into a destructive confirmation state, call the continue tool without the flag, verify rejection, then call it with the flag and verify acceptance.

**Acceptance Scenarios**:

1. **Given** a session waiting on a prompt classified destructive, **When** continue is called without `confirm_destructive`, **Then** the server rejects the call and the session state is unchanged.
2. **Given** the same session, **When** continue is called with `confirm_destructive` true, **Then** the input is delivered.
3. **Given** a session waiting on a non-destructive prompt, **When** continue is called without the flag, **Then** the input is delivered normally.
4. **Given** any rejection of this kind, **When** the harness reads the result, **Then** it explains that operator approval is required and does not present a retry that would bypass the check.

---

### User Story 5 - Discover Projects Without the Dashboard (Priority: P2)

A harness with no access to the OctoAlly web UI lists the configured projects, their paths, and their current lock state before choosing where to launch.

**Why this priority**: Every other tool needs a project path.
Without discovery the operator has to paste paths by hand, which reintroduces the copy-paste workflow feature 001 removed.

**Independent Test**: Call the project listing tool and verify it returns the same projects the dashboard shows, each with lock state.

**Acceptance Scenarios**:

1. **Given** configured projects, **When** the listing tool is called, **Then** it returns each project's ID, name, and path.
2. **Given** a project with an active write-capable session, **When** the listing tool is called, **Then** that project is marked locked with the owning session ID.

---

### Edge Cases

- OctoAlly server is not running: every tool returns a structured unreachable result naming the base URL, not a protocol error.
- Session ID does not exist or has been pruned: tools return a structured not-found result rather than throwing.
- `requested_by` is `mcp` but no controller kind is supplied: the launch is rejected, because an unattributed session defeats the audit trail feature 001 established.
- Output exceeds the transport-sensible size: monitor truncates and sets the truncation flag rather than returning unbounded text.
- Monitor is called with a wait budget larger than the server maximum: the budget is clamped server-side, never honoured as given.
- Two harnesses register the same MCP server concurrently: each is a separate process against the same OctoAlly instance, and workspace locking remains the only mutual exclusion.
- A harness calls the cancel tool on a session it did not launch: permitted, matching existing UI behaviour, but the cancellation is logged with the calling controller.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST expose OctoAlly session control as an MCP server over stdio.
- **FR-002**: System MUST provide tools for project listing, session launch, session status, session monitoring, follow-up input, and cancellation.
- **FR-003**: System MUST reuse the HTTP client, status normalization, and output summarization already implemented for the 001 skill, rather than reimplementing them.
- **FR-004**: System MUST express tool inputs using the field names already used by the session REST API and database, so that no third naming vocabulary is introduced.
- **FR-005**: System MUST record `requested_by` as `mcp` for every session it launches.
- **FR-006**: System MUST require a controller kind identifying the calling harness whenever `requested_by` is `mcp`, and MUST reject the launch when it is absent.
- **FR-007**: System MUST continue to accept the existing `openclaw` value of `requested_by` so that sessions created by the 001 skill and rows already stored remain valid.
- **FR-008**: System MUST return workspace lock conflicts as structured tool results, not as protocol-level errors.
- **FR-009**: Lock conflict results MUST name the owning session, its requester, its controller kind, its start time, and the monitor and cancel remediations.
- **FR-010**: System MUST support incremental output retrieval via an opaque cursor.
- **FR-011**: System MUST bound any waiting operation by a server-enforced maximum, regardless of the wait budget requested by the caller.
- **FR-012**: The OctoAlly server MUST reject follow-up input that answers a prompt classified destructive unless the request carries explicit destructive confirmation, and this rejection MUST be enforced in the API layer rather than only in the tool schema.
- **FR-013**: System MUST surface waiting-for-input state including prompt type and detected choices, matching the 001 skill contract.
- **FR-014**: System MUST log every tool invocation through the existing session lifecycle log with a correlation ID and the calling controller kind.
- **FR-015**: System MUST NOT require authentication for stdio transport, and MUST NOT expose a network transport in this feature.
- **FR-016**: System MUST leave all existing session flows working unchanged, including the 001 OpenClaw skill and the dashboard UI.
- **FR-017**: The repository MUST expose a runnable test command so that the existing and new test suites can be executed by CI without out-of-band knowledge.

### Key Entities

- **MCP Tool**: A named, schema-described operation the harness can invoke. Six exist in this feature, each mapping to one or two existing REST calls.
- **Controller**: The harness driving a session. Identified by kind, for example `hermes`, `claude-code`, `codex`, or `openclaw`. Already modelled in feature 001 as controller metadata.
- **Transport Attribution**: `requested_by` describes how the request reached OctoAlly (`ui`, `api`, `openclaw`, and now `mcp`), while controller kind describes which harness originated it. Separating these prevents one enum value per harness.
- **Output Cursor**: An opaque marker identifying how much session output the caller has already consumed.
- **Integration Client**: The shared TypeScript client currently at `openclaw-skills/`, consumed by both the OpenClaw skill and the MCP server.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can launch, monitor, answer, and cancel an OctoAlly session from Hermes Agent with no OctoAlly-specific skill installed in Hermes.
- **SC-002**: Launch acknowledgement returns within 2 seconds on the local happy path, matching the 001 target.
- **SC-003**: 100 percent of concurrent write-capable launches to the same workspace are refused, and every refusal is a structured result rather than a protocol error.
- **SC-004**: 100 percent of MCP-launched sessions carry both `requested_by` `mcp` and a non-null controller kind.
- **SC-005**: 0 destructive confirmation prompts can be answered without explicit destructive confirmation, verified by a test that calls the API directly and bypasses the tool schema.
- **SC-006**: Adding a further harness requires only registering the server with that harness, with no new code in this repository.
- **SC-007**: Total HTTP client code in the repository does not increase, because the MCP server consumes the existing client.
- **SC-008**: The existing 66 server tests still pass, and the full suite is runnable through a single documented command.

## Assumptions

- OctoAlly runs on localhost and the MCP server process runs on the same machine, so stdio transport and no authentication remain acceptable for this feature.
- The session REST surface delivered by feature 001 is stable and is extended, not replaced. The endpoints in scope are session create, get, delete, execute, cancel, state, display, and project list.
- Feature 001 is merged, or at minimum this branch is stacked on it, since every tool depends on its lock and controller metadata.
- Hermes Agent skills are not required. MCP is sufficient, so no SKILL.md files are authored for Hermes in this feature.
- The `openclaw_prompt` project column keeps its name in this feature. Renaming it is a separate migration whose risk should not be bundled with a new integration surface.
- Prompt destructiveness classification exists today only in the 001 skill client, as a keyword pattern at `openclaw-skills/octoally_research_session.ts:209`. This feature moves that classification into the server so it can be enforced, and the client keeps calling it for its own display purposes. This is new server work, not reuse.
- One MCP server process per harness is acceptable. No shared daemon or multiplexing is required.

## Clarifications

### Session 2026-07-24

- Q: Port the OpenClaw skill to a Hermes skill, or build one MCP server? → A: One MCP server. Hermes, Claude Code, and Codex all consume MCP, so a per-harness client does not scale and doubles the surface that can drift.
- Q: Is Hermes Agent a rename of OpenClaw? → A: No. Separate product from Nous Research, first released 2026-02-25. OpenClaw remains supported; this feature adds a harness-neutral path rather than removing one.
- Q: How is the calling harness identified without adding an enum value per harness? → A: `requested_by` becomes the transport (`mcp`) and controller kind carries the harness name. Existing `openclaw` rows are untouched and the value stays accepted.
- Q: Which transports in v1? → A: stdio only. A network transport would require authentication, which OctoAlly does not have, so it is out of scope here.
- Q: Should the `openclaw_prompt` column be renamed as part of this work? → A: No. It is orthogonal to who launched a session, and bundling a data migration into a new integration surface makes both harder to verify.
- Q: Where is destructive-prompt protection enforced? → A: In the OctoAlly API layer. Tool schemas are a client-side affordance and an autonomous harness can send any payload the API accepts.
