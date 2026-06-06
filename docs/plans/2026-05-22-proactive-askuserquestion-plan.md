# Proactive AskUserQuestion Prompt Guidance — Implementation Plan

Date: 2026-05-22
Status: Proposed (awaiting build verification)

## Goal

Make Cat Code reach for the `AskUserQuestion` multiple-choice picker proactively
— to clarify ambiguity and offer decision points — the way the current upstream
Claude Code CLI does, instead of almost always asking in plain prose.

## Background / Root cause (verified)

The "feels different from upstream" sensation was traced to prompt framing, not a
missing feature. Confirmed against source and authoritative external sources:

- The `AskUserQuestion` **tool**, its full interactive **UI** renderer
  (`src/components/permissions/AskUserQuestionPermissionRequest/`), and its
  **wiring** (`PermissionRequest.tsx:69`) are all present and correct in Cat Code.
- Cat Code's **tool description** (`src/tools/AskUserQuestionTool/prompt.ts`) is
  byte-for-byte equivalent to upstream's shipped description (verified against the
  Piebald-AI/claude-code-system-prompts extraction and the official Agent SDK
  docs). It already lists all four use cases: gather preferences, clarify
  ambiguity, get decisions, offer choices.
- The KAIROS-channel gate in `AskUserQuestionTool.isEnabled()` only disables the
  tool when launched with `--channels`; it is NOT the cause for plain TUI sessions.

The actual divergence: Cat Code's **session-specific system-prompt** lines layer a
*restrictive overlay* on top of the (correct) tool description, framing the tool as
a last-resort escalation. This is what suppresses proactive use.

## Exact restrictive lines today

Default prompt (`src/constants/prompts.ts`):
- L259 (failure-handling item): "...Escalate to the user with
  ${ASK_USER_QUESTION_TOOL_NAME} **only when you're genuinely stuck after
  investigation, not as a first response to friction**."
- L383 (Agent-mode session guidance) and L443 (normal session guidance), both:
  "If you do not understand why the user has denied a tool call, use the
  ${ASK_USER_QUESTION_TOOL_NAME} to ask them." — narrow, denial-only framing; no
  proactive guidance.

GPT/Codex prompt (`src/constants/promptStyles/gpt.ts`):
- L155 (failure-handling RULE): "...Escalate to the user with
  ${ASK_USER_QUESTION_TOOL_NAME} **only when genuinely stuck after
  investigation**."
- L341 (Agent-mode) and L419 (normal): "DENIED TOOL: If you do not understand why
  the user denied a tool call, use ${ASK_USER_QUESTION_TOOL_NAME} to ask." —
  denial-only framing.

## Change

Surgical, additive-then-soften. Two files, four session-guidance insertion points,
plus softening the two failure-handling lines. Do NOT touch the tool description
(`prompt.ts`) — it is already correct.

### 1. `src/constants/prompts.ts`

a. **L259** — soften the restrictive clause. Keep the failure-handling intent
   (don't ask as a knee-jerk reaction to *friction during execution*), but stop it
   from reading as a blanket "only when stuck" rule that bleeds into requirement
   clarification. Proposed: change "...only when you're genuinely stuck after
   investigation, not as a first response to friction." to scope it to *execution
   failure* specifically, e.g. "...When an approach keeps failing, escalate with
   ${ASK_USER_QUESTION_TOOL_NAME} rather than looping — but don't use repeated
   failure as the only trigger for asking."

b. **L383 and L443** — add a new `hasAskUserQuestionTool`-gated item alongside the
   existing denial line (keep the denial line). New item wording (default style):
   > `When a request is ambiguous, when you're choosing between approaches that
   > would change the outcome, or when a decision is really the user's to make,
   > prefer ${ASK_USER_QUESTION_TOOL_NAME} to offer concrete options instead of
   > asking in prose. Reserve it for genuine decision points — skip it for trivial
   > confirmations or anything you can resolve by reading the code.`

### 2. `src/constants/promptStyles/gpt.ts`

a. **L155** — same softening as 1a, in the terser "RULE —" voice.

b. **L341 and L419** — add a parallel item next to the "DENIED TOOL" line, in the
   file's imperative `LABEL:` style:
   > `CLARIFY: When a request is ambiguous or you're choosing between approaches
   > with materially different outcomes, prefer ${ASK_USER_QUESTION_TOOL_NAME} to
   > offer concrete options over prose. Genuine decision points only — not trivial
   > confirmations.`

## Scope decisions (defaults; adjust if desired)

- **Both prompt styles** (Anthropic default + GPT/Codex) — for consistent behavior
  across provider routes.
- **Both session-guidance variants** (Agent mode + normal) in each file, so the
  behavior doesn't differ by mode.
- **Keep** the existing denial-only line; the new line is additive.
- **Keep** the tool description untouched (already matches upstream).

## Out of scope

- No tool/UI/logic changes. No change to `AskUserQuestionTool.tsx`, the renderer,
  or the permission handler.
- No change to the KAIROS-channel gate (it is correct).
- Not porting any other upstream feature (Agent View, /code-review, etc. tracked
  separately).

## Verification

- `bun run build:dev:full` (per CLAUDE.md) — confirms compile + lint pass.
- Behavioral confirmation is **emergent and cannot be asserted by me**: whether the
  model now reaches for the picker on ambiguous requests is observed, not proven by
  the build. The user confirms by running a dev build and watching for the dialog
  on a genuinely ambiguous prompt. This will be stated honestly, not claimed as
  "done = working".

## Risk

Low. Additive prompt text plus a softened clause; no fork-divergence conflict.
Worst case: the model asks slightly too often, tunable by softening the new
wording. Fully reversible (prompt-only).
