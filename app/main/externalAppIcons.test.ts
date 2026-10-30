import { afterEach, describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createExternalAppIconService, type IconCommandRunner } from './externalAppIcons.js'
import { parseExternalAppIconRequest, parseExternalAppIconTarget } from '../shared/externalAppIcons.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'external-icons-test-'))
  directories.push(root)
  const bundle = join(root, 'Visual Studio Code.app')
  const resources = join(bundle, 'Contents/Resources')
  await mkdir(resources, { recursive: true })
  await writeFile(join(resources, 'App.icns'), 'icns fixture')
  const png = Buffer.alloc(33)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
  png.write('IHDR', 12)
  png.writeUInt32BE(64, 16)
  png.writeUInt32BE(64, 20)
  const calls: Array<{ file: string; args: readonly string[] }> = []
  let iconName = 'App'
  let identity = 'com.microsoft.VSCode'
  let fail = false
  let resolution: string | null = bundle
  const run: IconCommandRunner = async (file, args) => {
    calls.push({ file, args })
    if (file.endsWith('osascript')) return JSON.stringify(resolution)
    if (file.endsWith('plutil')) return args[1] === 'CFBundleIdentifier' ? identity : iconName
    if (file.endsWith('sips')) {
      if (fail) throw new Error('conversion failed')
      await writeFile(args.at(-1)!, png)
      return ''
    }
    throw new Error(`Unexpected command: ${file}`)
  }
  const service = createExternalAppIconService({ platform: 'darwin', run, applicationDirectories: [root], temporaryDirectory: root })
  return { root, bundle, resources, png, calls, run, service,
    setIcon: (value: string) => { iconName = value },
    setIdentity: (value: string) => { identity = value },
    setFail: (value: boolean) => { fail = value },
    setResolution: (value: string | null) => { resolution = value },
  }
}

function conversions(calls: Array<{ file: string }>) { return calls.filter(call => call.file.endsWith('sips')).length }

describe('external app icon contract', () => {
  test('accepts only closed target requests and bounded workspace references', () => {
    expect(parseExternalAppIconTarget('vscode')).toBe('vscode')
    expect(parseExternalAppIconTarget('terminal')).toBeNull()
    expect(parseExternalAppIconRequest({ target: 'browser' })).toEqual({ target: 'browser' })
    expect(parseExternalAppIconRequest({ target: 'browser', path: '/tmp/a' })).toBeNull()
    expect(parseExternalAppIconRequest({ target: 'default', appSessionId: 'session', path: 'file.ts' })).toEqual({ target: 'default', appSessionId: 'session', path: 'file.ts' })
    for (const input of [null, [], 'vscode', { target: 'default' }, { target: 'default', appSessionId: '', path: 'x' }, { target: 'default', appSessionId: 's', path: 'x\0y' }, { target: 'default', appSessionId: 's', path: 'x', extra: true }]) {
      expect(parseExternalAppIconRequest(input)).toBeNull()
    }
  })
})

