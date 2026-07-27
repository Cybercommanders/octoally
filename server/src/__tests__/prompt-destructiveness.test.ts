import { describe, test, expect } from 'bun:test';
import {
  classifyPrompt,
  answersPromptAffirmatively,
} from '../services/prompt-destructiveness.js';

describe('classifyPrompt', () => {
  test('returns null when the session is not prompting', () => {
    expect(classifyPrompt(null, null, 'just some output')).toBeNull();
  });

  test('flags a destructive verb in the prompt text', () => {
    const result = classifyPrompt('confirmation', null, 'Delete the build directory?');
    expect(result?.is_destructive).toBe(true);
    expect(result?.prompt_type).toBe('confirmation');
  });

  test('flags a destructive choice even when the prompt text is neutral', () => {
    const result = classifyPrompt('choice', ['Yes, remove it', 'Cancel'], 'How do you want to proceed?');
    expect(result?.is_destructive).toBe(true);
    expect(result?.destructive_choices).toEqual(['Yes, remove it']);
  });

  test('leaves an ordinary prompt unflagged', () => {
    const result = classifyPrompt('choice', ['Continue', 'Go back'], 'Which file should I read?');
    expect(result?.is_destructive).toBe(false);
    expect(result?.destructive_choices).toEqual([]);
  });

  test('matches "rm" as a word but not inside another word', () => {
    expect(classifyPrompt('confirmation', null, 'run rm on the temp dir?')?.is_destructive).toBe(true);
    expect(classifyPrompt('confirmation', null, 'confirm the form submission?')?.is_destructive).toBe(false);
  });

  test('matches "force push"', () => {
    expect(classifyPrompt('confirmation', null, 'force push to main?')?.is_destructive).toBe(true);
  });
});

describe('answersPromptAffirmatively', () => {
  const destructiveConfirmation = classifyPrompt('confirmation', null, 'Delete everything?')!;
  const destructiveChoice = classifyPrompt('choice', ['Yes, delete it', 'Cancel'], 'Pick one')!;

  test('treats yes-style input as affirmative on a confirmation prompt', () => {
    for (const input of ['y', 'yes', 'YES', '1', 'ok', 'confirm', 'proceed', 'do it']) {
      expect(answersPromptAffirmatively(input, destructiveConfirmation)).toBe(true);
    }
  });

  test('treats a refusal as not affirmative', () => {
    for (const input of ['n', 'no', 'cancel', 'abort', '']) {
      expect(answersPromptAffirmatively(input, destructiveConfirmation)).toBe(false);
    }
  });

  test('selecting a destructive choice by exact text is affirmative', () => {
    expect(answersPromptAffirmatively('Yes, delete it', destructiveChoice)).toBe(true);
  });

  test('selecting the safe choice by exact text is not affirmative', () => {
    expect(answersPromptAffirmatively('Cancel', destructiveChoice)).toBe(false);
  });

  test('selecting a destructive choice by 1-based index is affirmative', () => {
    expect(answersPromptAffirmatively('1', destructiveChoice)).toBe(true);
  });

  test('selecting the safe choice by 1-based index is not affirmative', () => {
    expect(answersPromptAffirmatively('2', destructiveChoice)).toBe(false);
  });

  test('an out-of-range index is not treated as affirmative', () => {
    expect(answersPromptAffirmatively('9', destructiveChoice)).toBe(false);
  });

  test('free-text input on a text prompt is not a confirmation', () => {
    const textPrompt = classifyPrompt('text', null, 'Delete which file?')!;
    expect(answersPromptAffirmatively('yes', textPrompt)).toBe(false);
  });
});
