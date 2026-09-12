import { describe, expect, test } from 'bun:test'

import type { AgentConfigSnapshot, ServerFrame } from '../../shared/protocol.js'
import {
  createRetainedSubmitState,
  foldRecalledPrompts,
  reduceRetainedSubmitCleared,
  reduceRetainedSubmitHeld,
  reduceRetainedSubmitSettled,
  reduceSubmitAnswers,
  RETAINED_SUBMIT_CAP,
  selectRetainedSubmit,
  selectSubmitAnswer,
} from './composerState.js'
import {
  applyMention,
  buildSubmitPrompt,
  caretAtHistoryEdge,
  countNewlines,
  createFileAttachmentState,
  createHistoryState,
  createImageAttachmentState,
  createPasteState,
  canSendUntypedSubmit,
  EMPTY_HISTORY_NAV,
  expandPasteRefs,
  formatPasteRef,
  HISTORY_CAP,
  navigateHistory,
  shouldRecallWaitingMessages,
  parseMentionQuery,
  pasteIdAtCaret,
  pasteTokenBeforeCaret,
  PASTE_MAX_LINES,
  PASTE_THRESHOLD,
  reduceFileAttachmentRemoved,
  reduceFileAttachmentSelected,
  reduceHistoryPushed,
  reduceImageAttachmentAdded,
  reduceImageAttachmentRemoved,
  reducePasteAdded,
  reducePasteRemoved,
  reducePastesPruned,
  reducePasteStateForDraftWrite,
  reduceSessionImagesReplaced,
  reduceSessionImagesRestored,
  reduceSessionPastesCleared,
  removePasteOccurrence,
  selectAgentMentionItems,
  selectHistory,
  selectImageAttachments,
  selectSessionPasteList,
  selectSessionPasteState,
  shouldCollapsePaste,
  createPendingSubmitState,
  createTransportErrorState,
  planSessionSubmit,
  reducePendingSubmitCleared,
  reducePendingSubmitHeld,
  reduceTransportErrorCleared,
  reduceTransportErrorSet,
  resolvePendingSubmit,
  restoreSelectedPrompt,
  restoreDraftWithPending,
  composerPromptPlaceholder,
  selectComposerGate,
  selectFileAttachment,
  selectPendingSubmit,
  selectTransportError,
  shouldReleasePendingSubmitOnStop,
  type ComposerGateInput,
} from './composerState.js'

const S1 = 's-1' as unknown as import('../../shared/protocol.js').SessionId
const S2 = 's-2' as unknown as import('../../shared/protocol.js').SessionId

describe('selected prompt restoration', () => {
  test('restores a string prompt as composer text', () => {
    expect(restoreSelectedPrompt({ content: 'Try the smaller model.' })).toEqual({
      text: 'Try the smaller model.',
      images: [],
    })
  })

  test('restores every accepted image block with composer-local ids', () => {
    expect(
      restoreSelectedPrompt({
        content: [
          { type: 'text', text: 'Compare these: ' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'YWJjZA==',
            },
          },
          { type: 'text', text: 'then this one' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/webp',
              data: 'ZWZnaA==',
            },
          },
        ],
        imagePasteIds: [7, 11],
      }),
    ).toEqual({
      text: 'Compare these: \nthen this one',
      images: [
        {
          id: 1,
          mediaType: 'image/png',
          data: 'YWJjZA==',
          name: 'image',
        },
        {
          id: 2,
          mediaType: 'image/webp',
          data: 'ZWZnaA==',
          name: 'image',
        },
      ],
    })
  })

  test('ignores malformed and unsupported blocks while preserving valid content', () => {
    expect(
      restoreSelectedPrompt({
        content: [
          { type: 'text', text: 'Keep this' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/svg+xml',
              data: 'YWJjZA==',
            },
          },
          { type: 'text', text: 12 },
          null,
          { type: 'document', text: 'not a composer block' },
        ],
      }),
    ).toEqual({ text: 'Keep this', images: [] })
  })

  test('rejects a selected prompt without string or block-array content', () => {
    expect(restoreSelectedPrompt({ content: 42 })).toBeNull()
    expect(restoreSelectedPrompt(null)).toBeNull()
  })

  test('restores an image-only prompt with a generated attachment id', () => {
    expect(
      restoreSelectedPrompt({
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: 'YWJjZA==',
            },
          },
        ],
      }),
    ).toEqual({
      text: '',
      images: [
        {
          id: 1,
          mediaType: 'image/jpeg',
          data: 'YWJjZA==',
          name: 'image',
        },
      ],
    })
  })
})

function agent(
  agentType: string,
  available: boolean,
  whenToUse = '',
): AgentConfigSnapshot['definitions'][number] {
  return {
    id: `built-in:${agentType}`,
    agentType,
    source: 'built-in',
    whenToUse,
    tools: { mode: 'all' } as never,
    provider: 'runtime',
    background: false,
    hasInitialPrompt: false,
    hasHooks: false,
    hasMcpServers: false,
    mcpServerRefs: [],
    inlineMcpServerNames: [],
    requiredMcpServers: [],
    missingMcpServers: [],
    active: true,
    available,
    editable: false,
    systemPrompt: { available: false, withheldReason: 'secret-boundary' },
  }
}

function snapshot(
  definitions: AgentConfigSnapshot['definitions'],
): AgentConfigSnapshot {
  return { definitions, failedFiles: [], availableMcpServers: [] }
}

describe('@-mention detection', () => {
  test('detects a trailing @token at start or after whitespace', () => {
    expect(parseMentionQuery('@')).toBe('')
    expect(parseMentionQuery('@rev')).toBe('rev')
    expect(parseMentionQuery('please ask @explo')).toBe('explo')
    expect(parseMentionQuery('path @src/utils/x.ts')).toBe('src/utils/x.ts')
  })

  test('no match once the mention is completed or not a token', () => {
    expect(parseMentionQuery('@agent ')).toBeNull() // trailing space closes it
    expect(parseMentionQuery('email a@b')).toBeNull() // @ mid-word, not a mention
    expect(parseMentionQuery('plain text')).toBeNull()
    expect(parseMentionQuery('')).toBeNull()
  })

  test('applyMention replaces the trailing token with @label plus a space', () => {
    expect(applyMention('@exp', 'explore')).toBe('@explore ')
    expect(applyMention('ask @re', 'reviewer')).toBe('ask @reviewer ')
    expect(applyMention('@', 'explore')).toBe('@explore ')
  })
})

describe('agent mention items', () => {
  test('offers only AVAILABLE agents, keyed by agentType (no name field)', () => {
    const items = selectAgentMentionItems(
      snapshot([
        agent('explore', true, 'Broad search'),
        agent('offline', false, 'Unavailable'),
        agent('reviewer', true),
      ]),
    )
    expect(items).toEqual([
      { label: 'explore', sub: 'Broad search', value: 'explore' },
      { label: 'reviewer', sub: undefined, value: 'reviewer' },
    ])
  })

  test('null snapshot yields no items', () => {
    expect(selectAgentMentionItems(null)).toEqual([])
  })
})

