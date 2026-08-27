import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RECOVERED_TERMINAL_TEXT_PREFIX } from './debug.js'

const CHILD = join(import.meta.dir, 'alwaysLogPrefix.probe.child.ts')
const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('always-log prefix routing', () => {
  // Regression for a fix that was itself defective: the recovery line was
  // written as a plain [codex-fetch] message, which shouldLogDebugMessage
  // drops for non-ant users outside debug mode. The log existed and recorded
  // nothing. No in-process test can catch that, so this spawns a real process.
  test('a prefixed line is written without debug mode; an unprefixed one is not', async () => {
    const logsDir = await mkdtemp(join(tmpdir(), 'catcode-alwayslog-'))
    cleanup.push(logsDir)
    // CLAUDE_CODE_DEBUG_LOGS_DIR is read as a full file path, not a directory.
    const logPath = join(logsDir, 'probe.txt')

    const child = Bun.spawn(['bun', 'run', CHILD], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        CLAUDE_CODE_DEBUG_LOGS_DIR: logPath,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await child.exited
    expect({ exitCode, stderr: await new Response(child.stderr).text() }).toMatchObject({
      exitCode: 0,
    })

    const contents = await readFile(logPath, 'utf8')

    expect(contents).toContain(RECOVERED_TERMINAL_TEXT_PREFIX)
    expect(contents).not.toContain('an ordinary gated line')
  })
})
