import { describe, expect, test } from 'bun:test'
import type { NestedTranscriptRow, ToolDiffProjection, ToolFamily } from './transcriptProjector.js'
import { deriveFocusedSegments, deriveFocusedTranscript, summarizeFocusedWork } from './focusedTranscriptLayout.js'

const base = (id: string) => ({ id, frameId: id, sessionId: 's', messageId: id, blockIndex: 0, parentToolUseId: null, children: [] })
const user = (id = 'u'): NestedTranscriptRow => ({ ...base(id), kind: 'user-text', role: 'user', content: 'Go', isReplay: false })
const text = (id: string): Extract<NestedTranscriptRow, { kind: 'assistant-text' }> => ({ ...base(id), kind: 'assistant-text', role: 'assistant', content: id })
const tool = (id = 't', family: ToolFamily = 'read'): NestedTranscriptRow => ({
  ...base(id), kind: 'tool-use', toolUseId: id, toolName: family, toolFamily: family,
  input: { file_path: '/a', command: 'bun test', pattern: 'needle' }, status: 'success', result: null, agentCompletion: null,
})
const result = (isError = false): NestedTranscriptRow => ({ ...base('r'), kind: 'result', subtype: isError ? 'error' : 'success', isError, errors: [], durationMs: 1234 })
const groups = (rows: readonly NestedTranscriptRow[], live = false) => deriveFocusedTranscript(rows, live).filter(x => x.kind === 'focused-turn')