describe('paste collapse model', () => {
  test('threshold: long text OR more than PASTE_MAX_LINES newlines collapses', () => {
    expect(shouldCollapsePaste('short one-liner')).toBe(false)
    expect(shouldCollapsePaste('a\nb\nc')).toBe(false) // 2 newlines == max, inline
    expect(shouldCollapsePaste('a\nb\nc\nd')).toBe(true) // 3 newlines > max
    expect(shouldCollapsePaste('x'.repeat(PASTE_THRESHOLD + 1))).toBe(true)
    expect(shouldCollapsePaste('x'.repeat(PASTE_THRESHOLD))).toBe(false)
    expect(PASTE_MAX_LINES).toBe(2)
  })

  test('countNewlines handles \\r\\n, \\r and \\n', () => {
    expect(countNewlines('a\r\nb\rc\nd')).toBe(3)
  })

  test('token format matches the engine (with/without line count)', () => {
    expect(formatPasteRef(1, 0)).toBe('[Pasted text #1]')
    expect(formatPasteRef(4, 12)).toBe('[Pasted text #4 +12 lines]')
  })

  test('add → token stored; expand restores full content on submit', () => {
    const big = 'line\n'.repeat(30)
    const { state, token } = reducePasteAdded(createPasteState(), S1, big)
    expect(token).toBe('[Pasted text #1 +30 lines]')
    const draft = `see this ${token} thanks`
    const entries = selectSessionPasteState(state, S1).entries
    expect(expandPasteRefs(draft, entries)).toBe(`see this ${big} thanks`)
  })

  test('unknown token id is left untouched by expand', () => {
    expect(expandPasteRefs('[Pasted text #9]', {})).toBe('[Pasted text #9]')
  })

  test('nextId is monotonic so a re-paste gets a fresh number', () => {
    let state = createPasteState()
    state = reducePasteAdded(state, S1, 'a\n'.repeat(10)).state
    const second = reducePasteAdded(state, S1, 'b\n'.repeat(10))
    expect(second.token).toBe('[Pasted text #2 +10 lines]')
  })

  test('remove drops the stored entry', () => {
    const { state } = reducePasteAdded(createPasteState(), S1, 'a\n'.repeat(10))
    expect(selectSessionPasteList(state, S1)).toHaveLength(1)
    const removed = reducePasteRemoved(state, S1, 1)
    expect(selectSessionPasteList(removed, S1)).toHaveLength(0)
  })

  test('prune drops entries whose token the user deleted from the draft', () => {
    let state = createPasteState()
    const a = reducePasteAdded(state, S1, 'a\n'.repeat(10))
    state = a.state
    const b = reducePasteAdded(state, S1, 'b\n'.repeat(10))
    state = b.state
    // Draft keeps only the second token.
    const pruned = reducePastesPruned(state, S1, `kept ${b.token}`)
    const list = selectSessionPasteList(pruned, S1)
    expect(list.map(e => e.id)).toEqual([2])
  })

  test('clear removes all of a session’s pastes (submit reset)', () => {
    const { state } = reducePasteAdded(createPasteState(), S1, 'a\n'.repeat(10))
    expect(selectSessionPasteList(reduceSessionPastesCleared(state, S1), S1)).toEqual(
      [],
    )
  })

  test('paste state is isolated per session', () => {
    let state = createPasteState()
    state = reducePasteAdded(state, S1, 'a\n'.repeat(10)).state
    state = reducePasteAdded(state, S2, 'b\n'.repeat(10)).state
    // Clearing S1 must not touch S2.
    state = reduceSessionPastesCleared(state, S1)
    expect(selectSessionPasteList(state, S1)).toEqual([])
    expect(selectSessionPasteList(state, S2)).toHaveLength(1)
  })
})

describe('input history recall', () => {
  test('push dedups the newest entry and caps at HISTORY_CAP', () => {
    let state = createHistoryState()
    state = reduceHistoryPushed(state, S1, 'one')
    state = reduceHistoryPushed(state, S1, 'one') // dup — ignored
    state = reduceHistoryPushed(state, S1, 'two')
    expect(selectHistory(state, S1)).toEqual(['one', 'two'])

    let capped = createHistoryState()
    for (let i = 0; i < HISTORY_CAP + 10; i++) {
      capped = reduceHistoryPushed(capped, S1, `p${i}`)
    }
    const list = selectHistory(capped, S1)
    expect(list).toHaveLength(HISTORY_CAP)
    expect(list[0]).toBe('p10') // oldest 10 dropped
    expect(list[list.length - 1]).toBe(`p${HISTORY_CAP + 9}`)
  })

  test('↑ walks back from the draft, preserving it; ↓ restores it', () => {
    const history = ['first', 'second', 'third']
    // Start editing a live draft.
    let nav = EMPTY_HISTORY_NAV
    const up1 = navigateHistory(history, nav, 'up', 'my draft')
    expect(up1).not.toBeNull()
    expect(up1!.value).toBe('third')
    expect(up1!.nav).toEqual({ index: 2, savedDraft: 'my draft' })
    nav = up1!.nav

    const up2 = navigateHistory(history, nav, 'up', 'ignored once in history')
    expect(up2!.value).toBe('second')
    expect(up2!.nav.savedDraft).toBe('my draft') // draft preserved
    nav = up2!.nav

    const up3 = navigateHistory(history, nav, 'up', '')
    expect(up3!.value).toBe('first')
    nav = up3!.nav

    // ↑ at the oldest entry is a no-op.
    expect(navigateHistory(history, nav, 'up', '')).toBeNull()

    // ↓ back down, then past the newest → restore the saved draft.
    const down1 = navigateHistory(history, nav, 'down', '')
    expect(down1!.value).toBe('second')
    const down2 = navigateHistory(history, down1!.nav, 'down', '')
    expect(down2!.value).toBe('third')
    const down3 = navigateHistory(history, down2!.nav, 'down', '')
    expect(down3!.value).toBe('my draft')
    expect(down3!.nav).toEqual(EMPTY_HISTORY_NAV)
  })

  test('after two submitted prompts, first ↑ recalls newest, then older, and ↓ restores the empty draft', () => {
    let state = createHistoryState()
    state = reduceHistoryPushed(state, S1, 'first submitted prompt')
    state = reduceHistoryPushed(state, S1, 'second submitted prompt')
    state = reduceHistoryPushed(state, S2, 'other session prompt')

    const history = selectHistory(state, S1)
    let nav = EMPTY_HISTORY_NAV

    const newest = navigateHistory(history, nav, 'up', '')
    expect(newest).not.toBeNull()
    expect(newest!.value).toBe('second submitted prompt')
    nav = newest!.nav

    const older = navigateHistory(history, nav, 'up', '')
    expect(older).not.toBeNull()
    expect(older!.value).toBe('first submitted prompt')
    nav = older!.nav

    const backToNewest = navigateHistory(history, nav, 'down', '')
    expect(backToNewest).not.toBeNull()
    expect(backToNewest!.value).toBe('second submitted prompt')

    const restoredDraft = navigateHistory(
      history,
      backToNewest!.nav,
      'down',
      '',
    )
    expect(restoredDraft).not.toBeNull()
    expect(restoredDraft!.value).toBe('')
    expect(restoredDraft!.nav).toEqual(EMPTY_HISTORY_NAV)
    expect(selectHistory(state, S2)).toEqual(['other session prompt'])
  })

  test('↓ while already editing the draft is a no-op', () => {
    expect(navigateHistory(['a'], EMPTY_HISTORY_NAV, 'down', 'x')).toBeNull()
  })

  test('recall on empty history is a no-op', () => {
    expect(navigateHistory([], EMPTY_HISTORY_NAV, 'up', 'x')).toBeNull()
  })

  test('history is isolated per session', () => {
    let state = createHistoryState()
    state = reduceHistoryPushed(state, S1, 'in-one')
    state = reduceHistoryPushed(state, S2, 'in-two')
    expect(selectHistory(state, S1)).toEqual(['in-one'])
    expect(selectHistory(state, S2)).toEqual(['in-two'])
  })
})

