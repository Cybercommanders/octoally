# Implementation Plan: OctoAlly MCP Server

**Branch**: `002-octoally-mcp-server` | **Date**: 2026-07-24 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/002-octoally-mcp-server/spec.md`

## Summary

Expose OctoAlly session control over the Model Context Protocol so that any harness which speaks MCP can launch, monitor, answer, and cancel sessions.
Six tools map onto the session REST surface delivered by feature 001.
The MCP server consumes the HTTP client that already exists for the OpenClaw skill instead of reimplementing it, so both integration paths share one behaviour.

Two server-side changes accompany the new package.
First, `requested_by` gains an `mcp` value and, when set, requires a controller kind, so that harness attribution does not need one enum value per harness.
Second, destructive-prompt classification moves into the OctoAlly API and becomes an enforced rejection, because the current keyword check lives in the client and an autonomous harness can bypass it by calling the API directly.

## Technical Context

**Language/Version**: TypeScript on Node.js, matching the existing server and skill packages
**Primary Dependencies**: `@modelcontextprotocol/sdk` (new, flagged below), Fastify (existing server), better-sqlite3 (existing storage)
**Storage**: No new storage. All state stays in the existing SQLite database.
**Testing**: `bun test`, matching the 66 existing server tests, which use `bun:sqlite` rather than better-sqlite3
**Target Platform**: Local development machine (Linux, macOS, WSL). Same host as the OctoAlly server.
**Project Type**: Additional workspace package in an existing web application repository
**Performance Goals**: Launch acknowledgement under 2 seconds, cancel under 3 seconds, matching feature 001. Monitor wait budget clamped server-side.
**Constraints**: stdio transport only. No authentication, and therefore no network transport. No change to existing session flows, the dashboard, or the OpenClaw skill's observable behaviour.
**Scale/Scope**: Single user, one MCP server process per harness, 1 to 10 concurrent sessions.

### New Dependency

`@modelcontextprotocol/sdk` is the only new runtime dependency.
It is the reference MCP implementation and provides the stdio server transport and tool registration.
Flagged here for explicit approval before installation, per repository policy on new dependencies.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The project constitution at `.specify/memory/constitution.md` is still an unfilled template, as it was for feature 001.
No project-specific gates are defined, so the same standard practices apply:

- [x] Test coverage for new functionality, including a test that bypasses the tool schema and calls the API directly
- [x] Backward compatibility preserved for the 001 skill, the dashboard, and existing session rows
- [x] No unnecessary abstractions. The MCP server is a thin adapter over an existing client.
- [x] Clear separation of concerns: transport adapter, shared client, server enforcement
- [x] New dependency flagged for approval rather than installed silently

## Project Structure

### Documentation (this feature)

```text
specs/002-octoally-mcp-server/
├── spec.md              # Feature specification
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── mcp-tools.md            # Tool names, inputs, outputs, error shapes
│   ├── controller-attribution.md  # requested_by and controller kind contract
│   └── destructive-guard.md    # Server-side classification and rejection
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output
```

### Source Code (repository root)

```text
integration-client/                    # renamed from openclaw-skills/
├── octoally_research_session.ts       # shared HTTP client and normalization (unchanged logic)
├── research_claude.ts                 # OpenClaw alias, unchanged
├── research_codex.ts                  # OpenClaw alias, unchanged
└── tests/

mcp-server/                            # new package
├── src/
│   ├── index.ts                       # stdio entrypoint
│   ├── tools/
│   │   ├── list-projects.ts
│   │   ├── launch-session.ts
│   │   ├── session-status.ts
│   │   ├── session-monitor.ts
│   │   ├── session-continue.ts
│   │   └── session-cancel.ts
│   ├── schemas.ts                     # tool input schemas, REST field names
│   └── results.ts                     # structured result shaping, including lock conflict
└── tests/
    ├── tools.test.ts                  # schema and mapping units
    └── integration/
        └── mcp-stdio.test.ts          # real MCP client over stdio against a live server

server/
└── src/
    ├── routes/
    │   └── agent.ts                   # destructive-confirmation rejection on execute
    └── services/
        ├── session-records.ts         # requested_by gains 'mcp'
        ├── prompt-destructiveness.ts  # new, classification moved server-side
        └── session-manager.ts         # controller kind required when requested_by is 'mcp'
```

**Structure Decision**: The MCP server is its own package because it runs as a separate process spawned by the harness, not inside the OctoAlly server.
The shared client moves out of `openclaw-skills/` because that name now describes only one of its two consumers.
The rename is mechanical and lands first, on its own, so that later diffs are readable.

## Phasing

1. **Groundwork**: add the runnable test command, rename `openclaw-skills/` to `integration-client/`, update imports. No behaviour change.
2. **Server enforcement**: `requested_by` `mcp` plus required controller kind, server-side destructive classification and rejection, tests that call the API directly.
3. **MCP package**: six tools over the shared client, stdio entrypoint.
4. **Integration proof**: a real MCP client driving launch, lock conflict, monitor, continue, cancel over stdio.
5. **Harness wiring**: register with Hermes, Claude Code, and Codex; document each in quickstart.

Phases 2 through 4 change server contracts, so they land after feature 001 is merged rather than stacking further unpushed work on unpushed work.

## Complexity Tracking

One deviation from pure minimal change is justified here.
Moving destructive-prompt classification from the client to the server duplicates a keyword pattern temporarily, because the client keeps its own copy for display while the server owns enforcement.
The alternative, leaving enforcement in the client, is not viable: the MCP server's caller is an autonomous model that can construct any request the API accepts, so a client-side check is an affordance rather than a control.
