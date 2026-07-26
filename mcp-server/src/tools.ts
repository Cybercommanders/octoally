import {
  OctoAllyClient,
  cancel as cancelSession,
  launch as launchSession,
  monitor as monitorSession,
  status as sessionStatus,
  type SessionSummary,
} from '@octoally/integration-client';

import { controllerKindRequired, failure, ok, toStructuredFailure, type ToolResult } from './results.js';

/**
 * Server-enforced ceiling on how long a monitor call may wait.
 *
 * A model that asks for a very long wait stalls its own turn and, in some
 * harnesses, trips a tool timeout that looks like a failure. The request is
 * clamped rather than honoured, and the result says so.
 */
export const MAX_WAIT_MS = 30_000;
export const MAX_LINES = 500;

const POLL_INTERVAL_MS = 500;

export interface ToolContext {
  client: OctoAllyClient;
  baseUrl: string;
  /** Harness identity from OCTOALLY_CONTROLLER_KIND, when configured. */
  defaultControllerKind: string | null;
  log: (fields: Record<string, unknown>) => void;
}

function clamp(value: number | undefined, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  return Math.max(0, Math.min(value, max));
}

function isSessionHoldingLock(session: SessionSummary): boolean {
  const active = session.status === 'running' || session.status === 'pending' || session.status === 'detached';
  return active && Boolean(session.lock_key) && session.write_capable !== 0;
}

export async function listProjects(ctx: ToolContext): Promise<ToolResult> {
  try {
    const [{ projects }, sessions] = await Promise.all([
      ctx.client.listProjects(),
      ctx.client.listSessions().then((r) => r.sessions).catch(() => [] as SessionSummary[]),
    ]);

    const locks = new Map<string, string>();
    for (const session of sessions) {
      if (isSessionHoldingLock(session) && session.lock_key) {
        locks.set(session.lock_key, session.id);
      }
    }

    return ok({
      projects: projects.map((project) => {
        const lockSessionId = locks.get(project.path) ?? null;
        return {
          id: project.id,
          name: project.name,
          path: project.path,
          locked: lockSessionId !== null,
          lock_session_id: lockSessionId,
        };
      }),
    });
  } catch (error) {
    return toStructuredFailure(error, { baseUrl: ctx.baseUrl });
  }
}

export interface LaunchArgs {
  project_path: string;
  task: string;
  controller_kind?: string;
  project_id?: string;
  cli_type?: 'claude' | 'codex';
  mode?: string;
  agent_type?: string;
  apply_project_prompts?: boolean;
  prompt_context?: string;
  lock_behavior?: 'reject' | 'ignore';
  first_output_lines?: number;
}

export async function launch(ctx: ToolContext, args: LaunchArgs): Promise<ToolResult> {
  const controllerKind = (args.controller_kind ?? ctx.defaultControllerKind ?? '').trim();
  if (!controllerKind) return controllerKindRequired();

  try {
    const result = await launchSession({
      client: ctx.client,
      projectPath: args.project_path,
      task: args.task,
      projectId: args.project_id,
      cliType: args.cli_type ?? 'claude',
      mode: (args.mode ?? 'session') as 'session' | 'terminal' | 'agent',
      agentType: args.agent_type,
      applyProjectPrompts: args.apply_project_prompts ?? true,
      promptContext: (args.prompt_context ?? 'openclaw') as 'default' | 'openclaw',
      lockBehavior: args.lock_behavior ?? 'reject',
      firstOutputLines: clamp(args.first_output_lines, MAX_LINES, 40),
      // Never taken from the caller: a model must not be able to label its own
      // sessions as UI-originated.
      requestedBy: 'mcp',
      controller: {
        kind: controllerKind,
        skill_name: 'octoally_launch_session',
        request_id: `mcp-${Date.now().toString(36)}`,
      },
    });

    if (result.ok === false) {
      ctx.log({ event: 'launch_lock_conflict', controller_kind: controllerKind });
      return failure({
        reason: 'workspace_locked',
        message: result.message,
        existing: {
          session_id: result.existing.sessionId,
          requested_by: result.existing.requestedBy,
          controller_kind: result.existing.controllerKind,
          started_at: result.existing.startedAt,
        },
        remediation: {
          monitor: { session_id: result.existing.sessionId },
          cancel: { session_id: result.existing.sessionId },
        },
      });
    }

    ctx.log({ event: 'launch_ok', session_id: result.sessionId, controller_kind: controllerKind });

    return ok({
      session_id: result.sessionId,
      status: result.status,
      cli_type: result.cliType,
      lock_key: result.lockKey,
      requested_by: result.requestedBy,
      controller_kind: result.controllerKind,
      task: result.task,
      first_output: result.firstOutput,
      summary: result.summary,
    });
  } catch (error) {
    return toStructuredFailure(error, { baseUrl: ctx.baseUrl });
  }
}