describe('paste survives history navigation (regression)', () => {
  test('history-nav write never prunes; the same draft as an edit does prune', () => {
    const { state } = reducePasteAdded(createPasteState(), S1, 'a\n'.repeat(10))
    // A recalled OLD prompt legitimately lacks the paste token. Browsing history
    // must NOT drop the live paste entry (constraint: ↓ restores it on the way back).
    const afterNav = reducePasteStateForDraftWrite(
      state,
      S1,
      'a prior prompt with no token',
      'history-nav',
    )
    expect(selectSessionPasteList(afterNav, S1)).toHaveLength(1)
    // The SAME token-less draft, if it's a genuine edit, IS a real deletion — prune it.
    const afterEdit = reducePasteStateForDraftWrite(
      state,
      S1,
      'a prior prompt with no token',
      'edit',
    )
    expect(selectSessionPasteList(afterEdit, S1)).toHaveLength(0)
  })

  test('[paste large → ↑ recall → ↓ restore → submit] hands the FULL body to submit, not the token', () => {
    const big = 'const x = 1\n'.repeat(40) // many newlines → collapses to a chip
    const history = ['an earlier prompt'] // a prior submitted prompt for this session
    expect(shouldCollapsePaste(big)).toBe(true)

    // 1) Paste large: the chip is stored and the draft becomes the token.
    const added = reducePasteAdded(createPasteState(), S1, big)
    let pasteState = added.state
    let draft = added.token

    // 2) ↑ recall: App writes the recalled old prompt with reason 'history-nav'.
    const up = navigateHistory(history, EMPTY_HISTORY_NAV, 'up', draft)
    expect(up).not.toBeNull()
    draft = up!.value
    pasteState = reducePasteStateForDraftWrite(pasteState, S1, draft, 'history-nav')
    expect(draft).toBe('an earlier prompt') // token gone from the visible draft

    // 3) ↓ restore: savedDraft (the token) returns; still a 'history-nav' write.
    const down = navigateHistory(history, up!.nav, 'down', '')
    expect(down).not.toBeNull()
    draft = down!.value
    pasteState = reducePasteStateForDraftWrite(pasteState, S1, draft, 'history-nav')
    expect(draft).toBe(added.token) // the [Pasted text #1 …] token is back

    // 4) Submit: expand refs against the still-present entry — the engine gets
    //    the FULL pasted body, never the literal placeholder.
    const entries = selectSessionPasteState(pasteState, S1).entries
    const submitted = expandPasteRefs(draft, entries)
    expect(submitted).toBe(big)
    expect(submitted).not.toContain('[Pasted text #')
  })
})

describe('P4-24 multi-line composer helpers', () => {
  test('caretAtHistoryEdge: single-line draft always recalls (no newlines)', () => {
    // Preserves the P4-0 single-line behaviour exactly.
    expect(caretAtHistoryEdge('hello', 0, 'up')).toBe(true)
    expect(caretAtHistoryEdge('hello', 5, 'up')).toBe(true)
    expect(caretAtHistoryEdge('hello', 5, 'down')).toBe(true)
    expect(caretAtHistoryEdge('', 0, 'up')).toBe(true)
  })

  test('caretAtHistoryEdge: multi-line recalls only at the first/last line', () => {
    const v = 'line one\nline two\nline three'
    // Caret on the first line → ArrowUp recalls; caret below → ArrowUp moves.
    expect(caretAtHistoryEdge(v, 3, 'up')).toBe(true)
    expect(caretAtHistoryEdge(v, 12, 'up')).toBe(false)
    // Caret on the last line → ArrowDown recalls; caret above → ArrowDown moves.
    expect(caretAtHistoryEdge(v, v.length - 2, 'down')).toBe(true)
    expect(caretAtHistoryEdge(v, 3, 'down')).toBe(false)
    // Caret exactly on a newline boundary: nothing before it → up recalls.
    expect(caretAtHistoryEdge(v, 0, 'up')).toBe(true)
    expect(caretAtHistoryEdge(v, v.length, 'down')).toBe(true)
  })

  test('pasteTokenBeforeCaret: returns the whole-token range when the caret abuts a token', () => {
    const token = formatPasteRef(3, 12) // [Pasted text #3 +12 lines]
    const draft = `look at ${token}`
    const range = pasteTokenBeforeCaret(draft, draft.length)
    expect(range).toEqual({ start: draft.length - token.length, end: draft.length })
    expect(draft.slice(range!.start, range!.end)).toBe(token)
  })

  test('pasteTokenBeforeCaret: no match when the caret is not right after a token', () => {
    const draft = `look at ${formatPasteRef(3, 0)} now`
    expect(pasteTokenBeforeCaret(draft, draft.length)).toBeNull() // caret after " now"
    expect(pasteTokenBeforeCaret('plain text', 10)).toBeNull()
    expect(pasteTokenBeforeCaret('', 0)).toBeNull()
  })

  test('pasteTokenBeforeCaret: single-line token (no "+N lines") also matches', () => {
    const token = formatPasteRef(7, 0) // [Pasted text #7]
    const draft = `x${token}`
    const range = pasteTokenBeforeCaret(draft, draft.length)
    expect(range).toEqual({ start: 1, end: draft.length })
  })

  test('removePasteOccurrence: cuts the occurrence at the given position', () => {
    const token = formatPasteRef(1, 2)
    const draft = `${token} and ${token}`
    const secondAt = token.length + ' and '.length
    // The SECOND pill was clicked, so the first must survive intact.
    expect(removePasteOccurrence(draft, token, secondAt)).toBe(`${token} and `)
    expect(removePasteOccurrence(draft, token, 0)).toBe(` and ${token}`)
  })

  test('removePasteOccurrence: a stale position falls back to the first match', () => {
    const token = formatPasteRef(1, 2)
    const draft = `x ${token}`
    expect(removePasteOccurrence(draft, token, 999)).toBe('x ')
    expect(removePasteOccurrence('nothing here', token, 0)).toBe('nothing here')
  })

  test('a duplicated token keeps its entry until the LAST copy is cut', () => {
    // Removing one pill must not strand the other: pruning is what decides the
    // stored text's fate, and it keeps the entry while a reference remains.
    const state = createPasteState()
    const added = reducePasteAdded(state, S1, 'x\ny\nz')
    const token = added.token
    const draft = `${token} ${token}`

    const afterFirst = removePasteOccurrence(draft, token, 0)
    const stillHeld = reducePastesPruned(added.state, S1, afterFirst)
    expect(selectSessionPasteList(stillHeld, S1)).toHaveLength(1)
    // The surviving pill still expands to real text, not the literal token.
    expect(
      expandPasteRefs(
        afterFirst,
        selectSessionPasteState(stillHeld, S1).entries,
      ),
    ).toBe(' x\ny\nz')

    const afterSecond = removePasteOccurrence(afterFirst, token, 1)
    const dropped = reducePastesPruned(stillHeld, S1, afterSecond)
    expect(selectSessionPasteList(dropped, S1)).toHaveLength(0)
  })

  test('pasteIdAtCaret: both edges of a token count as touching it', () => {
    const token = formatPasteRef(4, 9)
    const draft = `see ${token} ok`
    expect(pasteIdAtCaret(draft, 4)).toBe(4) // caret just before the token
    expect(pasteIdAtCaret(draft, 4 + token.length)).toBe(4) // just after it
    expect(pasteIdAtCaret(draft, 4 + 3)).toBe(4) // inside it
    expect(pasteIdAtCaret(draft, 3)).toBeNull()
    expect(pasteIdAtCaret(draft, draft.length)).toBeNull()
  })

  test('pasteIdAtCaret: picks the token the caret is in, not the first one', () => {
    const first = formatPasteRef(1, 2)
    const second = formatPasteRef(2, 3)
    const draft = `${first} and ${second}`
    expect(pasteIdAtCaret(draft, draft.length)).toBe(2)
    expect(pasteIdAtCaret(draft, first.length + 2)).toBeNull() // in " and "
  })
})

