import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAccountControlRunner } from './accountControlRunner.js'
import type { AccountControlEvent } from '../shared/accountControlWorker.js'
import type { WorkerProcessLifecycle } from './ndjsonWorker.js'
import { resolveSidecarLaunch } from './mainDecisions.js'

test('session-free account worker keeps one process through login and naming and dies with its owner', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'catcode-account-control-'))
  const fixture = join(directory, 'worker.ts')
  const service = new URL('../sidecar/accountControlSession.ts', import.meta.url).pathname
  writeFileSync(fixture, `
    import { serveAccountControl } from ${JSON.stringify(service)};
    let sink = () => {};
    await serveAccountControl(process.stdin, {
      setOAuthProgressSink(callback) { sink = callback; },
      async runVerb(verb) {
        if (verb.type === 'account.login') sink({ state: 'waiting_for_alias' });
        if (verb.type === 'account.oauthAlias') sink({ state: 'success' });
        return { verb: verb.type, result: { ok: true, message: 'Done' }, poolChanged: verb.type === 'account.oauthAlias' };
      }
    }, async event => { process.stdout.write(JSON.stringify(event) + '\\n'); });
  `)
  const progress: AccountControlEvent[] = []
  const lifecycle: WorkerProcessLifecycle[] = []
  let refreshed = 0
  const runner = createAccountControlRunner({
    launch: () => ({ command: process.execPath, args: [fixture], cwd: directory, onWorkerLifecycle: event => lifecycle.push(event) }),
    onProgress: event => progress.push(event), onPoolChanged: () => { refreshed++ },
  })
  try {
    const start = await runner.run({ type: 'account.login', requestId: 'login', provider: 'anthropic' })
    expect(start.ok).toBe(true)
    expect(start.sessionId).toBe('')
    expect(runner.replay()).toMatchObject({ provider: 'anthropic', progress: { state: 'waiting_for_alias' } })
    const saved = await runner.run({ type: 'account.oauthAlias', requestId: 'name', alias: 'work' })
    expect(saved.requestId).toBe('name')
    expect(saved.ok).toBe(true)
    expect(progress.map(event => event.type === 'progress' ? event.progress?.state : null)).toEqual(['waiting_for_alias', 'success'])
    expect(refreshed).toBeGreaterThan(0)
    expect(lifecycle.filter(event => event.phase === 'started')).toHaveLength(1)
  } finally {
    await runner.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
  expect(lifecycle.filter(event => event.phase === 'exited')).toHaveLength(1)
})

test.each(['wrong-request', 'unexpected-field'])('rejects %s from the worker before publishing', async mode => {
  const directory = mkdtempSync(join(tmpdir(), 'catcode-account-control-'))
  const fixture = join(directory, 'worker.js')
  writeFileSync(fixture, `
    import { createInterface } from 'node:readline';
    createInterface({ input: process.stdin }).on('line', line => {
      const verb = JSON.parse(line);
      const result = { type: 'result', version: 1, requestId: ${mode === 'wrong-request' ? "'unknown'" : 'verb.requestId'}, verb: verb.type, ok: true, message: 'Done', changed: true ${mode === 'unexpected-field' ? ", accessToken: 'synthetic-secret'" : ''} };
      process.stdout.write(JSON.stringify(result) + '\\n');
    });
  `)
  let publications = 0
  const runner = createAccountControlRunner({
    launch: () => ({ command: process.execPath, args: [fixture], cwd: directory }),
    onProgress: () => { publications++ }, onPoolChanged: () => { publications++ },
  })
  try {
    await expect(runner.run({ type: 'account.login', requestId: 'login' })).rejects.toThrow('worker stopped')
    expect(publications).toBe(0)
  } finally { await runner.dispose(); rmSync(directory, { recursive: true, force: true }) }
})

test('the production account worker boots without a session or credentials', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'catcode-account-control-boot-'))
  const blocker = join(directory, 'block-network.ts')
  writeFileSync(blocker, "globalThis.fetch = () => { throw new Error('network forbidden in account worker probe') };\n")
  const plan = resolveSidecarLaunch({ packaged: false, mainDir: new URL('.', import.meta.url).pathname, bunBin: process.execPath })
  const diagnostics: string[] = []
  const runner = createAccountControlRunner({
    launch: () => ({
      command: plan.command, args: ['run', `--preload=${blocker}`, ...plan.argsFor('account-control').slice(1)], cwd: directory,
      log: line => diagnostics.push(line),
      env: { ...process.env, HOME: directory, CLAUDE_CONFIG_DIR: join(directory, 'config'), CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-no-network', ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, CLAUDE_CODE_USE_BEDROCK: undefined, CLAUDE_CODE_USE_VERTEX: undefined, CLAUDE_CODE_USE_FOUNDRY: undefined },
    }),
    onProgress: () => { throw new Error('no login was requested') },
    onPoolChanged: () => { throw new Error('no account was changed') },
  })
  try {
    const result = await runner.run({ type: 'account.oauthPasteCode', requestId: 'paste', code: 'synthetic-code' }).catch(error => { throw new Error(diagnostics.join('\n'), { cause: error }) })
    expect(result.ok).toBe(false)
    expect(result.message).toBe('No sign-in is waiting for a code.')
  } finally { await runner.dispose(); rmSync(directory, { recursive: true, force: true }) }
})
