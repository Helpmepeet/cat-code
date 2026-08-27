import { tryAcquireConsolidationLock } from './consolidationLock.js'

const [role, memoryPath, startAtRaw] = process.argv.slice(2)
if (!role || !memoryPath || !startAtRaw) {
  throw new Error('expected role, memory path, and start timestamp')
}
process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = memoryPath

const startAt = Number(startAtRaw)
while (Date.now() < startAt) {
  await Bun.sleep(1)
}

const priorMtime = await tryAcquireConsolidationLock()
process.stdout.write(
  JSON.stringify({
    role,
    pid: process.pid,
    acquired: priorMtime !== null,
  }),
)
await Bun.sleep(1_000)
