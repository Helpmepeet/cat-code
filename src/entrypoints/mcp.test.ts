import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { FileReadTool, type Output } from '../tools/FileReadTool/FileReadTool.js'
import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/prompt.js'
import { createFileStateCacheWithSizeLimit } from '../utils/fileStateCache.js'
import { serializeMcpToolResult } from './mcp.js'

let tmpDir: string
let priorSimple: string | undefined

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mcp-file-read-'))
  priorSimple = process.env.CLAUDE_CODE_SIMPLE
  process.env.CLAUDE_CODE_SIMPLE = '1'
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  if (priorSimple === undefined) delete process.env.CLAUDE_CODE_SIMPLE
  else process.env.CLAUDE_CODE_SIMPLE = priorSimple
})

async function readText(
  filePath: string,
  input: { offset?: number; limit?: number } = {},
  maxTokens?: number,
): Promise<Extract<Output, { type: 'text' }>> {
  const result = await FileReadTool.call(
    { file_path: filePath, ...input },
    {
      readFileState: createFileStateCacheWithSizeLimit(10),
      abortController: new AbortController(),
      ...(maxTokens === undefined ? {} : { fileReadingLimits: { maxTokens } }),
    } as never,
  )
  const data = result.data as Output
  if (data.type !== 'text') throw new Error(`expected text, got ${data.type}`)
  return data
}

function ordinaryModelText(data: Extract<Output, { type: 'text' }>): string {
  const block = FileReadTool.mapToolResultToToolResultBlockParam(data, 'toolu')
  if (typeof block.content !== 'string') {
    throw new Error('expected text tool result')
  }
  return block.content
}

describe('MCP FileRead serialization', () => {
  test('preserves continuation and search guidance for a token-truncated read', async () => {
    const filePath = join(tmpDir, 'token-truncated.txt')
    writeFileSync(
      filePath,
      Array.from({ length: 100 }, (_, i) => `line ${i} ${'x'.repeat(80)}`).join(
        '\n',
      ),
    )
    const data = await readText(filePath, {}, 500)

    const mcpText = serializeMcpToolResult(FILE_READ_TOOL_NAME, { data })
    expect(mcpText).toBe(ordinaryModelText(data))
    expect(mcpText).toContain('partial view')
    expect(mcpText).toContain('Read again with offset')
    expect(mcpText).toContain('Search for specific content')
  })

  test('keeps a complete read free of continuation guidance', async () => {
    const filePath = join(tmpDir, 'complete.txt')
    writeFileSync(filePath, 'one\ntwo\n')
    const data = await readText(filePath)

    const mcpText = serializeMcpToolResult(FILE_READ_TOOL_NAME, { data })
    expect(mcpText).toBe(ordinaryModelText(data))
    expect(mcpText).not.toContain('partial view')
  })

  test('matches ordinary rendering for an explicit range', async () => {
    const filePath = join(tmpDir, 'range.txt')
    writeFileSync(filePath, 'one\ntwo\nthree\n')
    const data = await readText(filePath, { offset: 2, limit: 1 })

    const mcpText = serializeMcpToolResult(FILE_READ_TOOL_NAME, { data })
    expect(mcpText).toBe(ordinaryModelText(data))
    expect(mcpText).toMatch(/2(?:→|\t)two/)
    expect(mcpText).not.toContain('partial view')
  })
})