describe('focused transcript layout', () => {
  test('live prose stays inside; successful final prose stays outside at turn end', () => {
    const rows = [user(), text('update'), tool(), text('answer')]
    const live = groups(rows, true)[0]!
    expect(live.rows.map(x => x.id)).toEqual(['update', 't', 'answer'])
    expect(live.live).toBe(true)
    expect(live.completed).toBe(false)
    expect(live.durationMs).toBeNull()
    const done = deriveFocusedTranscript([...rows, result()], false)
    const group = done.find(x => x.kind === 'focused-turn')!
    expect(group.rows.map(x => x.id)).toEqual(['update', 't'])
    if (group.kind !== 'focused-turn') throw Error('missing group')
    expect(group.completed).toBe(true)
    expect(group.durationMs).toBe(1234)
    expect(done.at(-1)?.rows.map(x => x.id)).toEqual(['answer', 'r'])
    expect(group.id).toBe(live.id)
  })
  test('explicit commentary is never an answer and a partial tagged answer does not hide stopped work', () => {
    const update = { ...text('update'), phase: 'commentary' as const } as NestedTranscriptRow
    const answer = { ...text('answer'), phase: 'final_answer' as const } as NestedTranscriptRow
    const commentaryOnly = groups([user(), tool(), update, result()])[0]!
    expect(commentaryOnly.rows.map(row => row.id)).toEqual(['t', 'update'])
    expect(commentaryOnly.completed).toBe(false)
    for (const end of [result(true), { ...base('stop'), kind: 'turn-stopped' } as NestedTranscriptRow]) {
      const items = deriveFocusedTranscript([user(), update, tool(), answer, end], false)
      const work = items.find(item => item.kind === 'focused-turn')!
      expect(work.rows.map(row => row.id)).toEqual(['update', 't'])
      expect(work.kind === 'focused-turn' && work.completed).toBe(false)
      expect(items.at(-1)?.rows.map(row => row.id)).toEqual(['answer', end.id])
    }
    const finalOnly = deriveFocusedTranscript([user(), answer], true)
    expect(finalOnly.flatMap(item => item.rows).map(row => row.id)).toEqual(['u', 'answer'])
    expect(finalOnly.every(item => item.kind === 'rows')).toBe(true)
  })
  test('stopped, failed and no-answer turns never collapse', () => {
    for (const end of [result(true), { ...base('stop'), kind: 'turn-stopped' } as NestedTranscriptRow, result()]) {
      const group = groups([user(), text('update'), tool(), end])[0]!
      expect(group.completed).toBe(false)
      expect(group.rows.map(x => x.id)).toEqual(['update', 't'])
    }
  })
  test('multiple turns, missing user and safe boundaries retain every row', () => {
    const notice: NestedTranscriptRow = { ...base('notice'), kind: 'system-notice', noticeType: 'provider_error', content: 'Fix credentials' }
    const injected: NestedTranscriptRow = { ...base('injected'), kind: 'injected-turn', injectedKind: 'unknown', label: null, content: 'hello', isReplay: true }
    for (const boundary of [notice, injected, { ...text('hidden'), isHidden: true as const }, { ...base('history'), kind: 'history-boundary', children: [] } as unknown as NestedTranscriptRow]) {
      const rows = [user(), tool(), boundary, text('tail'), result()]
      const items = deriveFocusedTranscript(rows, false)
      expect(items.flatMap(x => x.rows)).toEqual(rows)
      expect(groups(rows)[0]!.completed).toBe(boundary.kind !== 'history-boundary')
    }
    const continuation = groups([tool(), text('answer'), result()])
    expect(continuation).toHaveLength(1)
    expect(continuation[0]!.rows.map(row => row.id)).toEqual(['t'])
    expect(continuation[0]!.completed).toBe(true)
    expect(continuation[0]!.durationMs).toBeNull()
    expect(groups([user(), tool(), text('a'), result(), user('u2'), tool('t2'), text('b'), result()])).toHaveLength(2)
  })
  test('image-only and mixed submissions create a single working row immediately', () => {
    const image: NestedTranscriptRow = {
      ...base('image'), frameId: 'u', kind: 'user-image',
      source: { type: 'base64', mediaType: 'image/png', data: 'a' }, isReplay: false,
    }
    for (const submission of [[user()], [image], [image, user()], [user(), image, { ...image, id: 'image2' }]]) {
      const empty = groups(submission, true)
      expect(empty).toHaveLength(1)
      expect(empty[0]!.rows).toEqual([])
      expect(empty[0]!.live).toBe(true)
      expect(empty[0]!.completed).toBe(false)
      const working = groups([...submission, tool()], true)
      expect(working).toHaveLength(1)
      expect(working[0]!.id).toBe(empty[0]!.id)
      expect(working[0]!.rows.map(x => x.id)).toEqual(['t'])
      expect(groups(submission)).toHaveLength(0)
    }
  })
  test('control points preserve position and resume distinct focused fragments without duplicated duration', () => {
    const notice: NestedTranscriptRow = { ...base('notice'), kind: 'system-notice', noticeType: 'provider_error', content: 'Fix credentials' }
    const injected: NestedTranscriptRow = { ...base('injected'), kind: 'injected-turn', injectedKind: 'unknown', label: null, content: 'hello', isReplay: true }
    const rows = [user(), text('update'), tool(), notice, text('continued'), tool('t2'), injected, tool('t3'), text('answer')]
    const live = groups(rows, true)
    const doneRows = [...rows, result()]
    const items = deriveFocusedTranscript(doneRows, false)
    const done = groups(doneRows)
    expect(done).toHaveLength(3)
    expect(done.map(x => x.id)).toEqual(live.map(x => x.id))
    expect(new Set(done.map(x => x.id)).size).toBe(3)
    expect(done.every(x => x.completed && x.durationMs === null)).toBe(true)
    expect(done.map(x => x.toolCalls)).toEqual([1, 1, 1])
    expect(items.flatMap(x => x.rows)).toEqual(doneRows)
    expect(items.filter(x => x.kind === 'rows').flatMap(x => x.rows).map(x => x.id)).toEqual(['u', 'notice', 'injected', 'answer', 'r'])
    for (const end of [result(true), { ...base('stop'), kind: 'turn-stopped' } as NestedTranscriptRow]) {
      const failed = groups([...rows, end])
      expect(failed.every(x => !x.completed)).toBe(true)
      expect(failed.at(-1)!.rows.at(-1)!.id).toBe('answer')
    }
  })
  test('display dividers split work while sharing completion evidence across the whole turn', () => {
    const rows = [user(), text('update'), tool(), text('continued'), tool('t2'), text('answer')]
    const fragmentAfter = new Set(['update', 'continued'])
    const derive = (input: NestedTranscriptRow[], live = false) => deriveFocusedTranscript(input, live, fragmentAfter)
    const focused = (input: NestedTranscriptRow[], live = false) => derive(input, live).filter(item => item.kind === 'focused-turn')
    const live = focused(rows, true)
    expect(live.map(item => item.rows.map(row => row.id))).toEqual([['update'], ['t', 'continued'], ['t2', 'answer']])
    expect(live.every(item => item.live && !item.completed)).toBe(true)
    const doneRows = [...rows, result()]
    const done = focused(doneRows)
    expect(done.map(item => item.id)).toEqual(live.map(item => item.id))
    expect(done.map(item => item.rows.map(row => row.id))).toEqual([['update'], ['t', 'continued'], ['t2']])
    expect(done.every(item => !item.live && item.completed && item.answering && item.durationMs === null)).toBe(true)
    expect(derive(doneRows).flatMap(item => item.rows)).toEqual(doneRows)
    // Calls without divider positions still use the unsplit cached layout.
    expect(groups(doneRows)).toHaveLength(1)
    expect(groups(doneRows)[0]!.durationMs).toBe(1234)
    const replay = [...rows.slice(0, -1), { ...text('answer'), replayEndTurn: true as const }]
    expect(focused(replay).every(item => item.completed)).toBe(true)
    for (const end of [result(true), { ...base('stop'), kind: 'turn-stopped' } as NestedTranscriptRow]) {
      expect(focused([...rows, end]).every(item => !item.completed)).toBe(true)
    }
    expect(focused([...rows.slice(0, -1), { ...text('answer'), phase: 'commentary' as const }, result()])
      .every(item => !item.completed)).toBe(true)
  })
  test('other actions use human-readable labels and parallel pending label uses first call', () => {
    const summary = summarizeFocusedWork(['agent', 'agent-control', 'web', 'mcp', 'skill', 'imagegen', 'other'].map((family, i) => tool(`${i}`, family as ToolFamily)))
    expect(summary.summary).toBe('delegated 1 task, sent 1 agent request, made 1 web request, made 1 MCP call, used 1 skill, requested 1 image, made 1 tool call')
    // The head's compact form keeps one short entry per category.
    expect(summary.compact).toBe('delegated 1 · sent 1 · made 1 · made 1 · used 1 · requested 1 · made 1')
    const first = tool('first', 'bash'), second = tool('second')
    if (first.kind !== 'tool-use' || second.kind !== 'tool-use') throw Error('tool')
    first.status = second.status = 'pending'
    expect(summarizeFocusedWork([first, second]).activeLabel).toBe('Running bun test')
  })
  test('segments preserve reasoning and nested agent work without duplicated counts', () => {
    const agent = tool('agent', 'agent')
    agent.children.push(tool('child'))
    const thinking: NestedTranscriptRow = { ...base('think'), kind: 'thinking', content: 'consider' }
    const rows = [text('update'), thinking, agent, { ...thinking, id: 'empty', content: '' }, tool(), text('next'), tool('last')]
    const segments = deriveFocusedSegments(rows)
    expect(segments.map(x => x.kind)).toEqual(['update', 'reasoning', 'stretch', 'update', 'stretch'])
    expect(segments.flatMap(x => x.rows)).toEqual(rows)
    expect(segments[2]!.toolCalls).toBe(2)
    expect(segments[2]!.otherFamilies.agent).toBe(1)
    expect(deriveFocusedSegments(rows)).toBe(segments)
    expect(deriveFocusedSegments([...rows])[1]!.id).toBe(segments[1]!.id)
  })
  test('multi-file diffs count each patch once, unique paths, searches, commands and errors', () => {
    const diff = (filePath: string): ToolDiffProjection => ({ filePath, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new', ' unchanged'] }] })
    const edit = tool('edit', 'edit')
    if (edit.kind !== 'tool-use') throw Error('tool')
    edit.result = { isError: true, content: 'failed', diff: diff('/a'), fileDiffs: [diff('/a'), diff('/b')] }
    const summary = summarizeFocusedWork([tool(), tool('read2'), edit, tool('bash', 'bash'), tool('grep', 'grep')])
    expect(summary.readPaths).toEqual(['/a'])
    expect(summary.editedPaths).toEqual(['/a', '/b'])
    expect(summary.additions).toBe(2)
    expect(summary.deletions).toBe(2)
    expect(summary.hasErrors).toBe(true)
    expect(summary.summary).toContain('edited 2 files')
    expect(summary.searchedPatterns).toEqual(['needle'])
    expect(summary.commands).toBe(1)
    edit.status = 'pending'
    expect(summarizeFocusedWork([edit]).activeLabel).toBe('Editing /a')
  })
  test('identity cache respects live state and never mutates frozen input', () => {
    const rows = Object.freeze([user(), text('update'), tool(), text('answer'), result()].map(row => Object.freeze(row)))
    const before = JSON.stringify(rows)
    expect(deriveFocusedTranscript(rows, false)).toBe(deriveFocusedTranscript(rows, false))
    expect(deriveFocusedTranscript(rows, false)).not.toBe(deriveFocusedTranscript(rows, true))
    expect(JSON.stringify(rows)).toBe(before)
  })
})
