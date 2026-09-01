import { beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'path'
import type { ToolPermissionContext } from '../../Tool.js'
import { validatePath } from './pathValidation.js'

// filesystem.ts reads MACRO.VERSION when it builds the bundled-skills root,
// and that global only exists in a built bundle.
beforeAll(() => {
  ;(
    globalThis as typeof globalThis & { MACRO?: { VERSION: string } }
  ).MACRO ??= { VERSION: 'test-version' }
})

const SHELL_EXPANSION_REASON = 'Shell expansion syntax in paths requires manual approval'

function permissionContext(): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  } as unknown as ToolPermissionContext
}

function check(path: string) {
  return validatePath(path, process.cwd(), permissionContext(), 'read')
}

function rejectedForShellExpansion(path: string): boolean {
  const result = check(path)
  return (
    !result.allowed &&
    result.decisionReason?.type === 'other' &&
    result.decisionReason.reason === SHELL_EXPANSION_REASON
  )
}

// `%VAR%` is a cmd.exe construct. On a POSIX shell `%` is an ordinary filename
// character, so rejecting it unconditionally made every percent-encoded name
// inside the project prompt. This suite runs on macOS, so the platform gate is
// exercised by the fact that these paths are now allowed.
describe('percent in a filename', () => {
  test('a percent-encoded name inside cwd is allowed on this platform', () => {
    expect(process.platform).not.toBe('win32')
    const result = check('report%20.txt')
    expect(result.allowed).toBe(true)
  })

  test('a literal percent sign in a name inside cwd is allowed', () => {
    expect(check('100% done.md').allowed).toBe(true)
    expect(check(join(process.cwd(), 'src', '%weird%.ts')).allowed).toBe(true)
  })

  // Narrowing % must not have relaxed the other expansion forms.
  test('dollar expansion is still rejected', () => {
    expect(rejectedForShellExpansion('$HOME/.ssh/id_rsa')).toBe(true)
    expect(rejectedForShellExpansion('${HOME}/x')).toBe(true)
    expect(rejectedForShellExpansion('$(echo /etc)/passwd')).toBe(true)
  })

  test('zsh equals expansion is still rejected', () => {
    expect(rejectedForShellExpansion('=rg')).toBe(true)
  })

  test('tilde variants are still rejected', () => {
    const result = check('~root/.ssh/id_rsa')
    expect(result.allowed).toBe(false)
    expect(result.decisionReason).toMatchObject({
      reason:
        'Tilde expansion variants (~user, ~+, ~-) in paths require manual approval',
    })
  })

  test('a path outside cwd is still not allowed', () => {
    expect(check('/etc/passwd').allowed).toBe(false)
  })
})

// Backticks are command substitution in every POSIX shell: the path we
// validate is not the path bash opens. This is rejected on all platforms,
// unlike %.
describe('backtick command substitution', () => {
  test('a backtick anywhere in the path is rejected', () => {
    expect(rejectedForShellExpansion('`whoami`.txt')).toBe(true)
    expect(rejectedForShellExpansion('report-`id`.txt')).toBe(true)
  })

  // The rejection must beat the cwd allow, exactly like the $ case: a
  // substitution that resolves inside the project is still unvalidatable.
  test('a backtick inside cwd is rejected rather than allowed', () => {
    const result = check(join(process.cwd(), 'src', '`whoami`.ts'))
    expect(result.allowed).toBe(false)
    expect(result.decisionReason).toMatchObject({
      reason: SHELL_EXPANSION_REASON,
    })
  })

  test('ordinary quote characters are not mistaken for backticks', () => {
    expect(check("it's-fine.txt").allowed).toBe(true)
  })
})