// ── CC-16: the composer accepts input while the engine is still spawning ─────

function gateInput(overrides: Partial<ComposerGateInput> = {}): ComposerGateInput {
  return {
    hasSession: true,
    preview: false,
    connectionStatus: 'ready',
    connectionInputEnabled: true,
    logInputEnabled: true,
    ...overrides,
  }
}

/**
 * The editable composer's prompt (PEER-SESSIONS §6). A named session is
 * addressed by its own name; an unnamed one keeps the original string, which is
 * the case for every session that predates the field.
 */
describe('composer prompt placeholder', () => {
  test('a named session is addressed by its name', () => {
    expect(composerPromptPlaceholder('Bear')).toBe(
      'Ask Bear anything or describe a task…',
    )
  })

  test('an unnamed session keeps the original prompt, byte for byte', () => {
    // Pinned as a literal, not derived: this is the string on screen for every
    // existing install, and a "harmless" reword of it would ship unreviewed.
    const original = 'Ask Cat Code anything or describe a task…'
    expect(composerPromptPlaceholder(null)).toBe(original)
    // A name that is only whitespace is not a name; it would otherwise render
    // as "Ask  anything or describe a task…".
    expect(composerPromptPlaceholder('')).toBe(original)
    expect(composerPromptPlaceholder('   ')).toBe(original)
  })
})

describe('composer gate — three reasons the engine cannot take a submit YET', () => {
  test('a live, idle session is editable and engine-enabled', () => {
    const gate = selectComposerGate(gateInput())
    expect(gate).toEqual({
      engineInputEnabled: true,
      connectPending: false,
      turnPending: false,
      editable: true,
    })
  })

  test('a previewed (not-yet-spawned) session accepts typing', () => {
    // The friction being removed: a preview pane used to be read-only and told
    // the user to "Focus to reconnect…". Focus/pointer-down already spawns.
    const gate = selectComposerGate(gateInput({ preview: true }))
    expect(gate.editable).toBe(true)
    expect(gate.connectPending).toBe(true)
    expect(gate.engineInputEnabled).toBe(false)
  })

  test('an in-flight spawn (connecting/starting) accepts typing', () => {
    for (const connectionStatus of ['connecting', 'starting'] as const) {
      const gate = selectComposerGate(
        gateInput({
          connectionStatus,
          connectionInputEnabled: false,
          logInputEnabled: false,
        }),
      )
      expect(gate.editable).toBe(true)
      expect(gate.connectPending).toBe(true)
      expect(gate.engineInputEnabled).toBe(false)
    }
  })

  test('a mid-turn session accepts typing and queues the submit', () => {
    // `ready` + `inputEnabled: false` is a turn running. The ENGINE takes one
    // turn at a time; the composer does not have to go dead for that, and in
    // the terminal REPL it never did. This is the turn-pending gate, and it is
    // NOT connect-pending: the engine is already attached.
    const gate = selectComposerGate(
      gateInput({ connectionInputEnabled: false }),
    )
    expect(gate).toEqual({
      engineInputEnabled: false,
      connectPending: false,
      turnPending: true,
      editable: true,
    })
  })

  test('an attached session whose log has not enabled input queues too', () => {
    // The two stores move together (both reduce `ready` and `turn.status`), so
    // this is a transient skew, not a state of its own. Queueing it is safe:
    // the drain reads the CONNECTION snapshot, so it flushes on the next tick.
    const gate = selectComposerGate(gateInput({ logInputEnabled: false }))
    expect(gate.editable).toBe(true)
    expect(gate.turnPending).toBe(true)
    expect(gate.connectPending).toBe(false)
    expect(gate.engineInputEnabled).toBe(false)
  })

  test('terminal statuses are neither pending nor editable — no spawn is coming', () => {
    for (const connectionStatus of [
      'dead',
      'failed',
      'exited',
      'disconnected',
    ] as const) {
      const gate = selectComposerGate(
        gateInput({
          connectionStatus,
          connectionInputEnabled: false,
          logInputEnabled: false,
        }),
      )
      expect(gate.editable).toBe(false)
      expect(gate.connectPending).toBe(false)
      expect(gate.turnPending).toBe(false)
    }
  })

  test('a terminal-status PREVIEW pane is still pending — focus re-spawns it', () => {
    const gate = selectComposerGate(
      gateInput({
        preview: true,
        connectionStatus: 'exited',
        connectionInputEnabled: false,
        logInputEnabled: false,
      }),
    )
    expect(gate.editable).toBe(true)
    expect(gate.connectPending).toBe(true)
  })

  test('an idle-PARKED session stays editable — the reclaim is not the user’s problem', () => {
    // IDLE-PARK: the engine behind this session was reclaimed on purpose while it
    // sat idle. Before this, the park arrived as a terminal `exited` and the
    // composer went read-only behind an unexpected-stop banner, so continuing a
    // conversation meant pressing Restart. It is the third connect-pending
    // reason, not a fourth terminal one.
    const gate = selectComposerGate(
      gateInput({
        connectionStatus: 'parked',
        connectionInputEnabled: false,
        logInputEnabled: false,
      }),
    )
    expect(gate.editable).toBe(true)
    expect(gate.connectPending).toBe(true)
    expect(gate.turnPending).toBe(false)
    expect(gate.engineInputEnabled).toBe(false)
  })

  test('no session at all: nothing is editable', () => {
    const gate = selectComposerGate(
      gateInput({ hasSession: false, connectionStatus: 'connecting' }),
    )
    expect(gate).toEqual({
      engineInputEnabled: false,
      connectPending: false,
      turnPending: false,
      editable: false,
    })
  })

  /**
   * The donut's Compact row sends `/compact` on a click, with no draft behind it
   * to park. It is therefore a STRICTER question than `editable`, and the whole
   * table below exists so the obvious-looking simplification to `editable` fails
   * here rather than in front of an operator: `editable` includes
   * `connectPending`, `connectPending` includes `preview`, and a verb sent to a
   * session the supervisor does not have comes back `session_not_found` — which
   * the connection reducer maps to `dead` (CC-28, pinned again at the App call
   * site in `App.test.tsx`).
   */
  describe('canSendUntypedSubmit — stricter than editable, by design', () => {
    const cases: [string, ComposerGateInput, boolean][] = [
      ['a live idle session takes it now', gateInput(), true],
      [
        'a mid-turn session queues it into the running turn',
        gateInput({ connectionInputEnabled: false }),
        true,
      ],
      [
        'a preview pane has no engine to take it',
        gateInput({ preview: true }),
        false,
      ],
      [
        'an in-flight spawn would have to park it, and the slot is the user’s',
        gateInput({
          connectionStatus: 'connecting',
          connectionInputEnabled: false,
          logInputEnabled: false,
        }),
        false,
      ],
      [
        'an idle-PARKED session looks fine and has no process',
        gateInput({
          connectionStatus: 'parked',
          connectionInputEnabled: false,
          logInputEnabled: false,
        }),
        false,
      ],
      [
        'a terminal session is gone',
        gateInput({
          connectionStatus: 'dead',
          connectionInputEnabled: false,
          logInputEnabled: false,
        }),
        false,
      ],
      [
        'no session at all',
        gateInput({ hasSession: false, connectionStatus: 'ready' }),
        false,
      ],
    ]
    for (const [name, input, expected] of cases) {
      test(name, () => {
        const gate = selectComposerGate(input)
        expect(canSendUntypedSubmit(gate)).toBe(expected)
        // Every false case here is a state the composer still accepts TYPING in,
        // except the last two — that difference is the point of the helper.
        if (!expected && input.hasSession && input.connectionStatus !== 'dead') {
          expect(gate.editable).toBe(true)
        }
      })
    }
  })
})

