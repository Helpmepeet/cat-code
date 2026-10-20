import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ServerFrame } from '../../shared/protocol.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { TranscriptRowsView } from './TranscriptView.js'
import { ToolsExpandedContext } from './toolsExpanded.js'
import { createTranscriptState, projectServerFrame, selectNestedTranscriptRows } from './transcriptProjector.js'
import { MAX_MOUNTED_OUTPUT_LINES } from './lineWindow.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })

const sessionId = 'multi-file-patch'
const rawSecondLine = `secondAfter${'x'.repeat(4_000)}`
const tailLines = Array.from({ length: 400 }, (_, index) => `tail_${index}`)

async function projectPatchRows() {
  const patchInput = [
    '*** Begin Patch',
    '*** Update File: /repo/src/a.ts', '@@', '-firstBefore', '+firstAfter',
    '*** Update File: /repo/src/b.ts', '@@', '-secondBefore', `+${rawSecondLine}`,
    ...tailLines.map(line => `+${line}`),
    '*** Delete File: /repo/removed.ts',
    '*** Delete File: /repo/empty.txt',
    '*** Add File: /repo/created.txt',
    ...Array.from({ length: 300 }, (_, index) => `*** Add File: /repo/extra-${index}.txt`),
    '*** End Patch',
  ].join('\n')
  const beforeByPath = [
    ['/repo/src/a.ts', 'firstBefore\n'], ['/repo/src/b.ts', 'secondBefore\n'],
    ['/repo/removed.ts', 'removedContent\n'], ['/repo/empty.txt', ''],
  ]
  // Engine imports belong in their own process, outside the desktop TypeScript
  // compile boundary. The producer uses no filesystem writes or account calls.
  const producerScript = `
    import { FilePatchTool } from './src/tools/FilePatchTool/FilePatchTool.tsx'
    import { parseFilePatch } from './src/tools/FilePatchTool/parser.ts'
    import { applyPatchToBuffersPlanned } from './src/tools/FilePatchTool/applier.ts'
    import { outputSchema } from './src/tools/FilePatchTool/types.ts'
    import { boundPatchLinesForPersistence, firstLineForLanguageDetection, getPatchFromContents,
      MAX_PERSISTED_PATCH_LINE_LENGTH } from './src/utils/diff.ts'
    const { patchInput, beforeEntries } = await Bun.stdin.json()
    const beforeByPath = new Map(beforeEntries)
    const operations = parseFilePatch(patchInput).ops
    const applied = applyPatchToBuffersPlanned(operations, new Map(operations.map(operation => [
      operation.path, { path: operation.path, exists: beforeByPath.has(operation.path),
        buffer: { content: beforeByPath.get(operation.path) ?? '', encoding: 'utf8', lineEndings: 'LF' } },
    ])))
    const output = outputSchema().parse({ contractVersion: applied.contractVersion,
      files: applied.files.map(file => ({ path: file.path, type: file.type,
        firstLine: firstLineForLanguageDetection(file.before ?? file.after),
        structuredPatch: boundPatchLinesForPersistence(getPatchFromContents({
          filePath: file.path, oldContent: file.before ?? '', newContent: file.after ?? '',
        })),
      })),
    })
    console.log(JSON.stringify({ output, lineBound: MAX_PERSISTED_PATCH_LINE_LENGTH,
      toolResult: FilePatchTool.mapToolResultToToolResultBlockParam(output, 'multi-patch') }))
  `
  const configDirectory = mkdtempSync(join(tmpdir(), 'cat-code-multi-patch-'))
  let producer
  try {
    const child = Bun.spawn([process.execPath, '-e', producerScript], {
      cwd: fileURLToPath(new URL('../../..', import.meta.url)),
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDirectory,
        ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', CODEX_API_KEY: '' },
    })
    child.stdin.write(JSON.stringify({ patchInput, beforeEntries: beforeByPath }))
    child.stdin.end()
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    if (exitCode !== 0) throw new Error(`Patch producer failed: ${stderr}`)
    producer = JSON.parse(stdout)
  } finally {
    rmSync(configDirectory, { recursive: true, force: true })
  }
  const frames: ServerFrame[] = [
    {
      kind: 'ready', protocolVersion: 4, sessionId, engineSessionId: 'engine-multi-file-patch',
      payload: {
        type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false,
        abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [],
      },
    },
    {
      kind: 'event', protocolVersion: 4, sessionId,
      event: { type: 'message', message: {
        type: 'assistant', session_id: 'engine-multi-file-patch', parent_tool_use_id: null,
        uuid: '00000000-0000-4000-8000-00000000f101',
        message: {
          id: 'multi-patch-use', role: 'assistant', model: 'claude-sonnet-5',
          content: [{ type: 'tool_use', id: 'multi-patch', name: 'apply_patch', input: { input: patchInput } }],
          stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1, service_tier: null },
        },
      } },
    },
    {
      kind: 'event', protocolVersion: 4, sessionId,
      event: { type: 'message', message: {
        type: 'user', session_id: 'engine-multi-file-patch', parent_tool_use_id: null,
        uuid: '00000000-0000-4000-8000-00000000f102', isSynthetic: true,
        message: { role: 'user', content: [producer.toolResult] },
        tool_use_result: producer.output,
      } },
    },
  ]
  let state = createTranscriptState()
  for (const frame of frames) state = projectServerFrame(state, frame)
  return { rows: selectNestedTranscriptRows(state, sessionId), lineBound: producer.lineBound as number }
}

