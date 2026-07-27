import { z } from 'zod';

/**
 * Tool input schemas.
 *
 * Field names are the ones the REST API and the database already use
 * (`project_path`, `cli_type`, `session_id`, ...). The camelCase form the
 * shared client uses internally stays private to that module. Introducing a
 * third spelling for the same concepts is how the `ruflo_prompt` /
 * `session_prompt` split happened, and it cost a broken build.
 */

export const CONTROLLER_KIND_DESCRIPTION =
  'Harness making the call, for example hermes, claude-code, codex, or openclaw. ' +
  'Defaults to OCTOALLY_CONTROLLER_KIND from the server environment.';

export const listProjectsSchema = {} as const;

export const launchSessionSchema = {
  project_path: z.string().min(1).describe('Absolute path of the project workspace to launch against.'),
  task: z.string().min(1).describe('What the session should do.'),
  controller_kind: z.string().min(1).optional().describe(CONTROLLER_KIND_DESCRIPTION),
  project_id: z.string().optional().describe('Optional OctoAlly project id, when already known.'),
  cli_type: z
    .enum(['claude', 'codex'])
    .optional()
    .describe('Executor to run. Defaults to claude.'),
  mode: z.string().optional().describe('Session mode. Defaults to session.'),
  agent_type: z.string().optional().describe('Optional agent type for agent-mode launches.'),
  apply_project_prompts: z
    .boolean()
    .optional()
    .describe('Merge the project-level prompts into the task. Defaults to true.'),
  prompt_context: z
    .string()
    .optional()
    .describe('Prompt composition context. Defaults to openclaw.'),
  lock_behavior: z
    .enum(['reject', 'ignore'])
    .optional()
    .describe('reject returns a structured conflict when the workspace is locked. Defaults to reject.'),
  first_output_lines: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('How many lines of first output to summarize. Clamped server-side.'),
} as const;

export const sessionStatusSchema = {
  session_id: z.string().min(1).describe('Session to inspect.'),
  prompt_lines: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Lines of output to read when assessing a prompt. Clamped.'),
} as const;

export const sessionMonitorSchema = {
  session_id: z.string().min(1).describe('Session to monitor.'),
  cursor: z
    .string()
    .optional()
    .describe('Opaque cursor from a previous monitor call. Omit for a full read. Do not parse it.'),
  lines: z.number().int().positive().optional().describe('Maximum lines of output to return. Clamped.'),
  max_wait_ms: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('How long to wait for new output. Clamped to the server maximum.'),
} as const;

export const sessionContinueSchema = {
  session_id: z.string().min(1).describe('Session to send input to.'),
  input: z.string().describe('Text to send to the session.'),
  confirm_destructive: z
    .boolean()
    .optional()
    .describe(
      'Set only on explicit operator instruction. Required to answer a prompt classified destructive. ' +
        'Never set this on your own initiative to clear a refusal.',
    ),
} as const;

export const sessionCancelSchema = {
  session_id: z.string().min(1).describe('Session to cancel.'),
} as const;
