import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFilePreviewService } from './filePreview.js'
import { sessionDescriptorFixture } from '../shared/sessionDescriptor.fixture.js'
import type { FilePreviewEvent } from '../shared/filePreview.js'

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cat-preview-text-')))
  let visible = true
  let sessions = [sessionDescriptorFixture({ appSessionId: 'text', cwd: root })]
  const events: FilePreviewEvent[] = []
  const service = createFilePreviewService({
    sessions: () => sessions,
    publish: event => events.push(event), home: root, isVisible: () => visible,
  })
  return { root, service, events, revoke() { sessions = [] }, hide() { visible = false }, show() { visible = true },
    async cleanup() { service.dispose(); await rm(root, { recursive: true, force: true }) } }
}

test('text previews retain source locations and bounded content without serving it to page scripts', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, 'source.ts'), 'const value = 42\n')
    const result = await f.service.prepare({ appSessionId: 'text', path: 'source.ts:12:3' })
    expect(result).toMatchObject({ ok: true, location: { line: 12, column: 3 }, descriptor: { kind: 'text', text: 'const value = 42\n', textWindow: { truncated: false, firstLine: 1, invalidUtf8: false } } })
    if (!result.ok) throw new Error('Expected source preview')
    expect((await f.service.respond(new Request(result.descriptor.url))).status).toBe(403)
    await writeFile(join(f.root, 'page.html'), '<h1>Page</h1>')
    const page = await f.service.prepare({ appSessionId: 'text', path: 'page.html' })
    if (!page.ok) throw new Error('Expected page preview')
    expect((await f.service.respond(new Request(new URL('/source.ts', page.descriptor.url)))).status).toBe(403)
  } finally { await f.cleanup() }
})

test('large text uses bounded start/end windows and a source target overrides log-tail defaults', async () => {
  const f = await fixture()
  try {
    const source = 'first\n' + 'middle\n'.repeat(350_000) + 'last\n'
    await writeFile(join(f.root, 'server.log'), source)
    const tail = await f.service.prepare({ appSessionId: 'text', path: 'server.log' })
    if (!tail.ok) throw new Error('Expected tail')
    expect(tail.descriptor.textWindow).toMatchObject({ side: 'end', firstLine: null, truncated: true, totalBytes: Buffer.byteLength(source) })
    expect(tail.descriptor.text!.endsWith('last\n')).toBe(true)
    expect(tail.descriptor.text!.split('\n').length).toBeLessThanOrEqual(50_001)
    const start = await f.service.prepare({ appSessionId: 'text', path: 'server.log:2' })
    expect(start).toMatchObject({ ok: true, location: { line: 2 }, descriptor: { textWindow: { side: 'start', firstLine: 1, truncated: true } } })
    if (!start.ok) throw new Error('Expected start')
    expect(start.descriptor.text!.startsWith('first\n')).toBe(true)
    await appendFile(join(f.root, 'server.log'), 'later\n')
    const unchanged = await f.service.refresh(start.descriptor.id)
    expect(unchanged?.revision).toBe(start.descriptor.revision)
    expect(f.events.filter(event => event.kind === 'updated' && event.id === start.descriptor.id)).toHaveLength(0)
  } finally { await f.cleanup() }
})

test('files over the snapshot cap and huge single lines remain bounded on valid UTF-8 boundaries', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, 'huge.txt'), 'ก'.repeat(6_000_000))
    const result = await f.service.prepare({ appSessionId: 'text', path: 'huge.txt' })
    if (!result.ok) throw new Error('Expected bounded preview')
    expect(result.descriptor.textWindow).toMatchObject({ truncated: true, invalidUtf8: false, totalBytes: 18_000_000 })
    expect(Buffer.byteLength(result.descriptor.text!)).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(result.descriptor.text!.includes('\uFFFD')).toBe(false)
  } finally { await f.cleanup() }
})

test('binary text fails with a typed reason while invalid UTF-8 remains readable and marked', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, 'binary.txt'), Buffer.from([1, 0, 2]))
    expect(await f.service.prepare({ appSessionId: 'text', path: 'binary.txt' })).toEqual({ ok: false, reason: 'binary' })
    await writeFile(join(f.root, 'legacy.txt'), Buffer.from([65, 0xff, 66]))
    expect(await f.service.prepare({ appSessionId: 'text', path: 'legacy.txt' })).toMatchObject({ ok: true, descriptor: { text: 'A\uFFFDB', textWindow: { invalidUtf8: true } } })
    expect(await f.service.prepare({ appSessionId: 'text', path: 'absent.txt' })).toEqual({ ok: false, reason: 'missing' })
    expect(await f.service.prepare({ appSessionId: 'text', path: 'legacy.txt', textWindow: 'middle' })).toEqual({ ok: false, reason: 'refused' })
  } finally { await f.cleanup() }
})

