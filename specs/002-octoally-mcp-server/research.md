# Research: OctoAlly MCP Server

**Feature**: 002-octoally-mcp-server
**Date**: 2026-07-24

## R1. Is Hermes Agent a successor to OpenClaw?

No.
They are separate products from separate organizations.

OpenClaw began as Clawdbot, was renamed Moltbot, then OpenClaw in early 2026.
It is a messaging gateway that sits between the operator and agents, handling routing, permissions, channels, and a large community skill catalog.

Hermes Agent is from Nous Research, first released as v0.1.0 on 2026-02-25.
It is agent-first: a terminal agent loop with persistent memory, reusable skills, built-in tools, and MCP client support.

**Consequence**: this is not a migration in the sense of replacing one system with its newer version.
OpenClaw support stays.
The correct move is a harness-neutral integration surface rather than removing the existing one.

Sources: [The New Stack](https://thenewstack.io/openclaw-hermes-agent-harness/), [Hermes Agent docs](https://hermes-agent.nousresearch.com/docs/)

## R2. Skill port or MCP server?

Hermes supports both SKILL.md skills, compatible with the agentskills.io specification, and MCP servers.
A skill port would be the closer analogue to the existing OpenClaw integration.

MCP was chosen.

| Criterion | Per-harness skill | MCP server |
|---|---|---|
| Cost per new harness | Full client port, currently 702 lines | Registration only, no code |
| Drift risk | One implementation per harness | One implementation |
| Reach | Hermes only | Hermes, Claude Code, Codex, and anything else speaking MCP |
| Existing client reuse | Partial, language and runtime dependent | Direct, same process |

The deciding factor is that the harness list is open-ended.
Two harnesses are in use today and the repository already contains configuration for several agent runtimes.

## R3. How do the target harnesses register an MCP server?

**Hermes Agent** stores servers in `~/.hermes/config.yaml` under `mcp_servers`.
Stdio entries take `command`, `args`, and optional `env`.
Servers installed from the catalog are disabled by default, and `tools.include` or `tools.exclude` can narrow the exposed set.
`hermes mcp add <name>` performs manual addition.

**Claude Code** reads stdio server entries from `.mcp.json` at the project or user level.

**Codex** reads `[mcp_servers.<name>]` blocks from `~/.codex/config.toml` with `command` and `args`.
A prior incident on this machine required `startup_timeout_sec` to be raised for `npx`-launched servers, so the quickstart should recommend a built entrypoint rather than an `npx` cold start.

**Consequence**: a single stdio entrypoint satisfies all three.
No harness-specific packaging is needed.

Source: [Hermes MCP docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)

## R4. What is the existing REST surface?

Verified by reading the routes rather than the specification.

| Operation | Endpoint | Location |
|---|---|---|
| Create session | `POST /api/sessions` | `server/src/routes/sessions.ts:96` |
| Get session | `GET /api/sessions/:id` | `server/src/routes/sessions.ts:75` |
| Delete session | `DELETE /api/sessions/:id` | `server/src/routes/sessions.ts:345` |
| Send input | `POST /api/sessions/:id/execute` | `server/src/routes/agent.ts:185` |
| Cancel | `POST /api/sessions/:id/cancel` | `server/src/routes/agent.ts:250` |
| Session state | `GET /api/sessions/:id/state` | `server/src/routes/agent.ts:265` |
| Rendered output | `GET /api/sessions/:id/display` | `server/src/routes/agent.ts:288` |
| List projects | `GET /api/projects` | `server/src/routes/projects.ts:324` |

All are registered under the `/api` prefix in `server/src/index.ts`.
The six planned tools cover this surface with no new endpoints required, apart from the destructive guard described in R6.

## R5. What can be reused from feature 001?

`openclaw-skills/octoally_research_session.ts` is 702 lines and already contains:

- an HTTP client over the endpoints in R4
- session status normalization from record status and process state to a single normalized status
- output summarization for launch results
- structured lock-conflict results including owner and remediation
- prompt shape modelling with choices and a destructiveness flag

The two alias files are 14 lines each and only bind a `cliType`.

**Decision**: the MCP server imports this module rather than reimplementing it.
The directory is renamed to `integration-client/` because `openclaw-skills` will no longer describe its only consumer.

## R6. Where is destructive-prompt protection today?

In the client only.

`octoally_research_session.ts:209` defines a keyword pattern covering delete, remove, destroy, drop, wipe, overwrite, discard, terminate, kill, reset, revert, erase, purge, truncate, force push, and rm.
The guard at lines 394 to 399 refuses to auto-confirm when the prompt is classified destructive and `allowDestructiveConfirmation` was not set.

A search of `server/src` for destructive handling returns only test fixtures.
The server accepts any execute payload.

**Consequence**: feature 001's FR-014 is satisfied for the well-behaved skill client and not satisfied against a direct API call.
The MCP server's caller is an autonomous model that composes its own tool arguments, so a client-side check would be an affordance rather than a control.
Classification and rejection move into the API layer in this feature.
The client keeps its copy for display and early feedback.

## R7. How should the calling harness be identified?

`session-records.ts:52` currently types `requestedBy` as `'ui' | 'openclaw' | 'api'`.

Three options were considered.

1. Add one value per harness: `hermes`, `claude-code`, and so on. Rejected. The enum grows without bound and every new harness becomes a schema change.
2. Reuse `openclaw` for all harnesses. Rejected. It makes the audit trail lie, and feature 001 already established controller metadata precisely to attribute sessions.
3. Separate transport from harness. Chosen. `requested_by` becomes `mcp` for anything arriving over this server, and the existing controller kind field carries `hermes`, `claude-code`, `codex`, or `openclaw`.

Option 3 requires the controller kind to be mandatory when `requested_by` is `mcp`, otherwise an unattributed session is indistinguishable from a bug.
Existing `openclaw` rows and the existing skill path are untouched, so no data migration is needed.

## R8. Which transports in v1?

stdio only.

OctoAlly deliberately has no authentication because it binds localhost.
An HTTP or SSE MCP transport would put session launch, which executes arbitrary work in a repository, on a listening socket.
That requires an authentication design, which is a separate decision from this integration.

## R9. Streaming and monitoring

MCP has no generic server-to-client push that all harnesses consume today, and OctoAlly's own streaming is a WebSocket the harness does not hold.
Monitoring is therefore a poll with a bounded wait and an opaque cursor for incremental output.

The wait budget is clamped server-side.
A model that asks for a very long wait would otherwise stall its own turn and, in some harnesses, hit a tool timeout that looks like a failure.

## R10. Test runner

The repository has no `test` script in the root or in `server/package.json`.
The 66 existing tests run under `bun test`, and `server/src/__tests__/workspace-lock.test.ts` documents that `bun:sqlite` is used because bun's runner does not support better-sqlite3.

This is discoverable only by reading the test files, so CI or a new contributor would miss the suite entirely.
Adding the script is folded into the groundwork phase.

## Open Questions

None blocking.
The dependency on `@modelcontextprotocol/sdk` requires explicit approval before installation.
