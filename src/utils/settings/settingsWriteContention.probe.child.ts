/**
 * settings-write contention probe — CHILD HARNESS (not a test; spawned as a
 * real OS process by settingsWriteContention.probe.test.ts).
 *
 * Each child is "one engine process" persisting an always-allow permission
 * rule to the SAME localSettings file (the P3-5a same-cwd race: two engine
 * processes, one cwd, `settings.local.json`). Runs the real production call
 * `persistPermissionUpdate` — the exact function the P3-5a GUI run proved
 * drops a rule under contention.
 *
 * Env contract (set by the parent test):
 *   PROBE_CWD      the shared localSettings root (getOriginalCwd())
 *   PROBE_RULE     the Bash rule content to add (unique per contender)
 *   PROBE_GO_FILE  barrier file; blocks until it exists
 *
 * Prints exactly one `RESULT:{json}` line on stdout.
 */

/* eslint-disable no-console */

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function waitForGoFile(goFile: string): Promise<void> {
  const { existsSync } = await import('fs')
  const start = Date.now()
  while (!existsSync(goFile)) {
    if (Date.now() - start > 20_000) {
      throw new Error('timed out waiting for go file')
    }
    await Bun.sleep(10)
  }
}

function printResult(result: Record<string, unknown>): void {
  console.log(`RESULT:${JSON.stringify(result)}`)
}

async function main(): Promise<void> {
  const cwd = requireEnv('PROBE_CWD')
  const rule = requireEnv('PROBE_RULE')
  const goFile = requireEnv('PROBE_GO_FILE')

  const { setOriginalCwd } = await import('../../bootstrap/state.js')
  setOriginalCwd(cwd)

  const { persistPermissionUpdate } = await import(
    '../permissions/PermissionUpdate.js'
  )
  const { writeFileSync } = await import('fs')
  writeFileSync(`${goFile}.ready.${process.pid}`, '1')
  await waitForGoFile(goFile)

  try {
    persistPermissionUpdate({
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: rule }],
      behavior: 'allow',
      destination: 'localSettings',
    })
    printResult({ ok: true })
  } catch (error) {
    printResult({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

void main().catch(error => {
  printResult({
    ok: false,
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  })
  process.exit(1)
})
