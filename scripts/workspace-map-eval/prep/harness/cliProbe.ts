#!/usr/bin/env bun
// CLI comparison probe: the frozen engine's headless CLI (-p) from source with
// the dev-full feature set that cli-dev is compiled with, same isolation,
// interceptor, and sandbox as harness.ts.
// Usage: bun cliProbe.ts --engine <dir> --copy <dir holding cat-code/> --out <dir> --prompt-file <file>
import { cpSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { sandboxProfile, probeScratch } from './sandbox.ts'
import { randomBytes } from 'node:crypto'

const args = process.argv.slice(2)
const opt = (k: string, d?: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1]! : d! }
const engine = resolve(opt('--engine'))
const copy = resolve(opt('--copy'))
const out = resolve(opt('--out'))
const model = opt('--model', 'gpt-6.1-sol')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const stage = join('/Users/Shared/ccw', randomBytes(3).toString('hex'))
mkdirSync(stage, { recursive: true })
const cwd = join(stage, 'cat-code')
renameSync(join(copy, 'cat-code'), cwd)
const scratch = probeScratch()
const prompt = readFileSync(opt('--prompt-file'), 'utf8').replaceAll('{{REPO}}', cwd).replaceAll('{{HOME}}', join(stage, 'home'))
try {
  const home = join(stage, 'home'), config = join(home, '.cat-code'), tmp = join(stage, 'tmp')
  for (const d of [config, tmp, join(home, '.cache'), join(home, '.config')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(config, '.config.json'), JSON.stringify({
    hasCompletedOnboarding: true,
    projects: { [cwd]: { hasTrustDialogAccepted: true } },
    codexOAuth: { accessToken: 'offline-probe-access', refreshToken: 'offline-probe-refresh', expiresAt: Date.now() + 365 * 86400e3, accountId: 'acct-offline-probe' },
  }, null, 2))
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ model, effortLevel: 'high' }, null, 2))

  const buildSrc = readFileSync(join(engine, 'scripts/build.ts'), 'utf8')
  const full = [...buildSrc.slice(buildSrc.indexOf('fullExperimentalFeatures'), buildSrc.indexOf('const defaultFeatures')).matchAll(/'([A-Z_]+)'/g)].map(m => m[1]!)
  const defaults = [...buildSrc.slice(buildSrc.indexOf('const defaultFeatures'), buildSrc.indexOf('const featureSet')).matchAll(/'([A-Z_]+)'/g)].map(m => m[1]!)
  const features = [...new Set([...defaults, ...full])]
  const env: Record<string, string> = {
    PATH: process.env.PATH!, USER: process.env.USER!, SHELL: process.env.SHELL ?? '/bin/zsh', LANG: process.env.LANG ?? 'en_US.UTF-8',
    HOME: home, CLAUDE_CONFIG_DIR: config, TMPDIR: tmp, XDG_CACHE_HOME: join(home, '.cache'), XDG_CONFIG_HOME: join(home, '.config'),
    CCW_PROBE_DIR: join(scratch.dir, 'stub'), ANTHROPIC_API_KEY: 'sk-ant-offline-probe', CCW_ENGINE: engine, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // The compiled CLI bundles its own transport module, so the in-process
    // WebSocket fake cannot attach: the sandbox refuses the socket and the
    // engine's own HTTP fallback reaches the fetch fake instead.
    CCW_NO_WS_FAKE: '1', BUN_OPTIONS: `--preload=${scratch.interceptor}`,
  }
  const profile = sandboxProfile(stage, engine)
  const proc = Bun.spawn(['/usr/bin/sandbox-exec', '-p', profile, join(engine, 'cli-dev'),
    '-p', prompt, '--model', model, '--permission-mode', 'auto', '--output-format', 'json'], { cwd, env, stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => proc.kill('SIGTERM'), Number(opt('--timeout-ms', '180000')))
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  clearTimeout(timer)
  writeFileSync(join(out, 'cli-stdout.txt'), stdout)
  writeFileSync(join(out, 'cli-stderr.txt'), stderr)
  writeFileSync(join(out, 'features.json'), JSON.stringify(features))
  cpSync(home, join(out, 'home'), { recursive: true })
  cpSync(join(scratch.dir, 'stub'), join(out, 'stub'), { recursive: true })
  console.log(JSON.stringify({ code, features: features.length, stdout: stdout.slice(0, 300), stderr: stderr.slice(0, 500) }, null, 1))
} finally {
  renameSync(cwd, join(copy, 'cat-code'))
  rmSync(stage, { recursive: true, force: true })
  rmSync(scratch.dir, { recursive: true, force: true })
  writeFileSync(join(out, 'stage.json'), JSON.stringify({ stage, cwd, copy }, null, 1))
}