describe('CC-16 submit planning — only the submit waits for the engine', () => {
  // The exact argument shape `App.submitSession` builds, so these cases
  // traverse the same join the production caller does.
  function submitInput(
    overrides: Partial<Parameters<typeof planSessionSubmit>[0]> = {},
  ): Parameters<typeof planSessionSubmit>[0] {
    return {
      draft: 'hello',
      pasteEntries: {},
      preview: false,
      connectionStatus: 'ready',
      connectionInputEnabled: true,
      logInputEnabled: true,
      alreadyParked: false,
      ...overrides,
    }
  }
  const spawning = {
    connectionStatus: 'connecting',
    connectionInputEnabled: false,
    logInputEnabled: false,
  } as const

  test('a live session sends immediately (unchanged path)', () => {
    expect(planSessionSubmit(submitInput())).toEqual({
      type: 'send',
      text: 'hello',
    })
  })

  test('a spawning session HOLDS instead of dropping the prompt', () => {
    expect(planSessionSubmit(submitInput(spawning))).toEqual({
      type: 'hold',
      text: 'hello',
      showQueuedRow: true,
    })
  })

  test('a previewed session HOLDS — this is the reported friction', () => {
    expect(planSessionSubmit(submitInput({ preview: true }))).toEqual({
      type: 'hold',
      text: 'hello',
      showQueuedRow: true,
    })
  })

  test('a mid-turn submit SENDS — the engine queues it into the running turn', () => {
    // `ready` + `inputEnabled: false` is exactly the mid-turn gate. It does NOT
    // park: the sidecar hands a mid-turn prompt to the engine's command queue
    // and the running turn drains it at its next tool round
    // (`src/query.ts:1636-1645`), which is the terminal REPL's behavior. Parking
    // would delay it to a turn afterwards.
    expect(
      planSessionSubmit(submitInput({ connectionInputEnabled: false })),
    ).toEqual({ type: 'send', text: 'hello' })
    expect(planSessionSubmit(submitInput({ logInputEnabled: false }))).toEqual({
      type: 'send',
      text: 'hello',
    })
  })

  test('a submit into a PARKED session HOLDS rather than being refused', () => {
    // The user pressed Enter, not Restart. The prompt is held and the drain's
    // `restore` arm fetches the engine back under it.
    expect(
      planSessionSubmit(
        submitInput({
          connectionStatus: 'parked',
          connectionInputEnabled: false,
          logInputEnabled: false,
        }),
      ),
    ).toEqual({ type: 'hold', text: 'hello', showQueuedRow: false })
  })

  test('one queued prompt at a time: a second parked-session submit keeps its draft', () => {
    // The duplicate-delivery guard for the park path: a second Enter while a
    // prompt is already queued is ignored and leaves the draft in the composer,
    // so a readiness race cannot turn one intent into two turns.
    expect(
      planSessionSubmit(
        submitInput({
          connectionStatus: 'parked',
          connectionInputEnabled: false,
          logInputEnabled: false,
          alreadyParked: true,
        }),
      ),
    ).toEqual({ type: 'ignore' })
  })

  test('mid-turn there is no one-at-a-time limit: every Enter is sent', () => {
    // The cap belongs to the PARK (one held prompt per session), and mid-turn
    // nothing is parked. The engine's queue is N-deep, so a second mid-turn
    // Enter goes out too — matching the terminal, where each queued line is its
    // own command. `alreadyParked` is irrelevant here and must not gate it.
    expect(
      planSessionSubmit(
        submitInput({ connectionInputEnabled: false, alreadyParked: true }),
      ),
    ).toEqual({ type: 'send', text: 'hello' })
  })

  test('a terminal (dead) session neither sends nor parks', () => {
    expect(
      planSessionSubmit(
        submitInput({
          connectionStatus: 'failed',
          connectionInputEnabled: false,
          logInputEnabled: false,
        }),
      ),
    ).toEqual({ type: 'ignore' })
  })

  test('an empty or whitespace-only prompt is ignored in every state', () => {
    expect(planSessionSubmit(submitInput({ draft: '' }))).toEqual({
      type: 'ignore',
    })
    expect(planSessionSubmit(submitInput({ draft: '   \n ', ...spawning }))).toEqual(
      { type: 'ignore' },
    )
  })

  test('a second submit while one is already parked leaves the draft alone', () => {
    // 'ignore' means submitSession returns before retiring the draft, so the
    // second prompt stays visible in the composer rather than vanishing.
    expect(
      planSessionSubmit(submitInput({ ...spawning, alreadyParked: true })),
    ).toEqual({ type: 'ignore' })
    // …but a live session still sends it, parked prompt or not.
    expect(planSessionSubmit(submitInput({ alreadyParked: true }))).toEqual({
      type: 'send',
      text: 'hello',
    })
  })

  test('a parked prompt carries EXPANDED paste text, exactly like a live send', () => {
    // The drain hands the sidecar `app.submit(text)` verbatim, so the expansion
    // has to happen at park time or the engine would receive the placeholder.
    const body = 'line\n'.repeat(30)
    const { state, token } = reducePasteAdded(createPasteState(), S1, body)
    const entries = selectSessionPasteState(state, S1).entries
    const action = planSessionSubmit(
      submitInput({ draft: `see ${token}`, pasteEntries: entries, ...spawning }),
    )
    expect(action).toEqual({
      type: 'hold',
      text: `see ${body}`.trim(),
      showQueuedRow: true,
    })
  })
})

describe('CC-16 parked prompt store', () => {
  test('hold / select / clear round-trip, keyed per session', () => {
    let state = createPendingSubmitState()
    expect(selectPendingSubmit(state, S1)).toBeNull()
    state = reducePendingSubmitHeld(state, S1, {
      text: 'first',
      showQueuedRow: true,
    })
    state = reducePendingSubmitHeld(state, S2, {
      text: 'second',
      showQueuedRow: false,
    })
    expect(selectPendingSubmit(state, S1)).toEqual({
      text: 'first',
      showQueuedRow: true,
    })
    expect(selectPendingSubmit(state, S2)).toEqual({
      text: 'second',
      showQueuedRow: false,
    })
    state = reducePendingSubmitCleared(state, S1)
    expect(selectPendingSubmit(state, S1)).toBeNull()
    expect(selectPendingSubmit(state, S2)).toEqual({
      text: 'second',
      showQueuedRow: false,
    })
  })

  test('empty text is never parked, and a null session selects nothing', () => {
    const state = reducePendingSubmitHeld(createPendingSubmitState(), S1, {
      text: '',
      showQueuedRow: true,
    })
    expect(selectPendingSubmit(state, S1)).toBeNull()
    expect(selectPendingSubmit(state, null)).toBeNull()
  })

  test('clearing an absent session is identity (no needless re-render)', () => {
    const state = createPendingSubmitState()
    expect(reducePendingSubmitCleared(state, S1)).toBe(state)
  })
})

describe('image attachment submit state', () => {
  const image = {
    mediaType: 'image/png' as const,
    data: 'AAAA',
    name: 'paste.png',
  }

  test('stores one session-scoped image and builds the engine content blocks', () => {
    let state = createImageAttachmentState()
    state = reduceImageAttachmentAdded(state, S1, image)
    const attachments = selectImageAttachments(state, S1)

    expect(attachments).toEqual([{ ...image, id: 1 }])
    expect(selectImageAttachments(state, S2)).toEqual([])
    expect(buildSubmitPrompt('inspect this', attachments)).toEqual([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'AAAA',
        },
      },
      { type: 'text', text: 'inspect this' },
    ])
  })

  test('an image-only prompt is sendable and removal clears its session state', () => {
    let state = reduceImageAttachmentAdded(createImageAttachmentState(), S1, image)
    const attachments = selectImageAttachments(state, S1)
    expect(
      planSessionSubmit({
        draft: '',
        pasteEntries: {},
        hasImages: true,
        preview: false,
        connectionStatus: 'ready',
        connectionInputEnabled: true,
        logInputEnabled: true,
        alreadyParked: false,
      }),
    ).toEqual({ type: 'send', text: '' })
    expect(buildSubmitPrompt('', attachments)).toHaveLength(1)

    state = reduceImageAttachmentRemoved(state, S1, attachments[0]!.id)
    expect(selectImageAttachments(state, S1)).toEqual([])
  })
})

