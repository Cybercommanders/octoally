#!/usr/bin/env node
/**
 * OctoAlly MCP server.
 *
 * Exposes session control over stdio so any harness that speaks MCP - Hermes
 * Agent, Claude Code, Codex, OpenClaw - can drive OctoAlly without a
 * harness-specific client.
 *
 * stdio only. OctoAlly has no enforced authentication (config.authToken is
 * parsed but referenced nowhere), so putting session launch, which executes
 * arbitrary work in a repository, on a listening socket would need an auth
 * design first. See specs/002-octoally-mcp-server/research.md R8.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { OctoAllyClient, resolveBaseUrl } from '@octoally/integration-client';

import {
  launchSessionSchema,
  listProjectsSchema,
  sessionCancelSchema,
  sessionContinueSchema,
  sessionMonitorSchema,
  sessionStatusSchema,
} from './schemas.js';
import * as tools from './tools.js';
import type { ToolContext } from './tools.js';
import type { ToolResult } from './results.js';

const baseUrl = resolveBaseUrl();
const defaultControllerKind = process.env.OCTOALLY_CONTROLLER_KIND?.trim() || null;

const ctx: ToolContext = {
  client: new OctoAllyClient({ baseUrl }),
  baseUrl,
  defaultControllerKind,
  // stdout carries the MCP protocol stream, so diagnostics must go to stderr.
  log: (fields) => {
    process.stderr.write(`[octoally-mcp] ${JSON.stringify(fields)}\n`);
  },
};

const server = new McpServer(
  { name: 'octoally', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

/**
 * Log every tool invocation with the calling harness (002 FR-014), so MCP
 * activity is visible in the same place as UI and OpenClaw activity rather
 * than only when a handler happens to log for itself.
 */
function logged<A>(name: string, handler: (args: A) => Promise<ToolResult>) {
  return async (args: A): Promise<ToolResult> => {
    const startedAt = Date.now();
    const result = await handler(args);
    const outcome = result.structuredContent as { ok?: boolean; reason?: string } | undefined;
    ctx.log({
      event: 'tool_call',
      tool: name,
      controller_kind: defaultControllerKind,
      ok: outcome?.ok ?? null,
      reason: outcome?.reason ?? null,
      duration_ms: Date.now() - startedAt,
    });
    return result;
  };
}

server.registerTool(
  'octoally_list_projects',
  {
    title: 'List OctoAlly projects',
    description:
      'List configured OctoAlly projects with their workspace paths and current lock state. ' +
      'Call this first: every other tool needs a project path or a session id.',
    inputSchema: listProjectsSchema,
    annotations: { readOnlyHint: true },
  },
  logged('octoally_list_projects', async () => tools.listProjects(ctx)),
);

server.registerTool(
  'octoally_launch_session',
  {
    title: 'Launch an OctoAlly session',
    description:
      'Start a Claude Code or Codex session against a project workspace. ' +
      'Returns a session id, normalized status, and a summary of the first output. ' +
      'If another write-capable session already holds the workspace, this returns ok=false with ' +
      'reason=workspace_locked naming the owner - that is a normal outcome, not an error to retry blindly.',
    inputSchema: launchSessionSchema,
  },
  logged('octoally_launch_session', async (args) => tools.launch(ctx, args as tools.LaunchArgs)),
);

server.registerTool(
  'octoally_session_status',
  {
    title: 'Get session status',
    description:
      'Report the normalized status of a session, and when it is waiting for input, the prompt type, ' +
      'the available choices, and whether the prompt was classified destructive.',
    inputSchema: sessionStatusSchema,
    annotations: { readOnlyHint: true },
  },
  logged('octoally_session_status', async (args) => tools.status(ctx, args as { session_id: string; prompt_lines?: number })),
);

server.registerTool(
  'octoally_session_monitor',
  {
    title: 'Monitor session output',
    description:
      'Read session output incrementally. Pass the cursor from the previous call to get only what is new; ' +
      'omit it for a full read. The cursor is opaque - do not parse it. ' +
      'max_wait_ms is clamped server-side and the result reports whether it was clamped.',
    inputSchema: sessionMonitorSchema,
    annotations: { readOnlyHint: true },
  },
  logged('octoally_session_monitor', async (args) =>
    tools.monitor(ctx, args as { session_id: string; cursor?: string; lines?: number; max_wait_ms?: number })),
);

server.registerTool(
  'octoally_session_continue',
  {
    title: 'Send input to a session',
    description:
      'Send follow-up input to a session, including answering a prompt it is waiting on. ' +
      'If the prompt was classified destructive, the server refuses unless confirm_destructive is set. ' +
      'That flag represents an explicit operator decision: on a refusal, report it and wait for the operator. ' +
      'Do not set it yourself to clear the refusal.',
    inputSchema: sessionContinueSchema,
  },
  logged('octoally_session_continue', async (args) =>
    tools.sendInput(ctx, args as { session_id: string; input: string; confirm_destructive?: boolean })),
);

server.registerTool(
  'octoally_session_cancel',
  {
    title: 'Cancel a session',
    description: 'Cancel a running session and release the workspace lock it holds.',
    inputSchema: sessionCancelSchema,
  },
  logged('octoally_session_cancel', async (args) => tools.cancel(ctx, args as { session_id: string })),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  ctx.log({
    event: 'ready',
    base_url: baseUrl,
    controller_kind: defaultControllerKind,
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`[octoally-mcp] fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
