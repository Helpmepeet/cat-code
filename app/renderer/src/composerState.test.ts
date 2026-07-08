import { describe, expect, test } from 'bun:test'

import type { AgentConfigSnapshot } from '../../shared/protocol.js'
import {
  applyMention,
  countNewlines,
  createHistoryState,
  createPasteState,
  EMPTY_HISTORY_NAV,
  expandPasteRefs,
  formatPasteRef,
  HISTORY_CAP,
  navigateHistory,
  parseMentionQuery,
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
  return { definitions, failedFiles: [], availableMcpServers: [], notes: [] }
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