describe('native file attachment state', () => {
  const file = { name: 'recommendation.md', token: 'picker-token' }

  test('keeps an opaque selection scoped to its session', () => {
    let state = createFileAttachmentState()
    state = reduceFileAttachmentSelected(state, S1, file)

    expect(selectFileAttachment(state, S1)).toEqual(file)
    expect(selectFileAttachment(state, S2)).toBeNull()

    state = reduceFileAttachmentRemoved(state, S1)
    expect(selectFileAttachment(state, S1)).toBeNull()
  })
})

// Bug fix (round8 finding 1) — `releasePendingSubmit` used to call
// `reduceSessionImagesReplaced` directly with `pending.images ?? []`, which
// DELETES the session's image entry when the array is empty. A text-only
// pending submit released after the user attached an image to the newer
// draft therefore erased that image. `reduceSessionImagesRestored` is the
// guarded helper now shared by every restore-to-composer path.
describe('reduceSessionImagesRestored — restoring an empty submit must not erase a newer attachment', () => {
  const imageB = {
    mediaType: 'image/png' as const,
    data: 'BBBB',
    name: 'imageB.png',
  }

  test('releasing/restoring an empty image list leaves a currently-attached image in place', () => {
    const held = reduceImageAttachmentAdded(createImageAttachmentState(), S1, imageB)
    expect(selectImageAttachments(held, S1)).toEqual([{ ...imageB, id: 1 }])

    // What the bug did: unconditional reduceSessionImagesReplaced wipes it.
    const wiped = reduceSessionImagesReplaced(held, S1, [])
    expect(selectImageAttachments(wiped, S1)).toEqual([])

    // The fix: the guarded restore leaves it untouched.
    const restored = reduceSessionImagesRestored(held, S1, [])
    expect(selectImageAttachments(restored, S1)).toEqual([{ ...imageB, id: 1 }])
  })

  test('restoring a submit that DOES carry images still replaces the current ones', () => {
    const held = reduceImageAttachmentAdded(createImageAttachmentState(), S1, imageB)
    const older = [{ mediaType: 'image/jpeg' as const, data: 'OLDER', name: 'older.jpg', id: 7 }]

    const restored = reduceSessionImagesRestored(held, S1, older)
    expect(selectImageAttachments(restored, S1)).toEqual(older)
  })

  test('is a no-op on a session with nothing attached', () => {
    const empty = createImageAttachmentState()
    expect(reduceSessionImagesRestored(empty, S1, [])).toBe(empty)
  })
})

describe('CC-16 drain — flushed on ready, given back on failure', () => {
  test('ready + input enabled sends the parked prompt', () => {
    expect(resolvePendingSubmit({ status: 'ready', inputEnabled: true })).toBe(
      'send',
    )
  })

  test('still spawning keeps holding', () => {
    expect(
      resolvePendingSubmit({ status: 'connecting', inputEnabled: false }),
    ).toBe('wait')
    expect(
      resolvePendingSubmit({ status: 'starting', inputEnabled: false }),
    ).toBe('wait')
  })

  test('a spawn that lands mid-turn still flushes — it does not wait for the boundary', () => {
    // The park exists for "no engine yet". Once one is attached, `inputEnabled`
    // stops mattering: the sidecar queues a mid-turn prompt into the running
    // turn, so holding on for the boundary would push it past the tool round
    // that should have seen it.
    expect(resolvePendingSubmit({ status: 'ready', inputEnabled: false })).toBe(
      'send',
    )
  })

  test('every terminal status RELEASES the prompt back to the user', () => {
    for (const status of ['dead', 'failed', 'exited', 'disconnected'] as const) {
      expect(resolvePendingSubmit({ status, inputEnabled: false })).toBe(
        'release',
      )
    }
  })

  test('a parked session asks for its engine back instead of waiting or failing', () => {
    // IDLE-PARK: `wait` would hold the prompt forever (nothing is spawning and
    // no turn will end), and `release` would demand a manual Restart. `restore`
    // is what makes the reclaim invisible — the drain re-spawns and keeps
    // holding, then sends off the resumed session's own `ready` frame.
    expect(resolvePendingSubmit({ status: 'parked', inputEnabled: false })).toBe(
      'restore',
    )
  })

  test('a released prompt is restored without clobbering a newer draft', () => {
    expect(restoreDraftWithPending('', 'parked')).toBe('parked')
    expect(restoreDraftWithPending('typed after', 'parked')).toBe(
      'parked\ntyped after',
    )
  })
})

describe('Bug 1 — Stop must not let the drain fire a queued prompt', () => {
  test('root cause: a post-abort snapshot is byte-identical to a natural turn end', () => {
    // `AppSessionController.submit`'s `finally` flips `activeTurn` to false
    // (`turn.status(activeTurn:false)`) on BOTH an abort and a natural
    // completion, so the connection snapshot the drain reads is the same
    // `{status:'ready', inputEnabled:true}` shape either way.
    // `resolvePendingSubmit` reads only `status`/`inputEnabled`, so — taken
    // alone — it cannot refuse to send a prompt parked by the turn Stop just
    // cancelled. This is exactly the bug: without an extra signal, the drain
    // sends.
    const postAbort = { status: 'ready' as const, inputEnabled: true }
    expect(resolvePendingSubmit(postAbort)).toBe('send')
  })

  test('a pending submit at the moment Stop is clicked must be released', () => {
    expect(
      shouldReleasePendingSubmitOnStop({
        text: 'also delete the old migration',
        showQueuedRow: true,
      }),
    ).toBe(true)
  })

  test('no pending submit is a no-op', () => {
    expect(shouldReleasePendingSubmitOnStop(null)).toBe(false)
  })
})

describe('Bug 3 — transport error is per-session, not one app-wide string', () => {
  test('set / select / clear round-trip, keyed per session', () => {
    let state = createTransportErrorState()
    expect(selectTransportError(state, S1)).toBeNull()
    state = reduceTransportErrorSet(state, S1, 'session A failed')
    state = reduceTransportErrorSet(state, S2, 'session B failed')
    expect(selectTransportError(state, S1)).toBe('session A failed')
    expect(selectTransportError(state, S2)).toBe('session B failed')
    state = reduceTransportErrorCleared(state, S1)
    expect(selectTransportError(state, S1)).toBeNull()
    expect(selectTransportError(state, S2)).toBe('session B failed')
  })

  test('a null session selects nothing', () => {
    expect(selectTransportError(createTransportErrorState(), null)).toBeNull()
  })

  test('clearing an absent session is identity (no needless re-render)', () => {
    const state = createTransportErrorState()
    expect(reduceTransportErrorCleared(state, S1)).toBe(state)
  })

  test('a background session error never bleeds into another session (regression)', () => {
    // The bug: a single app-wide `transportError` meant session B's drain
    // failure painted red text under whatever session the user was actually
    // looking at (session A), even though nothing about A failed.
    const state = reduceTransportErrorSet(
      createTransportErrorState(),
      S2,
      'session B failed',
    )
    expect(selectTransportError(state, S1)).toBeNull()
    expect(selectTransportError(state, S2)).toBe('session B failed')
  })
})

