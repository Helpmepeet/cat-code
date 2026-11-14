import { describe, expect, test } from 'bun:test'
import { isMemoryRecall, memoryReadPath, parseMemoryNote, selectMemoryNote } from './memoryRecall.js'
import { deriveFocusedSegments, summarizeFocusedWork } from './focusedTranscriptLayout.js'
import { groupToolRuns, toolRunFamily } from './toolRunLayout.js'
import type { NestedToolUseRow } from './transcriptProjector.js'

const path = '/custom/config/projects/-work-project/memory/project_database.md'
function read(id = 'recall', filePath = path): NestedToolUseRow {
  return { id, frameId: id, sessionId: 's', messageId: id, blockIndex: 0, parentToolUseId: null,
    kind: 'tool-use', toolUseId: id, toolName: 'Read', toolFamily: 'read', input: { file_path: filePath },
    status: 'success', result: null, agentCompletion: null, children: [] }
}
const numbered = (text: string, start = 1) => text.split('\n').map((line, i) => `${i + start}\t${line}`).join('\n')
const body = '---\nname: Database conventions\ndescription: Use a real database.\ntype: project\n---\n\nUse **real connections**.\n\nKeep transactions short.'

describe('memory recall', () => {
  test('detects reads independent of config base and preserves ordinary files and writes', () => {
    expect(memoryReadPath(read())).toBe(path)
    expect(memoryReadPath(read('win', 'D:\\custom\\projects\\-work\\memory\\feedback.md'))).not.toBeNull()
    expect(memoryReadPath(read('nested', '/config/projects/-work/memory/topics/a.md'))).not.toBeNull()
    for (const ordinary of ['/work/memory/project.md', '/work/projects/foo/src/a.md', '/config/projects/-work/memory/../a.md', 'projects/-work/memory/a.md', '/config/projects/-work/memory/a.txt']) {
      expect(memoryReadPath(read('ordinary', ordinary))).toBeNull()
    }
    expect(memoryReadPath({ ...read(), toolFamily: 'write' })).toBeNull()
    expect(memoryReadPath({ ...read(), toolFamily: 'edit' })).toBeNull()
  })

  test('frontmatter, numbering, body, quoted strings and folded YAML', () => {
    const note = parseMemoryNote(path, numbered(body))
    expect(note).toMatchObject({ name: 'Database conventions', type: 'project', description: 'Use a real database.', age: null })
    expect(note.body).toBe('Use **real connections**.\n\nKeep transactions short.')
    expect(parseMemoryNote(path, numbered(body.replace('Database conventions', '"Database: conventions"'))).name).toBe('Database: conventions')
    expect(parseMemoryNote(path, numbered(body.replace('Use a real database.', '>\n  Use a real\n  database.'))).description).toBe('Use a real database.\n')
  })

  test('age is taken only from the leading engine reminder, before numbering', () => {
    const reminder = '<system-reminder>This memory is 47 days old. Verify current code.</system-reminder>\n'
    expect(parseMemoryNote(path, reminder + numbered(body))).toMatchObject({ age: 47, name: 'Database conventions' })
    expect(parseMemoryNote(path, numbered(body + '\n' + reminder)).age).toBeNull()
    expect(parseMemoryNote(path, reminder.replace('47', '1') + numbered(body)).age).toBeNull()
  })

  test('malformed, partial and non-scalar frontmatter fall back to source and filename', () => {
    for (const content of ['not frontmatter', body.replace('name: Database conventions', 'name: [one, two]'), body.replace('type: project', 'type: ['), body.replace('type: project\n', ''), numbered(body, 10)]) {
      expect(parseMemoryNote(path, content)).toMatchObject({ name: 'project_database', type: null, body: null })
    }
    expect(parseMemoryNote('/config/projects/-work/memory/MEMORY.md', numbered('# Memories\n- A'))).toMatchObject({ name: 'memory index', body: '# Memories\n- A' })
  })

  test('failure, cancellation, review and approval keep ordinary read presentation', () => {
    expect(isMemoryRecall(read())).toBe(true)
    expect(isMemoryRecall({ ...read(), status: 'pending' })).toBe(true)
    expect(isMemoryRecall(read(), true)).toBe(false)
    expect(isMemoryRecall({ ...read(), status: 'error' })).toBe(false)
    expect(isMemoryRecall({ ...read(), status: 'cancelled' })).toBe(false)
    for (const outcome of ['blocked', 'reviewing', 'inconclusive'] as const) {
      expect(isMemoryRecall({ ...read(), autoModeReview: { type: 'tool.review', attemptId: 'attempt', toolUseId: 'recall', outcome, startedAt: 0 } })).toBe(false)
    }
  })

  test('recalls count separately and stay out of read runs without splitting ordinary neighbors', () => {
    const first = read('a', '/work/a.ts'), second = read('b', '/work/b.ts'), memory = read(), next = read('c', '/work/c.ts'), last = read('d', '/work/d.ts')
    const rows = [first, second, memory, next, last]
    expect(toolRunFamily(memory)).toBeNull()
    const grouped = groupToolRuns(rows.map(row => ({ kind: 'single' as const, row })))
    expect(grouped.map(item => item.kind)).toEqual(['tool-run', 'single', 'tool-run'])
    const segments = deriveFocusedSegments(rows)
    expect(segments.map(segment => segment.kind)).toEqual(['stretch', 'recall', 'stretch'])
    expect(deriveFocusedSegments(rows)).toBe(segments)
    expect(summarizeFocusedWork([first, memory, read('another')])).toMatchObject({ summary: 'read 1 file, recalled 2 memories', compact: 'read 1 · recalled 2', readPaths: ['/work/a.ts'] })
    expect(summarizeFocusedWork([memory]).summary).toBe('recalled 1 memory')
    expect(summarizeFocusedWork([{ ...memory, status: 'error' }]).summary).toBe('read 1 file')
  })

  test('unchanged rows reuse parsed notes; replacements invalidate them', () => {
    const row = read()
    expect(selectMemoryNote(row)).toBe(selectMemoryNote(row))
    expect(selectMemoryNote({ ...row })).not.toBe(selectMemoryNote(row))
  })
})
