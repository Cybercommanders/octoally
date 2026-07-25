/**
 * Server-side classification of interactive prompts.
 *
 * This logic previously existed only in the integration client. A client-side
 * check is an affordance for a cooperative caller, not a control: the execute
 * API accepted any payload, so a direct HTTP call could answer a delete
 * confirmation with no check at all. Feature 001 FR-014 requires that
 * destructive prompts are never auto-confirmed, and enforcement has to live
 * where the request is handled.
 *
 * The integration client keeps its own copy for display and early feedback.
 * That copy is advisory; this one is authoritative.
 */

export type PromptType = 'choice' | 'confirmation' | 'text' | null;

export interface PromptClassification {
  prompt_type: Exclude<PromptType, null>;
  choices: string[] | null;
  destructive_choices: string[];
  is_destructive: boolean;
}

const DESTRUCTIVE_PROMPT_PATTERN =
  /\b(delete|remove|destroy|drop|wipe|overwrite|discard|terminate|kill|reset|revert|erase|purge|truncate|force push|rm\b)\b/i;

const AFFIRMATIVE_CONFIRMATION_PATTERN =
  /^(?:y|yes|1|ok|okay|confirm|confirmed|approve|approved|proceed|continue|do it)$/i;

/**
 * Classify the prompt a session is currently waiting on.
 *
 * Returns null when the session is not prompting, which callers should treat
 * as "nothing to guard".
 */
export function classifyPrompt(
  promptType: PromptType,
  choices: string[] | null,
  output: string,
): PromptClassification | null {
  if (!promptType) return null;

  const resolvedChoices = Array.isArray(choices) ? choices : [];
  const destructiveChoices = resolvedChoices.filter((choice) =>
    DESTRUCTIVE_PROMPT_PATTERN.test(choice),
  );
  const promptText = `${output ?? ''}\n${resolvedChoices.join('\n')}`.trim();

  return {
    prompt_type: promptType,
    choices: choices === null ? null : resolvedChoices,
    destructive_choices: destructiveChoices,
    is_destructive: destructiveChoices.length > 0 || DESTRUCTIVE_PROMPT_PATTERN.test(promptText),
  };
}

/**
 * Does this input answer the prompt in the affirmative?
 *
 * Only affirmative answers are gated. Declining a destructive prompt, or
 * choosing its safe option, is always allowed through: the guard exists to
 * stop unattended confirmation, not to freeze the session.
 */
export function answersPromptAffirmatively(
  input: string,
  prompt: PromptClassification,
): boolean {
  const normalized = input.trim();
  if (!normalized) return false;

  if (prompt.prompt_type === 'confirmation') {
    return AFFIRMATIVE_CONFIRMATION_PATTERN.test(normalized);
  }

  if (prompt.prompt_type !== 'choice') return false;

  if (AFFIRMATIVE_CONFIRMATION_PATTERN.test(normalized)) return true;

  const choices = prompt.choices ?? [];

  if (/^\d+$/.test(normalized)) {
    const index = Number(normalized) - 1;
    if (index < 0 || index >= choices.length) return false;
    return DESTRUCTIVE_PROMPT_PATTERN.test(choices[index]);
  }

  const directChoice = choices.find(
    (choice) => choice.trim().toLowerCase() === normalized.toLowerCase(),
  );
  return directChoice !== undefined && DESTRUCTIVE_PROMPT_PATTERN.test(directChoice);
}

/**
 * The full decision: should this input be refused for lacking operator
 * approval? See specs/002-octoally-mcp-server/contracts/destructive-guard.md
 * for the decision table this implements.
 */
export function requiresDestructiveConfirmation(
  input: string,
  prompt: PromptClassification | null,
  confirmDestructive: boolean,
): boolean {
  if (!prompt?.is_destructive) return false;
  if (confirmDestructive) return false;
  return answersPromptAffirmatively(input, prompt);
}