describe('D5 — a refused submit comes back, images included', () => {
  const image = {
    id: 1,
    mediaType: 'image/png' as const,
    data: 'AAAA',
    name: 'screenshot.png',
  }

  function userMessageFrame(sessionId: string, replay?: true): ServerFrame {
    return {
      kind: 'event',
      protocolVersion: 2,
      sessionId,
      ...(replay ? { replay } : {}),
      event: {
        type: 'message',
        message: {
          type: 'user',
          message: { role: 'user', content: 'look at this' },
          parent_tool_use_id: null,
          session_id: 'engine-1',
          uuid: '00000000-0000-4000-8000-000000000001',
        },
      },
    } as ServerFrame
  }

  function errorFrame(sessionId: string, requestId?: string): ServerFrame {
    return {
      kind: 'error',
      protocolVersion: 2,
      sessionId,
      ...(requestId === undefined ? {} : { requestId }),
      code: 'bad_request',
      message: 'Too many messages are already waiting for this response.',
      retryable: false,
    } as ServerFrame
  }

  function submitAnswerFrame(
    sessionId: string,
    submitId: string,
    accepted: boolean,
  ): ServerFrame {
    return {
      kind: 'submit.result',
      protocolVersion: 2,
      sessionId,
      submitId,
      accepted,
      ...(accepted ? {} : { code: 'bad_request' }),
    } as ServerFrame
  }

  /** A tool result: it rides a USER SDKMessage, exactly like a submitted prompt. */
  function toolResultFrame(sessionId: string): ServerFrame {
    return {
      kind: 'event',
      protocolVersion: 2,
      sessionId,
      event: {
        type: 'message',
        message: {
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' },
            ],
          },
          parent_tool_use_id: null,
          session_id: 'engine-1',
          uuid: '00000000-0000-4000-8000-000000000004',
        },
      },
    } as ServerFrame
  }

  function stagedSnapshotFrame(sessionId: string): ServerFrame {
    return {
      kind: 'queued-prompts.snapshot',
      protocolVersion: 2,
      sessionId,
      prompts: [{ id: 'q-1', text: 'and check the logs' }],
    } as ServerFrame
  }

  function turnStatusFrame(sessionId: string, activeTurn: boolean): ServerFrame {
    return {
      kind: 'event',
      protocolVersion: 2,
      sessionId,
      event: { type: 'turn.status', activeTurn },
    } as ServerFrame
  }

  test('the retained copy carries the images the draft never could', () => {
    // `↑` history stores strings (`reduceHistoryPushed`), so before this store
    // existed a refused image-bearing submit had NO recovery path at all.
    let state = createRetainedSubmitState()
    expect(selectRetainedSubmit(state, S1, 'sub-1')).toBeNull()
    state = reduceRetainedSubmitHeld(state, S1, {
      submitId: 'sub-1',
      text: 'look at this',
      images: [image],
    })
    state = reduceRetainedSubmitHeld(state, S2, {
      submitId: 'sub-2',
      text: 'other',
      images: [],
    })
    expect(selectRetainedSubmit(state, S1, 'sub-1')).toEqual({
      submitId: 'sub-1',
      text: 'look at this',
      images: [image],
    })
    expect(selectRetainedSubmit(state, null, 'sub-1')).toBeNull()
    state = reduceRetainedSubmitCleared(state, S1)
    expect(selectRetainedSubmit(state, S1, 'sub-1')).toBeNull()
    expect(selectRetainedSubmit(state, S2, 'sub-2')).toEqual({
      submitId: 'sub-2',
      text: 'other',
      images: [],
    })
  })

  test('clearing an absent session is identity (no needless re-render)', () => {
    const state = createRetainedSubmitState()
    expect(reduceRetainedSubmitCleared(state, S1)).toBe(state)
  })

  test('an answer retires the submit it names, not the oldest one', () => {
    // Two submits inside one round trip. Retiring by POSITION made the first
    // answer take the first entry no matter which submit it was for, so the
    // refusal that followed handed back the wrong message and the refused one
    // was lost with its image.
    let state = createRetainedSubmitState()
    state = reduceRetainedSubmitHeld(state, S1, {
      submitId: 'sub-first',
      text: 'first',
      images: [],
    })
    state = reduceRetainedSubmitHeld(state, S1, {
      submitId: 'sub-second',
      text: 'second',
      images: [image],
    })

    state = reduceRetainedSubmitSettled(state, S1, 'sub-second')
    expect(selectRetainedSubmit(state, S1, 'sub-second')).toBeNull()
    expect(selectRetainedSubmit(state, S1, 'sub-first')).toEqual({
      submitId: 'sub-first',
      text: 'first',
      images: [],
    })

    state = reduceRetainedSubmitSettled(state, S1, 'sub-first')
    expect(selectRetainedSubmit(state, S1, 'sub-first')).toBeNull()
  })

  test('an answer for an id this page never held changes nothing', () => {
    // What makes a replayed `submit.result` inert after a reload: the retained
    // map starts empty, so the id matches nothing.
    const empty = createRetainedSubmitState()
    expect(reduceRetainedSubmitSettled(empty, S1, 'sub-1')).toBe(empty)

    const state = reduceRetainedSubmitHeld(empty, S1, {
      submitId: 'sub-1',
      text: 'a',
      images: [],
    })
    expect(reduceRetainedSubmitSettled(state, S1, 'sub-other')).toBe(state)
    expect(reduceRetainedSubmitSettled(state, S2, 'sub-1')).toBe(state)
  })

  test('the retained store drops the oldest copy past its cap', () => {
    // Nothing infers an answer any more, so an unanswered copy is released only
    // by the cap. Each holds a full base64 image, so an uncapped store grew for
    // the life of the session.
    let state = createRetainedSubmitState()
    for (let index = 0; index < RETAINED_SUBMIT_CAP + 2; index += 1) {
      state = reduceRetainedSubmitHeld(state, S1, {
        submitId: `sub-${index}`,
        text: `message ${index}`,
        images: [image],
      })
    }
    expect(state[S1]).toHaveLength(RETAINED_SUBMIT_CAP)
    expect(selectRetainedSubmit(state, S1, 'sub-0')).toBeNull()
    expect(selectRetainedSubmit(state, S1, 'sub-1')).toBeNull()
    expect(selectRetainedSubmit(state, S1, 'sub-2')).not.toBeNull()
  })

  test('a closed session drops every retained copy, not just the head', () => {
    // Each copy holds a full base64 image and a closed session has nothing left
    // to resolve it, so the whole map goes.
    let state = createRetainedSubmitState()
    state = reduceRetainedSubmitHeld(state, S1, {
      submitId: 'sub-1',
      text: 'first',
      images: [image],
    })
    state = reduceRetainedSubmitHeld(state, S1, {
      submitId: 'sub-2',
      text: 'second',
      images: [],
    })
    state = reduceRetainedSubmitCleared(state, S1)
    expect(selectRetainedSubmit(state, S1, 'sub-1')).toBeNull()
    expect(reduceRetainedSubmitSettled(state, S1, 'sub-2')).toBe(state)
  })

  test('only a submit answer is an answer', () => {
    expect(selectSubmitAnswer(submitAnswerFrame(S1, 'sub-1', false))).toEqual({
      submitId: 'sub-1',
      accepted: false,
    })
    expect(selectSubmitAnswer(submitAnswerFrame(S1, 'sub-1', true))).toEqual({
      submitId: 'sub-1',
      accepted: true,
    })
    // Every frame the old reading leaned on. Each of these settled a retained
    // submit before, and each has producers that have nothing to do with one.
    expect(selectSubmitAnswer(userMessageFrame(S1))).toBeNull()
    expect(selectSubmitAnswer(errorFrame(S1))).toBeNull()
    expect(selectSubmitAnswer(stagedSnapshotFrame(S1))).toBeNull()
    expect(selectSubmitAnswer(turnStatusFrame(S1, false))).toBeNull()
    expect(
      selectSubmitAnswer({
        kind: 'lifecycle',
        protocolVersion: 2,
        sessionId: S1,
        status: 'exited',
      } as ServerFrame),
    ).toBeNull()
  })

  test('a realistic mid-turn batch restores the submit that was actually refused', () => {
    // THE REGRESSION THIS FILE EXISTS FOR, and it is only visible against a real
    // frame sequence. Two submits are outstanding; the first was staged into the
    // running turn, the second hit the depth cap. In between comes the ordinary
    // traffic of a running turn: a tool result (which rides a USER SDKMessage), a
    // republished staged snapshot, and the turn's closing bracket. Read
    // positionally, those three retired both copies before the refusal arrived,
    // so the refused message and its image were gone and the accepted one was
    // handed back instead.
    let state = createRetainedSubmitState()
    state = reduceRetainedSubmitHeld(state, S1, {
      submitId: 'sub-accepted',
      text: 'and check the logs',
      images: [],
    })
    state = reduceRetainedSubmitHeld(state, S1, {
      submitId: 'sub-refused',
      text: 'look at this',
      images: [image],
    })

    const batch: ServerFrame[] = [
      submitAnswerFrame(S1, 'sub-accepted', true),
      toolResultFrame(S1),
      stagedSnapshotFrame(S1),
      turnStatusFrame(S1, false),
      submitAnswerFrame(S1, 'sub-refused', false),
    ]
    const outcome = reduceSubmitAnswers(state, batch)

    expect(outcome.restored).toEqual([
      {
        sessionId: S1,
        retained: {
          submitId: 'sub-refused',
          text: 'look at this',
          images: [image],
        },
      },
    ])
    expect(outcome.state[S1]).toBeUndefined()
  })

  test('a park refusal carrying a recall’s id cannot refuse a submit', () => {
    // `handlePromptRecall`'s parking branch answers with the RECALL's requestId
    // on an error frame. Positionally that read as a refusal of whatever submit
    // was at the head, and handed the user back a message that was on its way to
    // the model.
    const state = reduceRetainedSubmitHeld(createRetainedSubmitState(), S1, {
      submitId: 'sub-1',
      text: 'live message',
      images: [],
    })
    const outcome = reduceSubmitAnswers(state, [
      {
        kind: 'error',
        protocolVersion: 2,
        sessionId: S1,
        requestId: 'recall-1',
        code: 'session_disconnected',
        message: 'session parking',
        retryable: true,
      } as ServerFrame,
    ])

    expect(outcome.restored).toEqual([])
    expect(outcome.state).toBe(state)
  })

  test('a submit main never forwarded is restored, not stranded', () => {
    // Main answers this one itself (`answerUnforwardedSubmit`): the frame never
    // reached the supervisor, so no sidecar will ever answer it. Classifying the
    // synthesized `session_not_found` error as "not a refusal" turned a certain
    // loss into a silent one, and the image was unrecoverable.
    const state = reduceRetainedSubmitHeld(createRetainedSubmitState(), S1, {
      submitId: 'sub-1',
      text: 'look at this',
      images: [image],
    })
    const outcome = reduceSubmitAnswers(state, [
      {
        kind: 'submit.result',
        protocolVersion: 2,
        sessionId: S1,
        submitId: 'sub-1',
        accepted: false,
        code: 'session_not_found',
      } as ServerFrame,
    ])

    expect(outcome.restored).toEqual([
      {
        sessionId: S1,
        retained: { submitId: 'sub-1', text: 'look at this', images: [image] },
      },
    ])
  })

  test('an image-only submit restores without prepending a blank line', () => {
    // `restoreDraftWithPending('typed after', '')` used to return
    // '\ntyped after' — the image-only submit carries no text at all.
    expect(restoreDraftWithPending('typed after', '')).toBe('typed after')
    expect(restoreDraftWithPending('', '')).toBe('')
  })
})

