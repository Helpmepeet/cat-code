export type ProcessGroupOps = {
  alive(processGroupId: number): boolean
  signal(processGroupId: number, signal: NodeJS.Signals): void
  sleep(ms: number): Promise<void>
}

const realOps: ProcessGroupOps = {
  alive: processGroupId => {
    try { process.kill(-processGroupId, 0); return true } catch { return false }
  },
  signal: (processGroupId, signal) => { process.kill(-processGroupId, signal) },
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

/** Reap only the detached process group minted for one benchmark sample. */
export async function reapOwnedProcessGroup(
  processGroupId: number,
  options: { initialWaitMs?: number; termWaitMs?: number; killWaitMs?: number; pollMs?: number; ops?: ProcessGroupOps } = {},
): Promise<void> {
  if (!Number.isSafeInteger(processGroupId) || processGroupId < 1) throw new Error('invalid owned process group id')
  const ops = options.ops ?? realOps
  const pollMs = options.pollMs ?? 25
  if (await waitGone(processGroupId, options.initialWaitMs ?? 5_000, pollMs, ops)) return
  try { ops.signal(processGroupId, 'SIGTERM') } catch {}
  if (await waitGone(processGroupId, options.termWaitMs ?? 2_000, pollMs, ops)) return
  try { ops.signal(processGroupId, 'SIGKILL') } catch {}
  if (await waitGone(processGroupId, options.killWaitMs ?? 2_000, pollMs, ops)) return
  throw new Error(`owned Electron process group ${processGroupId} remained after SIGKILL`)
}

async function waitGone(processGroupId: number, waitMs: number, pollMs: number, ops: ProcessGroupOps): Promise<boolean> {
  const attempts = Math.max(1, Math.ceil(waitMs / Math.max(1, pollMs)))
  for (let index = 0; index < attempts; index++) {
    if (!ops.alive(processGroupId)) return true
    await ops.sleep(pollMs)
  }
  return !ops.alive(processGroupId)
}