export async function status(
  ctx: ToolContext,
  args: { session_id: string; prompt_lines?: number },
): Promise<ToolResult> {
  try {
    const result = await sessionStatus(args.session_id, {
      client: ctx.client,
      promptLines: clamp(args.prompt_lines, MAX_LINES, 40),
    });

    return ok({
      session_id: args.session_id,
      status: result.status,
      waiting_for_input: result.waitingForInput,
      prompt: result.prompt
        ? {
            prompt_type: result.prompt.type,
            choices: result.prompt.choices,
            destructive_choices: result.prompt.destructiveChoices,
            is_destructive: result.prompt.isDestructive,
          }
        : null,
    });
  } catch (error) {
    return toStructuredFailure(error, { baseUrl: ctx.baseUrl, sessionId: args.session_id });
  }
}

export async function monitor(
  ctx: ToolContext,
  args: { session_id: string; cursor?: string; lines?: number; max_wait_ms?: number },
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<ToolResult> {
  const requestedWait = args.max_wait_ms ?? 0;
  const waitBudget = clamp(requestedWait, MAX_WAIT_MS, 0);
  const waitClamped = requestedWait > MAX_WAIT_MS;
  const lines = clamp(args.lines, MAX_LINES, 80);
  const startCursor = args.cursor === undefined ? undefined : Number(args.cursor);

  if (args.cursor !== undefined && !Number.isFinite(startCursor)) {
    return failure({
      reason: 'invalid_cursor',
      message: 'cursor must be a value returned by a previous monitor call. Omit it for a full read.',
    });
  }

  const startedAt = Date.now();
  // Bound the poll count as well as the deadline. The wall-clock check alone
  // is only as reliable as the clock advancing between iterations; a bounded
  // count means the loop terminates regardless.
  const maxPolls = Math.ceil(waitBudget / POLL_INTERVAL_MS) + 1;
  let polls = 0;

  try {
    for (;;) {
      polls += 1;
      const result = await monitorSession(args.session_id, startCursor, {
        client: ctx.client,
        lines,
      });

      const hasNewOutput = result.output.length > 0;
      const elapsed = Date.now() - startedAt;
      const terminal =
        result.status === 'completed' || result.status === 'failed' || result.status === 'cancelled';

      if (hasNewOutput || terminal || elapsed >= waitBudget || polls >= maxPolls) {
        return ok({
          session_id: args.session_id,
          status: result.status,
          output: result.output,
          cursor: String(result.cursor),
          truncated: result.truncated,
          waited_ms: elapsed,
          wait_clamped: waitClamped,
        });
      }

      await sleep(Math.min(POLL_INTERVAL_MS, waitBudget - elapsed));
    }
  } catch (error) {
    return toStructuredFailure(error, { baseUrl: ctx.baseUrl, sessionId: args.session_id });
  }
}

export async function sendInput(
  ctx: ToolContext,
  args: { session_id: string; input: string; confirm_destructive?: boolean },
): Promise<ToolResult> {
  try {
    await ctx.client.execute(args.session_id, {
      input: args.input,
      confirmDestructive: args.confirm_destructive === true,
    });

    ctx.log({ event: 'continue_ok', session_id: args.session_id });
    return ok({ session_id: args.session_id, delivered: true });
  } catch (error) {
    return toStructuredFailure(error, { baseUrl: ctx.baseUrl, sessionId: args.session_id });
  }
}

export async function cancel(ctx: ToolContext, args: { session_id: string }): Promise<ToolResult> {
  try {
    const result = await cancelSession(args.session_id, { client: ctx.client });
    ctx.log({ event: 'cancel', session_id: args.session_id });
    return ok({ session_id: args.session_id, status: result.status ?? 'cancelled' });
  } catch (error) {
    return toStructuredFailure(error, { baseUrl: ctx.baseUrl, sessionId: args.session_id });
  }
}
