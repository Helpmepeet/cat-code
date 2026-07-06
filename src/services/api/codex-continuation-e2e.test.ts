/**
 * End-to-end regression tests for the Codex websocket continuation pipeline.
 *
 * Bug report: docs/codex/2026-04-30-bug-websocket-continuation-prefix-instability-and-context-bloat.md
 *
 * These tests exercise the full chain:
 *   normalizeMessagesForAPI() → translateMessages() → reconcileCanonicalDelta()
 *
 * The existing WS transport tests provide pre-constructed Codex items directly.
 * These tests start from transcript-style Message[] objects and verify that the
 * canonical reconciliation survives normalizeMessagesForAPI's mutation passes.
 */

import { describe, expect, test } from 'bun:test'
import { canonicalizeCodexItem, translateToCodexBody } from './codex-fetch-adapter.js'
import { reconcileCanonicalDelta } from './codex-websocket-transport.js'
import { normalizeMessagesForAPI } from '../../utils/messages.js'

// ── Minimal message factories ─────────────────────────────────────────────────

function userMsg(text: string, opts?: { id?: string; isMeta?: true }) {
  return {
    type: 'user' as const,
    uuid: opts?.id ?? crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    isMeta: opts?.isMeta,
    message: {
      role: 'user' as const,
      content: text,
    },
  }
}

function assistantMsg(text: string, msgId?: string) {
  return {
    type: 'assistant' as const,
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      id: msgId ?? `msg_${crypto.randomUUID().slice(0, 8)}`,
      type: 'message' as const,
      role: 'assistant' as const,
      model: 'gpt-5.3-codex',
      stop_reason: 'end_turn' as const,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: 'text' as const, text }],
    },
  }
}

function toolUseMsg(toolName: string, callId: string, input: Record<string, unknown>) {
  return {
    type: 'assistant' as const,
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      id: `msg_tu_${callId}`,
      type: 'message' as const,
      role: 'assistant' as const,
      model: 'gpt-5.3-codex',
      stop_reason: 'tool_use' as const,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: 'tool_use' as const, id: callId, name: toolName, input }],
    },
  }
}

function toolResultMsg(callId: string, output: string) {
  return {
    type: 'user' as const,
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      role: 'user' as const,
      content: [{ type: 'tool_result' as const, tool_use_id: callId, content: output }],
    },
  }
}

/** Translate a transcript message array to Codex input[] via the real pipeline. */
function transcriptToCodexInput(
  messages: ReturnType<typeof userMsg | typeof assistantMsg | typeof toolUseMsg | typeof toolResultMsg>[],
  instructions = 'You are a helpful assistant.',
): Array<Record<string, unknown>> {
  const normalized = normalizeMessagesForAPI(messages as any)
  const { codexBody } = translateToCodexBody({
    model: 'claude-sonnet-4-6',
    _openaiInstructionAssembly: {
      instructions,
      inputMessages: normalized,
    },
  })
  return Array.isArray(codexBody.input) ? (codexBody.input as Array<Record<string, unknown>>) : []
}

/**
 * Simulate what the WS transport stores after a completed turn.
 *
 * The output items MUST be built by running raw server output items through the
 * REAL canonicalizer (canonicalizeCodexItem) — the same function the transport's
 * normalizeCompletedOutputItem uses — otherwise these tests would only exercise
 * a local reimplementation and pass while testing nothing. `rawOutputItems` are
 * shaped exactly as the server sends them (e.g. output_text parts carry the
 * `logprobs` field the replay path must drop).
 */
function simulateCanonicalState(
  sentInput: Array<Record<string, unknown>>,
  outputText = 'Done.',
  rawOutputItems?: Array<Record<string, unknown>>,
) {
  const raw = rawOutputItems ?? [
    {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      // Server sends logprobs on output_text parts; canonicalizeCodexItem drops it.
      content: [{ type: 'output_text', text: outputText, annotations: [], logprobs: [] }],
    },
  ]
  return {
    sentInput,
    outputItems: raw.map(item => canonicalizeCodexItem(item)),
  }
}

// ── Helpers for checking canonical reconciliation ─────────────────────────────

/**
 * Returns the delta using the REAL transport reconciler (reconcileCanonicalDelta),
 * so this file tests the actual continuation contract rather than a copy of it.
 */
