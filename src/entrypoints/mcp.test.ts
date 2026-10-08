import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  FileReadTool,
  callFileReadToolWithPreparedCapability,
  type Output,
} from '../tools/FileReadTool/FileReadTool.js'
import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/prompt.js'
import { createFileStateCacheWithSizeLimit } from '../utils/fileStateCache.js'
import { getCwd } from '../utils/cwd.js'
import { setCwd } from '../utils/Shell.js'
import {
  registerMcpToolCallHandler,
  serializeMcpToolResult,
} from './mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

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
  const result = await callFileReadToolWithPreparedCapability(
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

describe('registered MCP FileRead handler', () => {
  test('prepares, normalizes, validates, and calls a real FileRead request', async () => {
    const previousCwd = getCwd()
    const previousSimple = process.env.CLAUDE_CODE_SIMPLE
    const filePath = join(tmpDir, 'registered-handler.txt')
    writeFileSync(filePath, 'handler read\n')
    setCwd(tmpDir)
    delete process.env.CLAUDE_CODE_SIMPLE
    let handler:
      | ((request: {
          params: { name: string; arguments?: Record<string, unknown> }
        }) => Promise<CallToolResult>)
      | undefined
    const server = {
      setRequestHandler(_schema: unknown, registered: unknown) {
        handler = registered as typeof handler
      },
    }

    try {
      registerMcpToolCallHandler(
        server as never,
        false,
        false,
        createFileStateCacheWithSizeLimit(10),
      )
      expect(handler).toBeDefined()
      const result = await handler!({
        params: {
          name: FILE_READ_TOOL_NAME,
          arguments: { file_path: filePath },
        },
      })
      expect(result.isError).not.toBe(true)
      expect(result.content[0]).toMatchObject({
        type: 'text',
        text: expect.stringContaining('handler read'),
      })

      const writeResult = await handler!({
        params: {
          name: 'Write',
          arguments: {
            file_path: join(tmpDir, 'registered-write.txt'),
            content: 'written through MCP\n',
          },
        },
      })
      expect(writeResult.isError).not.toBe(true)

      const editResult = await handler!({
        params: {
          name: 'Edit',
          arguments: {
            file_path: filePath,
            old_string: 'handler read',
            new_string: 'edited through MCP',
          },
        },
      })
      expect(editResult.isError).not.toBe(true)
    } finally {
      setCwd(previousCwd)
      if (previousSimple === undefined) delete process.env.CLAUDE_CODE_SIMPLE
      else process.env.CLAUDE_CODE_SIMPLE = previousSimple
    }
  })
})
