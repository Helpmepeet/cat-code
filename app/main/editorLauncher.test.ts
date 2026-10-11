import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import type { WorkspaceEditor } from './editorLauncher.js'

interface EditorReceipt {
  launcher: 'cli' | 'open'
  file: string
  line: number | null
  column: number | null
  selectedText: string
}

/** Real executable fixtures implement the documented editor CLI interfaces. */
function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'catcode-editor-process-'))
  const workspace = join(root, 'workspace')
  const binaries = join(root, 'bin')
  const receipt = join(root, 'receipt.json')
  mkdirSync(workspace)
  mkdirSync(binaries)
  const receiver = String.raw`#!${process.execPath}
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const isOpen = process.argv[1].endsWith('/open')
const editor = process.env.FIXTURE_EDITOR
let file, line = null, column = null
if (isOpen) {
  if (process.env.FIXTURE_OPEN_FAIL === '1') process.exit(1)
  if (args.length !== 3 || args[0] !== '-a' || args[1] !== 'Fixture Editor') process.exit(2)
  file = args[2]
} else {
  const goto = args[0] === '--goto'
  if (editor !== 'zed' && !goto && args.length !== 1) process.exit(2)
  if (editor === 'zed' && (goto || args.length !== 1)) process.exit(2)
  file = args[goto ? 1 : 0]
  if (goto || (editor === 'zed' && !existsSync(file))) {
    const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(file)
    if (!match) process.exit(3)
    file = match[1]
    line = Number(match[2])
    column = match[3] === undefined ? 1 : Number(match[3])
  }
}

const contents = readFileSync(file, 'utf8')
const selectedText = line === null ? contents : contents.split('\n')[line - 1]?.slice(column - 1)
writeFileSync(process.env.FIXTURE_RECEIPT, JSON.stringify({ launcher: isOpen ? 'open' : 'cli', file: realpathSync(file), line, column, selectedText }))
`
  for (const name of ['editor', 'open']) {
    const executable = join(binaries, name)
    writeFileSync(executable, receiver)
    chmodSync(executable, 0o755)
  }
  const entry = join(root, 'open-entry.ts')
  writeFileSync(entry, `
import { readFileSync } from 'node:fs'
import { openWorkspaceFile } from ${JSON.stringify(fileURLToPath(new URL('./openWorkspaceFile.ts', import.meta.url)))}
import { launchEditorApp } from ${JSON.stringify(fileURLToPath(new URL('./editorLauncher.ts', import.meta.url)))}
import { sessionDescriptorFixture } from ${JSON.stringify(fileURLToPath(new URL('../shared/sessionDescriptor.fixture.ts', import.meta.url)))}
const request = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const result = await openWorkspaceFile(request.input, [sessionDescriptorFixture({appSessionId: 'session-1', cwd: request.workspace})],
  (path, target, location) => launchEditorApp(target, 'Fixture Editor', request.binaries, path, location))
process.stdout.write(JSON.stringify(result))
`)
  return {
    root, workspace, receipt,
    async open(editor: WorkspaceEditor, path: string, openFails = false): Promise<{ opened: boolean; receipt: EditorReceipt | null }> {
      rmSync(receipt, { force: true })
      const request = join(root, 'request.json')
      writeFileSync(request, JSON.stringify({
        input: { appSessionId: 'session-1', path, target: editor },
        workspace,
        binaries: [join(binaries, 'missing-editor'), join(binaries, 'editor')],
      }))
      const child = Bun.spawn([process.execPath, entry, request], {
        env: {
          PATH: binaries,
          CLAUDE_CONFIG_DIR: join(root, 'config'),
          FIXTURE_EDITOR: editor,
          FIXTURE_RECEIPT: receipt,
          FIXTURE_OPEN_FAIL: openFails ? '1' : '0',
        },
        cwd: root,
        stdout: 'pipe', stderr: 'pipe',
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(stderr).toBe('')
      expect(exitCode).toBe(0)
      const opened = JSON.parse(stdout) as boolean
      if (opened) {
        const deadline = Date.now() + 2_000
        while (!existsSync(receipt) && Date.now() < deadline) {
          await Bun.sleep(10)
        }
      }
      return { opened, receipt: existsSync(receipt) ? JSON.parse(readFileSync(receipt, 'utf8')) : null }
    },
  }
}

async function createNodeLauncherFixture() {
  const root = mkdtempSync(join(tmpdir(), 'catcode-node-editor-'))
  const node = Bun.which('node')
  if (!node) throw new Error('Node is required to verify the Electron main runtime contract')
  const entry = join(root, 'launcher-entry.ts')
  writeFileSync(entry, `
import { launchEditorApp } from ${JSON.stringify(fileURLToPath(new URL('./editorLauncher.ts', import.meta.url)))}
const accepted = await launchEditorApp('vscode', 'Fixture Editor', process.argv.slice(2), ${JSON.stringify(join(root, 'source.ts'))}, {line: 4, column: 7})
process.stdout.write(JSON.stringify(accepted))
`)
  const build = await Bun.build({ entrypoints: [entry], outdir: root, target: 'node', format: 'esm' })
  if (!build.success) throw new Error(build.logs.join('\n'))
  const accepted = join(root, 'accepted')
  const completed = join(root, 'completed')
  const receiver = join(root, 'receiver.mjs')
  const delayed = join(root, 'delayed.mjs')
  for (const [path, body] of [
    [receiver, `writeFileSync(${JSON.stringify(accepted)}, 'accepted'); process.exit(0)`],
    [delayed, `setTimeout(() => { writeFileSync(${JSON.stringify(completed)}, 'completed'); process.exit(Number(process.env.FIXTURE_EXIT_CODE)) }, Number(process.env.FIXTURE_DELAY_MS))`],
  ] as const) {
    writeFileSync(path, `#!${node}\nimport { writeFileSync } from 'node:fs'\n${body}\n`)
    chmodSync(path, 0o755)
  }
  return {
    root, accepted, completed,
    async run(delayMs: number, exitCode: number) {
      const child = Bun.spawn([node, build.outputs[0]!.path, join(root, 'missing'), delayed, receiver], {
        cwd: root,
        env: { FIXTURE_DELAY_MS: String(delayMs), FIXTURE_EXIT_CODE: String(exitCode) },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      expect(stderr).toBe('')
      expect(code).toBe(0)
      return JSON.parse(stdout) as boolean
    },
    async waitForCompletion() {
      const deadline = Date.now() + 7_000
      while (!existsSync(completed) && Date.now() < deadline) await Bun.sleep(10)
      expect(existsSync(completed)).toBe(true)
    },
  }
}

test('workspace citations select the requested text through each editor CLI after a missing candidate', async () => {
  const fixture = createFixture()
  try {
    const source = join(fixture.workspace, 'source # $(touch SHOULD_NOT_EXIST); "ไทย".ts')
    writeFileSync(source, 'one\ntwo\nthree\nABCDEFtarget\nfive')
    for (const editor of ['vscode', 'cursor', 'zed'] as const) {
      for (const [suffix, column, selectedText] of [
        [':0004', 1, 'ABCDEFtarget'],
        [':0004:0007', 7, 'target'],
      ] as const) {
        const result = await fixture.open(editor, `${source}${suffix}`)
        expect(result.opened).toBe(true)
        expect(result.receipt).toEqual({ launcher: 'cli', file: realpathSync(source), line: 4, column, selectedText })
      }
    }
    expect(existsSync(join(fixture.root, 'SHOULD_NOT_EXIST'))).toBe(false)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('literal colon filenames stay literal, and unsupported VS Code or Cursor locations launch nothing', async () => {
  const fixture = createFixture()
  try {
    const literal = join(fixture.workspace, 'report:2026')
    writeFileSync(literal, 'Literal report')
    writeFileSync(join(fixture.workspace, 'report'), 'Different file')
    for (const editor of ['vscode', 'cursor', 'zed'] as const) {
      const result = await fixture.open(editor, literal)
      expect(result.opened).toBe(true)
      expect(result.receipt).toEqual({
        launcher: process.platform === 'darwin' ? 'open' : 'cli',
        file: realpathSync(literal), line: null, column: null, selectedText: 'Literal report',
      })
    }
    for (const editor of ['vscode', 'cursor'] as const) {
      const result = await fixture.open(editor, `${literal}:4:7`)
      expect(result).toEqual({ opened: false, receipt: null })
    }
    const fallback = await fixture.open('zed', literal, true)
    expect(fallback.opened).toBe(true)
    expect(fallback.receipt).toEqual({
      launcher: 'cli', file: realpathSync(literal), line: null, column: null, selectedText: 'Literal report',
    })
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('Zed locations cannot be reinterpreted as a different existing literal file or escaping symlink', async () => {
  const fixture = createFixture()
  try {
    const source = join(fixture.workspace, 'source.ts')
    const collision = `${source}:4:7`
    const outside = join(fixture.root, 'outside.ts')
    writeFileSync(source, 'one\ntwo\nthree\nABCDEFtarget')
    writeFileSync(outside, 'Outside workspace')
    for (const kind of ['file', 'symlink'] as const) {
      if (kind === 'file') writeFileSync(collision, 'Different literal file')
      else symlinkSync(outside, collision)
      const result = await fixture.open('zed', `${source}:0004:0007`)
      expect(result).toEqual({ opened: false, receipt: null })
      rmSync(collision)
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('Node waits for a delayed rejected CLI before trying the next executable', async () => {
  const fixture = await createNodeLauncherFixture()
  try {
    const result = await fixture.run(500, 1)
    await fixture.waitForCompletion()
    expect(result).toBe(true)
    expect(existsSync(fixture.accepted)).toBe(true)
  } finally {
    await fixture.waitForCompletion()
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('Node reports an unresolved CLI launch as false without starting a duplicate candidate', async () => {
  const fixture = await createNodeLauncherFixture()
  try {
    const result = await fixture.run(5_500, 0)
    await fixture.waitForCompletion()
    expect(result).toBe(false)
    expect(existsSync(fixture.accepted)).toBe(false)
  } finally {
    await fixture.waitForCompletion()
    rmSync(fixture.root, { recursive: true, force: true })
  }
}, 10_000)
