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
import { openWorkspaceFile } from './openWorkspaceFile.js'

function session(cwd: string): SessionDescriptor {
  return {
    appSessionId: 'session-1',
    engineSessionId: null,
    cwd,
    title: null,
    titleUpdatedAt: null,
    status: 'ready',
    restorable: false,
    parked: false,
    createdAt: 1,
    lastAttachedAt: 1,
    lastMessageSentAt: null,
  }
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
    ]) {
      expect(await openWorkspaceFile(input, [session(root)], openPath)).toBe(false)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