test('canonical credential files and a configured vault never reach the renderer, including through aliases', async () => {
  const f = await fixture()
  try {
    for (const directory of ['.ssh', 'custom-store', '.codex-nootp']) await mkdir(join(f.root, directory))
    await writeFile(join(f.root, '.codex-nootp/config.toml'), `vault_path = "${join(f.root, 'custom-store')}"\n`)
    for (const name of ['auth.json', '.ssh/config.json', 'custom-store/account.json', '.env', '.env.production', 'secrets.yaml']) {
      await writeFile(join(f.root, name), 'credential sentinel')
      expect(await f.service.prepare({ appSessionId: 'text', path: name })).toEqual({ ok: false, reason: 'external' })
    }
    await symlink(join(f.root, 'custom-store/account.json'), join(f.root, 'innocent.json'))
    expect(await f.service.prepare({ appSessionId: 'text', path: 'innocent.json' })).toEqual({ ok: false, reason: 'external' })
    await writeFile(join(f.root, '.env.example'), 'KEY=example\n')
    expect(await f.service.prepare({ appSessionId: 'text', path: '.env.example' })).toMatchObject({ ok: true, descriptor: { kind: 'text' } })
    await mkdir(join(f.root, 'work'))
    await writeFile(join(f.root, 'work/report.json'), '{"public":true}')
    const publicFile = await f.service.prepare({ appSessionId: 'text', path: 'work/report.json' })
    if (!publicFile.ok) throw new Error('Expected public file')
    await writeFile(join(f.root, '.codex-nootp/config.toml'), `vault_path = "${join(f.root, 'work')}"\n`)
    await writeFile(join(f.root, 'work/report.json'), 'new credential sentinel')
    expect(await f.service.refresh(publicFile.descriptor.id)).toBeNull()
    expect(f.events.some(event => event.kind === 'updated' && event.descriptor.text?.includes('new credential sentinel'))).toBe(false)

  } finally { await f.cleanup() }
})

test('fork config and settings credentials stay external through canonical aliases and effective config roots', async () => {
  const f = await fixture()
  const priorConfig = process.env.CLAUDE_CONFIG_DIR
  try {
    const configRoot = join(f.root, 'effective-config')
    process.env.CLAUDE_CONFIG_DIR = configRoot
    const names = [
      '.cat-code/settings.json', '.cat-code/settings.local.json', '.cat-code/cowork_settings.json',
      '.cat-code/.cat-code.json', '.cat-code/.cat-code-local-oauth.json',
      '.cat-code/.cat-code-staging-oauth.json', '.cat-code/.cat-code-custom-oauth.json',
      '.cat-code/.config.json', '.cat-code.json',
      'effective-config/.config.json', 'effective-config/settings.local.json',
    ]
    const results = []
    for (const name of names) {
      const file = join(f.root, name)
      await mkdir(join(file, '..'), { recursive: true })
      await writeFile(file, '{"env":{"TOKEN":"synthetic credential sentinel"}}')
      const result = await f.service.prepare({ appSessionId: 'text', path: name })
      results.push(result)
      if (result.ok) f.service.release(result.descriptor.id)
    }
    expect(results).toEqual(names.map(() => ({ ok: false, reason: 'external' })))
    await symlink(join(f.root, '.cat-code/settings.json'), join(f.root, 'innocent-settings.json'))
    expect(await f.service.prepare({ appSessionId: 'text', path: 'innocent-settings.json' })).toEqual({ ok: false, reason: 'external' })
    // The protected settings entry itself can point at an otherwise ordinary name.
    await mkdir(join(f.root, 'ordinary'))
    await writeFile(join(f.root, 'ordinary/private.json'), 'synthetic credential sentinel')
    await symlink(join(f.root, 'ordinary/private.json'), join(configRoot, 'cowork_settings.json'))
    expect(await f.service.prepare({ appSessionId: 'text', path: 'ordinary/private.json' })).toEqual({ ok: false, reason: 'external' })
    await mkdir(join(f.root, '.cat-code/projects/session'), { recursive: true })
    await writeFile(join(f.root, '.cat-code/projects/session/session.jsonl'), '{"message":"accepted log"}\n')
    expect(await f.service.prepare({ appSessionId: 'text', path: '.cat-code/projects/session/session.jsonl' })).toMatchObject({ ok: true, descriptor: { kind: 'text', text: '{"message":"accepted log"}\n' } })
  } finally {
    if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = priorConfig
    await f.cleanup()
  }
})

