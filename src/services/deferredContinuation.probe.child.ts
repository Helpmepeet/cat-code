import { appendFile, access } from 'node:fs/promises'
import {
  acquireDeferredContinuationLocks,
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

await Bun.write(ready, 'ready')
while (true) {
  try {
    await access(go)
    break
  } catch {
    await Bun.sleep(5)
  }
}

try {
  const guard = await acquireDeferredContinuationLocks(job)
  await appendFile(winners, `${process.pid}\n`)
  await Bun.sleep(300)
  await guard.release()
  process.stdout.write('RESULT:acquired\n')
} catch {
  process.stdout.write('RESULT:contended\n')
}
