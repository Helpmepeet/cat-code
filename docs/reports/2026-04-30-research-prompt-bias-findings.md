# GPT Prompt Bias Findings

Audit of everything sent to GPT 5.4 and Claude Opus/Sonnet 4.6 at inference time.
Covers the main session prompt, subagent prompts, tool descriptions, and the fork
notification pipeline. No fixes are included — this document records what was found.

Date: 2026-04-13  
Session branch: `phase1`

---

## Context

Cat Code has two prompt style systems that dispatch at runtime based on provider:

- **Claude path** — `src/constants/prompts.ts` + `src/constants/promptStyles/` (narrative
  style, XML structural tags, RLHF-tuned phrasing)
- **GPT path** — `src/constants/promptStyles/gpt.ts` (contract-first, numbered rules,
  explicit output contracts)

Dispatch point: `src/constants/prompts.ts` → `isGPTPromptStyle(requestProvider)` →
`provider === 'openai'`.

Built-in agents (`src/tools/AgentTool/built-in/`) each branch independently on
`resolveRequestProvider(mainLoopModel, mainLoopProvider)`. The fork notification pipeline
(`agentToolUtils.ts` → `taskNotification.ts`) is provider-unaware.

Reference docs consulted during audit:
- `https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices`
- `https://developers.openai.com/api/docs/guides/prompt-guidance`

---

## What was fixed in this session (do not re-investigate)

### Fix A — `isNewInstructionEnabled` lock removed

All six anti-sycophancy instructions (Finding 1) were unlocked and made unconditional.
`isNewInstructionEnabled()` now returns dead code — the function still exists in
`src/constants/newInstruction.ts` but has no callers. The "new instruction" text fires
on every session for both Claude and GPT paths.

Commits: changes are uncommitted as of session end, on branch `phase1`.

### Fix B — `delete-account` dangling import removed

The broken import and registry entry (Finding 2) were removed from `src/commands.ts`.
`bun run build:dev:full` succeeds. The `/delete-account` feature still does not exist —
only the broken references were cleaned up.

---

## What was verified as correctly implemented (do not re-investigate)

These surfaces were examined and found to be well-handled. The next session should not
spend time on them.

- **System section structure**: Claude uses bullet narrative; GPT uses numbered rules.
  Correct per each model's training characteristics.
- **Explore agent** (`exploreAgent.ts`): Claude uses `=== CRITICAL ===` banner; GPT uses
  numbered `READ-ONLY RULES:`. Correct split.
- **Verification agent opening framing**: Claude uses narrative failure-pattern framing
  ("you have two documented failure patterns"); GPT uses `EXECUTION CONTRACT:`. Correct —
  matches Claude's response to motivational context vs GPT's response to explicit
  contracts.
- **Plan agent** (`planAgent.ts`): Claude uses `## Your Process` narrative; GPT uses
  `PHASED EXECUTION CONTRACT:`. Correct split.
- **AgentTool "when not to use" section** (`prompt.ts`): correctly branches on
  `isGPTPromptStyle`.
- **`run_in_background` emphasis** in AgentTool: correctly emphasized more strongly in
  GPT path with explicit `IMPORTANT:` callout.
- **Fork semantics guidance**: Claude path gets narrative; GPT path gets contract rules.
  Correct split.
- **Identity prefix** (`system.ts`): correctly dispatches `"powered by Claude"` vs
  `"running on OpenAI's Codex/GPT models"` per provider for all agent types.
- **`<system-reminder>` instruction**: Claude path says "treat as metadata" (correct for
  RLHF training); GPT path says "parse and apply them" (explicit directive, correct for
  GPT). The asymmetry is intentional.
- **`serializeStructuredTeammateMessage`** in `orchestration.ts`: correctly dispatches
  between Claude XML and OpenAI plain JSON based on provider parameter.

---

---

## Finding 1 — Anti-sycophancy cluster silently disabled by unknown env var

**Severity:** Critical  
**Files:** `src/constants/prompts.ts`, `src/constants/promptStyles/gpt.ts`,
`src/tools/AgentTool/built-in/generalPurposeAgent.ts`, `src/constants/outputStyles.ts`

Six behavioral instructions were gated behind `CLAUDE_CODE_NEW_INSTRUCTION=1`. The env
var was unknown and unset, meaning neither the Claude nor GPT prompt path received these
instructions in any session.

The locked instructions:

- **Intro**: "prioritize correctness over appearing successful"
- **Disagreement**: "do not agree just to preserve momentum"
- **Failure handling**: "do not force a pass; do not hardcode outputs to pass tests; if
  contradictory, say so directly"
- **Outcome reporting**: "never imply success you did not verify"
- **Tone**: "without flattery, unnecessary reassurance, or performative agreement"
- **Agent completion rule**: "without forcing a pass; if contradictory or impossible, say
  so plainly"

These were the highest-value behavioral instructions in the entire prompt. Without the
flag, each location fell back to softer, more conservative text — the model was more
likely to perform agreement, force a passing result, and hedge outcomes.

