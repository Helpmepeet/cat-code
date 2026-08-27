import { readFile } from 'fs/promises'
import {
  acquireFileMutationLock,
  writeFileAtomicDurable,
  writeFileAtomicDurableIfAbsent,
} from './atomicFile.js'

const [role, filePath, iterationsRaw] = process.argv.slice(2)
const iterations = Number(iterationsRaw)

if (!role || !filePath || !Number.isInteger(iterations)) {
  throw new Error('expected role, file path, and iteration count')
}

if (role === 'terminal-writer') {
  for (let i = 0; i < iterations; i++) {
    await writeFileAtomicDurable(
      filePath,
      JSON.stringify({ role, iteration: i, payload: 'x'.repeat(32_768) }),
      { encoding: 'utf8' },
    )
  }
} else if (role === 'desktop-reader') {
  let reads = 0
  while (reads < iterations * 8) {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as {
        role?: unknown
        payload?: unknown
      }
      if (
        parsed.role !== 'terminal-writer' ||
        typeof parsed.payload !== 'string' ||
        parsed.payload.length !== 32_768
      ) {
        throw new Error('reader observed an incomplete publication')
      }
      reads++
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        continue
      }
      throw error
    }
  }
} else if (role === 'terminal-creator' || role === 'desktop-creator') {
  const payload = `${role}:${'y'.repeat(32_768)}`
  await writeFileAtomicDurableIfAbsent(filePath, payload, {
    encoding: 'utf8',
  })
} else if (role === 'lock-holder') {
  const release = await acquireFileMutationLock(filePath)
  try {
    await Bun.write(`${filePath}.ready`, String(process.pid))
    await Bun.sleep(iterations)
  } finally {
    await release()
  }
  process.stdout.write(JSON.stringify({ role, pid: process.pid }))
} else if (role === 'lock-waiter') {
  while (true) {
    try {
      await readFile(`${filePath}.ready`)
      break
    } catch {
      await Bun.sleep(5)
    }
  }
  const startedAt = Date.now()
  const release = await acquireFileMutationLock(filePath)
  const waitedMs = Date.now() - startedAt
  await release()
  process.stdout.write(JSON.stringify({ role, pid: process.pid, waitedMs }))
} else {
  throw new Error(`unknown role: ${role}`)
}
