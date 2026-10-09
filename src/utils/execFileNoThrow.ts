// This file represents useful wrappers over node:child_process
// These wrappers ease error handling and cross-platform compatbility
// By using execa, Windows automatically gets shell escaping + BAT / CMD handling

import { type ExecaError, type Options as ExecaOptions, execa } from 'execa'
import { getCwd } from '../utils/cwd.js'
import { logError } from './log.js'

export { execSyncWithDefaults_DEPRECATED } from './execFileNoThrowPortable.js'

const MS_IN_SECOND = 1000
const SECONDS_IN_MINUTE = 60

type ExecFileOptions = {
  abortSignal?: AbortSignal
  timeout?: number
  killSignal?: ExecaOptions['killSignal']
  killProcessGroupOnTimeout?: boolean
  preserveOutputOnError?: boolean
  // Setting useCwd=false avoids circular dependencies during initialization
  // getCwd() -> PersistentShell -> logEvent() -> execFileNoThrow
  useCwd?: boolean
  env?: NodeJS.ProcessEnv
  stdin?: 'ignore' | 'inherit' | 'pipe'
  input?: string
}

export function execFileNoThrow(
  file: string,
  args: string[],
  options: ExecFileOptions = {
    timeout: 10 * SECONDS_IN_MINUTE * MS_IN_SECOND,
    preserveOutputOnError: true,
    useCwd: true,
  },
): Promise<{ stdout: string; stderr: string; code: number; error?: string }> {
  return execFileNoThrowWithCwd(file, args, {
    abortSignal: options.abortSignal,
    timeout: options.timeout,
    killSignal: options.killSignal,
    killProcessGroupOnTimeout: options.killProcessGroupOnTimeout,
    preserveOutputOnError: options.preserveOutputOnError,
    cwd: options.useCwd ? getCwd() : undefined,
    env: options.env,
    stdin: options.stdin,
    input: options.input,
  })
}

type ExecFileWithCwdOptions = {
  abortSignal?: AbortSignal
  timeout?: number
  killSignal?: ExecaOptions['killSignal']
  /**
   * Isolate this invocation in a POSIX process group and close its captured
   * pipes at the timeout deadline. Windows keeps execa's direct-child behavior.
   */
  killProcessGroupOnTimeout?: boolean
  preserveOutputOnError?: boolean
  maxBuffer?: number
  cwd?: string
  env?: NodeJS.ProcessEnv
  shell?: boolean | string | undefined
  stdin?: 'ignore' | 'inherit' | 'pipe'
  input?: string
}

type ExecaResultWithError = {
  shortMessage?: string
  signal?: string
}

/**
 * Extracts a human-readable error message from an execa result.
 *
 * Priority order:
 * 1. shortMessage - execa's human-readable error (e.g., "Command failed with exit code 1: ...")
 *    This is preferred because it already includes signal info when a process is killed,
 *    making it more informative than just the signal name.
 * 2. signal - the signal that killed the process (e.g., "SIGTERM")
 * 3. errorCode - fallback to just the numeric exit code
 */
function getErrorMessage(
  result: ExecaResultWithError,
  errorCode: number,
): string {
  if (result.shortMessage) {
    return result.shortMessage
  }
  if (typeof result.signal === 'string') {
    return result.signal
  }
  return String(errorCode)
}

/**
 * execFile, but always resolves (never throws)
 */
export function execFileNoThrowWithCwd(
  file: string,
  args: string[],
  {
    abortSignal,
    timeout: finalTimeout = 10 * SECONDS_IN_MINUTE * MS_IN_SECOND,
    killSignal,
    killProcessGroupOnTimeout = false,
    preserveOutputOnError: finalPreserveOutput = true,
    cwd: finalCwd,
    env: finalEnv,
    maxBuffer,
    shell,
    stdin: finalStdin,
    input: finalInput,
  }: ExecFileWithCwdOptions = {
    timeout: 10 * SECONDS_IN_MINUTE * MS_IN_SECOND,
    preserveOutputOnError: true,
    maxBuffer: 1_000_000,
  },
): Promise<{ stdout: string; stderr: string; code: number; error?: string }> {
  return new Promise(resolve => {
    // Use execa for cross-platform .bat/.cmd compatibility on Windows
    const isolateProcessGroup =
      killProcessGroupOnTimeout && process.platform !== 'win32'
    const subprocess = execa(file, args, {
      maxBuffer,
      signal: abortSignal,
      timeout: finalTimeout,
      killSignal,
      ...(isolateProcessGroup
        ? { forceKillAfterDelay: 500, detached: true }
        : {}),
      cwd: finalCwd,
      env: finalEnv,
      shell,
      stdin: finalStdin,
      input: finalInput,
      reject: false, // Don't throw on non-zero exit codes
    })
    const hardDeadline =
      !isolateProcessGroup || finalTimeout === undefined
        ? undefined
        : setTimeout(() => {
            // On POSIX, a timed-out command may have descendants holding the
            // captured pipes open after execa has killed the direct child.
            // detached gives this invocation its own process group, so this
            // signal cannot reach unrelated processes.
            try {
              const childPid = subprocess.pid
              if (childPid !== undefined) process.kill(-childPid, 'SIGKILL')
            } catch {
              // The process group already exited.
            }
            subprocess.stdout?.destroy()
            subprocess.stderr?.destroy()
            resolve({
              stdout: '',
              stderr: '',
              code: 1,
              error: 'Command timed out',
            })
          }, finalTimeout + 250)
    subprocess
      .then(result => {
        if (hardDeadline) clearTimeout(hardDeadline)
        if (result.failed) {
          if (finalPreserveOutput) {
            const errorCode = result.exitCode ?? 1
            void resolve({
              stdout: result.stdout || '',
              stderr: result.stderr || '',
              code: errorCode,
              error: getErrorMessage(
                result as unknown as ExecaResultWithError,
                errorCode,
              ),
            })
          } else {
            void resolve({ stdout: '', stderr: '', code: result.exitCode ?? 1 })
          }
        } else {
          void resolve({
            stdout: result.stdout,
            stderr: result.stderr,
            code: 0,
          })
        }
      })
      .catch((error: ExecaError) => {
        if (hardDeadline) clearTimeout(hardDeadline)
        logError(error)
        void resolve({ stdout: '', stderr: '', code: 1 })
      })
  })
}