function canonicalDelta(
  freshInput: Array<Record<string, unknown>>,
  sentInput: Array<Record<string, unknown>>,
  outputItems: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> | null {
  return reconcileCanonicalDelta(freshInput, sentInput, outputItems).delta
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('codex continuation e2e: normalization → translation → reconciliation', () => {

  test('plain two-turn conversation stays incremental through the full pipeline', () => {
    const turn1Messages = [userMsg('hello')]
    const turn1Input = transcriptToCodexInput(turn1Messages)
    expect(turn1Input).toHaveLength(1)
    expect(turn1Input[0]).toMatchObject({ role: 'user', content: 'hello' })

    const { sentInput, outputItems } = simulateCanonicalState(turn1Input, 'Hi there!')

    const turn2Messages = [
      userMsg('hello'),
      assistantMsg('Hi there!'),
      userMsg('follow-up'),
    ]
    const turn2Input = transcriptToCodexInput(turn2Messages)

    const delta = canonicalDelta(turn2Input, sentInput, outputItems)
    expect(delta).not.toBeNull()
    expect(delta!).toHaveLength(1)
    expect(delta![0]).toMatchObject({ role: 'user', content: 'follow-up' })
  })

  test('assistant message merge does not break canonical reconciliation', () => {
    const msgId = 'msg_test_merge'
    const turn1Messages = [
      userMsg('hello'),
      assistantMsg('Part 1. ', msgId),
      assistantMsg('Part 2.', msgId),
    ]
    const turn1Input = transcriptToCodexInput(turn1Messages)
    expect(turn1Input.length).toBeGreaterThanOrEqual(2)

    // sentInput = all of turn1Input; outputItems = [] (no server output items —
    // the assistant content was already included in the sent input[])
    const state = { sentInput: turn1Input, outputItems: [] as Array<Record<string, unknown>> }

    const turn2Messages = [
      userMsg('hello'),
      assistantMsg('Part 1. ', msgId),
      assistantMsg('Part 2.', msgId),
      userMsg('next'),
    ]
    const turn2Input = transcriptToCodexInput(turn2Messages)

    const delta = canonicalDelta(turn2Input, state.sentInput, state.outputItems)
    expect(delta).not.toBeNull()
    expect(delta!).toHaveLength(1)
    expect(delta![0]).toMatchObject({ role: 'user', content: 'next' })
  })

  test('tool use + tool result round-trip stays incremental', () => {
    const callId = 'call_read_file'
    const turn1Messages = [
      userMsg('read the file'),
      toolUseMsg('Read', callId, { file_path: 'src/foo.ts' }),
      toolResultMsg(callId, 'const x = 1'),
    ]
    const turn1Input = transcriptToCodexInput(turn1Messages)
    expect(turn1Input).toHaveLength(3)
    expect(turn1Input[1]).toMatchObject({ type: 'function_call', name: 'Read' })
    expect(turn1Input[2]).toMatchObject({ type: 'function_call_output' })

    const { sentInput, outputItems } = simulateCanonicalState(turn1Input, 'File read complete.')

    const turn2Messages = [
      userMsg('read the file'),
      toolUseMsg('Read', callId, { file_path: 'src/foo.ts' }),
      toolResultMsg(callId, 'const x = 1'),
      assistantMsg('File read complete.'),
      userMsg('now edit it'),
    ]
    const turn2Input = transcriptToCodexInput(turn2Messages)

    const delta = canonicalDelta(turn2Input, sentInput, outputItems)
    expect(delta).not.toBeNull()
    expect(delta!).toHaveLength(1)
    expect(delta![0]).toMatchObject({ role: 'user', content: 'now edit it' })
  })

  test('normalization drift in sent-input portion does not block canonical reconciliation', () => {
    // Core regression from the bug report: normalizeMessagesForAPI rewrites the
    // user message prefix (id-tags, block merges, etc.), but since sent-input is
    // trusted by length only, the canonical delta still succeeds.
    const turn1Input = transcriptToCodexInput([userMsg('hello')])
    const { sentInput, outputItems } = simulateCanonicalState(turn1Input, 'world')

    const driftedTurn2Input: Array<Record<string, unknown>> = [
      // Drifted from canonical: [id:...] tag appended by appendMessageTagToUserMessage
      { role: 'user', content: 'hello [id:drifted_tag]' },
      // Output item replayed verbatim
      ...outputItems,
      // Genuinely new item
      { role: 'user', content: 'follow-up' },
    ]

    const delta = canonicalDelta(driftedTurn2Input, sentInput, outputItems)
    expect(delta).not.toBeNull()
    expect(delta!).toEqual([{ role: 'user', content: 'follow-up' }])
  })

  test('input shorter than baseline always falls back to full send', () => {
    const turn1Input = transcriptToCodexInput([userMsg('hello')])
    const { sentInput, outputItems } = simulateCanonicalState(turn1Input)

    // baseline = 1 sent + 1 output = 2 items; turn2 has only 1 → must full-send
    const turn2Input = transcriptToCodexInput([userMsg('fresh context')])
    const delta = canonicalDelta(turn2Input, sentInput, outputItems)
    expect(delta).toBeNull()
  })

  test('logprobs-bearing server message stays incremental (message_content_drift killed)', () => {
    // Regression for message_content_drift len_delta=-14: the server's output_text
    // part carries a `logprobs` field the replay path drops. The record side must
    // drop it too so the two byte-match.
    const turn1Input = transcriptToCodexInput([userMsg('hello')])
    const { sentInput, outputItems } = simulateCanonicalState(turn1Input, 'world', [
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'world', annotations: [], logprobs: [] }],
      },
    ])
    // The canonical baseline must not contain logprobs.
    expect(JSON.stringify(outputItems)).not.toContain('logprobs')

    const turn2Input = transcriptToCodexInput([
      userMsg('hello'),
      assistantMsg('world'),
      userMsg('next'),
    ])
    const delta = canonicalDelta(turn2Input, sentInput, outputItems)
    expect(delta).not.toBeNull()
    expect(delta!).toEqual([{ role: 'user', content: 'next' }])
  })

})
