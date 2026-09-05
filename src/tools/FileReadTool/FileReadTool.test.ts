import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getAutoMemPath } from '../../memdir/paths.js'
import { getFileIdentity } from '../../utils/file.js'
import {
  createFileStateCacheWithSizeLimit,
  isCompleteUnboundedRead,
} from '../../utils/fileStateCache.js'
import { createAssistantMessage } from '../../utils/messages.js'
import {
  FileReadTool,
  MaxFileReadTokenExceededError,
  type Output,
  suggestedRetryLimit,
} from './FileReadTool.js'
import { DEFAULT_MAX_OUTPUT_TOKENS } from './limits.js'
import { MAX_LINES_TO_READ, OFFSET_INSTRUCTION_TARGETED } from './prompt.js'

let tmpDir: string
let priorSimple: string | undefined
let priorFixturesRoot: string | undefined

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'file-read-tool-'))
  // Skips skill discovery in call(), which would hit the real filesystem.
  priorSimple = process.env.CLAUDE_CODE_SIMPLE
  priorFixturesRoot = process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT
  process.env.CLAUDE_CODE_SIMPLE = '1'
  process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = tmpDir
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  if (priorSimple === undefined) delete process.env.CLAUDE_CODE_SIMPLE
  else process.env.CLAUDE_CODE_SIMPLE = priorSimple
  if (priorFixturesRoot === undefined) {
    delete process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT
  } else {
    process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = priorFixturesRoot
  }
})

/**
 * Real source files end with a newline, and readFileInRange counts a phantom
 * empty final line for those. Fixtures default to that shape so the tests see
 * what production sees.
 */
function writeLines(
  name: string,
  count: number,
  options: { trailingNewline?: boolean; compact?: boolean } = {},
): string {
  const filePath = join(tmpDir, name)
  const lines = Array.from({ length: count }, (_, i) =>
    options.compact ? 'x' : `line ${i + 1}`,
  )
  const trailing = options.trailingNewline === false ? '' : '\n'
  writeFileSync(filePath, lines.join('\n') + trailing, 'utf-8')
  return filePath
}

function createContext(maxTokens?: number) {
  return {
    readFileState: createFileStateCacheWithSizeLimit(100),
    abortController: new AbortController(),
    ...(maxTokens === undefined ? {} : { fileReadingLimits: { maxTokens } }),
  }
}

async function readWith(
  context: ReturnType<typeof createContext>,
  filePath: string,
  input: { offset?: number; limit?: number } = {},
): Promise<Extract<Output, { type: 'text' }>> {
  const result = await FileReadTool.call(
    { file_path: filePath, ...input },
    context as never,
  )
  const data = result.data as Output
  if (data.type !== 'text') throw new Error(`expected text, got ${data.type}`)
  return data
}

async function readFile(
  filePath: string,
  input: { offset?: number; limit?: number } = {},
): Promise<Extract<Output, { type: 'text' }>['file']> {
  return (await readWith(createContext(), filePath, input)).file
}

describe('default line limit', () => {
  test('a no-limit read stops at MAX_LINES_TO_READ', async () => {
    const filePath = writeLines('long.txt', MAX_LINES_TO_READ + 500, {
      compact: true,
    })

    const file = await readFile(filePath)

    // Before the clamp existed this returned every line, so the read only
    // discovered it had blown maxTokens after paying for the whole file.
    expect(file.numLines).toBe(MAX_LINES_TO_READ)
    expect(file.content.endsWith('x')).toBe(true)
    // +1: readFileInRange counts a phantom empty line for the trailing
    // newline. Pre-existing, and why the notice cannot derive truncation
    // from these totals.
    expect(file.totalLines).toBe(MAX_LINES_TO_READ + 500 + 1)
  })

  test('an explicit limit still wins over the default', async () => {
    const filePath = writeLines('long-explicit.txt', MAX_LINES_TO_READ + 500)

    const file = await readFile(filePath, { limit: 10 })

    expect(file.numLines).toBe(10)
  })

  test('a file shorter than the default is returned whole', async () => {
    const filePath = writeLines('short.txt', 12, { trailingNewline: false })

    const file = await readFile(filePath)

    expect(file.numLines).toBe(12)
    expect(file.totalLines).toBe(12)
    expect(file.content.endsWith('line 12')).toBe(true)
  })
})

