import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { parse } from 'yaml'

type Step = {
  name: string
  id?: string
  uses?: string
  run?: string
  if?: string
  'continue-on-error'?: boolean
  with?: Record<string, unknown>
}

const source = readFileSync(new URL('../../.github/workflows/delivery.yml', import.meta.url), 'utf8')
const workflow = parse(source)
const job = workflow.jobs.package
const steps: Step[] = job.steps
const scratchDirs: string[] = []
const commit = 'a'.repeat(40)

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function step(name: string): Step {
  const result = steps.find(candidate => candidate.name === name)
  if (!result) throw new Error(`Missing delivery step: ${name}`)
  return result
}

function accepts(overrides: Record<string, unknown> = {}, repository = 'owner/cat-code'): boolean {
  return runInNewContext(job.if.replace(/^\s*\$\{\{|\}\}\s*$/g, ''), {
    github: {
      repository,
      event: {
        workflow_run: {
          conclusion: 'success',
          head_branch: 'main',
          head_repository: { full_name: repository },
          event: 'push',
          ...overrides,
        },
      },
    },
  }) as boolean
}

test('delivery accepts only successful same-repository main CI runs', () => {
  expect(workflow.on).toEqual({
    workflow_run: { workflows: ['CI'], types: ['completed'], branches: ['main'] },
  })
  const ci = parse(readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'))
  expect(ci.name).toBe('CI')
  expect(accepts()).toBe(true)
  expect(accepts({ event: 'workflow_dispatch' })).toBe(true)
  for (const conclusion of ['failure', 'cancelled', 'skipped', 'timed_out', null]) {
    expect(accepts({ conclusion })).toBe(false)
  }
  expect(accepts({ event: 'pull_request' })).toBe(false)
  expect(accepts({ event: 'pull_request_target' })).toBe(false)
  expect(accepts({ head_branch: 'feature' })).toBe(false)
  expect(accepts({ head_repository: { full_name: 'someone/fork' } })).toBe(false)
  expect(accepts({ head_repository: null })).toBe(false)
})

test('delivery pins the passing revision without write credentials or secret references', () => {
  expect(workflow.permissions).toEqual({ contents: 'read' })
  expect(step('Check out the passing commit').with).toEqual({
    ref: '${{ github.event.workflow_run.head_sha }}',
    'persist-credentials': false,
  })
  expect(job.env.DELIVERY_COMMIT).toBe('${{ github.event.workflow_run.head_sha }}')
  expect(job['runs-on']).toBe('macos-15')
  expect(source).not.toMatch(/secrets\.|secrets\[/)
  for (const entry of steps.filter(candidate => candidate.uses)) {
    expect(entry.uses).toMatch(/@[a-f0-9]{40}$/)
  }
})

test('packaging and smoke checks must pass before uploading only the archive and checksum', () => {
  const required = [
    'Verify build source',
    'Package and verify the app',
    'Exercise the packaged engine',
    'Archive and verify the download',
    'Upload the verified download',
  ]
  const indices = required.map(name => steps.indexOf(step(name)))
  expect(indices).toEqual([...indices].sort((a, b) => a - b))
  expect(step(required[1]!).run).toBe('bun run --cwd app package')
  expect(step(required[2]!).run).toBe('bun run --cwd app smoke:packaged:headless')
  for (const entry of steps) {
    expect(entry.if).toBeUndefined()
    expect(entry['continue-on-error']).toBeUndefined()
  }
  expect(step('Upload the verified download').with).toEqual({
    name: 'cat-code-macos-arm64-${{ env.DELIVERY_COMMIT }}',
    path: [
      '${{ runner.temp }}/cat-code-delivery/Cat-Code-macos-arm64-${{ env.DELIVERY_COMMIT }}.zip',
      '${{ runner.temp }}/cat-code-delivery/Cat-Code-macos-arm64-${{ env.DELIVERY_COMMIT }}.zip.sha256',
      '',
    ].join('\n'),
    'if-no-files-found': 'error',
    'retention-days': 14,
    'compression-level': 0,
  })
})

function archiveFixture(): { root: string; bundle: string; resources: string } {
  const root = mkdtempSync(join(tmpdir(), 'catcode-delivery-'))
  scratchDirs.push(root)
  const bundle = join(root, 'app', 'dist-app', 'Cat Code.app')
  const contents = join(bundle, 'Contents')
  const resources = join(contents, 'Resources')
  mkdirSync(join(contents, 'MacOS'), { recursive: true })
  mkdirSync(resources)
  copyFileSync('/usr/bin/true', join(contents, 'MacOS', 'Cat Code'))
  chmodSync(join(contents, 'MacOS', 'Cat Code'), 0o755)
  writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Cat Code</string>
<key>CFBundleIdentifier</key><string>com.catcode.delivery-test</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`)
  writeFileSync(join(resources, 'sentinel.txt'), 'delivery fixture\n')
  symlinkSync('sentinel.txt', join(resources, 'sentinel-link'))
  const signed = spawnSync('codesign', ['--force', '--sign', '-', bundle], { encoding: 'utf8' })
  if (signed.status !== 0) throw new Error(`Fixture signing failed: ${signed.stderr}`)
  return { root, bundle, resources }
}

function archive(root: string): ReturnType<typeof spawnSync> {
  return spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step('Archive and verify the download').run!], {
    cwd: root,
    env: { ...process.env, RUNNER_TEMP: root, DELIVERY_COMMIT: commit },
    encoding: 'utf8',
  })
}

test('the real archive step preserves signatures, executable permissions, symlinks, and checksum', () => {
  const { root } = archiveFixture()
  const result = archive(root)
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
  const unpacked = join(root, 'cat-code-delivery-check', 'Cat Code.app', 'Contents')
  expect(lstatSync(join(unpacked, 'MacOS', 'Cat Code')).mode & 0o777).toBe(0o755)
  expect(readlinkSync(join(unpacked, 'Resources', 'sentinel-link'))).toBe('sentinel.txt')
  const checksum = spawnSync('shasum', ['-a', '256', '-c', `Cat-Code-macos-arm64-${commit}.zip.sha256`], {
    cwd: join(root, 'cat-code-delivery'),
    encoding: 'utf8',
  })
  expect(checksum.status).toBe(0)
})

test('the real archive step rejects a damaged signature without producing a checksum', () => {
  const { root, resources } = archiveFixture()
  writeFileSync(join(resources, 'sentinel.txt'), 'tampered after signing\n')
  const result = archive(root)
  expect(result.status).not.toBe(0)
  expect(String(result.stderr)).toContain('invalid')
  expect(() => readFileSync(join(root, 'cat-code-delivery', `Cat-Code-macos-arm64-${commit}.zip.sha256`)))
    .toThrow()
})
