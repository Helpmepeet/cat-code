import { expect, test } from 'bun:test'
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPreviewApplications } from './previewApplications.js'
import { sessionDescriptorFixture } from '../shared/sessionDescriptor.fixture.js'
import type { OpenWorkspaceFileTarget } from '../shared/protocol.js'

test('offers installed type-specific apps and persists successful choices while Finder keeps the prior choice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cat-preview-apps-')), root = await realpath(directory)
  try {
    await writeFile(join(root, 'page.html'), '<h1>Hello</h1>')
    await writeFile(join(root, 'notes.md'), '# Hello')
    const opened: OpenWorkspaceFileTarget[] = []
    const deps = { userData: root, sessions: () => [sessionDescriptorFixture({ appSessionId: 's1', cwd: root })],
      installed: async (target: OpenWorkspaceFileTarget) => ['default', 'chrome', 'vscode', 'finder'].includes(target),
      open: async (_path: string, target: OpenWorkspaceFileTarget) => { opened.push(target); return true },
    }
    const service = createPreviewApplications(deps), input = { appSessionId: 's1', path: 'page.html' }
    expect((await service.list(input)).applications.map(app => app.target)).toEqual(['default', 'chrome', 'vscode', 'finder'])
    expect(await service.choose({ ...input, target: 'chrome' })).toBe(true)
    expect(await service.choose({ ...input, target: 'finder' })).toBe(true)
    expect(createPreviewApplications(deps).list(input).then(result => result.selected)).resolves.toBe('chrome')
    expect(await service.choose({ appSessionId: 's1', path: 'notes.md', target: 'chrome' })).toBe(false)
    expect(await service.choose({ ...input, target: 'safari' })).toBe(false)
    expect(opened).toEqual(['chrome', 'finder'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('an older slow browser launch cannot replace the latest persisted choice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cat-preview-choice-race-'))
  try {
    let finishChrome!: (result: boolean) => void
    const deps = { userData: root, sessions: () => [sessionDescriptorFixture({ appSessionId: 's', cwd: root })],
      installed: async () => true,
      open: async (_path: string, target: OpenWorkspaceFileTarget) => target === 'chrome' ? new Promise<boolean>(resolve => { finishChrome = resolve }) : true,
    }
    const service = createPreviewApplications(deps), input = { appSessionId: 's', path: 'http://localhost:4000/' }
    const older = service.choose({ ...input, target: 'chrome' })
    while (!finishChrome) await Bun.sleep(0)
    expect(await service.choose({ ...input, target: 'safari' })).toBe(true)
    finishChrome(true)
    expect(await older).toBe(true)
    expect((await createPreviewApplications(deps).list(input)).selected).toBe('safari')
  } finally { await rm(root, { recursive: true, force: true }) }
})
