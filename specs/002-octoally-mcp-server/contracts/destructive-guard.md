# Contract: Destructive-Prompt Guard

**Feature**: 002-octoally-mcp-server

## Problem

Feature 001 FR-014 requires that destructive prompts are never auto-confirmed.
Today that requirement is met by the skill client only.

- The keyword pattern lives at `openclaw-skills/octoally_research_session.ts:209`.
- The refusal lives at lines 394 to 399 of the same file, gated on `allowDestructiveConfirmation`.
- A search of `server/src` for destructive handling finds only test fixtures.

The server accepts any execute payload.
A direct `POST /api/sessions/:id/execute` with the body `y` answers a delete confirmation with no check at all.

The MCP server's caller is an autonomous model that composes its own tool arguments.
A client-side check is an affordance for a cooperative client, not a control against an arbitrary one.
FR-014 is therefore not currently satisfied for the callers this feature introduces.

## Rule

The OctoAlly API rejects follow-up input that answers a prompt classified destructive, unless the request carries explicit destructive confirmation.

Enforcement is in the execute route, in the API layer, on the server.
The tool schema's `confirm_destructive` field is a client affordance and is not the control.

## Classification

Moves to `server/src/services/prompt-destructiveness.ts`.

Input: the prompt text and the detected choices from the existing session state path.

Output:

```ts
interface PromptClassification {
  prompt_type: 'choice' | 'confirmation' | 'text' | null;
  choices: string[] | null;
  destructive_choices: string[];
  is_destructive: boolean;
}
```

The pattern is the one already in use, moved rather than rewritten:

```
delete, remove, destroy, drop, wipe, overwrite, discard, terminate,
kill, reset, revert, erase, purge, truncate, force push, rm
```

`is_destructive` is true when the prompt text matches, or when any detected choice matches.

An input counts as answering the prompt affirmatively when it matches the existing affirmative pattern:
`y`, `yes`, `1`, `ok`, `okay`, `confirm`, `confirmed`, `approve`, `approved`, `proceed`, `continue`, `do it`.
Selecting a choice that itself matches the destructive pattern also counts.

## Decision table

| Prompt classified destructive | Input answers it affirmatively | `confirm_destructive` | Result |
|---|---|---|---|
| no | any | any | delivered |
| yes | no | any | delivered |
| yes | yes | absent or false | **rejected**, 409, state unchanged |
| yes | yes | true | delivered |

## Rejection response

HTTP 409 with:

```json
{
  "error": "destructive_confirmation_required",
  "message": "Operator approval is required to confirm a destructive prompt.",
  "prompt": {
    "prompt_type": "confirmation",
    "choices": ["Yes, delete", "Cancel"],
    "destructive_choices": ["Yes, delete"],
    "is_destructive": true
  }
}
```

The session state is unchanged.
Nothing is delivered to the process.

## Client behaviour after the move

The shared client keeps its own classification for display and early feedback, so a harness can see the assessment before it acts.
That copy becomes advisory.
The server's answer is authoritative, and the client no longer claims to be the enforcement point.

Duplicating the pattern across two modules is a known cost.
The alternative, having the client import from the server package, would couple a process that runs inside a harness to server internals.
The pattern is small, both copies are covered by tests, and the enforcement copy is the one that matters.

## Required tests

1. Server-side rejection, called through the HTTP API directly with no MCP server and no client involved, so the tool schema cannot be credited with the protection.
2. Acceptance when `confirm_destructive` is true.
3. Delivery of an affirmative answer to a non-destructive prompt.
4. Delivery of a non-affirmative answer to a destructive prompt, for example choosing Cancel.
5. Classification unit tests on both prompt text and choices.

Test 1 is the one that matters.
Without it, this contract restates a claim feature 001 already made and did not enforce.
