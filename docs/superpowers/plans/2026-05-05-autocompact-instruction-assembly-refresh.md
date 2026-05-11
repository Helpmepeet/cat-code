# Autocompact Instruction Assembly Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure successful auto-compaction actually reduces the next model request by rebuilding provider instruction assembly after the query loop replaces `messagesForQuery` with post-compact messages.

**Architecture:** Keep the fix in `src/query.ts`, where message-flow ownership already lives. Add a focused dependency-injected regression test that forces `autocompact` to return a compacted message set, then asserts both the generic model `messages` payload and OpenAI/Codex `_openaiInstructionAssembly.inputMessages` are built from the post-compact messages. Build the provider instruction assembly at the latest safe point before each model attempt so compaction and fallback-time message mutations cannot leave stale snapshots.

**Tech Stack:** TypeScript, Bun test runner, Cat Code query dependency injection, existing provider-native instruction assembly.

---

## Verified Root Cause

- `src/query.ts:491-497` currently builds `instructionAssembly` before auto-compaction runs.
- `src/query.ts:499-513` runs `deps.autocompact(...)`.
- `src/query.ts:575-583` replaces `messagesForQuery` with `buildPostCompactMessages(compactionResult)` after successful compaction.
- `src/query.ts:700-703` still passes `instructionAssembly.messages` and `instructionAssembly.openAIInstructionAssembly` to `deps.callModel(...)`.
- `src/services/api/instructionAssembly.ts:56-64` stores OpenAI/Codex `inputMessages` as a snapshot of the messages passed during assembly.
- `src/services/api/codex-fetch-adapter.ts:620-636` translates `_openaiInstructionAssembly.inputMessages`, so stale OpenAI assembly means the Codex request still contains the pre-compact context.
- Local config and environment did not show `DISABLE_COMPACT`, `DISABLE_AUTO_COMPACT`, or `autoCompactEnabled: false`.

---

## File Structure

- Create: `src/query.test.ts`
  - Owns a focused regression test for query-loop message assembly after auto-compaction.
  - Uses `QueryDeps` injection so no live model, tool, or compaction calls run.
- Modify: `src/query.ts`
  - Moves provider instruction assembly creation from before auto-compaction to immediately before each model attempt.
  - Preserves the latest assembly for post-sampling hooks.
- Verify: `src/services/api/instructionAssembly.ts`
  - No code changes expected.
  - Serves as the snapshot-building function the query loop must call after message mutations.
- Verify: `src/services/api/codex-fetch-adapter.ts`
  - No code changes expected.
  - Confirms OpenAI/Codex uses `_openaiInstructionAssembly.inputMessages` rather than the Anthropic `messages` field.

---

### Task 1: Add A Regression Test For Post-Compaction Request Assembly

**Files:**
- Create: `src/query.test.ts`
- Read-only reference: `src/query/deps.ts`
- Read-only reference: `src/services/compact/compact.ts`
- Read-only reference: `src/types/message.ts`

- [ ] **Step 1: Write the failing test**

Create `src/query.test.ts` with this complete content:

