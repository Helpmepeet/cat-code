import { describe, expect, test } from 'bun:test'
import { join } from 'path'
import type { Tool } from '../../Tool.js'
import { getAutoMemPath } from '../../memdir/paths.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_PATCH_TOOL_NAME } from '../../tools/FilePatchTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import {
  createAutoMemCanUseTool,
  getWrittenFilePaths,
  hasMemoryWritesSince,
} from './extractMemories.js'
import { buildExtractAutoOnlyPrompt } from './prompts.js'

describe('createAutoMemCanUseTool with Apply_patch', () => {
  const memoryDir = getAutoMemPath()
  const canUseTool = createAutoMemCanUseTool(memoryDir)
  const patchTool = { name: FILE_PATCH_TOOL_NAME } as Tool
  const editTool = { name: FILE_EDIT_TOOL_NAME } as Tool
  const writeTool = { name: FILE_WRITE_TOOL_NAME } as Tool

  test('allows an Apply_patch where all targets are inside the auto-memory directory', async () => {
    const memoryFile1 = join(memoryDir, 'notes.md')
    const memoryFile2 = join(memoryDir, 'user_prefs.md')

    const result = await canUseTool(patchTool, {
      input: `*** Begin Patch
*** Update File: ${memoryFile1}
@@
-old
+new
*** Add File: ${memoryFile2}
+preferred_name: Alice
*** End Patch
`,
    })

    expect(result.behavior).toBe('allow')
  })

  test('denies a multi-file Apply_patch when one target is outside auto-memory', async () => {
    const memoryFile = join(memoryDir, 'notes.md')
    const outsideFile = '/tmp/unsafe-escape.ts'

    const result = await canUseTool(patchTool, {
      input: `*** Begin Patch
*** Update File: ${memoryFile}
@@
-old
+new
*** Add File: ${outsideFile}
+console.log('pwned')
*** End Patch
`,
    })

    expect(result.behavior).toBe('deny')
    expect(result.message).toContain('all patch mutation targets must be within')
  })

  test('denies an Apply_patch whose source is inside memory but moveTo is outside', async () => {
    const memoryFile = join(memoryDir, 'notes.md')
    const outsideMoveDest = '/tmp/escaped.md'

    const result = await canUseTool(patchTool, {
      input: `*** Begin Patch
*** Update File: ${memoryFile}
*** Move to: ${outsideMoveDest}
@@
-old
+new
*** End Patch
`,
    })

    expect(result.behavior).toBe('deny')
    expect(result.message).toContain('all patch mutation targets must be within')
  })

  test('allows an Apply_patch with moveTo when both source and destination are inside memory', async () => {
    const memoryFileOld = join(memoryDir, 'old-notes.md')
    const memoryFileNew = join(memoryDir, 'new-notes.md')

    const result = await canUseTool(patchTool, {
      input: `*** Begin Patch
*** Update File: ${memoryFileOld}
*** Move to: ${memoryFileNew}
@@
-old
+new
*** End Patch
`,
    })

    expect(result.behavior).toBe('allow')
  })

  test('supports structured { ops: FilePatchOperation[] } input', async () => {
    const memoryFile = join(memoryDir, 'topic.md')
    const outsideFile = join(process.cwd(), 'src', 'index.ts')

    const allowResult = await canUseTool(patchTool, {
      ops: [
        { type: 'add', path: memoryFile, lines: ['line1'], noNewlineAtEndOfFile: false },
      ],
    })
    expect(allowResult.behavior).toBe('allow')

    const denyResult = await canUseTool(patchTool, {
      ops: [
        { type: 'add', path: memoryFile, lines: ['line1'], noNewlineAtEndOfFile: false },
        { type: 'update', path: outsideFile, hunks: [] },
      ],
    })
    expect(denyResult.behavior).toBe('deny')
  })

  test('denies malformed or empty patches', async () => {
    const emptyResult = await canUseTool(patchTool, {})
    expect(emptyResult.behavior).toBe('deny')

    const malformedResult = await canUseTool(patchTool, {
      input: 'not a valid patch envelope',
    })
    expect(malformedResult.behavior).toBe('deny')
  })

  test('preserves Edit and Write behavior inside and outside memory', async () => {
    const memoryFile = join(memoryDir, 'rules.md')
    const outsideFile = '/tmp/other.ts'

    expect((await canUseTool(editTool, { file_path: memoryFile })).behavior).toBe('allow')
    expect((await canUseTool(writeTool, { file_path: memoryFile })).behavior).toBe('allow')
    expect((await canUseTool(editTool, { file_path: outsideFile })).behavior).toBe('deny')
    expect((await canUseTool(writeTool, { file_path: outsideFile })).behavior).toBe('deny')
  })
})

