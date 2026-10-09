import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createAttemptWorkspace } from './attemptWorkspace.ts'
import { runtimeAllowances } from './harness/runtimeAllowances.ts'
import { copyPrivateSeed, securePrivateTree } from './privateModes.ts'
import { isRepositoryPath } from './pathEvidence.ts'
import { hasTaskTimeEvidence, isFileAssociatedOutput, supportsChangedLines } from './reconstructionEvidence.ts'
import { sandboxProfile } from './harness/sandbox.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('successful Codex patch paths resolve relative to the recorded repository cwd', () => {
  expect(isRepositoryPath('src/file.ts', '/Users/pt/cat-code')).toBe(true)
  expect(isRepositoryPath('src/file.ts', '/tmp/checkout', '/tmp/checkout')).toBe(true)
  expect(isRepositoryPath('../secrets.txt', '/Users/pt/cat-code')).toBe(false)
  expect(isRepositoryPath('/Users/pt/cat-code-other/file.ts', '/Users/pt/cat-code')).toBe(false)
})

test('sandbox-exec enforces staged reads and writes against isolated fixtures', () => {
  if (process.platform !== 'darwin') return
  const root = mkdtempSync('/private/tmp/cat-code-sandbox-test-')
  roots.push(root)
  const stage = join(root, 'stage')
  const engine = join(root, 'engine')
  const otherEngine = join(root, 'other-engine')
  const operator = join(root, 'operator')
  const scratch = join(root, 'scratch')
  for (const dir of [stage, engine, otherEngine, operator, scratch]) mkdirSync(dir)
  writeFileSync(join(stage, 'input'), 'stage-ok')
  writeFileSync(join(engine, 'source'), 'engine-ok')
  writeFileSync(join(otherEngine, 'secret'), 'other-engine-secret')
  writeFileSync(join(operator, 'secret'), 'operator-secret')
  const bun = Bun.which('bun')!
  const git = Bun.which('git')!
  const node = Bun.which('node')!
  const runtimes = runtimeAllowances([bun, git, node])
  const profile = sandboxProfile(stage, engine, {
    scratch,
    frozenEngines: [engine, otherEngine],
    runtimeBinaries: runtimes.binaries,
    runtimeLibraries: runtimes.libraries,
  })
  const sandboxExec = (command: string, commandArgs: string[] = [], cwd = stage, env: Record<string, string> = {}) => spawnSync(
    '/usr/bin/sandbox-exec',
    ['-p', profile, command, ...commandArgs],
    { cwd, encoding: 'utf8', timeout: 10_000, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: stage, ...env } },
  )
  const requireSuccess = (name: string, result: ReturnType<typeof spawnSync>) => {
    if (result.error || result.status !== 0) {
      throw new Error(`${name}: ${JSON.stringify({ error: result.error?.message, status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr })}`)
    }
  }
  requireSuccess('/bin/echo', sandboxExec('/bin/echo'))
  const shellScript = [
    `test "$(cat "${join(stage, 'input')}")" = stage-ok`,
    `test "$(cat "${join(engine, 'source')}")" = engine-ok`,
    `! cat "${join(otherEngine, 'secret')}" >/dev/null 2>&1`,
    `! cat "${join(operator, 'secret')}" >/dev/null 2>&1`,
    `! touch "${join(engine, 'mutation')}" 2>/dev/null`,
    `touch "${join(stage, 'created')}"`,
    `touch "${join(scratch, 'created')}"`,
  ].join(' && ')
  requireSuccess('/bin/sh fixture', sandboxExec('/bin/sh', ['-c', shellScript]))
  requireSuccess('isolated Git --version', sandboxExec(git, ['--version'], stage, { GIT_CONFIG_NOSYSTEM: '1' }))
  requireSuccess('isolated Node --version', sandboxExec(node, ['--version']))
  const bunScript = `import { readFileSync, writeFileSync } from 'node:fs';
const canRead = path => { try { readFileSync(path); return true } catch { return false } };
const canWrite = path => { try { writeFileSync(path, 'new'); return true } catch { return false } };
if (!canRead(${JSON.stringify(join(stage, 'input'))}) || !canRead(${JSON.stringify(join(engine, 'source'))})) process.exit(21);
if (canRead(${JSON.stringify(join(otherEngine, 'secret'))}) || canRead(${JSON.stringify(join(operator, 'secret'))})) process.exit(22);
if (canWrite(${JSON.stringify(join(engine, 'mutation'))})) process.exit(23);
if (!canWrite(${JSON.stringify(join(stage, 'bun-created'))}) || !canWrite(${JSON.stringify(join(scratch, 'bun-created'))})) process.exit(24);`
  const bunResult = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, bun, '-e', bunScript], {
    cwd: stage,
    encoding: 'utf8',
    timeout: 15_000,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: stage, TMPDIR: scratch },
  })
  requireSuccess('isolated Bun fixture', bunResult)
})