describe('partial read notice', () => {
  function render(data: Extract<Output, { type: 'text' }>): string {
    const block = FileReadTool.mapToolResultToToolResultBlockParam(
      data,
      'toolu-file-read',
    )
    return typeof block.content === 'string'
      ? block.content
      : JSON.stringify(block.content)
  }

  async function renderRead(
    filePath: string,
    input: { offset?: number; limit?: number } = {},
  ): Promise<string> {
    return render(await readWith(createContext(), filePath, input))
  }

  test('a clamped read is marked partial and names the next offset', async () => {
    const filePath = writeLines('notice.txt', MAX_LINES_TO_READ + 500, {
      compact: true,
    })

    const rendered = await renderRead(filePath)

    // Without this the model sees 2000 numbered lines and no signal that the
    // file continues, so it concludes it read the whole thing.
    expect(rendered).toContain('partial view')
    expect(rendered).toContain(`offset ${MAX_LINES_TO_READ + 1}`)
  })

  test('a complete read carries no notice', async () => {
    const filePath = writeLines('complete.txt', 12)

    expect(await renderRead(filePath)).not.toContain('partial view')
  })

  test('a range ending exactly at the last line carries no notice', async () => {
    const filePath = writeLines('exact.txt', 12)

    const rendered = await renderRead(filePath, { offset: 3, limit: 10 })

    expect(rendered).not.toContain('partial view')
  })

  test('a file of exactly the cap length is not called partial', async () => {
    // The trailing newline makes readFileInRange report totalLines = 2001, so
    // deriving truncation from the line totals alone claims a 2001st line the
    // model can never read.
    const filePath = writeLines('exactly-cap.txt', MAX_LINES_TO_READ, {
      compact: true,
    })

    const rendered = await renderRead(filePath)

    expect(rendered).not.toContain('partial view')
  })

  test('a real line beyond the cap is still called partial', async () => {
    const filePath = writeLines('cap-plus-one.txt', MAX_LINES_TO_READ + 1, {
      trailingNewline: false,
      compact: true,
    })

    const rendered = await renderRead(filePath)

    expect(rendered).toContain('partial view')
  })
})

describe('truncated reads are not proof the file was read', () => {
  test('a clamped read records isTruncatedView', async () => {
    const filePath = writeLines('write-gate.txt', MAX_LINES_TO_READ + 500, {
      compact: true,
    })
    const context = createContext()

    await readWith(context, filePath)

    // FileWriteTool rejects on this flag: a write replaces the whole file, so
    // having seen only its head must not satisfy the read-before-write gate.
    expect(context.readFileState.get(filePath)?.isTruncatedView).toBe(true)
  })

  test('a complete read does not', async () => {
    const filePath = writeLines('write-gate-full.txt', 12)
    const context = createContext()

    await readWith(context, filePath)

    expect(context.readFileState.get(filePath)?.isTruncatedView).toBeUndefined()
  })

  test('an explicit range does not, since the caller chose it', async () => {
    const filePath = writeLines('write-gate-explicit.txt', 500)
    const context = createContext()

    await readWith(context, filePath, { limit: 10 })

    expect(context.readFileState.get(filePath)?.isTruncatedView).toBeUndefined()
  })
})

describe('byte cap applies only to no-limit reads', () => {
  // 300 KB spread over many short lines, so a small explicit range stays well
  // under maxTokens and the byte cap is the only thing under test.
  function writeOversizedFile(name: string): string {
    const filePath = join(tmpDir, name)
    const line = 'x'.repeat(99)
    writeFileSync(filePath, `${line}\n`.repeat(3200), 'utf-8')
    return filePath
  }

  test('an explicit range reads a file past the byte cap', async () => {
    // This bypass is what makes huge files (session transcripts) readable at
    // all, and the line clamp had to leave it intact, so it is pinned here.
    const file = await readFile(writeOversizedFile('huge.txt'), { limit: 5 })

    expect(file.numLines).toBe(5)
  })

  test('a no-limit read of the same file still throws pre-read', async () => {
    const filePath = writeOversizedFile('huge-nolimit.txt')

    await expect(readFile(filePath)).rejects.toThrow(/exceeds maximum/i)
  })
})

describe('prompt steers the model to targeted ranges', () => {
  test('the default prompt asks for the needed range, not the whole file', async () => {
    // GrowthBook is inert in this fork, so this arm is a hardcoded default. A
    // future upstream merge of limits.ts is what would silently revert it.
    const prompt = await FileReadTool.prompt()

    expect(prompt).toContain(OFFSET_INSTRUCTION_TARGETED)
    expect(prompt).not.toContain('recommended to read the whole file')
  })

  test('the offset and limit parameter text agrees with that prompt', () => {
    // These two descriptions used to say "only provide if the file is too
    // large to read at once", which told the model the opposite of both
    // OFFSET_INSTRUCTION_TARGETED and the system prompt's READ DISCIPLINE.
    const shape = FileReadTool.inputSchema.shape
    const offset = shape.offset.description ?? ''
    const limit = shape.limit.description ?? ''

    expect(offset).not.toContain('Only provide if the file is too large')
    expect(limit).not.toContain('Only provide if the file is too large')
    expect(offset).toContain('when you already know which part of the file')
    expect(limit).toContain('when you already know how much of the file')
  })
})

