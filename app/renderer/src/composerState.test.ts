import { describe, expect, test } from 'bun:test'

import type { AgentConfigSnapshot } from '../../shared/protocol.js'
import {
  applyMention,
  caretAtHistoryEdge,
  countNewlines,
  createHistoryState,
  createPasteState,
  EMPTY_HISTORY_NAV,
  expandPasteRefs,
  formatPasteRef,
  HISTORY_CAP,
  navigateHistory,
  parseMentionQuery,
  pasteTokenBeforeCaret,
  PASTE_MAX_LINES,
  PASTE_THRESHOLD,
  reduceHistoryPushed,
  reducePasteAdded,
  reducePasteRemoved,
  reducePastesPruned,
  reducePasteStateForDraftWrite,
  reduceSessionPastesCleared,
  selectAgentMentionItems,
  selectHistory,
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
  restoreDraftWithPending,
  selectComposerGate,
  selectPendingSubmit,
  selectTransportError,
  shouldReleasePendingSubmitOnStop,
  type ComposerGateInput,
} from './composerState.js'

const S1 = 's-1' as unknown as import('../../shared/protocol.js').SessionId
const S2 = 's-2' as unknown as import('../../shared/protocol.js').SessionId

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
    })
  })

  test('a previewed session HOLDS — this is the reported friction', () => {
    expect(planSessionSubmit(submitInput({ preview: true }))).toEqual({
      type: 'hold',
      text: 'hello',
    })
  })

  test('a mid-turn submit HOLDS — it waits for the turn, it is not dropped', () => {
    // `ready` + `inputEnabled: false` is exactly the mid-turn gate. The park is
    // the same one the spawn case uses, and `resolvePendingSubmit` already
    // answers 'wait' here, so the drain flushes it at the turn boundary.
    expect(
      planSessionSubmit(submitInput({ connectionInputEnabled: false })),
    ).toEqual({ type: 'hold', text: 'hello' })
    expect(planSessionSubmit(submitInput({ logInputEnabled: false }))).toEqual({
      type: 'hold',
      text: 'hello',
    })
  })

  test('one queued prompt at a time: a second mid-turn submit keeps its draft', () => {
    // 'ignore' leaves the text in the composer (submitSession returns before
    // retiring the draft), so the second prompt is visibly still there rather
    // than silently replacing the one already waiting on the turn.
    expect(
      planSessionSubmit(
        submitInput({ connectionInputEnabled: false, alreadyParked: true }),
      ),
    ).toEqual({ type: 'ignore' })
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
    expect(action).toEqual({ type: 'hold', text: `see ${body}`.trim() })
  })
})

describe('CC-16 parked prompt store', () => {
  test('hold / select / clear round-trip, keyed per session', () => {
    let state = createPendingSubmitState()
    expect(selectPendingSubmit(state, S1)).toBeNull()
    state = reducePendingSubmitHeld(state, S1, 'first')
    state = reducePendingSubmitHeld(state, S2, 'second')
    expect(selectPendingSubmit(state, S1)).toBe('first')
    expect(selectPendingSubmit(state, S2)).toBe('second')
    state = reducePendingSubmitCleared(state, S1)
    expect(selectPendingSubmit(state, S1)).toBeNull()
    expect(selectPendingSubmit(state, S2)).toBe('second')
  })

  test('empty text is never parked, and a null session selects nothing', () => {
    const state = reducePendingSubmitHeld(createPendingSubmitState(), S1, '')
    expect(selectPendingSubmit(state, S1)).toBeNull()
    expect(selectPendingSubmit(state, null)).toBeNull()
  })

  test('clearing an absent session is identity (no needless re-render)', () => {
    const state = createPendingSubmitState()
    expect(reducePendingSubmitCleared(state, S1)).toBe(state)
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

  test('ready but mid-turn keeps holding — it is not a failure', () => {
    expect(resolvePendingSubmit({ status: 'ready', inputEnabled: false })).toBe(
      'wait',
    )
  })

  test('every terminal status RELEASES the prompt back to the user', () => {
    for (const status of ['dead', 'failed', 'exited', 'disconnected'] as const) {
      expect(resolvePendingSubmit({ status, inputEnabled: false })).toBe(
        'release',
      )
    }
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
      shouldReleasePendingSubmitOnStop('also delete the old migration'),
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
