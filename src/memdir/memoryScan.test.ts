import { afterEach, expect, mock, test } from 'bun:test'

const files = Array.from({ length: 250 }, (_, index) => `memory-${index}.md`)
let activeStats = 0
let maxActiveStats = 0
let headerReads = 0
let abortDuringHeaders: AbortController | null = null

const actualFsPromises = await import('fs/promises')

await mock.module('fs/promises', () => ({
  ...actualFsPromises,
  readdir: async () => files,
  stat: async (filePath: string) => {
    activeStats += 1
    maxActiveStats = Math.max(maxActiveStats, activeStats)
    await Promise.resolve()
    activeStats -= 1
    const match = filePath.match(/memory-(\d+)\.md$/)
    return { mtimeMs: Number(match?.[1] ?? 0) }
  },
}))

await mock.module('../utils/readFileInRange.js', () => ({
  readFileInRange: async (
    filePath: string,
    _start: number,
    _end: number,
    _encoding: undefined,
    signal: AbortSignal,
  ) => {
    headerReads += 1
    if (headerReads === 8) abortDuringHeaders?.abort()
    if (signal.aborted) throw new Error('aborted')
    const match = filePath.match(/memory-(\d+)\.md$/)
    return {
      content: `---\ndescription: memory ${match?.[1] ?? 'unknown'}\n---`,
      mtimeMs: Number(match?.[1] ?? 0),
    }
  },
}))

const { MAX_MEMORY_FILES, MEMORY_SCAN_CONCURRENCY, scanMemoryFiles } = await import('./memoryScan.js')

afterEach(() => {
  activeStats = 0
  maxActiveStats = 0
  headerReads = 0
  abortDuringHeaders = null
})

test('memory scan bounds metadata fan-out and opens headers only for newest survivors', async () => {
  const headers = await scanMemoryFiles('/memories', new AbortController().signal)

  expect(maxActiveStats).toBeLessThanOrEqual(MEMORY_SCAN_CONCURRENCY)
  expect(headerReads).toBe(MAX_MEMORY_FILES)
  expect(headers).toHaveLength(MAX_MEMORY_FILES)
  expect(headers[0]?.filename).toBe('memory-249.md')
  expect(headers.at(-1)?.filename).toBe('memory-50.md')
})

test('an already-aborted scan does not return partial memory headers', async () => {
  const controller = new AbortController()
  controller.abort()

  expect(await scanMemoryFiles('/memories', controller.signal)).toEqual([])
  expect(headerReads).toBe(0)
})

test('a mid-scan abort stops scheduling headers and returns no partial manifest', async () => {
  const controller = new AbortController()
  abortDuringHeaders = controller

  expect(await scanMemoryFiles('/memories', controller.signal)).toEqual([])
  expect(controller.signal.aborted).toBe(true)
  expect(headerReads).toBeLessThan(MAX_MEMORY_FILES)
})
