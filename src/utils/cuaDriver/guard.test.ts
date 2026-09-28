import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  CUA_DRIVER_OFF_MESSAGE,
  checkCuaDriverToolCall,
  getCuaDriverOffPath,
  isCuaDriverCommand,
  isCuaDriverToolCall,
} from './guard.js'
import type { CuaDriverRun } from './run.js'

describe('isCuaDriverCommand', () => {
  test.each([
    ['cua-driver call list_apps'],
    ['cua-driver status'],
    ['/Users/pt/.local/bin/cua-driver mcp'],
    ['/Applications/CuaDriver.app/Contents/MacOS/cua-driver serve'],
    ['cua-driver serve > /tmp/cua-driver.log 2>&1 &'],
    [`echo '{"pid":844}' | cua-driver call get_window_state`],
    ['cd /tmp && cua-driver call list_apps'],
    ['which cua-driver; cua-driver stop'],
    ['CUA_DRIVER_NO_RELAUNCH=1 cua-driver serve'],
    ['timeout 30 cua-driver call list_apps'],
    ['nohup cua-driver serve'],
    ['echo $(cua-driver status)'],
    ['open -n -g -a CuaDriver --args serve'],
    ['git status\ncua-driver call list_apps'],
  ])('runs cua-driver: %s', command => {
    expect(isCuaDriverCommand(command)).toBe(true)
  })

  test.each([
    ['rg -n cua-driver docs/plans'],
    ['ls ~/.claude/skills/cua-driver'],
    ['git log --oneline -- src/utils/cuaDriver'],
    ['cat docs/plans/2026-09-28-cua-driver-safety-net.md'],
    ['echo "use cua-driver later"'],
    ['cua-driver-other status'],
    ['open https://example.com'],
  ])('does not run cua-driver: %s', command => {
    expect(isCuaDriverCommand(command)).toBe(false)
  })
})

describe('isCuaDriverToolCall', () => {
  test('any cua-driver MCP tool counts', () => {
    expect(isCuaDriverToolCall('mcp__cua-driver__click', {})).toBe(true)
  })

  test('a Bash call counts only when its command runs cua-driver', () => {
    expect(
      isCuaDriverToolCall('Bash', { command: 'cua-driver call list_apps' }),
    ).toBe(true)
    expect(isCuaDriverToolCall('Bash', { command: 'rg cua-driver' })).toBe(
      false,
    )
    expect(isCuaDriverToolCall('Bash', {})).toBe(false)
  })

  test('other tools never count', () => {
    expect(
      isCuaDriverToolCall('Read', { command: 'cua-driver call list_apps' }),
    ).toBe(false)
  })
})

describe('checkCuaDriverToolCall', () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  let configDir: string
  let marks: number
  const run: CuaDriverRun = {
    markUsed: () => {
      marks++
    },
    end: async () => {},
  }

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'cua-guard-'))
    process.env.CLAUDE_CONFIG_DIR = configDir
    marks = 0
  })

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    rmSync(configDir, { recursive: true, force: true })
  })

  test('lets a cua-driver call run and marks the run', () => {
    expect(
      checkCuaDriverToolCall('mcp__cua-driver__list_apps', {}, run),
    ).toBeNull()
    expect(marks).toBe(1)
  })

  test('refuses every cua-driver call while the off switch exists', () => {
    writeFileSync(getCuaDriverOffPath(), '')
    expect(checkCuaDriverToolCall('mcp__cua-driver__list_apps', {}, run)).toBe(
      CUA_DRIVER_OFF_MESSAGE,
    )
    expect(
      checkCuaDriverToolCall('Bash', { command: 'cua-driver serve' }, run),
    ).toBe(CUA_DRIVER_OFF_MESSAGE)
    expect(marks).toBe(0)
  })

  test('ignores unrelated calls even while the off switch exists', () => {
    writeFileSync(getCuaDriverOffPath(), '')
    expect(checkCuaDriverToolCall('Bash', { command: 'ls' }, run)).toBeNull()
    expect(marks).toBe(0)
  })
})