```ts
import { describe, expect, test } from 'bun:test'
import type { ToolUseContext } from './Tool.js'
import { query } from './query.js'
import type { QueryDeps } from './query/deps.js'
import type { CompactionResult } from './services/compact/compact.js'
import type { AssistantMessage, Message, SystemMessage } from './types/message.js'
import { createUserMessage } from './utils/messages.js'

function createAssistantMessage(text: string, uuid: string): AssistantMessage {
  return {
    type: 'assistant',
    uuid,
    timestamp: '2026-05-05T00:00:00.000Z',
    message: {
      id: uuid,
      model: 'gpt-5.5',
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage: {
        input_tokens: 10,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      stop_reason: 'end_turn',
      stop_sequence: null,
    },
  } as AssistantMessage
}

function createToolUseContext(messages: Message[]): ToolUseContext {
  const appState = {
    toolPermissionContext: {
      mode: 'default',
      additionalWorkingDirectories: new Map<string, string>(),
    },
    mcp: {
      tools: [],
      clients: [],
    },
    tasks: {},
    fastMode: false,
    effortValue: undefined,
    advisorModel: undefined,
  }

  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'gpt-5.5',
      mainLoopProvider: 'openai',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: {
        activeAgents: [],
        allowedAgentTypes: [],
      },
    },
    abortController: new AbortController(),
    readFileState: new Map(),
    getAppState: () => appState,
    setAppState: updater => {
      Object.assign(appState, updater(appState))
    },
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages,
  } as unknown as ToolUseContext
}

describe('query auto-compaction request assembly', () => {
  test('sends post-compact messages to both generic and OpenAI request assembly', async () => {
    const originalUserMessage = createUserMessage({ content: 'pre compact user text' })
    const originalMessages: Message[] = [
      originalUserMessage,
      createAssistantMessage('pre compact assistant text', 'assistant-before-compact'),
    ]

    const compactBoundary: SystemMessage = {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'compact-boundary',
      timestamp: '2026-05-05T00:00:01.000Z',
      compactMetadata: {
        trigger: 'auto',
        preTokens: 240_000,
      },
    }
    const compactSummary = createUserMessage({
      content: 'post compact summary text',
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    })
    const compactionResult: CompactionResult = {
      boundaryMarker: compactBoundary,
      summaryMessages: [compactSummary],
      attachments: [],
      hookResults: [],
      preCompactTokenCount: 240_000,
      truePostCompactTokenCount: 1_000,
    }
    const expectedPostCompactMessages = [compactBoundary, compactSummary]

    let capturedMessages: Message[] | undefined
    let capturedOpenAIInputMessages: Message[] | undefined

    const deps: QueryDeps = {
      uuid: () => 'test-query-chain-id',
      microcompact: async messages => ({ messages }),
      autocompact: async () => ({
        wasCompacted: true,
        compactionResult,
        consecutiveFailures: 0,
      }),
      callModel: async function* ({ messages, openAIInstructionAssembly }) {
        capturedMessages = messages
        capturedOpenAIInputMessages = openAIInstructionAssembly?.inputMessages
        yield createAssistantMessage('final assistant response', 'assistant-after-compact')
      },
    }

    const toolUseContext = createToolUseContext(originalMessages)

    for await (const _message of query({
      messages: originalMessages,
      systemPrompt: ['system prompt'],
      userContext: {},
      systemContext: {},
      canUseTool: async () => ({
        behavior: 'allow',
        decisionReason: {
          type: 'other',
          reason: 'test allows all tools',
        },
      }),
      toolUseContext,
      querySource: 'repl_main_thread',
      deps,
    })) {
      // Drain the query generator so the fake model call runs.
    }

    expect(capturedMessages).toEqual(expectedPostCompactMessages)
    expect(capturedOpenAIInputMessages).toEqual(expectedPostCompactMessages)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails on current code**

Run:

```bash
bun test src/query.test.ts
```

Expected before implementation: the test fails because `capturedMessages` and `capturedOpenAIInputMessages` contain the original pre-compact messages instead of `[compactBoundary, compactSummary]`.

- [ ] **Step 3: Commit the failing regression test**

Run:

```bash
git add src/query.test.ts
git commit -m "test: cover autocompact request assembly refresh"
```

Expected: one new commit containing only `src/query.test.ts`.

---

### Task 2: Rebuild Provider Instruction Assembly After Message Mutations

**Files:**
- Modify: `src/query.ts`
- Test: `src/query.test.ts`

- [ ] **Step 1: Remove the stale pre-autocompact assembly build**

In `src/query.ts`, remove this block from the section after `currentProvider` is assigned and before `queryCheckpoint('query_autocompact_start')`:

```ts
    const instructionAssembly = buildProviderInstructionAssembly({
      provider: currentProvider,
      messages: messagesForQuery,
      systemPrompt,
      userContext,
      systemContext,
    })
```

- [ ] **Step 2: Add a latest-assembly variable before the API loop**

In `src/query.ts`, after the blocking-limit check and before `let attemptWithFallback = true`, add this variable:

```ts
    let instructionAssembly:
      | ReturnType<typeof buildProviderInstructionAssembly>
      | undefined

    let attemptWithFallback = true
```

The nearby code should keep the existing `let attemptWithFallback = true` line only once.

- [ ] **Step 3: Rebuild assembly immediately before each model attempt**

In `src/query.ts`, inside the `while (attemptWithFallback)` loop, immediately before `let streamingFallbackOccured = false`, add this block:

```ts
          instructionAssembly = buildProviderInstructionAssembly({
            provider: currentProvider,
            messages: messagesForQuery,
            systemPrompt,
            userContext,
            systemContext,
          })

          let streamingFallbackOccured = false
