import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const probe = new URL('./claudeTokenRefresh.probe.child.ts', import.meta.url).pathname
function spawn(root: string, account: string, mode: string, config = mode) {
  return Bun.spawn([process.execPath, probe, root, account, mode], {
    env: { ...process.env, HOME: root, CLAUDE_CONFIG_DIR: join(root, config) }, stdout: 'pipe', stderr: 'pipe',
  })
}
async function output(child: ReturnType<typeof spawn>) {
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (code !== 0) throw new Error(`Probe failed (${code}): ${stderr}\n${stdout}`)
  return JSON.parse(stdout)
}
async function started(root: string, account: string) {
  const deadline = Date.now() + 5_000
  while (!existsSync(join(root, `started-${account}`))) {
    if (Date.now() > deadline) throw new Error('Probe never reached dispatch')
    await Bun.sleep(5)
  }
}
function isolated() { return mkdtempSync(join(tmpdir(), 'claude-refresh-process-')) }

test('different configs share a refresh while a suspended holder does not block another account', async () => {
  const root = isolated()
  const children: ReturnType<typeof spawn>[] = []
  try {
    await output(spawn(root, 'a', 'login'))
    await output(spawn(root, 'b', 'login'))
    const holder = spawn(root, 'a', 'hold', 'config-one'); children.push(holder)
    await started(root, 'a')
    process.kill(holder.pid, 'SIGSTOP')
    const waiter = spawn(root, 'a', 'refresh', 'config-two'); children.push(waiter)
    const independent = await output(spawn(root, 'b', 'refresh', 'config-three'))
    expect(independent.result.status).toBe('ready')
    expect(independent.sends).toBe(1)
    writeFileSync(join(root, 'release-a'), 'go')
    process.kill(holder.pid, 'SIGCONT')
    const [first, second] = await Promise.all([output(holder), output(waiter)])
    expect(first.result.status).toBe('ready')
    expect(second.result.status).toBe('ready')
    expect(second.sends).toBe(0)
    expect(readFileSync(join(root, 'sends'), 'utf8').split('\n').filter(id => id === 'a')).toHaveLength(1)
  } finally {
    for (const child of children) { try { process.kill(child.pid, 'SIGCONT') } catch {} child.kill() }
    rmSync(root, { recursive: true, force: true })
  }
}, 20_000)

test('lost response is durable uncertain and another process never replays', async () => {
  const root = isolated()
  let child: ReturnType<typeof spawn> | undefined
  try {
    await output(spawn(root, 'a', 'login'))
    child = spawn(root, 'a', 'lost-response')
    await started(root, 'a')
    writeFileSync(join(root, 'release-a'), 'go')
    expect((await output(child)).result.status).toBe('refresh_uncertain')
    const next = await output(spawn(root, 'a', 'refresh'))
    expect(next.result.status).toBe('refresh_uncertain')
    expect(next.sends).toBe(0)
  } finally { child?.kill(); rmSync(root, { recursive: true, force: true }) }
})