describe('external app icon service', () => {
  test('extracts bundle resources, coalesces concurrent reads, caches and removes temporary files', async () => {
    const f = await fixture()
    const results = await Promise.all(Array.from({ length: 20 }, () => f.service.read('vscode')))
    expect(results.every(result => result.dataUrl === `data:image/png;base64,${f.png.toString('base64')}`)).toBe(true)
    expect(conversions(f.calls)).toBe(1)
    await f.service.read('vscode')
    expect(conversions(f.calls)).toBe(1)
    expect((await readdir(f.root)).sort()).toEqual(['Visual Studio Code.app'])
    expect(f.calls.find(call => call.file.endsWith('sips'))?.args).toContain(await realpath(join(f.resources, 'App.icns')))
  })

  test('resolves browser and file associations using data arguments, without hardcoded browser identity', async () => {
    const f = await fixture()
    const path = '/workspace/a"; dangerous file.ts'
    await Promise.all([f.service.read('browser'), f.service.read('default', path)])
    const calls = f.calls.filter(call => call.file.endsWith('osascript'))
    expect(calls.map(call => call.args.slice(-2))).toContainEqual(['browser', ''])
    expect(calls.map(call => call.args.slice(-2))).toContainEqual(['file', path])
    expect(calls[0]!.args[3]).not.toContain(path)
    expect(calls[0]!.args[3]).not.toContain('Safari')
    expect(conversions(f.calls)).toBe(1)
  })

  test('falls back to installed applications but verifies bundle identity', async () => {
    const f = await fixture()
    f.setResolution(null)
    expect((await f.service.read('vscode')).dataUrl).not.toBeNull()
    f.setIdentity('unrelated.app')
    expect(await f.service.read('vscode')).toEqual({ dataUrl: null })
    expect(await f.service.read('zed')).toEqual({ dataUrl: null })
    expect(await f.service.read('browser')).toEqual({ dataUrl: null })
  })

  test('failed conversions are not cached and always clean up', async () => {
    const f = await fixture()
    f.setFail(true)
    expect(await f.service.read('vscode')).toEqual({ dataUrl: null })
    expect(await readdir(f.root)).toEqual(['Visual Studio Code.app'])
    f.setFail(false)
    expect((await f.service.read('vscode')).dataUrl).not.toBeNull()
    expect(conversions(f.calls)).toBe(2)
  })

  test('rejects traversal, symlink escape, oversized sources and malformed converter output', async () => {
    const f = await fixture()
    f.setIcon('../App')
    expect(await f.service.read('vscode')).toEqual({ dataUrl: null })
    f.setIcon('Escaped.icns')
    await writeFile(join(f.root, 'outside.icns'), 'icns')
    await symlink(join(f.root, 'outside.icns'), join(f.resources, 'Escaped.icns'))
    expect(await f.service.read('vscode')).toEqual({ dataUrl: null })
    f.setIcon('App')
    await writeFile(join(f.resources, 'App.icns'), Buffer.alloc(16 * 1024 * 1024 + 1))
    expect(await f.service.read('vscode')).toEqual({ dataUrl: null })
    expect(conversions(f.calls)).toBe(0)
    await writeFile(join(f.resources, 'App.icns'), 'icns')
    f.png[0] = 0
    expect(await f.service.read('vscode')).toEqual({ dataUrl: null })
    f.png[0] = 137
    f.png.writeUInt32BE(4096, 16)
    expect(await f.service.read('vscode')).toEqual({ dataUrl: null })
  })

  test('expires successful entries and retries changed app resources', async () => {
    const f = await fixture()
    let now = 0
    const service = createExternalAppIconService({ platform: 'darwin', run: f.run, now: () => now, temporaryDirectory: f.root })
    await service.read('vscode')
    now = 300_001
    await service.read('vscode')
    expect(conversions(f.calls)).toBe(2)
  })

  test('rejects oversized converter output and removes it', async () => {
    const f = await fixture()
    const service = createExternalAppIconService({
      platform: 'darwin', temporaryDirectory: f.root,
      run: async (file, args) => {
        if (!file.endsWith('sips')) return f.run(file, args)
        await writeFile(args.at(-1)!, Buffer.alloc(512 * 1024 + 1))
        return ''
      },
    })
    expect(await service.read('vscode')).toEqual({ dataUrl: null })
    expect(await readdir(f.root)).toEqual(['Visual Studio Code.app'])
  })

  test('bounds pending association lookups and concurrent subprocess chains', async () => {
    let active = 0
    let peak = 0
    const releases: Array<() => void> = []
    const service = createExternalAppIconService({ platform: 'darwin', run: async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise<void>(resolve => releases.push(resolve))
      active--
      return 'null'
    } })
    const pending = Array.from({ length: 32 }, (_, i) => service.read('default', `/workspace/${i}`))
    expect(await service.read('default', '/workspace/overflow')).toEqual({ dataUrl: null })
    for (let batch = 0; batch < 8; batch++) {
      const current = releases.splice(0)
      expect(current).toHaveLength(4)
      current.forEach(release => release())
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect((await Promise.all(pending)).every(result => result.dataUrl === null)).toBe(true)
    expect(peak).toBe(4)
  })

  test('unsupported platforms, unknown targets and missing trusted paths never execute commands', async () => {
    const run: IconCommandRunner = async () => { throw new Error('must not run') }
    const service = createExternalAppIconService({ platform: 'darwin', run })
    expect(await service.read('default')).toEqual({ dataUrl: null })
    expect(await service.read('default', 'relative')).toEqual({ dataUrl: null })
    expect(await service.read('untrusted' as 'vscode')).toEqual({ dataUrl: null })
    expect(await createExternalAppIconService({ platform: 'linux', run }).read('vscode')).toEqual({ dataUrl: null })
  })
})

test.skipIf(process.platform !== 'darwin')('converts the installed Finder bundle icon into a real 64px PNG using sips', async () => {
  const exec = promisify(execFile)
  const root = await mkdtemp(join(tmpdir(), 'external-icons-real-'))
  directories.push(root)
  const service = createExternalAppIconService({
    temporaryDirectory: root,
    run: async (file, args) => {
      // Keep the integration check read-only and independent of Launch Services.
      if (file.endsWith('osascript')) return 'null'
      const result = await exec(file, [...args], { timeout: 2500, maxBuffer: 65536, encoding: 'utf8', killSignal: 'SIGKILL' })
      return result.stdout.trim()
    },
  })
  const result = await service.read('finder')
  expect(result.dataUrl).toStartWith('data:image/png;base64,')
  const png = Buffer.from(result.dataUrl!.split(',')[1]!, 'base64')
  expect(png.length).toBeGreaterThan(100)
  expect(png.readUInt32BE(16)).toBe(64)
  expect(png.readUInt32BE(20)).toBe(64)
  expect(await readdir(root)).toEqual([])
})