```

The beginning of the model-attempt block should become:

```ts
        try {
          instructionAssembly = buildProviderInstructionAssembly({
            provider: currentProvider,
            messages: messagesForQuery,
            systemPrompt,
            userContext,
            systemContext,
          })

          let streamingFallbackOccured = false
          queryCheckpoint('query_api_streaming_start')
          for await (const message of deps.callModel({
            messages: instructionAssembly.messages,
            systemPrompt: instructionAssembly.systemPrompt,
            openAIInstructionAssembly: instructionAssembly.openAIInstructionAssembly,
```

This placement ensures successful auto-compaction, fallback model changes, and fallback-time `stripSignatureBlocks(messagesForQuery)` all flow into the next request payload.

- [ ] **Step 4: Guard post-sampling hook assembly access**

In `src/query.ts`, update the post-sampling hook block from:

```ts
    if (assistantMessages.length > 0) {
      void executePostSamplingHooks(
        [...messagesForQuery, ...assistantMessages],
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        querySource,
        instructionAssembly.openAIInstructionAssembly,
      )
    }
```

to:

```ts
    if (assistantMessages.length > 0 && instructionAssembly) {
      void executePostSamplingHooks(
        [...messagesForQuery, ...assistantMessages],
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        querySource,
        instructionAssembly.openAIInstructionAssembly,
      )
    }
```

The guard is only for TypeScript narrowing. In normal execution, `assistantMessages.length > 0` implies the model-attempt block assigned `instructionAssembly`.

- [ ] **Step 5: Run the focused test**

Run:

```bash
bun test src/query.test.ts
```

Expected after implementation: PASS.

- [ ] **Step 6: Commit the implementation**

Run:

```bash
git add src/query.ts
git commit -m "fix: refresh request assembly after autocompact"
```

Expected: one new commit containing only `src/query.ts`.

---

### Task 3: Verify Provider Assembly And Stale References

**Files:**
- Verify: `src/query.ts`
- Verify: `src/services/api/instructionAssembly.ts`
- Verify: `src/services/api/claude.ts`
- Verify: `src/services/api/codex-fetch-adapter.ts`
- Verify: `src/utils/providerPromptRegressions.test.ts`

- [ ] **Step 1: Search for stale query-loop instruction assembly assumptions**

Run:

```bash
rg "instructionAssembly|openAIInstructionAssembly|buildProviderInstructionAssembly" src/query.ts src/services/api src/utils src/query
```

Expected:

- `src/query.ts` builds `instructionAssembly` inside the model-attempt loop, after auto-compaction can mutate `messagesForQuery`.
- `src/query.ts` passes `instructionAssembly.messages`, `instructionAssembly.systemPrompt`, and `instructionAssembly.openAIInstructionAssembly` to `deps.callModel(...)`.
- `src/services/api/claude.ts` still serializes `openAIInstructionAssembly.inputMessages` into `_openaiInstructionAssembly.inputMessages`.
- `src/services/api/codex-fetch-adapter.ts` still translates `_openaiInstructionAssembly.inputMessages` for Codex.
- No additional pre-autocompact assembly build remains in `src/query.ts`.

- [ ] **Step 2: Run provider prompt regression tests**

Run:

```bash
bun test src/utils/providerPromptRegressions.test.ts
```

Expected: PASS. These tests protect existing provider-native OpenAI instruction assembly behavior.

- [ ] **Step 3: Run the new focused query regression test again**

Run:

```bash
bun test src/query.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run the dev-full build verification**

Run:

```bash
bun run build:dev:full
```

Expected: lint, dev-full build, and `./cli-dev --version` all pass.

- [ ] **Step 5: Commit verification-only adjustments if needed**

If Task 3 uncovers a TypeScript import issue or lint-only adjustment, run:

```bash
git add src/query.ts src/query.test.ts
git commit -m "chore: finish autocompact assembly verification"
```

Expected: create this commit only if files changed during Task 3. If no files changed, skip this step.

---

## Self-Review

- Spec coverage: The plan covers the reported failure mode by testing and fixing stale request assembly after successful auto-compaction. It also verifies the OpenAI/Codex-specific path because GPT sessions use `_openaiInstructionAssembly.inputMessages`.
- Placeholder scan: The plan contains exact file paths, code blocks, commands, and expected outcomes. There are no open implementation placeholders.
- Type consistency: The test uses existing `QueryDeps`, `ToolUseContext`, `CompactionResult`, and `Message` types. The implementation uses `ReturnType<typeof buildProviderInstructionAssembly>` so later call sites stay type-aligned with the existing assembly function.