test('successor persistence failure retries only local persistence', async () => {
  const root = isolated()
  try {
    await output(spawn(root, 'a', 'login'))
    const result = await output(spawn(root, 'a', 'pending-save'))
    expect(result.result.status).toBe('persistence_pending')
    expect(result.retried.status).toBe('ready')
    expect(result.sends).toBe(1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('definitely not connected gets one bounded retry; rejection persists without replay', async () => {
  const root = isolated()
  try {
    await output(spawn(root, 'a', 'login'))
    const offline = await output(spawn(root, 'a', 'offline'))
    expect(offline.result.status).toBe('ready')
    expect(offline.sends).toBe(2)
    await output(spawn(root, 'b', 'login'))
    expect((await output(spawn(root, 'b', 'rejected'))).result.status).toBe('sign_in_required')
    const again = await output(spawn(root, 'b', 'refresh'))
    expect(again.result.status).toBe('sign_in_required')
    expect(again.sends).toBe(0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('removed refresh lock reconciles a late successor durably without a second request', async () => {
  const root = isolated()
  let child: ReturnType<typeof spawn> | undefined
  try {
    await output(spawn(root, 'a', 'login'))
    child = spawn(root, 'a', 'hold')
    await started(root, 'a')
    rmSync(join(root, 'refresh-locks', 'a.lock'), { recursive: true })
    writeFileSync(join(root, 'release-a'), 'go')
    expect((await output(child)).result.status).toBe('ready')
    const record = JSON.parse(readFileSync(join(root, 'authority-v1', 'a.json'), 'utf8'))
    expect(record.credentials.accessToken).toBe('successor-a')
    const restored = await output(spawn(root, 'a', 'refresh'))
    expect(restored.result.status).toBe('ready')
    expect(restored.sends).toBe(0)
  } finally { child?.kill(); rmSync(root, { recursive: true, force: true }) }
})

test('login and deletion racing an issued refresh fence late credentials', async () => {
  for (const mutation of ['relogin', 'delete']) {
    for (const compromise of [false, true]) {
      const root = isolated()
      let child: ReturnType<typeof spawn> | undefined
      try {
        await output(spawn(root, 'a', 'login'))
        child = spawn(root, 'a', 'hold')
        await started(root, 'a')
        if (compromise) rmSync(join(root, 'refresh-locks', 'a.lock'), { recursive: true })
        expect((await output(spawn(root, 'a', mutation))).outcome).toBe('committed')
        writeFileSync(join(root, 'release-a'), 'go')
        expect((await output(child)).result.status).toBe('older_login')
        const record = JSON.parse(readFileSync(join(root, 'authority-v1', 'a.json'), 'utf8'))
        expect(record.credentials?.accessToken).not.toBe('successor-a')
      } finally { child?.kill(); rmSync(root, { recursive: true, force: true }) }
    }
  }
})

test('process death after dispatch becomes uncertain once its filesystem lock is stale', async () => {
  const root = isolated()
  let child: ReturnType<typeof spawn> | undefined
  try {
    await output(spawn(root, 'a', 'login'))
    child = spawn(root, 'a', 'hold')
    await started(root, 'a')
    child.kill('SIGKILL')
    await child.exited
    const old = new Date(Date.now() - 180_000)
    utimesSync(join(root, 'refresh-locks', 'a.lock'), old, old)
    const recovered = await output(spawn(root, 'a', 'refresh'))
    expect(recovered.result.status).toBe('refresh_uncertain')
    expect(recovered.sends).toBe(0)
  } finally { child?.kill(); rmSync(root, { recursive: true, force: true }) }
})

test('cancelled waiter leaves the issued refresh running and captures its successor', async () => {
  const root = isolated()
  try {
    await output(spawn(root, 'a', 'login'))
    const result = await output(spawn(root, 'a', 'cancelled'))
    expect(result.cancelled.status).toBe('waiting')
    expect(result.result.status).toBe('ready')
    expect(result.result.credentials.accessToken).toBe('successor-a')
    expect(result.sends).toBe(1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('lifecycle mutation before initiation prevents a network send', async () => {
  for (const mode of ['login-before-dispatch', 'delete-before-dispatch']) {
    const root = isolated()
    try {
      await output(spawn(root, 'a', 'login'))
      const result = await output(spawn(root, 'a', mode))
      expect(result.result.status).toBe('older_login')
      expect(result.sends).toBe(0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('revision authority adopts unchanged token bytes and fences old-revision rejection', async () => {
  const root = isolated()
  try {
    await output(spawn(root, 'a', 'login'))
    const result = await output(spawn(root, 'a', 'newer-revision'))
    expect(result.result.status).toBe('ready')
    expect(result.result.handle.revision).toBe(1)
    expect(result.rejected.outcome).toBe('rejected')
    expect(result.sends).toBe(0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('access rejection survives offline refresh and a fresh process cannot send the old revision', async () => {
  const root = isolated()
  try {
    await output(spawn(root, 'a', 'login'))
    expect((await output(spawn(root, 'a', 'reject-access'))).outcome).toBe('committed')
    const offline = await output(spawn(root, 'a', 'offline-always'))
    expect(offline.result.status).toBe('temporarily_unavailable')
    expect(offline.sends).toBe(2)
    const observed = await output(spawn(root, 'a', 'inspect'))
    expect(observed.status).toBe('rejected')
    expect(observed.sendable).toBe(false)
    const repaired = await output(spawn(root, 'a', 'refresh'))
    expect(repaired.result.status).toBe('ready')
    expect(repaired.result.handle.revision).toBe(1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('compromised successor save failure retries fenced reconciliation without network', async () => {
  const root = isolated()
  try {
    await output(spawn(root, 'a', 'login'))
    const result = await output(spawn(root, 'a', 'compromised-pending-save'))
    expect(result.result.status).toBe('persistence_pending')
    expect(result.retried.status).toBe('ready')
    expect(result.sends).toBe(1)
    expect((await output(spawn(root, 'a', 'refresh'))).sends).toBe(0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('refresh diagnostics contain hashed identities and classified outcomes, never credentials', async () => {
  const root = isolated()
  try {
    await output(spawn(root, 'sensitive-account-id', 'login'))
    const result = await output(spawn(root, 'sensitive-account-id', 'diagnostics'))
    const diagnostics = result.diagnostics.join('\\n')
    expect(diagnostics).toContain('phase=init outcome=started')
    expect(diagnostics).toContain('phase=lock outcome=acquired')
    expect(diagnostics).toContain('phase=dispatch outcome=initiated')
    expect(diagnostics).toContain('phase=operation outcome=ready')
    for (const secret of [root, 'sensitive-account-id', 'initial-', 'refresh-', 'successor-', 'rotated-']) {
      expect(diagnostics).not.toContain(secret)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('late lock-loss successor cannot override terminal refresh rejection', async () => {
  const root = isolated()
  let child: ReturnType<typeof spawn> | undefined
  try {
    await output(spawn(root, 'a', 'login'))
    child = spawn(root, 'a', 'hold')
    await started(root, 'a')
    rmSync(join(root, 'refresh-locks', 'a.lock'), { recursive: true })
    expect((await output(spawn(root, 'a', 'reject-refresh'))).outcome).toBe('committed')
    writeFileSync(join(root, 'release-a'), 'go')
    expect((await output(child)).result.status).toBe('sign_in_required')
    const next = await output(spawn(root, 'a', 'refresh'))
    expect(next.result.status).toBe('sign_in_required')
    expect(next.sends).toBe(0)
  } finally { child?.kill(); rmSync(root, { recursive: true, force: true }) }
})

test('ownership loss before physical initiation is safely not sent, not uncertain', async () => {
  const root = isolated()
  try {
    await output(spawn(root, 'a', 'login'))
    const result = await output(spawn(root, 'a', 'lock-loss-before-dispatch'))
    expect(result.result.status).toBe('temporarily_unavailable')
    expect(result.sends).toBe(0)
    const record = JSON.parse(readFileSync(join(root, 'authority-v1', 'a.json'), 'utf8'))
    expect(record.refreshIntent).toBeUndefined()
    expect(record.credentialDisposition).toBe('usable')
    const retried = await output(spawn(root, 'a', 'refresh'))
    expect(retried.result.status).toBe('ready')
    expect(retried.sends).toBe(1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
