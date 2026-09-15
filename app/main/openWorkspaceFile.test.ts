import { expect, test } from 'bun:test'
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

test('cleans line number suffix and forwards valid targets to opener', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catcode-open-file-'))
  try {
    mkdirSync(join(root, 'src'))
    const sourceFile = join(root, 'src', 'index.ts')
    writeFileSync(sourceFile, 'console.log("hello")')

    const calls: Array<{ path: string; target?: string }> = []
    const openPath = async (path: string, target?: string) => {
      calls.push({ path, target })
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

    // Target 'finder'
    expect(
      await openWorkspaceFile(
        { appSessionId: 'session-1', path: 'src/index.ts', target: 'finder' },
        [session(root)],
        openPath,
      ),
    ).toBe(true)

    expect(calls).toEqual([
      { path: realpathSync(sourceFile), target: 'vscode' },
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
