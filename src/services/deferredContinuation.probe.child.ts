import { appendFile, access, rm } from 'node:fs/promises'
import {
  acquireDeferredContinuationLocks,
  getDeferredContinuationLockTargets,
  type DeferredContinuationJobV1,
} from './deferredContinuation.js'

const sessionId = process.env.PROBE_SESSION_ID!
const jobId = process.env.PROBE_JOB_ID!
const ready = process.env.PROBE_READY!
const go = process.env.PROBE_GO!
const winners = process.env.PROBE_WINNERS!

const job = { sessionId, jobId } as Pick<
  DeferredContinuationJobV1,
  'sessionId' | 'jobId'
>

async function waitForFile(path: string): Promise<void> {
  while (true) {
    try {
      await access(path)
      return
    } catch {
      await Bun.sleep(5)
    }
  }
}

// Steal mode models the scenario the dual lock exists to contain: this process
// takes real ownership of a session another live process still believes it
// owns. The victim's proper-lockfile updater then observes a foreign mtime and
// fires onCompromised for real — no fake guard involved.
if (process.env.PROBE_MODE === 'steal') {
  const targets = getDeferredContinuationLockTargets(job)
  for (const target of [targets.session, targets.job]) {
    await rm(`${target}.lock`, { recursive: true, force: true })
  }
  const stolenGuard = await acquireDeferredContinuationLocks(job)
  await Bun.write(process.env.PROBE_STOLEN!, 'stolen')
  await waitForFile(process.env.PROBE_RELEASE!)
  await stolenGuard.release()
  process.stdout.write('RESULT:stolen\n')
  process.exit(0)
}

await Bun.write(ready, 'ready')
await waitForFile(go)

try {
  const guard = await acquireDeferredContinuationLocks(job)
  await appendFile(winners, `${process.pid}\n`)
  await Bun.sleep(300)
  await guard.release()
  process.stdout.write('RESULT:acquired\n')
} catch {
  process.stdout.write('RESULT:contended\n')
}
