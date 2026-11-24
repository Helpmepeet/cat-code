import { spyOn } from 'bun:test'
import * as fs from 'fs/promises'
import { join, sep } from 'node:path'
import { exec } from './Shell.js'
import { getTaskOutputDir } from './task/diskOutput.js'

const root = process.env.CATCODE_SHELL_CANCEL_TEST_ROOT
if (!root || process.cwd() !== root || process.env.HOME !== root) {
  throw new Error('Isolated Shell cancellation fixture required')
}
Object.assign(globalThis, { MACRO: { VERSION: 'shell-cancellation-test' } })

const outputOpened = Promise.withResolvers<{ handle: fs.FileHandle; path: string }>()
const finishOpening = Promise.withResolvers<void>()
const outputPrefix = getTaskOutputDir() + sep
const originalOpen = fs.open
const openSpy = spyOn(fs, 'open').mockImplementation(async (...args) => {
  const handle = await originalOpen(...args)
  const path = String(args[0])
  if (path.startsWith(outputPrefix) && path.endsWith('.output')) {
    outputOpened.resolve({ handle, path })
    // Hold the real file descriptor after open and before exec can spawn.
    await finishOpening.promise
  }
  return handle
})

const controller = new AbortController()
const marker = join(root, 'started')
const pending = exec('printf started > started', controller.signal, 'bash', {
  cwd: root,
  preventCwdChanges: true,
  timeout: 3_000,
  onProgress: () => {},
})
try {
  const { handle, path } = await Promise.race([
    outputOpened.promise,
    pending.then(() => { throw new Error('Shell returned before opening its output file') }),
  ])
  controller.abort('stop')
  finishOpening.resolve()
  const command = await pending
  const result = await command.result
  const exists = async (file: string) => fs.access(file).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false
    throw error
  })
  console.log(JSON.stringify({
    code: result.code,
    interrupted: result.interrupted,
    spawned: command.pid !== undefined,
    markerExists: await exists(marker),
    outputExists: await exists(path),
    outputClosed: handle.fd === -1,
  }))
} finally {
  controller.abort('stop')
  finishOpening.resolve()
  try {
    const command = await pending
    await command.result
    command.cleanup()
  } finally {
    openSpy.mockRestore()
  }
}