**Origin:** Commit `593729b`. Instructions previously gated behind
`process.env.USER_TYPE === 'ant'` (Anthropic-internal only) were migrated to be
available externally, but instead of being made unconditional they were re-gated behind
the new env var.

The lock applied identically to both Claude and GPT prompt paths, and to the
general-purpose subagent prompt.

---

## Finding 2 — Broken build: `delete-account` command registered but never implemented

**Severity:** Critical  
**Files:** `src/commands.ts:6`, `src/commands.ts:312`

A previous session added:
- `import deleteAccount from './commands/delete-account/index.js'`
- `deleteAccount` entry in the command registry array

The implementation file `src/commands/delete-account/index.js` was never created.
`bun run build:dev:full` failed with a module resolution error on this import. The
`/delete-account` command was never functional.

---

## Finding 3 — Fork result serialization uses Claude XML wrapper for all providers

**Severity:** High  
**Files:** `src/tools/AgentTool/agentToolUtils.ts:279-282`,
`src/contracts/orchestration.ts:212-222`

`formatForkWorkerResultForNotification` always calls `serializeForkWorkerResultForClaude`,
which wraps the fork result JSON in an XML envelope with entity-escaped content:

```
<fork-worker-result>
{"version":1,"kind":"fork_worker_result","result":"...","key_files":[...],...}
</fork-worker-result>
```

The full notification message GPT 5.4 receives as a user-role message after a fork
completes:

```
Task notification
Status: completed
Summary: Agent "ship-audit" completed
Result:
<fork-worker-result>
{entity-escaped JSON}
</fork-worker-result>
```

`serializeForkWorkerResultForOpenAI` exists in the same file and returns plain JSON with
no XML wrapper. It is never called anywhere in the codebase.
`formatForkWorkerResultForNotification` has no provider parameter, so it cannot dispatch
to the correct variant.

Claude is trained to extract structured content from XML wrappers and handles this
cleanly. GPT 5.4 treats it as raw text — the entity escaping and XML structure obscure
the result content the model needs to reason from. The UI (`parseTaskNotificationDetails`)
correctly parses the notification for display purposes. The bug only affects what the
model itself reads when deciding how to act on fork results.

---

## Finding 4 — `<thinking>` blocks in AgentTool fork examples sent to GPT 5.4

**Severity:** Medium  
**File:** `src/tools/AgentTool/prompt.ts:123, 147`

The fork examples in the AgentTool tool description show:

```
assistant: <thinking>Forking this — it's a survey question...</thinking>
```

`<thinking>` is Claude's extended thinking API format. Claude is trained to understand it
as internal reasoning that does not appear in normal output. GPT 5.4 has no equivalent
concept. It reads these as examples of "what the assistant does" and may emit `<thinking>`
tags verbatim in responses.

The rest of the AgentTool prompt is correctly split by provider — section headers,
`run_in_background` emphasis, and "when not to use" guidance all branch on
`isGPTPromptStyle`. The examples block was not split.

---

## Finding 5 — XML structural tags in AgentTool examples not split by provider

**Severity:** Low-medium  
**File:** `src/tools/AgentTool/prompt.ts:121-191`

The examples use `<example>`, `<commentary>`, and `<code>` XML tags throughout,
regardless of provider. Claude is trained to treat these as semantic structural separators.
GPT 5.4 treats them as HTML-like markup and may imitate them in agent prompts it writes
or in output it produces.

---

## Finding 6 — Claude behavioral idiom injected into all GPT subagent prompts

**Severity:** Low  
**File:** `src/constants/prompts.ts:777`

`enhanceSystemPromptWithEnvDetails` appends this to every subagent's system prompt
regardless of provider:

```
- Do not use a colon before tool calls. Text like "Let me read the file:" followed
  by a read tool call should just be "Let me read the file." with a period.
```

This suppresses a Claude-specific RLHF quirk — Claude has a trained tendency to write
colons before tool use. GPT 5.4 does not have this pattern. The instruction is
meaningless to GPT 5.4 and may cause it to overthink phrasing that was never a problem.

The function has no provider parameter and cannot dispatch provider-specific notes.

---

## Finding 7 — WebSearch tool gives GPT 5.4 the wrong knowledge cutoff anchor

**Severity:** Low-medium  
**File:** `src/tools/WebSearchTool/prompt.ts:8, 11`

Tool description sent to GPT 5.4:

```
- Allows Claude to search the web and use the results to inform responses
- Use this tool for accessing information beyond Claude's knowledge cutoff
```

GPT 5.4's knowledge cutoff differs from Claude's. "Beyond Claude's knowledge cutoff"
gives GPT 5.4 the wrong anchor for when to invoke the tool, affecting its reasoning about
whether a web search is needed for a given query.

---

## Finding 8 — `CLAUDE.md` hardcoded in verification agent baseline steps