test('production-shaped stage rules override parent denial without granting sibling access', () => {
  const stage = '/Users/Shared/ccw/synthetic-run/cat-code'
  const engine = '/Users/Shared/cce/synthetic-engine'
  const profile = sandboxProfile(stage, engine, {
    frozenEngines: [engine, '/Users/Shared/cce/other-engine'],
    scratch: '/private/tmp/ccp-synthetic',
    runtimeBinaries: ['/Users/pt/.bun/bin/bun'],
  })
  const parentDeny = profile.indexOf('(deny file-read* (subpath "/Users/pt/cat-code")')
  const stageAllow = profile.lastIndexOf(`(allow file-read* (subpath "${stage}")`)
  expect(parentDeny).toBeGreaterThan(-1)
  expect(stageAllow).toBeGreaterThan(parentDeny)
  expect(profile.lastIndexOf(`(allow file-write* (subpath "${stage}")`)).toBeGreaterThan(profile.indexOf('(deny file-write*)'))
  expect(profile).toContain('(subpath "/Users/Shared/cce/other-engine")')
  expect(profile).not.toContain('(allow file-read* (subpath "/Users/Shared/cce")')
})

test('live sandbox option retains network access', () => {
  expect(sandboxProfile('/stage', '/engine', { network: true, scratch: '/scratch', frozenEngines: [] })).not.toContain('deny network-outbound')
  expect(sandboxProfile('/stage', '/engine', { scratch: '/scratch', frozenEngines: [] })).toContain('deny network-outbound')
})

test('dirty reconstruction requires positive matching task-time evidence', () => {
  expect(hasTaskTimeEvidence([true], 0, 0)).toBe(true)
  expect(hasTaskTimeEvidence([], 0, 0)).toBe(false)
  expect(hasTaskTimeEvidence([], 2, 0)).toBe(true)
  expect(hasTaskTimeEvidence([false], 2, 0)).toBe(false)
  expect(hasTaskTimeEvidence([true], 2, 1)).toBe(false)
})

test('numbered evidence must come from an output explicitly associated with this file', () => {
  expect(isFileAssociatedOutput('{"file_path":"src/target.ts"}', 'src/target.ts', '/repo')).toBe(true)
  expect(isFileAssociatedOutput('{"file_path":"/repo/src/target.ts"}', 'src/target.ts', '/repo')).toBe(true)
  expect(isFileAssociatedOutput('{"file_path":"src/other.ts"}', 'src/target.ts', '/repo')).toBe(false)
  expect(isFileAssociatedOutput('{"command":"cat src/target.ts"}', 'src/target.ts', '/repo')).toBe(false)
})

test('numbered evidence must include candidate lines that differ from the base', () => {
  expect(supportsChangedLines([[1, 'same'], [2, 'common'], [3, 'line']], ['same', 'common', 'line'], ['same', 'common', 'line'])).toBe(false)
  expect(supportsChangedLines([[1, 'same'], [2, 'changed'], [3, 'line']], ['same', 'changed', 'line'], ['same', 'old', 'line'])).toBe(true)
  expect(supportsChangedLines([[1, 'same'], [2, 'later answer'], [3, 'line']], ['same', 'changed', 'line'], ['same', 'old', 'line'])).toBe(false)
})

