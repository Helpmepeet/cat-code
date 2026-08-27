import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  acquireFileMutationLock,
  writeFileAtomicDurable,
} from '../../utils/atomicFile.js'
import { writeRemoteEntriesToLocalForTest } from './index.js'

const [role, memoryPath, readyPath] = process.argv.slice(2)
if (!role || !memoryPath || !readyPath) {
  throw new Error('expected role, memory path, and ready path')
}
process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = memoryPath

const localPath = join(memoryPath, 'team', 'topic.md')
const mutationTarget = join(memoryPath, '.memory-mutation')

if (role === 'terminal-pull') {
  const expected = await readFile(localPath, 'utf8')
  await writeFile(readyPath, String(process.pid), 'utf8')
  await Bun.sleep(250)
  const release = await acquireFileMutationLock(mutationTarget)
  try {
    const firstAttempt = await writeRemoteEntriesToLocalForTest(
      { 'topic.md': 'remote-content' },
      { 'topic.md': expected },
    )
    const retry = await writeRemoteEntriesToLocalForTest(
      { 'topic.md': 'remote-content' },
      { 'topic.md': 'desktop-local-change' },
    )
    process.stdout.write(
      JSON.stringify({ role, pid: process.pid, firstAttempt, retry }),
    )
  } finally {
    await release()
  }
} else if (role === 'desktop-extraction') {
  for (;;) {
    try {
      await readFile(readyPath)
      break
    } catch {
      await Bun.sleep(5)
    }
  }
  const release = await acquireFileMutationLock(mutationTarget)
  try {
    await writeFileAtomicDurable(localPath, 'desktop-local-change', {
      encoding: 'utf8',
    })
  } finally {
    await release()
  }
  process.stdout.write(JSON.stringify({ role, pid: process.pid }))
} else {
  throw new Error(`unknown role: ${role}`)
}
