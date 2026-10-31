import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { SessionDescriptor } from '../shared/hostApi.js'
import { sessionDescriptorFixture } from '../shared/sessionDescriptor.fixture.js'
import { openWorkspaceFile } from './openWorkspaceFile.js'
import { writeSessionRelocation } from '../../src/utils/sessionRelocationState.js'

function session(cwd: string): SessionDescriptor {
  return sessionDescriptorFixture({
    appSessionId: 'session-1',
    cwd,
    createdAt: 1,
    lastAttachedAt: 1,
  })
}

test('opens an existing workspace-relative regular file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catcode-open-file-'))
  try {
    mkdirSync(join(root, 'docs'))
    const report = join(root, 'docs', 'report.md')
    writeFileSync(report, '# Report')
    const opened: string[] = []

    expect(
      await openWorkspaceFile(
        { appSessionId: 'session-1', path: 'docs/report.md' },
        [session(root)],
        async path => {
          opened.push(path)
          return ''
        },
      ),
    ).toBe(true)
    expect(opened).toEqual([realpathSync(report)])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('local file URLs retain literal-first suffix resolution and canonical containment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catcode-file-url-'))
  const outside = mkdtempSync(join(tmpdir(), 'catcode-file-url-outside-'))
  try {
    const file = join(root, 'a %20.html')
    writeFileSync(file, 'report')
    writeFileSync(`${file}:12`, 'literal')
    writeFileSync(join(outside, 'secret.html'), 'secret')
    symlinkSync(join(outside, 'secret.html'), join(root, 'escape.html'))
    const url = (path: string) => `file://${path.split('/').map(encodeURIComponent).join('/')}`
    const opened: Array<[string, unknown]> = []
    const open = async (path: string, _target: unknown, location: unknown) => {
      opened.push([path, location])
      return true
    }
    expect(await openWorkspaceFile({ appSessionId: 'session-1', path: `${url(file)}:12` }, [session(root)], open)).toBe(true)
    expect(opened.pop()).toEqual([realpathSync(`${file}:12`), undefined])
    expect(await openWorkspaceFile({ appSessionId: 'session-1', path: `${url(file)}:13:2` }, [session(root)], open)).toBe(true)
    expect(opened.pop()).toEqual([realpathSync(file), { line: 13, column: 2 }])
    for (const path of [url(join(outside, 'secret.html')), url(join(root, 'escape.html')), 'file://remote/tmp/a.html', `${url(file)}%00`]) {
      expect(await openWorkspaceFile({ appSessionId: 'session-1', path }, [session(root)], open)).toBe(false)
    }
    expect(opened).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('rejects traversal, symlink escape, directories, and unknown sessions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catcode-open-file-'))
  const outside = mkdtempSync(join(tmpdir(), 'catcode-open-file-outside-'))
  try {
    writeFileSync(join(outside, 'secret.md'), 'not in workspace')
    symlinkSync(join(outside, 'secret.md'), join(root, 'linked.md'))
    const openPath = async () => {
      throw new Error('rejected paths must not reach the OS')
    }

    for (const input of [
      { appSessionId: 'session-1', path: '../outside.md' },
      { appSessionId: 'session-1', path: 'linked.md' },
      { appSessionId: 'session-1', path: '.' },
      { appSessionId: 'missing', path: 'report.md' },
      { appSessionId: 'session-1', path: 'report.md', target: 'unknown_app' },
      { appSessionId: 'session-1', path: 'report.md', extraField: 'bad' },
    ]) {
      expect(await openWorkspaceFile(input, [session(root)], openPath)).toBe(false)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('forwards normalized source locations and valid targets to the opener', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catcode-open-file-'))
  try {
    mkdirSync(join(root, 'src'))
    const sourceFile = join(root, 'src', 'index.ts')
    writeFileSync(sourceFile, 'console.log("hello")')

    const calls: Array<{ path: string; target?: string; location?: { line: number; column?: number } }> = []
    const openPath = async (path: string, target?: string, location?: { line: number; column?: number }) => {
      calls.push({ path, target, ...(location ? { location } : {}) })
      return true
    }

    // Path with :line suffix and target 'vscode'
    expect(
      await openWorkspaceFile(
        { appSessionId: 'session-1', path: 'src/index.ts:42', target: 'vscode' },
        [session(root)],
        openPath,
      ),
    ).toBe(true)

    expect(
      await openWorkspaceFile(
        { appSessionId: 'session-1', path: 'src/index.ts:0042:0007', target: 'cursor' },
        [session(root)],
        openPath,
      ),
    ).toBe(true)

    // Target 'finder'
    expect(
      await openWorkspaceFile(
        { appSessionId: 'session-1', path: 'src/index.ts', target: 'finder' },
        [session(root)],
        openPath,
      ),
    ).toBe(true)

    expect(calls).toEqual([
      { path: realpathSync(sourceFile), target: 'vscode', location: { line: 42 } },
      { path: realpathSync(sourceFile), target: 'cursor', location: { line: 42, column: 7 } },
      { path: realpathSync(sourceFile), target: 'finder' },
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('prefers an existing literal filename over an ambiguous source location suffix', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catcode-open-file-'))
  try {
    const literal = join(root, 'report:2026')
    const base = join(root, 'report')
    writeFileSync(literal, 'literal')
    writeFileSync(base, 'base')
    const opened: string[] = []

    expect(
      await openWorkspaceFile(
        { appSessionId: 'session-1', path: 'report:2026' },
        [session(root)],
        async path => {
          opened.push(path)
          return true
        },
      ),
    ).toBe(true)
    expect(opened).toEqual([realpathSync(literal)])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects invalid source coordinates without opening the existing base file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catcode-open-file-'))
  try {
    writeFileSync(join(root, 'source.ts'), 'existing source')
    const opened: string[] = []
    for (const suffix of [':0', ':1:0', ':2147483648', ':1:2147483648', ':999999999999999999999']) {
      expect(await openWorkspaceFile(
        { appSessionId: 'session-1', path: `source.ts${suffix}`, target: 'vscode' },
        [session(root)],
        async path => { opened.push(path); return true },
      )).toBe(false)
    }
    expect(opened).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('preserves literal hash characters in workspace paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catcode-open-file-'))
  try {
    const sourceDirectory = join(root, 'C#')
    mkdirSync(sourceDirectory)
    const sourceFile = join(sourceDirectory, 'Program.cs')
    writeFileSync(sourceFile, 'class Program {}')
    const opened: string[] = []

    expect(
      await openWorkspaceFile(
        { appSessionId: 'session-1', path: 'C#/Program.cs' },
        [session(root)],
        async path => {
          opened.push(path)
          return true
        },
      ),
    ).toBe(true)
    expect(
      await openWorkspaceFile(
        { appSessionId: 'session-1', path: 'C#/Program.cs:42:7' },
        [session(root)],
        async path => {
          opened.push(path)
          return true
        },
      ),
    ).toBe(true)
    expect(opened).toEqual([realpathSync(sourceFile), realpathSync(sourceFile)])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('relocated conversations refuse ambiguous relative links while retaining current-workspace absolute links', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catcode-open-relocated-file-'))
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  try {
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const source = join(root, 'chat')
    const destination = join(root, 'project')
    mkdirSync(source)
    mkdirSync(destination)
    const oldReport = join(source, 'report.md')
    const newReport = join(destination, 'report.md')
    writeFileSync(oldReport, 'Original chat report')
    writeFileSync(newReport, 'Different project report')
    const appSessionId = randomUUID()
    const engineSessionId = randomUUID()
    const original = { cwd: source, binding: {
      kind: 'managed' as const, storageRootId: randomUUID(), storageId: randomUUID(),
    } }
    writeSessionRelocation({
      version: 1, appSessionId, engineSessionId, phase: 'complete',
      original, source: original,
      target: { cwd: destination, binding: { kind: 'project' } },
      controls: { mode: 'default' }, backup: join(root, 'backup'), movedAt: 1,
    })
    const relocated = sessionDescriptorFixture({
      appSessionId, engineSessionId, cwd: destination, binding: { kind: 'project' },
    })
    const opened: string[] = []
    const openPath = async (path: string) => {
      opened.push(path)
      return true
    }

    for (const path of ['report.md', 'report.md:12:3', oldReport]) {
      expect(await openWorkspaceFile({ appSessionId, path }, [relocated], openPath)).toBe(false)
    }
    expect(opened).toEqual([])
    expect(await openWorkspaceFile({ appSessionId, path: newReport }, [relocated], openPath)).toBe(true)
    expect(opened).toEqual([realpathSync(newReport)])
  } finally {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    rmSync(root, { recursive: true, force: true })
  }
})

test('opens image files under the generated-images root outside the workspace, and nothing else there', async () => {
  const base = mkdtempSync(join(tmpdir(), 'catcode-open-generated-'))
  try {
    const workspace = join(base, 'workspace')
    const imagesRoot = join(base, 'config', 'generated-images')
    const elsewhere = join(base, 'elsewhere')
    for (const dir of [workspace, imagesRoot, elsewhere]) mkdirSync(dir, { recursive: true })
    const image = join(imagesRoot, 'cat.png')
    const note = join(imagesRoot, 'notes.md')
    const strayImage = join(elsewhere, 'stray.png')
    const linked = join(imagesRoot, 'linked.png')
    for (const file of [image, note, strayImage]) writeFileSync(file, 'x')
    symlinkSync(strayImage, linked)

    const opened: string[] = []
    const opener = async (path: string): Promise<string> => {
      opened.push(path)
      return ''
    }
    const open = (path: string, options?: { generatedImagesRoot?: string }) =>
      openWorkspaceFile(
        { appSessionId: 'session-1', path },
        [session(workspace)],
        opener,
        options,
      )
    const options = { generatedImagesRoot: imagesRoot }

    expect(await open(image, options)).toBe(true)
    expect(opened).toEqual([realpathSync(image)])

    expect(await open(note, options)).toBe(false)
    expect(await open(strayImage, options)).toBe(false)
    expect(await open(linked, options)).toBe(false)
    expect(await open(image)).toBe(false)
    expect(await open(image, { generatedImagesRoot: join(base, 'missing') })).toBe(false)
    expect(opened).toHaveLength(1)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