describe('suggestedRetryLimit', () => {
  test('scales the line count down by the token overshoot', () => {
    // 1000 lines cost 50k tokens against a 25k cap, so about half fit, less
    // the 10% headroom.
    expect(suggestedRetryLimit(1000, 25_000, 50_000)).toBe(450)
  })

  test('returns 0 when even one line cannot fit', () => {
    // A minified bundle: one line, far over the cap. Suggesting limit 1 would
    // send the model back into the identical failure.
    expect(suggestedRetryLimit(1, 25_000, 125_000)).toBe(0)
  })

  test('returns 0 for a degenerate range instead of dividing by zero', () => {
    expect(suggestedRetryLimit(0, 25_000, 50_000)).toBe(0)
    expect(suggestedRetryLimit(10, 25_000, 0)).toBe(0)
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

describe('token overflow prefixes', () => {
  test('returns a complete-line prefix with continuation and search guidance', async () => {
    const filePath = join(tmpDir, 'token-prefix.txt')
    writeFileSync(filePath, `${'x'.repeat(100)}\n`.repeat(100), 'utf-8')

    const data = await readWith(createContext(1_000), filePath)
    const rendered = FileReadTool.mapToolResultToToolResultBlockParam(
      data,
      'toolu-file-read',
    )
    const text = typeof rendered.content === 'string' ? rendered.content : ''

    expect(data.file.numLines).toBeLessThan(100)
    expect(data.file.content.endsWith('\n')).toBe(false)
    expect(text).toContain('partial view')
    expect(text).toContain('offset ')
    expect(text).toContain('Search for specific content')
  })

  test('still errors when one complete line cannot fit', async () => {
    const filePath = join(tmpDir, 'token-single-line.txt')
    writeFileSync(filePath, 'x'.repeat(20_000), 'utf-8')

    await expect(readWith(createContext(1_000), filePath)).rejects.toBeInstanceOf(
      MaxFileReadTokenExceededError,
    )
  })

  test('keeps a small first line when a much larger later line overflows', async () => {
    const filePath = join(tmpDir, 'token-skewed-lines.txt')
    writeFileSync(filePath, `ok\n${'x'.repeat(20_000)}`, 'utf-8')

    const data = await readWith(createContext(1_000), filePath)

    expect(data.file.content).toBe('ok')
    expect(data.file.numLines).toBe(1)
  })

  test('budgets line-number gutters as part of the returned prefix', async () => {
    const filePath = join(tmpDir, 'token-line-gutters.txt')
    writeFileSync(filePath, `${'x'}\n`.repeat(500), 'utf-8')

    const data = await readWith(createContext(1_000), filePath)
    const rendered = FileReadTool.mapToolResultToToolResultBlockParam(
      data,
      'toolu-file-read',
    )
    const text = typeof rendered.content === 'string' ? rendered.content : ''

    expect(data.file.numLines).toBeLessThan(500)
    expect(text).toContain('partial view')
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1_000)
  })

  test('keeps the rendered overflow prefix below the hard cap', async () => {
    const filePath = join(tmpDir, 'token-hard-cap.txt')
    writeFileSync(filePath, `${'x'.repeat(200)}\n`.repeat(1_000), 'utf-8')

    // A caller-supplied higher limit cannot lift the 25k hard ceiling.
    const data = await readWith(createContext(50_000), filePath)
    const rendered = FileReadTool.mapToolResultToToolResultBlockParam(
      data,
      'toolu-file-read',
    )
    const text = typeof rendered.content === 'string' ? rendered.content : ''
    expect(data.file.numLines).toBeLessThan(1_000)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(
      DEFAULT_MAX_OUTPUT_TOKENS,
    )
  })
})

describe('whole-file Write authorization provenance', () => {
  test('internal reads do not authorize Write, but model-visible reads do', async () => {
    const filePath = writeLines('authorization.txt', 2)
    const internalContext = createContext()
    await readWith(internalContext, filePath)

    expect(
      isCompleteUnboundedRead(internalContext.readFileState.get(filePath)),
    ).toBe(false)

    const visibleContext = createContext()
    await FileReadTool.call(
      { file_path: filePath },
      visibleContext as never,
      undefined,
      createAssistantMessage({ content: [] }),
    )

    const visibleState = visibleContext.readFileState.get(filePath)
    expect(isCompleteUnboundedRead(visibleState)).toBe(true)
    expect(visibleState?.fileIdentity?.canonicalPath).toBe(
      getFileIdentity(filePath).canonicalPath,
    )
  })
})

describe('memory freshness token budget', () => {
  test('includes a stale-memory reminder in the hard rendered limit', async () => {
    const memoryDir = join(tmpDir, 'memory')
    const filePath = join(memoryDir, 'stale.md')
    mkdirSync(memoryDir, { recursive: true })
    writeFileSync(filePath, `${'x'.repeat(100)}\n`.repeat(30), 'utf-8')
    const old = new Date(Date.now() - 3 * 86_400_000)
    utimesSync(filePath, old, old)

    const priorDisable = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
    const priorOverride = process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
    process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '0'
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = memoryDir
    getAutoMemPath.cache.clear()

    try {
      const data = await readWith(createContext(1_000), filePath)
      const rendered = FileReadTool.mapToolResultToToolResultBlockParam(
        data,
        'toolu-stale-memory',
      )
      const text = typeof rendered.content === 'string' ? rendered.content : ''

      expect(text).toContain('days old')
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1_000)
    } finally {
      if (priorDisable === undefined) {
        delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
      } else {
        process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = priorDisable
      }
      if (priorOverride === undefined) {
        delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
      } else {
        process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = priorOverride
      }
      getAutoMemPath.cache.clear()
    }
  })
})