describe('getWrittenFilePaths and hasMemoryWritesSince', () => {
  const memoryDir = getAutoMemPath()

  test('extracts single file from Edit and Write blocks', () => {
    expect(
      getWrittenFilePaths({
        type: 'tool_use',
        name: FILE_EDIT_TOOL_NAME,
        input: { file_path: 'notes.md' },
      }),
    ).toEqual(['notes.md'])

    expect(
      getWrittenFilePaths({
        type: 'tool_use',
        name: FILE_WRITE_TOOL_NAME,
        input: { file_path: 'rules.md' },
      }),
    ).toEqual(['rules.md'])

    expect(
      getWrittenFilePaths({
        type: 'tool_use',
        name: 'Grep',
        input: { pattern: 'test' },
      }),
    ).toEqual([])
  })

  test('extracts all mutation paths from Apply_patch blocks including moves', () => {
    const patchInput = `*** Begin Patch
*** Update File: file1.md
*** Move to: file2.md
@@
-a
+b
*** Add File: file3.md
+new
*** End Patch
`
    expect(
      getWrittenFilePaths({
        type: 'tool_use',
        name: FILE_PATCH_TOOL_NAME,
        input: { input: patchInput },
      }),
    ).toEqual(['file1.md', 'file2.md', 'file3.md'])
  })

  test('hasMemoryWritesSince recognizes Apply_patch targeting auto-memory', () => {
    const memoryFile = join(memoryDir, 'notes.md')
    const messages: Message[] = [
      {
        uuid: 'msg-1',
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: FILE_PATCH_TOOL_NAME,
              input: {
                input: `*** Begin Patch
*** Update File: ${memoryFile}
@@
-old
+new
*** End Patch
`,
              },
            },
          ],
        },
      } as AssistantMessage,
    ]

    expect(hasMemoryWritesSince(messages)).toBe(true)
  })

  test('hasMemoryWritesSince returns false if Apply_patch only touches files outside auto-memory', () => {
    const outsideFile = '/tmp/unrelated.ts'
    const messages: Message[] = [
      {
        uuid: 'msg-1',
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: FILE_PATCH_TOOL_NAME,
              input: {
                input: `*** Begin Patch
*** Update File: ${outsideFile}
@@
-old
+new
*** End Patch
`,
              },
            },
          ],
        },
      } as AssistantMessage,
    ]

    expect(hasMemoryWritesSince(messages)).toBe(false)
  })

  test('hasMemoryWritesSince respects sinceUuid boundary', () => {
    const memoryFile = join(memoryDir, 'notes.md')
    const messages: Message[] = [
      {
        uuid: 'old-turn',
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: FILE_PATCH_TOOL_NAME,
              input: {
                input: `*** Begin Patch
*** Update File: ${memoryFile}
@@
-old
+new
*** End Patch
`,
              },
            },
          ],
        },
      } as AssistantMessage,
      {
        uuid: 'checkpoint',
        type: 'user',
        message: { content: 'hello' },
      } as unknown as Message,
      {
        uuid: 'new-turn',
        type: 'assistant',
        message: { content: 'just text' },
      } as AssistantMessage,
    ]

    expect(hasMemoryWritesSince(messages, 'checkpoint')).toBe(false)
    expect(hasMemoryWritesSince(messages, 'old-turn')).toBe(false)
    expect(hasMemoryWritesSince(messages)).toBe(true)
  })
})

describe('Memory extraction prompts provider awareness', () => {
  test('GPT memory prompt specifies Apply_patch and not Edit', () => {
    const prompt = buildExtractAutoOnlyPrompt(5, '', false, 'openai')

    expect(prompt).toContain('Apply_patch/Write')
    expect(prompt).toContain('issue every required Write and Apply_patch call in parallel')
    expect(prompt).toContain('Apply_patch requires a prior Read of the same file')
    expect(prompt).toContain('successful write/patch tool results')
    expect(prompt).not.toContain('Edit/Write')
    expect(prompt).not.toContain('write/edit')
    expect(prompt).not.toContain('Edit requires a prior Read')
  })

  test('Claude memory prompt specifies Edit and not Apply_patch', () => {
    const prompt = buildExtractAutoOnlyPrompt(5, '', false, 'firstParty')

    expect(prompt).toContain('Edit/Write')
    expect(prompt).toContain('issue all Write/Edit calls in parallel')
    expect(prompt).toContain('Edit requires a prior Read of the same file')
    expect(prompt).not.toContain('Apply_patch')
  })
})
