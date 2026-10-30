import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFilePreviewService } from './filePreview.js'
import { sessionDescriptorFixture } from '../shared/sessionDescriptor.fixture.js'
import type { FilePreviewEvent } from '../shared/filePreview.js'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'cat-preview-'))
  const root = await realpath(directory)
  const outside = await mkdtemp(join(tmpdir(), 'cat-preview-outside-'))
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'REPORT.HTML'), '<!doctype html><link rel="stylesheet" href="assets/site.css"><h1>First</h1>')
  await writeFile(join(root, 'assets/site.css'), 'body {color:red}')
  await writeFile(join(outside, 'secret.css'), 'secret')
  let sessions = [sessionDescriptorFixture({ appSessionId: 's1', cwd: root })]
  const events: FilePreviewEvent[] = []
  const service = createFilePreviewService({ sessions: () => sessions, publish: event => events.push(event), home: root })
  const preview = await service.prepare({ appSessionId: 's1', path: 'REPORT.HTML:14' })
  if (!preview) throw new Error('Expected preview')
  return { root, outside, service, preview, events,
    revoke() { sessions = [] },
    async cleanup() { service.dispose(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) },
  }
}

test('serves immutable contained files while refusing forged and escaping resource requests', async () => {
  const f = await fixture()
  try {
    expect(f.preview.kind).toBe('html')
    expect(f.preview.path).toBe(join(f.root, 'REPORT.HTML'))
    expect(f.preview.displayPath).toBe('~/REPORT.HTML')
    const response = await f.service.respond(new Request(f.preview.url))
    expect(await response.text()).toContain('<h1>First</h1>')
    expect(response.headers.get('content-security-policy')).toContain('sandbox allow-scripts allow-same-origin')
    const asset = new URL('assets/site.css', f.preview.url).href
    expect(await (await f.service.respond(new Request(asset))).text()).toBe('body {color:red}')
    await symlink(join(f.outside, 'secret.css'), join(f.root, 'assets/escape.css'))
    expect((await f.service.respond(new Request(new URL('assets/escape.css', f.preview.url)))).status).toBe(403)
    expect(await f.service.prepare({ appSessionId: 's1', path: join(f.outside, 'secret.css') })).toBeNull()
    expect(await f.service.prepare({ appSessionId: 's1', path: 'REPORT.HTML', extra: true })).toBeNull()
    expect((await f.service.respond(new Request(f.preview.url.replace(f.preview.id, '0'.repeat(48))))).status).toBe(404)
    await writeFile(join(f.root, 'REPORT.HTML'), '<h1>Second</h1>')
    expect(await (await f.service.respond(new Request(f.preview.url))).text()).toContain('First')
  } finally { await f.cleanup() }
})

test('stages a new root without deleted former dependencies and commits only successfully loaded assets', async () => {
  const f = await fixture()
  try {
    await f.service.respond(new Request(new URL('assets/site.css', f.preview.url)))
    await writeFile(join(f.root, 'REPORT.HTML'), '<h1>Second without stylesheet</h1>')
    await rm(join(f.root, 'assets/site.css'))
    const updated = await f.service.refresh(f.preview.id)
    expect(updated?.revision).toBeGreaterThan(f.preview.revision)
    expect(await (await f.service.respond(new Request(updated!.url))).text()).toContain('Second without stylesheet')
    expect(f.service.commit(updated!.id, updated!.revision)).toBe(true)
    expect((await f.service.respond(new Request(f.preview.url))).status).toBe(404)
    const candidate = await f.service.refresh(f.preview.id)
    expect(candidate?.revision).toBeGreaterThan(updated!.revision)
    await f.service.respond(new Request(new URL('assets/missing.css', candidate!.url)))
    expect(f.service.commit(candidate!.id, candidate!.revision)).toBe(false)
    expect(await (await f.service.respond(new Request(updated!.url))).text()).toContain('Second without stylesheet')
  } finally { await f.cleanup() }
})

test('retains the last good root through removal, recovers on return, and revokes capabilities with the session', async () => {
  const f = await fixture()
  try {
    await rm(join(f.root, 'REPORT.HTML'))
    expect(await f.service.refresh(f.preview.id)).toBeNull()
    expect(f.events.some(event => event.kind === 'removed')).toBe(true)
    expect(await (await f.service.respond(new Request(f.preview.url))).text()).toContain('First')
    await writeFile(join(f.root, 'REPORT.HTML'), '<h1>Returned</h1>')
    const returned = await f.service.refresh(f.preview.id)
    expect(returned).not.toBeNull()
    expect(await (await f.service.respond(new Request(returned!.url))).text()).toContain('Returned')
    f.revoke()
    expect((await f.service.respond(new Request(returned!.url))).status).toBe(403)
    expect(f.service.has(f.preview.id)).toBe(false)
  } finally { await f.cleanup() }
})

test('watches a loaded dependency, coalesces writes, and stops serving after release', async () => {
  const f = await fixture()
  try {
    await f.service.respond(new Request(new URL('assets/site.css', f.preview.url)))
    await writeFile(join(f.root, 'assets/site.css'), 'body {color:blue}')
    await writeFile(join(f.root, 'assets/site.css'), 'body {color:green}')
    const deadline = Date.now() + 2500
    while (!f.events.some(event => event.kind === 'updated') && Date.now() < deadline) await Bun.sleep(20)
    const event = [...f.events].reverse().find(event => event.kind === 'updated')
    expect(event?.kind).toBe('updated')
    if (event?.kind !== 'updated') throw new Error('Watch did not publish')
    expect(await (await f.service.respond(new Request(new URL('assets/site.css', event.descriptor.url)))).text()).toBe('body {color:green}')
    f.service.release(f.preview.id)
    expect((await f.service.respond(new Request(event.descriptor.url))).status).toBe(404)
  } finally { await f.cleanup() }
})


test('does not mint a capability when session authority changes while the root is being read', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cat-preview-move-')), root = await realpath(directory)
  try {
    await mkdir(join(root, 'old')); await mkdir(join(root, 'new'))
    await writeFile(join(root, 'old/report.html'), '<h1>Old workspace</h1>')
    let session = sessionDescriptorFixture({ appSessionId: 'moving', cwd: join(root, 'old') })
    const service = createFilePreviewService({ sessions: () => [session], publish: () => {} })
    try {
      const pending = service.prepare({ appSessionId: 'moving', path: 'report.html' })
      await Bun.sleep(10)
      session = { ...session, cwd: join(root, 'new') }
      expect(await pending).toBeNull()
    } finally { service.dispose() }
  } finally { await rm(root, { recursive: true, force: true }) }
})


test.skipIf(process.getuid?.() === 0)('a watcher failure before subscription is retained on the prepared descriptor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cat-preview-watch-error-')), root = await realpath(directory)
  const locked = join(root, 'locked')
  await mkdir(locked)
  const service = createFilePreviewService({
    sessions: () => [sessionDescriptorFixture({ appSessionId: 'watch-failure', cwd: root })],
    publish: () => {},
  })
  try {
    await writeFile(join(locked, 'report.html'), '<h1>Readable file</h1>')
    // Traversal permits opening a known file while watching the unreadable directory fails.
    await chmod(locked, 0o111)
    const descriptor = await service.prepare({ appSessionId: 'watch-failure', path: 'locked/report.html' })
    expect(descriptor).not.toBeNull()
    expect(descriptor).toHaveProperty('watchError', true)
    expect(await (await service.respond(new Request(descriptor!.url))).text()).toContain('Readable file')
  } finally {
    service.dispose()
    await chmod(locked, 0o700)
    await rm(root, { recursive: true, force: true })
  }
})
