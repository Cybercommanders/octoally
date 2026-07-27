import { OctoAllyRequestError } from '@octoally/integration-client';

/**
 * Result shaping.
 *
 * A tool call fails at the MCP protocol level only when the call itself is
 * malformed. Every expected operational outcome - a locked workspace, an
 * unknown session, an OctoAlly that is not running, a refused destructive
 * confirmation - comes back as a successful call carrying `ok: false`.
 *
 * A protocol error is opaque to the calling model and reliably produces a
 * retry loop. A structured refusal carrying remediation lets it choose.
 */

export type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export function ok(payload: Record<string, unknown>): ToolResult {
  const body = { ok: true, ...payload };
  return {
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
    structuredContent: body,
  };
}

export function failure(payload: Record<string, unknown>): ToolResult {
  const body = { ok: false, ...payload };
  return {
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
    structuredContent: body,
  };
}

export function sessionNotFound(sessionId: string): ToolResult {
  return failure({
    reason: 'session_not_found',
    session_id: sessionId,
    message: `No session ${sessionId}. It may have completed and been pruned. List projects or launch a new session.`,
  });
}

export function octoallyUnreachable(baseUrl: string, message: string): ToolResult {
  return failure({
    reason: 'octoally_unreachable',
    base_url: baseUrl,
    message: `Could not reach OctoAlly at ${baseUrl}: ${message}. Is the server running?`,
  });
}

export function controllerKindRequired(): ToolResult {
  return failure({
    reason: 'controller_kind_required',
    message:
      'No controller_kind supplied and OCTOALLY_CONTROLLER_KIND is unset. ' +
      'Set it in the harness configuration so sessions can be attributed.',
  });
}

export function destructiveConfirmationRequired(body: Record<string, unknown>): ToolResult {
  return failure({
    reason: 'destructive_confirmation_required',
    message:
      'This prompt was classified destructive and the server refused to answer it. ' +
      'Operator approval is required. Report the prompt to the operator and wait; ' +
      'do not retry with confirm_destructive set on your own initiative.',
    prompt: body.prompt ?? null,
  });
}

/**
 * Translate a thrown client error into a structured result.
 *
 * Anything unrecognized is still returned as a structured failure rather than
 * rethrown, so a tool call never surfaces as a protocol error the model cannot
 * interpret.
 */
export function toStructuredFailure(
  error: unknown,
  context: { baseUrl: string; sessionId?: string },
): ToolResult {
  if (error instanceof OctoAllyRequestError) {
    if (error.statusCode === 404 && context.sessionId) {
      return sessionNotFound(context.sessionId);
    }

    if (error.statusCode === 409) {
      const body = (error.body ?? {}) as Record<string, unknown>;
      if (body.error === 'destructive_confirmation_required') {
        return destructiveConfirmationRequired(body);
      }
      return failure({
        reason: typeof body.error === 'string' ? body.error : 'conflict',
        message: typeof body.message === 'string' ? body.message : error.message,
        detail: body,
      });
    }

    if (error.statusCode === 400) {
      const body = (error.body ?? {}) as Record<string, unknown>;
      return failure({
        reason: typeof body.error === 'string' ? body.error : 'bad_request',
        message: typeof body.message === 'string' ? body.message : error.message,
        detail: body,
      });
    }

    return failure({
      reason: 'octoally_error',
      status_code: error.statusCode,
      message: error.message,
      detail: error.body,
    });
  }

  // fetch failures surface as TypeError, with the cause carrying ECONNREFUSED.
  const message = error instanceof Error ? error.message : String(error);
  return octoallyUnreachable(context.baseUrl, message);
}