test('vault policy reads complete bounded configuration and fails closed for oversized or ambiguous roots', async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.root, '.codex-nootp'))
    await mkdir(join(f.root, 'custom-store'))
    await writeFile(join(f.root, 'custom-store/account.json'), 'credential sentinel')
    await writeFile(join(f.root, 'public.txt'), 'public')
    const config = join(f.root, '.codex-nootp/config.toml')
    await writeFile(config, '# padding\n'.repeat(2000) + `vault_path = "${join(f.root, 'custom-store')}"\n`)
    expect(await f.service.prepare({ appSessionId: 'text', path: 'custom-store/account.json' })).toEqual({ ok: false, reason: 'external' })
    const publicFile = await f.service.prepare({ appSessionId: 'text', path: 'public.txt' })
    expect(publicFile).toMatchObject({ ok: true, descriptor: { text: 'public' } })
    if (publicFile.ok) f.service.release(publicFile.descriptor.id)
    // The account pool replaces any leading tilde, including this non-shell form.
    await writeFile(config, 'vault_path = "~-store"\n')
    await mkdir(`${f.root}-store`)
    try {
      await writeFile(join(`${f.root}-store`, 'account.json'), 'credential sentinel')
      expect(await f.service.prepare({ appSessionId: 'text', path: join(`${f.root}-store`, 'account.json') })).toEqual({ ok: false, reason: 'external' })
    } finally { await rm(`${f.root}-store`, { recursive: true, force: true }) }
    await writeFile(config, 'vault_path = "custom-store"\n')
    expect(await f.service.prepare({ appSessionId: 'text', path: 'custom-store/account.json' })).toEqual({ ok: false, reason: 'external' })
    await writeFile(config, '# padding\n'.repeat(110_000) + 'vault_path = "somewhere"\n')
    expect(await f.service.prepare({ appSessionId: 'text', path: 'public.txt' })).toEqual({ ok: false, reason: 'external' })
  } finally { await f.cleanup() }
})

test('live text publishes during continuous appends, skips hidden chats, and catches up explicitly', async () => {
  const f = await fixture()
  let writer: ReturnType<typeof setInterval> | undefined
  try {
    const path = join(f.root, 'events.log')
    await writeFile(path, 'first\n')
    const result = await f.service.prepare({ appSessionId: 'text', path: 'events.log' })
    if (!result.ok) throw new Error('Expected preview')
    f.service.commit(result.descriptor.id, result.descriptor.revision)
    writer = setInterval(() => { void appendFile(path, 'next\n') }, 75)
    const deadline = Date.now() + 2400
    while (Date.now() < deadline && !f.events.some(event => event.kind === 'updated')) await new Promise(resolve => setTimeout(resolve, 30))
    expect(f.events.some(event => event.kind === 'updated')).toBe(true)
    clearInterval(writer); writer = undefined
    await new Promise(resolve => setTimeout(resolve, 300))
    f.hide(); f.events.length = 0
    await appendFile(path, 'hidden\n')
    await new Promise(resolve => setTimeout(resolve, 1700))
    expect(f.events.filter(event => event.kind === 'updated')).toHaveLength(0)
    const refreshed = await f.service.refresh(result.descriptor.id)
    expect(refreshed?.text).toContain('hidden\n')
  } finally { clearInterval(writer); await f.cleanup() }
})


test('document snapshots require retained revisions, current authority, and current credential policy', async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.root, 'reports'))
    await writeFile(join(f.root, 'reports/report.pdf'), 'PDF bytes')
    const result = await f.service.prepare({ appSessionId: 'text', path: 'reports/report.pdf' })
    if (!result.ok) throw new Error('Expected PDF snapshot')
    const { id, revision } = result.descriptor
    expect(await f.service.documentBytes(id, revision)).toEqual(new Uint8Array(Buffer.from('PDF bytes')))
    expect(await f.service.documentBytes(id, revision + 1)).toBeNull()
    await writeFile(join(f.root, 'source.ts'), 'source bytes')
    const source = await f.service.prepare({ appSessionId: 'text', path: 'source.ts' })
    if (!source.ok) throw new Error('Expected source')
    expect(await f.service.documentBytes(source.descriptor.id, source.descriptor.revision)).toBeNull()
    await mkdir(join(f.root, '.codex-nootp'))
    await writeFile(join(f.root, '.codex-nootp/config.toml'), `vault_path = "${join(f.root, 'reports')}"\n`)
    expect(await f.service.documentBytes(id, revision)).toBeNull()
    expect(await f.service.documentAuthorized(id, revision)).toBe(false)
    f.revoke()
    expect(await f.service.documentAuthorized(source.descriptor.id, source.descriptor.revision)).toBe(false)
  } finally { await f.cleanup() }
})
