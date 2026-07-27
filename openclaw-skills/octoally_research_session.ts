export type ExecutorType = 'claude' | 'codex';
export type PromptType = 'choice' | 'confirmation' | 'text' | null;
export type ProcessState = 'busy' | 'idle' | 'waiting_for_input';
export type SessionRecordStatus =
  | 'pending'
  | 'launching'
  | 'running'
  | 'detached'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type NormalizedSessionStatus =
  | 'pending'
  | 'running'
  | 'waiting_for_input'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface SessionStateResponse {
  sessionId: string;
  processState: ProcessState;
  lastActivity: number;
  promptType: PromptType;
  choices: string[] | null;
}

export interface SessionDisplayResponse {
  sessionId: string;
  processState: ProcessState;
  promptType: PromptType;
  choices: string[] | null;
  output: string;
  cursor: number;
  truncated: boolean;
}

export interface SessionRecordResponse {
  session: {
    id: string;
    status: SessionRecordStatus | string;
    lock_key?: string | null;
  };
}

export interface ExecuteResponse {
  id: string;
  status: 'completed' | 'timeout' | 'pattern_matched';
  output: string;
  durationMs: number;
  state: SessionStateResponse;
}

export interface CancelResponse {
  ok?: boolean;
  session?: {
    id: string;
    status: SessionRecordStatus | string;
    lock_key?: string | null;
  };
}

export interface PromptAssessment {
  type: Exclude<PromptType, null>;
  choices: string[];
  destructiveChoices: string[];
  isDestructive: boolean;
  requiresExplicitApproval: boolean;
  reason?: string;
}

export interface StatusResult {
  sessionId: string;
  status: NormalizedSessionStatus;
  waitingForInput: boolean;
  prompt: PromptAssessment | null;
  summary?: string;
}

export interface MonitorResult extends StatusResult {
  output: string;
  summary: string;
  cursor: number;
  truncated: boolean;
}

export interface ContinueResult {
  sessionId: string;
  responseStatus: ExecuteResponse['status'];
  sessionStatus: NormalizedSessionStatus;
  output: string;
  summary: string;
  durationMs: number;
  prompt: PromptAssessment | null;
}

export interface CancelResult {
  sessionId: string;
  status: NormalizedSessionStatus;
  cancelled: boolean;
  lockReleased: boolean;
}

export interface SessionControllerMetadata {
  kind: string;
  skill_name: string;
  channel_id?: string | null;
  message_id?: string | null;
  request_id: string;
}

export interface LaunchOptions {
  projectPath: string;
  task: string;
  projectId?: string;
  mode?: 'session' | 'terminal' | 'agent';
  agentType?: string;
  applyProjectPrompts?: boolean;
  promptContext?: 'default' | 'openclaw';
  requestedBy?: 'ui' | 'openclaw' | 'api';
  controller?: SessionControllerMetadata;
  lockBehavior?: 'reject' | 'ignore';
  client?: OctoAllyClient;
  firstOutputLines?: number;
  cliType?: ExecutorType;
}

export interface LaunchSuccessResult {
  ok: true;
  sessionId: string;
  status: NormalizedSessionStatus;
  cliType: ExecutorType;
  lockKey: string | null;
  requestedBy: string | null;
  controllerKind: string | null;
  task: string;
  firstOutput: string | null;
  summary: string;
}

export interface WorkspaceLockedDetails {
  sessionId: string;
  requestedBy: string;
  controllerKind: string | null;
  startedAt: string;
}

export interface LaunchLockedResult {
  ok: false;
  reason: 'workspace_locked';
  message: string;
  existing: WorkspaceLockedDetails;
  remediation: {
    monitor: { sessionId: string };
    cancel: { sessionId: string };
  };
}

export type LaunchResult = LaunchSuccessResult | LaunchLockedResult;

export interface OctoAllyClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface StatusOptions {
  client?: OctoAllyClient;
  promptLines?: number;
}

export interface MonitorOptions {
  client?: OctoAllyClient;
  lines?: number;
}

export interface ContinueOptions {
  client?: OctoAllyClient;
  allowDestructiveConfirmation?: boolean;
}

export interface CancelOptions {
  client?: OctoAllyClient;
}

export interface ResearchSessionSkillOptions extends OctoAllyClientOptions {
  cliType?: ExecutorType;
}

export class OctoAllyRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'OctoAllyRequestError';
  }
}

const DEFAULT_BASE_URL = 'http://localhost:3000';
const DEFAULT_PROMPT_LINES = 40;
const DEFAULT_MONITOR_LINES = 80;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_QUIESCENCE_MS = 2_000;
const SUMMARY_MAX_LINES = 10;
const SUMMARY_MAX_CHARS = 1_200;