**Severity:** Low  
**File:** `src/tools/AgentTool/built-in/verificationAgent.ts:46, 130, 164`

Both the Claude and GPT verifier system prompts include as a required baseline step:

> "Read the project's CLAUDE.md / README for build/test commands and conventions."

And in the FAIL gate reasoning section:

> "does CLAUDE.md / comments / commit message explain this as deliberate?"

On any project that is not Cat Code, `CLAUDE.md` does not exist. The verifier wastes a
tool call on every run attempting to read it before falling back to README.

The GPT actions section in `gpt.ts:166` already handles this better with
`"CLAUDE.md or CAT_CODE.md files"`. The verifier agent was not updated to match.

---

## Finding 9 — "Claude session" branding in tool descriptions sent to GPT 5.4

**Severity:** Low  
**Files:** `src/tools/ScheduleCronTool/prompt.ts:71, 78, 81`,
`src/tools/SendMessageTool/prompt.ts:7`

Tool descriptions received by GPT 5.4:

- `"Schedule a prompt to run at a future time within this Claude session"`
- `"the job lives only in this Claude session — nothing is written to disk, and the job
  is gone when Claude exits"`
- `"Local Claude session's socket"`

Incorrect branding. Does not affect behavior.

---

## Summary

| # | Severity | File(s) | Problem | Status |
|---|---|---|---|---|
| 1 | Critical | `prompts.ts`, `gpt.ts`, `generalPurposeAgent.ts`, `outputStyles.ts` | Anti-sycophancy cluster disabled by unknown env var | Fixed this session |
| 2 | Critical | `src/commands.ts:6,312` | Registered command with no implementation; breaks build | Fixed this session (import removed; feature not implemented) |
| 3 | High | `agentToolUtils.ts:281`, `orchestration.ts:212-222` | Fork results always Claude XML-wrapped; OpenAI variant never called | Open |
| 4 | Medium | `AgentTool/prompt.ts:123,147` | `<thinking>` in fork examples; GPT 5.4 may emit visible thinking tags | Open |
| 5 | Low-medium | `AgentTool/prompt.ts:121-191` | `<example>/<commentary>/<code>` XML tags in examples not split by provider | Open |
| 6 | Low | `prompts.ts:777` | Claude "colon before tool calls" idiom injected into all GPT subagents | Open |
| 7 | Low-medium | `WebSearchTool/prompt.ts:11` | Wrong knowledge cutoff anchor for GPT 5.4 tool invocation decisions | Open |
| 8 | Low | `verificationAgent.ts:46,130,164` | `CLAUDE.md` hardcoded in required baseline; wasted tool call on non-Cat Code projects | Open |
| 9 | Low | `ScheduleCronTool/prompt.ts:71,78,81`, `SendMessageTool/prompt.ts:7` | "Claude session" branding in tool descriptions | Open |

---

## Audit methodology — how to extend this

All prompt surfaces that reach the model:

1. **Main session system prompt** — assembled in `src/constants/prompts.ts:getSystemPrompt()`.
   Static sections (cacheable) come first; dynamic sections are registry-managed after
   `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`. GPT path swaps each section via `gpt ? getGPT*() : getSimple*()`.

2. **Subagent system prompts** — each built-in agent in `src/tools/AgentTool/built-in/`
   implements `getSystemPrompt({ toolUseContext })` and branches on
   `resolveRequestProvider(mainLoopModel, mainLoopProvider)`. Custom/plugin agents do not
   have this branching.

3. **Subagent enhancement** — `enhanceSystemPromptWithEnvDetails()` in `prompts.ts:768`
   appends notes + env info to every subagent prompt after the base system prompt. Has no
   provider parameter.

4. **Tool descriptions** — each tool's `prompt.ts` or `constants.ts` defines the
   description the model sees in the tool list. Only `BashTool` was observed checking
   `isGPTPromptStyle`. All others are provider-agnostic strings.

5. **AgentTool tool description** — `src/tools/AgentTool/prompt.ts:getPrompt()` is
   provider-aware for structure but the examples block is shared.

6. **Fork notification pipeline** — fork result flows:
   `AgentTool.tsx` → `formatForkWorkerResultForNotification` → `agentToolUtils.ts:281`
   → `serializeForkWorkerResultForClaude` → `formatTaskNotificationText` →
   `enqueuePendingNotification` → injected as user-role message.
   The provider-correct path (`serializeForkWorkerResultForOpenAI`) is never reached.

7. **Orchestration contracts** — `src/contracts/orchestration.ts` has both Claude and
   OpenAI serialization variants for teammate messages (correctly dispatched) and fork
   worker results (not dispatched for notifications — see Finding 3).

To search for new Claude-specific constructs leaking into GPT paths:
```
grep -rn "Claude\|<thinking>\|IMPORTANT:" src/tools/*/prompt.ts src/tools/*/constants.ts
grep -rn "isGPTPromptStyle\|provider.*openai" src/constants/ src/tools/AgentTool/
```
