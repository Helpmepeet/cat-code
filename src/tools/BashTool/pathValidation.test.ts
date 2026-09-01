import { beforeAll, describe, expect, test } from 'bun:test'
import type { z } from 'zod/v4'
import type { ToolPermissionContext } from '../../Tool.js'
import type { BashTool } from './BashTool.js'
import { PATH_EXTRACTORS, checkPathConstraints } from './pathValidation.js'

// filesystem.ts reads MACRO.VERSION when it builds the bundled-skills root,
// and that global only exists in a built bundle.
beforeAll(() => {
  ;(
    globalThis as typeof globalThis & { MACRO?: { VERSION: string } }
  ).MACRO ??= { VERSION: 'test-version' }
})

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

function decide(command: string, compoundCommandHasCd = false) {
  return checkPathConstraints(
    { command } as z.infer<typeof BashTool.inputSchema>,
    process.cwd(),
    permissionContext(),
    compoundCommandHasCd,
  )
}

// `cd build && make > /dev/null` prompted on every run: the compound-cd guard
// returned 'ask' for any redirection at all, ahead of the /dev/null exemption
// that the per-target loop below it already applied. /dev/null discards its
// input, so the directory `cd` leaves us in cannot change where the write
// lands and there is nothing to approve.
describe('compound cd with output redirection', () => {
  test('a /dev/null redirect after cd does not prompt', () => {
    expect(decide('cd build && make > /dev/null', true).behavior).toBe(
      'passthrough',
    )
  })

  test('appending to /dev/null after cd does not prompt', () => {
    expect(decide('cd build && make >> /dev/null', true).behavior).toBe(
      'passthrough',
    )
  })

  test('a real redirect target after cd still prompts', () => {
    const result = decide('cd build && make > out.txt', true)
    expect(result.behavior).toBe('ask')
    expect(result.decisionReason).toMatchObject({
      reason:
        'Compound command contains cd with output redirection - manual approval required to prevent path resolution bypass',
    })
  })

  // The exemption is per-command, not per-redirection: one safe target must
  // not launder an unsafe one in the same command.
  test('a real target mixed with /dev/null after cd still prompts', () => {
    expect(
      decide('cd build && make > out.txt 2> /dev/null', true).behavior,
    ).toBe('ask')
  })
})

// These four commands used the bare flag filter, which has no notion of a flag
// that consumes the NEXT argument. `cut -d / data.txt` extracted ['/',
// 'data.txt'], so the field delimiter was validated as a path at the
// filesystem root and prompted.
describe('flag arguments are not paths', () => {
  test('cut does not read its delimiter or field list as a path', () => {
    expect(PATH_EXTRACTORS.cut(['-d', '/', 'data.txt'])).toEqual(['data.txt'])
    expect(PATH_EXTRACTORS.cut(['-f', '1', '-d', ',', 'data.txt'])).toEqual([
      'data.txt',
    ])
    expect(
      PATH_EXTRACTORS.cut(['--delimiter', '/', '--fields', '2', 'data.txt']),
    ).toEqual(['data.txt'])
  })

  test('cut still extracts paths when the flag value is bundled', () => {
    expect(PATH_EXTRACTORS.cut(['-d/', '-f1', '/etc/passwd'])).toEqual([
      '/etc/passwd',
    ])
    expect(PATH_EXTRACTORS.cut(['--delimiter=/', '/etc/passwd'])).toEqual([
      '/etc/passwd',
    ])
  })

  test('paste does not read its delimiter as a path', () => {
    expect(PATH_EXTRACTORS.paste(['-d', '/', 'a.txt', 'b.txt'])).toEqual([
      'a.txt',
      'b.txt',
    ])
    expect(PATH_EXTRACTORS.paste(['--delimiters', '/', 'a.txt'])).toEqual([
      'a.txt',
    ])
  })

  // paste's -s takes no argument. Treating it as one would silently swallow
  // the first file and skip validating it.
  test('paste -s does not swallow the following file', () => {
    expect(PATH_EXTRACTORS.paste(['-s', 'a.txt', 'b.txt'])).toEqual([
      'a.txt',
      'b.txt',
    ])
  })

  test('column does not read its separator as a path', () => {
    expect(PATH_EXTRACTORS.column(['-s', '/', '-t', 'table.txt'])).toEqual([
      'table.txt',
    ])
    expect(PATH_EXTRACTORS.column(['--separator', '/', 'table.txt'])).toEqual([
      'table.txt',
    ])
    expect(PATH_EXTRACTORS.column(['-c', '80', 'table.txt'])).toEqual([
      'table.txt',
    ])
  })

  test('awk does not read its field separator, assignment or program as a path', () => {
    expect(PATH_EXTRACTORS.awk(['-F', '/', '{print $1}', 'data.txt'])).toEqual([
      'data.txt',
    ])
    expect(PATH_EXTRACTORS.awk(['-v', 'x=/etc', '{print}', 'data.txt'])).toEqual(
      ['data.txt'],
    )
    // The program text is the first positional and is never a path.
    expect(PATH_EXTRACTORS.awk(['{print $1}', 'data.txt'])).toEqual(['data.txt'])
    expect(PATH_EXTRACTORS.awk(['-e', '{print}', 'data.txt'])).toEqual([
      'data.txt',
    ])
  })

  // The asymmetry: -f names a program FILE that awk actually opens, so unlike
  // -F/-v/-e its argument must stay a validated path.
  test('awk -f keeps its program file as a path', () => {
    expect(PATH_EXTRACTORS.awk(['-f', 'prog.awk', 'data.txt'])).toEqual([
      'prog.awk',
      'data.txt',
    ])
    expect(PATH_EXTRACTORS.awk(['--file=prog.awk', 'data.txt'])).toEqual([
      'prog.awk',
      'data.txt',
    ])
    // -f supplies the program, so the next positional is a file, not program text.
    expect(PATH_EXTRACTORS.awk(['-f', 'prog.awk'])).toEqual(['prog.awk'])
  })

  test('arguments after -- are still treated as paths', () => {
    expect(PATH_EXTRACTORS.cut(['-d', ',', '--', '-weird.txt'])).toEqual([
      '-weird.txt',
    ])
  })
})

describe('flag-argument handling end to end', () => {
  test('cut with a slash delimiter inside cwd does not prompt', () => {
    expect(decide('cut -d / data.txt').behavior).toBe('passthrough')
  })

  test('awk with a slash field separator inside cwd does not prompt', () => {
    expect(decide("awk -F / '{print $1}' data.txt").behavior).toBe(
      'passthrough',
    )
  })

  test('awk reading a program file outside cwd still prompts', () => {
    expect(decide('awk -f /etc/passwd data.txt').behavior).toBe('ask')
  })

  test('cut reading a file outside cwd still prompts', () => {
    expect(decide('cut -d , -f 1 /etc/passwd').behavior).toBe('ask')
  })
})
