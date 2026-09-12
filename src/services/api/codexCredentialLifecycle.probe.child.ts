import { existsSync, writeFileSync } from 'fs'
import { createCodexCredentialLifecycle } from './codexCredentialLifecycle.js'

const [role, directory, accountId, readyPath, delayRaw] = process.argv.slice(2)
const delayMs = Number(delayRaw)

if (
  !role ||
  !directory ||
  !accountId ||
  !readyPath ||
  !Number.isSafeInteger(delayMs) ||
  delayMs < 0
) {
  throw new Error('expected lifecycle probe role, directory, account, ready path, and delay')
}

function printResult(result: Record<string, unknown>): void {
  process.stdout.write(`RESULT:${JSON.stringify(result)}\n`)
}

async function waitForReady(): Promise<void> {
  const startedAt = Date.now()
  while (!existsSync(readyPath)) {
    if (Date.now() - startedAt > 20_000) {
      throw new Error('timed out waiting for lifecycle lock holder')
    }
    await Bun.sleep(10)
  }
}

async function main(): Promise<void> {
  const lifecycle = createCodexCredentialLifecycle({ directory })
  if (role === 'holder') {
    await lifecycle.withTransaction(
      accountId,
      { operationKind: 'refresh', operationId: `holder-${process.pid}` },
      async () => {
        writeFileSync(readyPath, String(process.pid), 'utf8')
        await Bun.sleep(delayMs)
      },
    )
    printResult({ ok: true, role })
    return
  }

  if (role === 'waiter') {
    await waitForReady()
    const startedAt = Date.now()
    await lifecycle.withTransaction(
      accountId,
      { operationKind: 'refresh', operationId: `waiter-${process.pid}` },
      () => undefined,
    )
    printResult({ ok: true, role, waitedMs: Date.now() - startedAt })
    return
  }

  throw new Error('unknown lifecycle probe role')
}

void main().catch(error => {
  printResult({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  })
  process.exit(1)
})
