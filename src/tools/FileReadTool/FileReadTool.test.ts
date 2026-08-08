import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import {
  FileReadTool,
  MaxFileReadTokenExceededError,
  type Output,
} from './FileReadTool.js'
import { MAX_LINES_TO_READ } from './prompt.js'

let tmpDir: string
let priorSimple: string | undefined

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'file-read-tool-'))
  // Skips skill discovery in call(), which would hit the real filesystem.
  priorSimple = process.env.CLAUDE_CODE_SIMPLE
  process.env.CLAUDE_CODE_SIMPLE = '1'
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  if (priorSimple === undefined) delete process.env.CLAUDE_CODE_SIMPLE
  else process.env.CLAUDE_CODE_SIMPLE = priorSimple
})

const contexts: { abortController: AbortController }[] = []

afterEach(() => {
  for (const c of contexts) c.abortController.abort()
  contexts.length = 0
})

function writeLines(name: string, count: number): string {
  const filePath = join(tmpDir, name)
  const lines = Array.from({ length: count }, (_, i) => `line ${i + 1}`)
  writeFileSync(filePath, lines.join('\n'), 'utf-8')
  return filePath
}

function createContext() {
  const context = {
    readFileState: createFileStateCacheWithSizeLimit(100),
    abortController: new AbortController(),
    options: { isNonInteractiveSession: false },
  }
  contexts.push(context)
  return context as never
}

async function readFile(
  filePath: string,
  input: { offset?: number; limit?: number } = {},
): Promise<Extract<Output, { type: 'text' }>['file']> {
  const result = await FileReadTool.call(
    { file_path: filePath, ...input },
    createContext(),
  )
  const data = result.data as Output
  if (data.type !== 'text') throw new Error(`expected text, got ${data.type}`)
  return data.file
}

describe('default line limit', () => {
  test('a no-limit read stops at MAX_LINES_TO_READ', async () => {
    const filePath = writeLines('long.txt', MAX_LINES_TO_READ + 500)

    const file = await readFile(filePath)

    // Before the clamp existed this returned every line, so the read only
    // discovered it had blown maxTokens after paying for the whole file.
    expect(file.numLines).toBe(MAX_LINES_TO_READ)
    expect(file.totalLines).toBe(MAX_LINES_TO_READ + 500)
    expect(file.content.endsWith(`line ${MAX_LINES_TO_READ}`)).toBe(true)
  })

  test('an explicit limit still wins over the default', async () => {
    const filePath = writeLines('long-explicit.txt', MAX_LINES_TO_READ + 500)

    const file = await readFile(filePath, { limit: 10 })

    expect(file.numLines).toBe(10)
  })

  test('a file shorter than the default is returned whole', async () => {
    const filePath = writeLines('short.txt', 12)

    const file = await readFile(filePath)

    expect(file.numLines).toBe(12)
    expect(file.totalLines).toBe(12)
  })
})

describe('partial read notice', () => {
  function render(file: Extract<Output, { type: 'text' }>['file']): string {
    const block = FileReadTool.mapToolResultToToolResultBlockParam(
      { type: 'text', file },
      'toolu-file-read',
    )
    return typeof block.content === 'string'
      ? block.content
      : JSON.stringify(block.content)
  }

  test('a clamped read is marked partial and names the next offset', async () => {
    const filePath = writeLines('notice.txt', MAX_LINES_TO_READ + 500)

    const rendered = render(await readFile(filePath))

    // Without this the model sees 2000 numbered lines and no signal that the
    // file continues, so it concludes it read the whole thing.
    expect(rendered).toContain('partial view')
    expect(rendered).toContain(`offset ${MAX_LINES_TO_READ + 1}`)
    expect(rendered).toContain(`of ${MAX_LINES_TO_READ + 500}`)
  })

  test('a complete read carries no notice', async () => {
    const filePath = writeLines('complete.txt', 12)

    const rendered = render(await readFile(filePath))

    expect(rendered).not.toContain('partial view')
  })

  test('a range ending exactly at the last line carries no notice', async () => {
    const filePath = writeLines('exact.txt', 12)

    const rendered = render(await readFile(filePath, { offset: 3, limit: 10 }))

    expect(rendered).not.toContain('partial view')
  })
})

describe('MaxFileReadTokenExceededError', () => {
  test('names a concrete retry range when the line range is known', () => {
    const error = new MaxFileReadTokenExceededError(50_000, 25_000, {
      startLine: 1,
      totalLines: 8_000,
      suggestedLimit: 900,
    })

    expect(error.message).toContain('8000 lines')
    expect(error.message).toContain('offset 1')
    expect(error.message).toContain('limit 900')
  })

  test('falls back to generic advice without a line range', () => {
    const error = new MaxFileReadTokenExceededError(50_000, 25_000)

    expect(error.message).toContain('offset and limit')
    expect(error.tokenCount).toBe(50_000)
    expect(error.maxTokens).toBe(25_000)
  })
})
