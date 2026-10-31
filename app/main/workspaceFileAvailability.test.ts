import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionDescriptorFixture } from '../shared/sessionDescriptor.fixture.js'
import { workspaceFileAvailability } from './workspaceFileAvailability.js'

test('availability returns only a boolean for canonical regular files inside and outside the workspace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catcode-file-availability-'))
  try {
    const workspace = join(root, 'workspace')
    const images = join(root, 'generated-images')
    mkdirSync(workspace)
    mkdirSync(images)
    mkdirSync(join(workspace, 'folder'))
    writeFileSync(join(workspace, 'source.ts'), 'source')
    writeFileSync(join(images, 'image.png'), 'image')
    writeFileSync(join(images, 'notes.txt'), 'outside workspace')
    symlinkSync(join(workspace, 'source.ts'), join(workspace, 'file-link'))
    symlinkSync(join(workspace, 'folder'), join(workspace, 'folder-link'))
    symlinkSync(join(images, 'notes.txt'), join(workspace, 'escape-link'))
    symlinkSync(join(workspace, 'missing'), join(workspace, 'broken-link'))
    const sessions = [sessionDescriptorFixture({ appSessionId: 'availability-session', cwd: workspace })]
    for (const [path, available] of [
      ['source.ts', true], ['source.ts:42:3', true], ['file-link', true],
      ['.', false], ['folder', false], ['folder-link', false],
      ['missing', false], ['broken-link', false], ['escape-link', true],
      [join(images, 'image.png'), true], [join(images, 'notes.txt'), true],
    ] as const) {
      expect(await workspaceFileAvailability(
        { appSessionId: 'availability-session', path }, sessions,
      )).toBe(available)
    }
    expect(await workspaceFileAvailability(
      { appSessionId: 'availability-session', path: 'source.ts' }, [],
    )).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('availability rejects malformed or expanded read payloads even when the file exists', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catcode-file-availability-input-'))
  try {
    writeFileSync(join(root, 'file.txt'), 'file')
    const valid = { appSessionId: 'availability-session', path: 'file.txt' }
    const sessions = [sessionDescriptorFixture({ appSessionId: valid.appSessionId, cwd: root })]
    expect(await workspaceFileAvailability(valid, sessions)).toBe(true)
    for (const input of [
      null, [], 'file.txt', {}, { ...valid, appSessionId: 1 },
      { ...valid, appSessionId: 'unknown' }, { ...valid, path: 1 },
      { ...valid, path: '' }, { ...valid, path: 'file.txt\0' },
      { ...valid, path: 'x'.repeat(4_097) },
      { ...valid, target: 'finder' }, { ...valid, readContents: true },
    ]) {
      expect(await workspaceFileAvailability(input, sessions)).toBe(false)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
