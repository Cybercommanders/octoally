# Quickstart: OctoAlly MCP Server

**Feature**: 002-octoally-mcp-server

## Prerequisites

- OctoAlly server running. Default port is `42010`, from `server/src/config.ts:96`, overridable with `PORT` or the `server_port` settings row.
- Node.js available on PATH, since the harness spawns the MCP server as a child process.
- Feature 001 merged, because every tool depends on its workspace lock and controller metadata.

## Base URL defect to fix first

The shared client defaults to `http://localhost:3000` at `integration-client/octoally_research_session.ts:201`, while the server listens on `42010`.
The client reads no environment variable, so the default never resolves to a running server and a caller that omits `baseUrl` fails to connect.

Groundwork task: resolve the base URL as `OCTOALLY_BASE_URL`, then `PORT`, then `http://127.0.0.1:42010`.
The MCP server depends on this, since a harness config supplies environment variables rather than constructor options.

## Build

```bash
cd mcp-server
npm install
npm run build
```

The build output is a plain Node entrypoint at `mcp-server/dist/index.js`.
Register that path rather than an `npx` invocation.
An `npx` cold start has previously exceeded MCP startup timeouts on this machine and required raising `startup_timeout_sec` in the Codex config.

## Register with Hermes Agent

Servers live in `~/.hermes/config.yaml` under `mcp_servers`.

```yaml
mcp_servers:
  octoally:
    command: "node"
    args: ["/home/stavros/dev/octoally/mcp-server/dist/index.js"]
    env:
      OCTOALLY_BASE_URL: "http://127.0.0.1:42010"
      OCTOALLY_CONTROLLER_KIND: "hermes"
    enabled: true
```

Catalog installs are disabled by default, so `enabled: true` is required for a manual entry.
`tools.include` or `tools.exclude` can narrow the exposed tools if the full set is not wanted.

Verify with `hermes mcp`, which lists the registered servers and their tools.

## Register with Claude Code

`.mcp.json`, project or user scope:

```json
{
  "mcpServers": {
    "octoally": {
      "command": "node",
      "args": ["/home/stavros/dev/octoally/mcp-server/dist/index.js"],
      "env": {
        "OCTOALLY_BASE_URL": "http://127.0.0.1:42010",
        "OCTOALLY_CONTROLLER_KIND": "claude-code"
      }
    }
  }
}
```

## Register with Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.octoally]
command = "node"
args = ["/home/stavros/dev/octoally/mcp-server/dist/index.js"]
startup_timeout_sec = 90

[mcp_servers.octoally.env]
OCTOALLY_BASE_URL = "http://127.0.0.1:42010"
OCTOALLY_CONTROLLER_KIND = "codex"
```

## First run

1. List projects.

   ```
   octoally_list_projects
   ```

   Confirms connectivity and returns the paths the other tools need.

2. Launch a session.

   ```
   octoally_launch_session
     project_path: /home/stavros/dev/octoally
     task: Summarize the session lifecycle logging
     controller_kind: hermes
   ```

   Returns a session ID, normalized status, lock key, and a first-output summary.

3. Watch it.

   ```
   octoally_session_monitor  session_id: <id>
   octoally_session_monitor  session_id: <id>  cursor: <cursor from the previous call>
   ```

4. Answer a prompt when the status is `waiting_for_input`.

   ```
   octoally_session_continue  session_id: <id>  input: yes
   ```

   If the prompt is destructive, this is refused with `destructive_confirmation_required`.
   That refusal is the guard working.
   Confirming requires an operator decision to set `confirm_destructive`, not a model retry.

5. Cancel.

   ```
   octoally_session_cancel  session_id: <id>
   ```

## Verify attribution

```bash
sqlite3 ~/.octoally/octoally.db \
  "SELECT id, requested_by, controller_kind FROM sessions ORDER BY created_at DESC LIMIT 5;"
```

MCP-launched rows show `requested_by` `mcp` and a non-null `controller_kind`.
Rows from the OpenClaw skill still show `openclaw`, unchanged.

## Verify the destructive guard properly

Testing through the tool proves only that the tool passes the flag along.
Test the API directly, with no MCP server in the path:

```bash
curl -sS -X POST "http://127.0.0.1:42010/api/sessions/<id>/execute" \
  -H 'Content-Type: application/json' \
  -d '{"input":"yes"}'
```

Against a session waiting on a destructive confirmation this must return 409 `destructive_confirmation_required`, and the session state must be unchanged.

## Run the tests

```bash
bun test          # from server/ or mcp-server/
```

Feature 002 adds a root `test` script, so a single command runs every suite.
Before that lands, `bun test` inside each package is the only way to run them, which is why the existing 66 tests are invisible to CI.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `octoally_unreachable` | Base URL points at 3000 rather than 42010 | Set `OCTOALLY_BASE_URL` |
| `controller_kind_required` | `OCTOALLY_CONTROLLER_KIND` unset and the tool call omitted it | Set it in the harness `env` block |
| Server missing from the harness | Registered but not enabled | Hermes catalog entries are disabled by default |
| Startup timeout | `npx` cold start | Register the built `dist/index.js` path |