describe('D1b — folding recalled messages back into the composer', () => {
  test('several recalled messages join with newlines, oldest first', () => {
    // Terminal parity: `↑` pops EVERY editable queued command into the input at
    // once, joined by newlines, rather than making the user recall them one by
    // one (`src/utils/messageQueueManager.ts` popAllEditable).
    expect(
      foldRecalledPrompts([
        { id: 'a', prompt: 'first' },
        { id: 'b', prompt: 'second' },
      ]),
    ).toEqual({ text: 'first\nsecond', images: [] })
  })

  test('an image-bearing message comes back with its image, not just its text', () => {
    // D2: a mid-turn prompt carrying an image is a content-block array, and the
    // renderer holds no other copy of the bytes once the composer cleared.
    const folded = foldRecalledPrompts([
      {
        id: 'a',
        prompt: [
          { type: 'text', text: 'what is wrong here' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
          },
        ],
      },
    ])

    expect(folded.text).toBe('what is wrong here')
    expect(folded.images).toEqual([
      { id: 1, mediaType: 'image/png', data: 'AAAA', name: 'image' },
    ])
  })

  test('two image-bearing messages fold to ONE image, the most recent', () => {
    // The composer holds exactly one image and the submit schema caps base64 as
    // a total across the prompt, so restoring one per message would build a
    // draft the sidecar refuses, which the refusal path restores again: the
    // user can neither send nor easily clear it.
    const folded = foldRecalledPrompts([
      {
        id: 'a',
        prompt: [
          { type: 'text', text: 'first' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
          },
        ],
      },
      {
        id: 'b',
        prompt: [
          { type: 'text', text: 'second' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/webp', data: 'BBBB' },
          },
        ],
      },
    ])

    expect(folded.text).toBe('first\nsecond')
    expect(folded.images).toEqual([
      { id: 1, mediaType: 'image/webp', data: 'BBBB', name: 'image' },
    ])
  })

  test('an image-only message folds to no text at all', () => {
    // The composer merges this text under whatever is being typed, so an empty
    // string is what keeps a blank line out of a draft in progress.
    const folded = foldRecalledPrompts([
      {
        id: 'a',
        prompt: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/webp', data: 'BBBB' },
          },
        ],
      },
    ])

    expect(folded.text).toBe('')
    expect(folded.images).toHaveLength(1)
  })

  test('nothing recalled folds to nothing', () => {
    expect(foldRecalledPrompts([])).toEqual({ text: '', images: [] })
  })
})

describe('↑ takes waiting messages back before it walks history', () => {
  // Terminal parity: `handleHistoryUp` pops every editable queued command ahead
  // of prompt history (`src/components/PromptInput/PromptInput.tsx`). Escape is
  // deliberately NOT this key, so the composer's interrupt is untouched.
  test('waiting messages win over history, but only on ↑ and only with a handler', () => {
    expect(shouldRecallWaitingMessages('up', 1, true)).toBe(true)
    expect(shouldRecallWaitingMessages('up', 3, true)).toBe(true)

    // Nothing waiting: ↑ is the history key it has always been.
    expect(shouldRecallWaitingMessages('up', 0, true)).toBe(false)
    // ↓ never recalls. Recall means "everything still waiting", which has no
    // direction; the newer end of history is what ↓ is for.
    expect(shouldRecallWaitingMessages('down', 2, true)).toBe(false)
    // No handler wired (a pane with no recall path) must fall through to
    // history rather than swallow the keystroke.
    expect(shouldRecallWaitingMessages('up', 2, false)).toBe(false)
  })
})