const DESTRUCTIVE_PROMPT_PATTERN = /\b(delete|remove|destroy|drop|wipe|overwrite|discard|terminate|kill|reset|revert|erase|purge|truncate|force push|rm\b)\b/i;
const AFFIRMATIVE_CONFIRMATION_PATTERN = /^(?:y|yes|1|ok|okay|confirm|confirmed|approve|approved|proceed|continue|do it)$/i;

export class OctoAllyClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OctoAllyClientOptions = {}) {
    this.baseUrl = options.baseUrl?.replace(/\/+$/, '') || DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getState(sessionId: string): Promise<SessionStateResponse> {
    return this.request<SessionStateResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/state`);
  }

  async getStateOrNull(sessionId: string): Promise<SessionStateResponse | null> {
    return this.requestOrNull<SessionStateResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/state`);
  }

  async getSession(sessionId: string): Promise<SessionRecordResponse> {
    return this.request<SessionRecordResponse>(`/api/sessions/${encodeURIComponent(sessionId)}`);
  }

  async getDisplay(
    sessionId: string,
    options: { cursor?: number; lines?: number } = {},
  ): Promise<SessionDisplayResponse> {
    const search = new URLSearchParams();
    if (typeof options.cursor === 'number') {
      search.set('since', String(options.cursor));
    }
    search.set('lines', String(options.lines ?? DEFAULT_MONITOR_LINES));
    const query = search.toString();
    return this.request<SessionDisplayResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/display${query ? `?${query}` : ''}`,
    );
  }

  async execute(
    sessionId: string,
    payload: { input: string; timeout?: number; quiescenceMs?: number; stripAnsi?: boolean },
  ): Promise<ExecuteResponse> {
    return this.request<ExecuteResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/execute`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async cancel(sessionId: string): Promise<CancelResponse> {
    return this.request<CancelResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/cancel`, {
      method: 'POST',
    });
  }

  async createSession(payload: Record<string, unknown>): Promise<{ ok: true; session: Record<string, unknown> } | { ok: false; conflict: WorkspaceLockedRaw }> {
    const headers = new Headers({ accept: 'application/json', 'content-type': 'application/json' });
    const response = await this.fetchImpl(new URL('/api/sessions', this.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const body = await parseResponsePayload(response);
    if (response.status === 409 && isWorkspaceLockedConflict(body)) {
      return { ok: false, conflict: body };
    }
    if (!response.ok) {
      throw new OctoAllyRequestError(
        extractErrorMessage(response.status, body),
        response.status,
        body,
      );
    }
    return body as { ok: true; session: Record<string, unknown> };
  }

  private async requestOrNull<T>(path: string, init?: RequestInit): Promise<T | null> {
    try {
      return await this.request<T>(path, init);
    } catch (error) {
      if (error instanceof OctoAllyRequestError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    if (init.body && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }

    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      ...init,
      headers,
    });
    const payload = await parseResponsePayload(response);
    if (!response.ok) {
      throw new OctoAllyRequestError(
        extractErrorMessage(response.status, payload),
        response.status,
        payload,
      );
    }
    return payload as T;
  }
}

export async function status(
  sessionId: string,
  options: StatusOptions = {},
): Promise<StatusResult> {
  const client = options.client ?? new OctoAllyClient();
  const promptLines = options.promptLines ?? DEFAULT_PROMPT_LINES;
  const liveState = await client.getStateOrNull(sessionId);

  if (liveState) {
    if (liveState.processState === 'waiting_for_input') {
      const display = await client.getDisplay(sessionId, { lines: promptLines });
      const prompt = assessPrompt(display.promptType, display.choices, display.output);
      return {
        sessionId,
        status: 'waiting_for_input',
        waitingForInput: true,
        prompt,
        summary: summarizeOutput(display.output),
      };
    }

    return {
      sessionId,
      status: normalizeProcessState(liveState.processState),
      waitingForInput: false,
      prompt: null,
    };
  }

  const session = await client.getSession(sessionId);
  return {
    sessionId,
    status: normalizeSessionRecordStatus(session.session.status),
    waitingForInput: false,
    prompt: null,
  };
}

export async function monitor(
  sessionId: string,
  cursor?: number,
  options: MonitorOptions = {},
): Promise<MonitorResult> {
  const client = options.client ?? new OctoAllyClient();
  const display = await client.getDisplay(sessionId, {
    cursor,
    lines: options.lines ?? DEFAULT_MONITOR_LINES,
  });
  const prompt = assessPrompt(display.promptType, display.choices, display.output);
  const sessionStatus = normalizeProcessState(display.processState);

  return {
    sessionId,
    status: sessionStatus,
    waitingForInput: sessionStatus === 'waiting_for_input',
    prompt,
    output: display.output,
    summary: summarizeOutput(display.output),
    cursor: display.cursor,
    truncated: display.truncated,
  };
}

async function continueSession(
  sessionId: string,
  input: string,
  timeout: number = DEFAULT_TIMEOUT_MS,
  quiescence: number = DEFAULT_QUIESCENCE_MS,
  options: ContinueOptions = {},
): Promise<ContinueResult> {
  const client = options.client ?? new OctoAllyClient();
  const currentStatus = await status(sessionId, { client });

  if (
    currentStatus.waitingForInput
    && currentStatus.prompt?.isDestructive
    && !options.allowDestructiveConfirmation
    && isDestructiveConfirmationInput(input, currentStatus.prompt)
  ) {
    throw new Error(
      'Refusing to auto-confirm a destructive prompt without explicit approval.',
    );
  }

  const response = await client.execute(sessionId, {
    input,
    timeout,
    quiescenceMs: quiescence,
    stripAnsi: true,
  });
  const prompt = assessPrompt(response.state.promptType, response.state.choices, response.output);

  return {
    sessionId,
    responseStatus: response.status,
    sessionStatus: normalizeProcessState(response.state.processState),
    output: response.output,
    summary: summarizeOutput(response.output),
    durationMs: response.durationMs,
    prompt,
  };
}

export { continueSession as continue };

export async function cancel(
  sessionId: string,
  options: CancelOptions = {},
): Promise<CancelResult> {
  const client = options.client ?? new OctoAllyClient();
  const response = await client.cancel(sessionId);

  const session = response.session ?? (await client.getSession(sessionId)).session;
  const normalizedStatus = normalizeSessionRecordStatus(session.status);

  return {
    sessionId,
    status: normalizedStatus,
    cancelled: normalizedStatus === 'cancelled',
    lockReleased: normalizedStatus === 'cancelled' && session.lock_key == null,
  };
}

export async function launch(options: LaunchOptions): Promise<LaunchResult> {
  const client = options.client ?? new OctoAllyClient();
  const cliType = options.cliType ?? 'claude';
  const mode = options.mode ?? 'session';
  const requestedBy = options.requestedBy ?? 'openclaw';
  const promptContext = options.promptContext ?? 'openclaw';
  const lockBehavior = options.lockBehavior ?? 'reject';
  const applyProjectPrompts = options.applyProjectPrompts ?? true;
  const firstOutputLines = options.firstOutputLines ?? DEFAULT_PROMPT_LINES;

  if (!options.projectPath || !options.projectPath.trim()) {
    throw new Error('launch: projectPath is required');
  }
  if (!options.task || !options.task.trim()) {
    throw new Error('launch: task is required');
  }

  const payload: Record<string, unknown> = {
    project_path: options.projectPath,
    task: options.task,
    mode,
    cli_type: cliType,
    apply_project_prompts: applyProjectPrompts,
    prompt_context: promptContext,
    requested_by: requestedBy,
    lock_behavior: lockBehavior,
  };
  if (options.projectId) payload.project_id = options.projectId;
  if (options.agentType) payload.agent_type = options.agentType;
  if (options.controller) payload.controller = options.controller;

  const result = await client.createSession(payload);

  if (result.ok === false) {
    const conflict = result.conflict;
    return {
      ok: false,
      reason: 'workspace_locked',
      message: conflict.message,
      existing: {
        sessionId: conflict.lock.session_id,
        requestedBy: conflict.lock.requested_by,
        controllerKind: conflict.lock.controller_kind,
        startedAt: conflict.lock.started_at,
      },
      remediation: {
        monitor: { sessionId: conflict.lock.session_id },
        cancel: { sessionId: conflict.lock.session_id },
      },
    };
  }

  const session = result.session as Record<string, unknown>;
  const sessionId = String(session.id ?? '');
  const recordStatus = typeof session.status === 'string' ? session.status : 'pending';

  let firstOutput: string | null = null;
  let summary = '';
  try {
    const display = await client.getDisplay(sessionId, { lines: firstOutputLines });
    firstOutput = display.output;
    summary = summarizeOutput(display.output);
  } catch {
    // First-output fetch is best-effort; absence is not a failure for launch.
  }

  return {
    ok: true,
    sessionId,
    status: normalizeSessionRecordStatus(recordStatus),
    cliType,
    lockKey: (session.lock_key as string | null) ?? null,
    requestedBy: (session.requested_by as string | null) ?? requestedBy,
    controllerKind: (session.controller_kind as string | null) ?? options.controller?.kind ?? null,
    task: String(session.task ?? options.task),
    firstOutput,
    summary,
  };
}

export function createResearchSessionSkill(options: ResearchSessionSkillOptions = {}) {
  const client = new OctoAllyClient(options);
  const cliType = options.cliType ?? 'claude';

  return {
    cliType,
    client,
    launch: (launchOptions: Omit<LaunchOptions, 'client' | 'cliType'>) =>
      launch({ ...launchOptions, client, cliType }),
    status: (sessionId: string, statusOptions: Omit<StatusOptions, 'client'> = {}) =>
      status(sessionId, { ...statusOptions, client }),
    monitor: (sessionId: string, cursor?: number, monitorOptions: Omit<MonitorOptions, 'client'> = {}) =>
      monitor(sessionId, cursor, { ...monitorOptions, client }),
    continue: (
      sessionId: string,
      input: string,
      timeout?: number,
      quiescence?: number,
      continueOptions: Omit<ContinueOptions, 'client'> = {},
    ) => continueSession(sessionId, input, timeout, quiescence, { ...continueOptions, client }),
    cancel: (sessionId: string, cancelOptions: Omit<CancelOptions, 'client'> = {}) =>
      cancel(sessionId, { ...cancelOptions, client }),
  };
}

function normalizeProcessState(processState: ProcessState): NormalizedSessionStatus {
  switch (processState) {
    case 'busy':
      return 'running';
    case 'idle':
      return 'idle';
    case 'waiting_for_input':
      return 'waiting_for_input';
    default:
      return 'running';
  }
}

function normalizeSessionRecordStatus(status: string): NormalizedSessionStatus {
  switch (status) {
    case 'pending':
    case 'launching':
      return 'pending';
    case 'running':
    case 'detached':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'running';
  }
}

function assessPrompt(
  promptType: PromptType,
  choices: string[] | null,
  output: string,
): PromptAssessment | null {
  if (!promptType) {
    return null;
  }

  const resolvedChoices = Array.isArray(choices) ? choices : [];
  const destructiveChoices = resolvedChoices.filter((choice) => DESTRUCTIVE_PROMPT_PATTERN.test(choice));
  const promptText = `${output}\n${resolvedChoices.join('\n')}`.trim();
  const isDestructive = destructiveChoices.length > 0 || DESTRUCTIVE_PROMPT_PATTERN.test(promptText);

  return {
    type: promptType,
    choices: resolvedChoices,
    destructiveChoices,
    isDestructive,
    requiresExplicitApproval: isDestructive,
    reason: isDestructive ? 'Prompt references a destructive action.' : undefined,
  };
}

function isDestructiveConfirmationInput(input: string, prompt: PromptAssessment): boolean {
  const normalizedInput = input.trim();
  if (!normalizedInput) {
    return false;
  }

  if (prompt.type === 'confirmation') {
    return AFFIRMATIVE_CONFIRMATION_PATTERN.test(normalizedInput);
  }

  if (prompt.type !== 'choice') {
    return false;
  }

  if (AFFIRMATIVE_CONFIRMATION_PATTERN.test(normalizedInput)) {
    return true;
  }

  if (/^\d+$/.test(normalizedInput)) {
    const index = Number(normalizedInput) - 1;
    if (index < 0 || index >= prompt.choices.length) {
      return false;
    }
    return DESTRUCTIVE_PROMPT_PATTERN.test(prompt.choices[index]);
  }

  const directChoice = prompt.choices.find(
    (choice) => choice.trim().toLowerCase() === normalizedInput.toLowerCase(),
  );
  return directChoice ? DESTRUCTIVE_PROMPT_PATTERN.test(directChoice) : false;
}

function summarizeOutput(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trimEnd())
    .reduce<string[]>((accumulator, line) => {
      if (line.length === 0) {
        if (accumulator[accumulator.length - 1] !== '') {
          accumulator.push('');
        }
        return accumulator;
      }

      accumulator.push(line);
      return accumulator;
    }, [])
    .filter((line, index, source) => !(index === 0 && line === '') && !(index === source.length - 1 && line === ''));

  const tail = lines.slice(-SUMMARY_MAX_LINES).join('\n');
  if (tail.length <= SUMMARY_MAX_CHARS) {
    return tail;
  }

  return `${tail.slice(0, SUMMARY_MAX_CHARS - 1)}…`;
}

async function parseResponsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractErrorMessage(statusCode: number, body: unknown): string {
  if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
    return body.error;
  }

  return `OctoAlly request failed with status ${statusCode}`;
}

export interface WorkspaceLockedRaw {
  error: 'workspace_locked';
  message: string;
  lock: {
    session_id: string;
    requested_by: string;
    controller_kind: string | null;
    started_at: string;
  };
}

function isWorkspaceLockedConflict(body: unknown): body is WorkspaceLockedRaw {
  if (!body || typeof body !== 'object') return false;
  const record = body as Record<string, unknown>;
  if (record.error !== 'workspace_locked') return false;
  const lock = record.lock as Record<string, unknown> | undefined;
  return !!lock && typeof lock.session_id === 'string';
}

const octoallyResearchSession = createResearchSessionSkill();

export default octoallyResearchSession;
