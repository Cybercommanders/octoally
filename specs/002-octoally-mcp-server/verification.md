# Verification Record: OctoAlly MCP Server

**Feature**: 002-octoally-mcp-server

What was actually exercised, when, and against what.
Anything not listed here was not proven, however confident the surrounding prose sounds.

## Environment

| Item | Value | Verified |
|---|---|---|
| `@modelcontextprotocol/sdk` | 1.29.0, MIT | 2026-07-26 |
| MCP protocol negotiated | `2025-06-18` | 2026-07-26 |
| Node | v24.12.0 | 2026-07-26 |
| Hermes Agent | v0.18.2 (2026.7.7.2) | 2026-07-26 |
| Codex CLI | 0.145.0 | 2026-07-26 |
| OctoAlly server default port | 42010 (`server/src/config.ts`) | 2026-07-24 |

Note: research.md R1 cites Hermes v0.1.0 from 2026-02-25, which was the first release.
The installed version is v0.18.2.
The `mcp_servers` config shape described in R3 was re-checked against the installed version and still holds.

## Harness registration

| Harness | Where | Result | Date |
|---|---|---|---|
| Hermes Agent | `~/.hermes/config.yaml` via `hermes mcp add` | Connected, discovered 6 tools, saved with 6/6 enabled | 2026-07-26 |
| Codex CLI | `~/.codex/config.toml` | Appended block; `codex mcp list` shows `octoally` enabled | 2026-07-26 |
| Claude Code | `.mcp.json` in the repository | File written; not launched from a fresh Claude Code session yet | 2026-07-26 |

Both user-level config files were backed up before editing:
`~/.hermes/config.yaml.bak-<timestamp>` and `~/.codex/config.toml.bak-20260726-182646`.

**Not yet proven**: Claude Code actually loading `.mcp.json` and listing the tools.
The file matches the documented format, but a fresh session has not been started to confirm it.

## Protocol level

Driven by hand against the built `dist/index.js` over real stdio, 2026-07-26:

- `initialize` returned `octoally 1.0.0`, protocol `2025-06-18`.
- `tools/list` returned all six tools.
- `tools/call octoally_list_projects` against the running instance on 42010 returned four live projects with lock state.
- `tools/call octoally_session_status` with an unknown id returned `{"ok": false, "reason": "session_not_found"}` rather than a protocol error.

Automated equivalent lives in `mcp-server/tests/integration/mcp-stdio.test.ts`, which spawns the built server through `StdioClientTransport` and a real `Client`.
10 tests, all passing.

## End-to-end launch (T055)

Run against an **isolated** OctoAlly instance, not the operator's running one.

The instance on port 42010 is an older build that predates the Phase 2 attribution change, so it rejects `requested_by: mcp` outright.
A second server was started from the current `server/dist` on port 42099 with a temporary database, used, and stopped.

Confirmed live:

1. `POST /api/sessions` with `requested_by: mcp` and no controller returned
   `{"error":"controller_kind_required", ...}` - the invariant holds against the real route, not only in unit tests.
2. `octoally_list_projects` through the MCP server returned the seeded project.
3. `octoally_launch_session` returned `ok: true`, session `O-aodtKrY8YR`, `requested_by: mcp`, `controller_kind: hermes`.
4. The database row:

   ```
   id            requested_by  controller_kind  status   prompt_context
   O-aodtKrY8YR  mcp           hermes           pending  openclaw
   ```

   with `controller_meta_json` carrying
   `{"kind":"hermes","skill_name":"octoally_launch_session","request_id":"mcp-ms2jtec5"}`.

5. Server lifecycle log carried the attribution:
   `session_create_requested` and `session_created`, both with `requested_by: mcp`, `controller_kind: hermes`, one correlation id.
6. MCP-side log emitted one `tool_call` line per invocation with the controller kind and duration.

**Scope limit**: the launch used `mode: terminal`, which spawns a shell rather than a Claude session.
That produces a genuine session row and genuine attribution without spending tokens on an LLM turn.
A full Claude-session launch through MCP has **not** been run.

## What is covered by which test

| Claim | Proven by | Against |
|---|---|---|
| Destructive prompts cannot be auto-confirmed | `server/src/__tests__/agent-execute-guard.test.ts` (T021) | The real HTTP route, no MCP server and no client in the path |
| Prompt classification | `server/src/__tests__/prompt-destructiveness.test.ts` | Pure unit |
| `mcp` requires a controller kind | `session-records.test.ts`, `session-routes.test.ts`, plus the live curl above | Real database and real route |
| Tools return structured failures, never protocol errors | `mcp-server/tests/tools.test.ts`, `mcp-stdio.test.ts` | Stubbed OctoAlly, real stdio transport |
| Lock conflict carries owner and remediation | `mcp-stdio.test.ts` (T047) | Stubbed 409 |
| Cursor scoping | `mcp-stdio.test.ts` (T048) | Stubbed display endpoint |
| Attribution reaches the database | Live run above (T055) | Real server, real SQLite |

Two integration behaviours are driven against a stub rather than a live session, deliberately:
a real lock conflict needs two concurrent write-capable Claude sessions, and a real destructive refusal needs a Claude session sitting on a delete confirmation.
Both server-side rules are covered against real routes elsewhere in the table.

## Test totals at Phase 4 close

```
server            94 pass
dashboard          8 pass
integration-client 19 pass
mcp-server         25 pass   (15 unit + 10 stdio integration)
-----------------------------
total             146 pass, 0 fail
```

`npm run build` and `npm run typecheck` both exit 0 across all four packages.

## Known open items

- 001 is still not merged to `origin/main`; push access is denied for this account (403), so it needs a PR from the fork. 002 remains stacked on it.
- `npm audit` reports 2 moderate advisories from `@hono/node-server`, pulled in transitively by the SDK: path traversal in `serve-static` on Windows via an encoded backslash. Not reachable here - stdio transport only, Hono is never imported, no static serving, Linux host. `npm audit fix --force` would downgrade the SDK to 1.24.3, a breaking change, so it was not applied.
- The OctoAlly instance the operator runs on 42010 predates the Phase 2 server changes. It must be rebuilt and restarted before MCP launches work against it.
