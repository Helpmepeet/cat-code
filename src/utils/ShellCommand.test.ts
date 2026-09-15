import { describe, expect, test } from 'bun:test'
import { spawn } from 'child_process'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { setTimeout as sleep } from 'timers/promises'
import { TaskOutput } from './task/TaskOutput.js'
import { wrapSpawn } from './ShellCommand.js'

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Process already exited.
    }
  }
}

async function readPid(path: string): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const raw = await readFile(path, 'utf8')
      const pid = Number(raw.trim())
      if (Number.isInteger(pid) && pid > 0) {
        return pid
      }
    } catch {
      // File may not exist yet.
    }
    await sleep(20)
  }
  throw new Error(`PID file was not written: ${path}`)
}

describe('ShellCommand', () => {
  test('kills detached shell process group when the parent process exits', async () => {
    if (process.platform === 'win32') {
      return
    }

    const dir = await mkdtemp(join(tmpdir(), 'shell-command-exit-'))
    const pidFile = join(dir, 'child.pid')
    let shellPid: number | undefined

    try {
      const shellCommandUrl = pathToFileURL(
        join(process.cwd(), 'src/utils/ShellCommand.ts'),
      ).href
      const taskOutputUrl = pathToFileURL(
        join(process.cwd(), 'src/utils/task/TaskOutput.ts'),
      ).href
      const code = `
        import { spawn } from 'child_process'
        import { TaskOutput } from ${JSON.stringify(taskOutputUrl)}
        import { wrapSpawn } from ${JSON.stringify(shellCommandUrl)}

        const child = spawn('/bin/sh', [
          '-c',
          ${JSON.stringify(`printf "%s" "$$" > ${pidFile}; sleep 1000`)},
        ], {
          detached: true,
          stdio: ['ignore', 'ignore', 'ignore'],
        })

        const shellCommand = wrapSpawn(
          child,
          new AbortController().signal,
          60_000,
          new TaskOutput('shell_command_exit_test', null, false),
        )
        shellCommand.background('shell_command_exit_test')

        setTimeout(() => process.exit(0), 100)
      `

      const parent = spawn(process.execPath, ['--eval', code], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })

      let stderr = ''
      parent.stderr?.setEncoding('utf8')
      parent.stderr?.on('data', chunk => {
        stderr += chunk
      })

      const exitCode = await new Promise<number | null>(resolve => {
        parent.once('exit', resolve)
      })
      expect(stderr).toBe('')
      expect(exitCode).toBe(0)

      shellPid = await readPid(pidFile)
      await sleep(300)

      expect(processExists(shellPid)).toBe(false)
    } finally {
      if (shellPid !== undefined) {
        killProcessGroup(shellPid)
      }
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('reports a real SIGTERM death as exit code 143, not the 144 sentinel', async () => {
    // Under the universal 128+N convention, 143 (128+15) is SIGTERM and 144
    // (128+16) is SIGURG on macOS. #exitHandler used to hardcode 144 for a
    // signal-killed process with no exit code, even though this same file
    // already defines `const SIGTERM = 143` for exactly this case.
    if (process.platform === 'win32') {
      return
    }

    const child = spawn('/bin/sh', ['-c', 'sleep 30'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    const shellCommand = wrapSpawn(
      child,
      new AbortController().signal,
      60_000,
      new TaskOutput('shell_command_sigterm_test', null, false),
    )

    // Let the shell actually start running before signaling it.
    await sleep(50)
    child.kill('SIGTERM')

    const result = await shellCommand.result
    expect(result.code).toBe(143)
  })
})