function button(root: ParentNode, label: string): HTMLButtonElement {
  const found = root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  expect(found).not.toBeNull()
  return found!
}

async function setInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

test('a production multi-file patch renders separate file cards and opens the matching retained diff with bounded DOM', async () => {
  const clipboardWrites: string[] = []
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => { clipboardWrites.push(text) } },
  })
  try {
    const projected = await projectPatchRows()
    const tree = await harness.mount(createElement(ToolsExpandedContext.Provider, { value: { expanded: false, setExpanded: () => {} } },
      createElement(TranscriptRowsView, { rows: projected.rows, cwd: '/repo' }),
    ))
    expect(tree.container.querySelector('[aria-label="File number"]')).toBeNull()
    expect(tree.container.querySelector('[aria-label="Next file"]')).toBeNull()
    const headers = [...tree.container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')]
    const first = headers.find(item => item.textContent?.includes('src/a.ts'))!
    const second = headers.find(item => item.textContent?.includes('src/b.ts'))!
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first.textContent).toContain('+1')
    expect(second.textContent).toContain('+401')
    expect(second.textContent).toContain('−1')
    expect(tree.container.textContent).not.toContain('firstAfter')
    expect(tree.container.textContent).not.toContain('secondAfter')
    await act(async () => { second.click() })
    expect(first.getAttribute('aria-expanded')).toBe('false')
    expect(second.getAttribute('aria-expanded')).toBe('true')
    expect(tree.container.textContent).toContain('tail_399')
    expect(tree.container.textContent).not.toContain('firstAfter')
    expect(headers.length).toBeLessThan(305)
    expect(tree.container.querySelectorAll('*').length).toBeLessThan(MAX_MOUNTED_OUTPUT_LINES * 6)
    const openFull = [...tree.container.querySelectorAll<HTMLButtonElement>('button')]
      .find(item => item.textContent?.trim() === 'Open full output')!
    expect(openFull).toBeDefined()
    await act(async () => { openFull.click() })

    const dialog = tree.container.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog).not.toBeNull()
    expect(dialog.textContent).toContain('Diff · /repo/src/b.ts')
    expect(dialog.querySelector<HTMLInputElement>('[aria-label="File number"]')!.value).toBe('2')
    expect(dialog.textContent).not.toContain('Diff · /repo/extra-299.txt')
    expect(dialog.querySelectorAll('[aria-label="Search output"]').length).toBe(2)
    expect(dialog.querySelectorAll('*').length).toBeLessThan(MAX_MOUNTED_OUTPUT_LINES * 6)

    await act(async () => { button(dialog, 'Copy output').click() })
    const expectedSecondDiff = [
      '-secondBefore',
      `${(`+${rawSecondLine}`).slice(0, projected.lineBound)}…`,
      ...tailLines.map(line => `+${line}`),
    ].join('\n')
    expect(clipboardWrites).toEqual([expectedSecondDiff])

    const search = dialog.querySelector<HTMLInputElement>('[aria-label="Search output"]')!
    await setInput(search, 'tail_399')
    await act(async () => { await harness.nextFrame() })
    expect(dialog.querySelector('mark')?.textContent).toBe('tail_399')

    await act(async () => { button(dialog, 'Next file').click() })
    expect(dialog.textContent).toContain('Diff · /repo/removed.ts')
    expect(dialog.textContent).toContain('Deleted')
    await act(async () => { button(dialog, 'Copy output').click() })
    expect(clipboardWrites.at(-1)).toBe('-removedContent')
    expect(dialog.querySelector<HTMLInputElement>('[aria-label="Search output"]')!.value).toBe('')

    await act(async () => { button(dialog, 'Next file').click() })
    expect(dialog.textContent).toContain('Diff · /repo/empty.txt')
    expect(dialog.textContent).toContain('Deleted')
    expect(dialog.textContent).toContain('No diff lines.')
    await act(async () => { button(dialog, 'Copy output').click() })
    expect(clipboardWrites.at(-1)).toBe('')

    const drawerFileNumber = dialog.querySelector<HTMLInputElement>('[aria-label="File number"]')!
    await setInput(drawerFileNumber, '305')
    expect(dialog.textContent).toContain('Diff · /repo/extra-299.txt')
    expect(dialog.textContent).toContain('Added')
    expect(button(dialog, 'Next file').disabled).toBe(true)
    expect(dialog.querySelectorAll('[aria-label="Search output"]').length).toBe(2)
    expect(dialog.querySelectorAll('*').length).toBeLessThan(MAX_MOUNTED_OUTPUT_LINES * 6)
  } finally {
    if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})
