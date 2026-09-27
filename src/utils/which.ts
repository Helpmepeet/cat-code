import { execa } from 'execa'
import { execSync_DEPRECATED } from './execSyncWrapper.js'

async function whichNodeAsync(command: string): Promise<string | null> {
  if (process.platform === 'win32') {
    // On Windows, use where.exe and return the first result
    const result = await execa(`where.exe ${command}`, {
      shell: true,
      stderr: 'ignore',
      reject: false,
    })
    if (result.exitCode !== 0 || !result.stdout) {
      return null
    }
    // where.exe returns multiple paths separated by newlines, return the first
    return result.stdout.trim().split(/\r?\n/)[0] || null
  }

  // On POSIX systems (macOS, Linux, WSL), use which
  // Cross-platform safe: Windows is handled above
  // eslint-disable-next-line custom-rules/no-cross-platform-process-issues
  const result = await execa(`which ${command}`, {
    shell: true,
    stderr: 'ignore',
    reject: false,
  })
  if (result.exitCode !== 0 || !result.stdout) {
    return null
  }
  return result.stdout.trim()
}

function whichNodeSync(command: string): string | null {
  if (process.platform === 'win32') {
    try {
      const result = execSync_DEPRECATED(`where.exe ${command}`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const output = result.toString().trim()
      return output.split(/\r?\n/)[0] || null
    } catch {
      return null
    }
  }

  try {
    const result = execSync_DEPRECATED(`which ${command}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return result.toString().trim() || null
  } catch {
    return null
  }
}

// Bun.which without a PATH option searches the PATH the process started with,
// ignoring later process.env.PATH changes such as the packaged sidecar's
// bundled-tool prepend. An explicitly absent PATH also falls back to that
// startup value, so it is passed as empty.
const bunWhich =
  typeof Bun !== 'undefined' && typeof Bun.which === 'function'
    ? (command: string) =>
        Bun.which(command, { PATH: process.env.PATH ?? '' })
    : null

/**
 * Finds the full path to a command executable.
 * Uses Bun.which when running in Bun (fast, no process spawn),
 * otherwise spawns the platform-appropriate command.
 *
 * @param command - The command name to look up
 * @returns The full path to the command, or null if not found
 */
export const which: (command: string) => Promise<string | null> = bunWhich
  ? async command => bunWhich(command)
  : whichNodeAsync

/**
 * Synchronous version of `which`.
 *
 * @param command - The command name to look up
 * @returns The full path to the command, or null if not found
 */
export const whichSync: (command: string) => string | null =
  bunWhich ?? whichNodeSync
