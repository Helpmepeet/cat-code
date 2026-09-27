import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export function packagedBinPath(execPath: string): string {
  return join(dirname(dirname(execPath)), 'bin')
}

export function appendPackagedBinToPath(
  execPath: string,
  currentPath: string | undefined,
): string {
  const bin = packagedBinPath(execPath)
  const existing = (currentPath ?? '')
    .split(delimiter)
    .filter(entry => entry.length > 0 && entry !== bin)
  return [...existing, bin].join(delimiter)
}

/** Include the user's shell PATH before the engine, hooks, and tools initialize. */
export async function resolvePackagedSidecarPath(
  execPath: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const inherited = appendPackagedBinToPath(execPath, env.PATH)
  const preferredShell = [env.CLAUDE_CODE_SHELL, env.SHELL, '/bin/zsh'].find(
    candidate =>
      candidate &&
      isAbsolute(candidate) &&
      (basename(candidate) === 'zsh' || basename(candidate) === 'bash'),
  )
  if (!preferredShell) return inherited

  const shellName = basename(preferredShell)
  const home = env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir()
  const rcFile = join(home, '.bashrc')
  try {
    // The shell can print from login files before this command runs. NUL
    // delimiters identify the PATH without treating that output as PATH data.
    const { stdout } = await execFileAsync(
      preferredShell,
      [
        '-c',
        '-l',
        shellName === 'zsh'
          ? 'source "${ZDOTDIR:-$HOME}/.zshrc" < /dev/null >/dev/null 2>&1; printf "\\0%s\\0" "$PATH"'
          : 'source "$1" < /dev/null >/dev/null 2>&1; printf "\\0%s\\0" "$PATH"',
        'catcode-path',
        rcFile,
      ],
      {
        // PATH discovery needs shell configuration, not the sidecar's
        // credentials. Keep the subprocess environment deliberately narrow.
        env: {
          HOME: home,
          PATH: inherited,
          SHELL: preferredShell,
          USER: env.USER,
          LOGNAME: env.LOGNAME,
          TMPDIR: env.TMPDIR,
          TERM: env.TERM,
          LANG: env.LANG,
          LC_ALL: env.LC_ALL,
          XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
          ZDOTDIR: env.ZDOTDIR,
        },
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      },
    )
    const end = stdout.lastIndexOf('\0')
    const start = end > 0 ? stdout.lastIndexOf('\0', end - 1) : -1
    const captured = start >= 0 ? stdout.slice(start + 1, end) : ''
    if (!captured || captured.includes('\n') || captured.includes('\0')) {
      return inherited
    }
    return appendPackagedBinToPath(execPath, captured)
  } catch {
    return inherited
  }
}