test('harness lifecycle creates evidence before staging and preserves failed attempts and source copies', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-attempt-'))
  roots.push(root)
  const requestedOut = join(root, 'run')
  const copy = join(root, 'prepared-copy')
  mkdirSync(join(copy, 'cat-code'), { recursive: true })
  writeFileSync(join(copy, 'cat-code', 'baseline.txt'), 'untouched baseline')
  let onExit = () => {}
  const attempt = createAttemptWorkspace(requestedOut, join(root, 'stage-one'), copy, listener => {
    expect(existsSync(requestedOut)).toBe(true)
    expect(existsSync(join(root, 'stage-one'))).toBe(false)
    onExit = listener
  })
  expect(attempt.out).toBe(requestedOut)
  expect(statSync(attempt.out).mode & 0o777).toBe(0o700)
  expect(statSync(attempt.stage).mode & 0o777).toBe(0o700)
  expect(readFileSync(join(attempt.cwd, 'baseline.txt'), 'utf8')).toBe('untouched baseline')
  writeFileSync(join(attempt.cwd, 'model-edit.txt'), 'kept failed workspace')
  attempt.setScratch(join(root, 'scratch-one'))
  expect(readFileSync(join(copy, 'cat-code', 'baseline.txt'), 'utf8')).toBe('untouched baseline')
  onExit()
  expect(JSON.parse(readFileSync(join(attempt.out, 'stage.json'), 'utf8'))).toMatchObject({
    state: 'failed',
    scratch: join(root, 'scratch-one'),
  })
  expect(readFileSync(join(attempt.cwd, 'model-edit.txt'), 'utf8')).toBe('kept failed workspace')

  const retry = createAttemptWorkspace(requestedOut, join(root, 'stage-two'), copy, () => {})
  expect(retry.out).not.toBe(attempt.out)
  expect(readFileSync(join(attempt.out, 'attempt.json'), 'utf8')).toContain('starting')
  retry.complete()
  expect(JSON.parse(readFileSync(join(retry.out, 'stage.json'), 'utf8')).state).toBe('completed')
})

test('stage-name collision fails before copying and records failure without changing prior attempt data', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-stage-collision-'))
  roots.push(root)
  const copy = join(root, 'prepared-copy')
  const source = join(copy, 'cat-code')
  const stage = join(root, 'stage')
  mkdirSync(source, { recursive: true })
  mkdirSync(join(stage, 'cat-code'), { recursive: true })
  writeFileSync(join(source, 'baseline.txt'), 'prepared baseline')
  writeFileSync(join(stage, 'cat-code', 'model-edit.txt'), 'previous attempt')
  const requestedOut = join(root, 'run')
  let onExit = () => {}
  expect(() => createAttemptWorkspace(requestedOut, stage, copy, listener => { onExit = listener })).toThrow()
  expect(readFileSync(join(stage, 'cat-code', 'model-edit.txt'), 'utf8')).toBe('previous attempt')
  expect(readFileSync(join(source, 'baseline.txt'), 'utf8')).toBe('prepared baseline')
  onExit()
  expect(JSON.parse(readFileSync(join(requestedOut, 'stage.json'), 'utf8'))).toMatchObject({
    stage,
    state: 'failed',
  })
})

test('private home-seed permissions preserve executable files', () => {
  const root = mkdtempSync(join(tmpdir(), 'private-tree-'))
  roots.push(root)
  const tree = join(root, 'home')
  const nested = join(tree, '.cat-code')
  mkdirSync(nested, { recursive: true, mode: 0o777 })
  writeFileSync(join(nested, 'transcript.jsonl'), 'synthetic')
  chmodSync(join(nested, 'transcript.jsonl'), 0o644)
  writeFileSync(join(nested, 'skill-script'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(nested, 'skill-script'), 0o755)
  securePrivateTree(tree)
  expect(statSync(tree).mode & 0o777).toBe(0o700)
  expect(statSync(nested).mode & 0o777).toBe(0o700)
  expect(statSync(join(nested, 'transcript.jsonl')).mode & 0o777).toBe(0o600)
  expect(statSync(join(nested, 'skill-script')).mode & 0o777).toBe(0o700)
})

test('private home-seed rejects links before harness can write or chmod external targets', () => {
  const root = mkdtempSync(join(tmpdir(), 'private-links-'))
  roots.push(root)
  for (const linkedPath of ['.cat-code', join('.cat-code', '.config.json')]) {
    const seed = join(root, `seed-${linkedPath.replaceAll('/', '-')}`)
    const home = join(root, `home-${linkedPath.replaceAll('/', '-')}`)
    const outside = join(root, `external-${linkedPath.replaceAll('/', '-')}`)
    mkdirSync(seed, { recursive: true })
    mkdirSync(home, { recursive: true })
    writeFileSync(outside, 'external fixture')
    chmodSync(outside, 0o644)
    if (linkedPath === '.cat-code') {
      symlinkSync(outside, join(seed, linkedPath))
      mkdirSync(join(home, '.cat-code'))
    } else {
      mkdirSync(join(seed, '.cat-code'))
      mkdirSync(join(home, '.cat-code'))
      symlinkSync(outside, join(seed, linkedPath))
    }
    const externalMode = statSync(outside).mode & 0o777
    expect(() => copyPrivateSeed(seed, home)).toThrow()
    expect(readFileSync(outside, 'utf8')).toBe('external fixture')
    expect(statSync(outside).mode & 0o777).toBe(externalMode)
  }
})
