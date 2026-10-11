import { constants, cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { cases, fixture, investigation } from './fixtures.js'
import { policy, schedule, sha } from './policy.js'
import { environment } from './isolation.js'

export function inventory(root: string): Record<string, string> {
  const result: Record<string, string> = {}
  function walk(dir: string, relative: string) {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name === 'node_modules') continue
      const path = join(dir, item.name), key = relative ? `${relative}/${item.name}` : item.name
      if (item.isDirectory()) walk(path, key)
      else if (item.isFile()) result[key] = sha(readFileSync(path))
      else throw Error(`Unexpected source symlink ${key}`)
    }
  }
  walk(root, '')
  return result
}
export function dependencyHash(root: string): string {
  const hashes: string[] = []
  function walk(dir: string, prefix: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name), relative = `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(path, relative)
      else hashes.push(`${relative}:${entry.isSymbolicLink() ? 'link:' + readlinkSync(path) : sha(readFileSync(path))}`)
    }
  }
  walk(root, '')
  return sha(hashes.join('\n'))
}
export async function prepare(out: string) {
  if (existsSync(out)) throw Error('Preparation directory must be new')
  const repo = resolve(import.meta.dir, '../../..')
  const engine = join(out, 'engine')
  mkdirSync(engine, { recursive: true, mode: 0o700 })
  const archive = Bun.spawnSync(['git', '-c', 'core.fsmonitor=false', 'archive', policy.engineCommit], { cwd: repo, stdout: 'pipe', stderr: 'pipe' })
  if (archive.exitCode) throw Error(archive.stderr.toString())
  const unpack = Bun.spawnSync(['/usr/bin/tar', '-xf', '-', '-C', engine], { stdin: archive.stdout, stdout: 'pipe', stderr: 'pipe' })
  if (unpack.exitCode) throw Error(unpack.stderr.toString())
  cpSync(import.meta.dir, join(engine, 'scripts/harness-design-eval/task-restore'), { recursive: true })
  cpSync(join(repo, 'node_modules'), join(engine, 'node_modules'), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
  const inputs: Record<string, unknown> = {}
  for (const c of cases) {
    const f = fixture(c.id), root = join(out, 'seeds', c.id), cwd = join(root, 'workspace'), home = join(root, 'home'), temp = join(root, 'tmp')
    for (const d of [cwd, home, temp, join(home, '.cat-code')]) mkdirSync(d, { recursive: true, mode: 0o700 })
    for (const [p, body] of Object.entries(f.files)) {
      mkdirSync(resolve(cwd, p, '..'), { recursive: true })
      writeFileSync(join(cwd, p), body)
    }
    mkdirSync(join(cwd, 'investigation'))
    for (let i = 0; i < (c.long ? 24 : 2); i++) writeFileSync(join(cwd, 'investigation', `batch-${i}.txt`), investigation(i))
    const sessionId = randomUUID()
    const config = { hasCompletedOnboarding: true, primaryProvider: 'anthropic', projects: { [cwd]: { hasTrustDialogAccepted: true } } }
    writeFileSync(join(home, '.cat-code/.config.json'), JSON.stringify(config), { mode: 0o600 })
    writeFileSync(join(home, '.cat-code/settings.json'), JSON.stringify({ model: policy.model, effortLevel: policy.effort }), { mode: 0o600 })
    const child = Bun.spawn([process.execPath, '--feature=COMPACT_TASK_RESTORE', join(engine, 'scripts/harness-design-eval/task-restore/seed.ts'), c.id, sessionId, join(root, 'seed.json')],
      { cwd, env: environment(home, temp, c.mode), stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    writeFileSync(join(root, 'seed.log'), stdout + stderr)
    if (code !== 0) throw Error(`Seed failed ${c.id}: ${stderr}`)
    inputs[c.id] = { seed: JSON.parse(readFileSync(join(root, 'seed.json'), 'utf8')), workspace: inventory(cwd), home: inventory(home), prompt: f }
  }
  const runtime = { bun: Bun.version, binarySha256: sha(readFileSync(process.execPath)), dependencyLockSha256: sha(readFileSync(join(repo, 'bun.lock'))), dependencyTreeSha256: dependencyHash(join(engine, 'node_modules')) }
  const manifest = { ...policy, schedule, engineArchiveSha256: sha(archive.stdout), runtime, engineInventory: inventory(engine), inputs,
    preparation: { sourceWorkingTree: 'Only pinned Git archive plus hashed evaluation support; unrelated AgentTool edit excluded',
      keyAndBilling: 'Unresolved offline. No key was read, no live request was sent.',
      liveAuthorization: 'None. This package is offline-only. The four-attempt GPT-6.1 Sol proposal is separate and blocked pending a verified Responses gateway and new digest-bound human authorization.' } }
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
  writeFileSync(join(out, 'manifest.sha256'), sha(JSON.stringify(manifest, null, 2)) + '\n')
  return { out, manifestSha256: sha(JSON.stringify(manifest, null, 2)), runs: schedule.length }
}
if (import.meta.main) console.log(JSON.stringify(await prepare(resolve(process.argv[2] ?? '/private/tmp/task-restore-screen-v1')), null, 2))
