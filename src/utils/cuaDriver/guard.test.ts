import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  beginCuaDriverToolCall,
  CUA_DRIVER_OFF_MESSAGE,
  CUA_DRIVER_RUN_ENDED_MESSAGE,
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
    ['"$HOME/.local/bin/cua-driver" call list_apps'],
    ['"/Applications/CuaDriver.app/Contents/MacOS/cua-driver" serve'],
    ['cua-driver serve > /tmp/cua-driver.log 2>&1 &'],
    [`echo '{"pid":844}' | cua-driver call get_window_state`],
    ['cd /tmp && cua-driver call list_apps'],
    ['which cua-driver; cua-driver stop'],
    ['CUA_DRIVER_NO_RELAUNCH=1 cua-driver serve'],
    ['timeout 30 cua-driver call list_apps'],
    ['nohup cua-driver serve'],
    ['echo $(cua-driver status)'],
    ['echo "$(cua-driver status)"'],
    [`P=$(cua-driver list_apps '{}' 2>&1 | python3 -c "import sys")`],
    ['open -n -g -a CuaDriver --args serve'],
    ['/usr/bin/open -n -g -a CuaDriver --args serve'],
    ['if true; then cua-driver call list_apps; fi'],
    [`for n in R1 R2; do cua-driver get_window_state '{"pid":1}'; done`],
    ['git status\ncua-driver call list_apps'],
    ["cat > x.md <<'MD'\nnotes\nMD\ncua-driver call list_apps"],
  ])('runs cua-driver: %s', command => {
    expect(isCuaDriverCommand(command)).toBe(true)
  })

  test.each([
    ['rg -n cua-driver docs/plans'],
    ['ls ~/.claude/skills/cua-driver'],
    ['git log --oneline -- src/utils/cuaDriver'],
    ['cat docs/plans/2026-09-28-cua-driver-safety-net.md'],
    ['echo "use cua-driver later"'],
    ['echo "a; cua-driver status"'],
    ["echo '$(cua-driver status)'"],
    ["echo 'x; cua-driver stop'"],
    ['ps aux | grep -i "cuadriver\\|cua-driver" | grep -v grep'],
    ['grep cua\\|cua-driver notes.txt'],
    ["cat > notes.md <<'MD'\ncua-driver call list_apps\nMD"],
    ['cat > notes.md <<EOF\n  cua-driver serve\nEOF'],
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

describe('beginCuaDriverToolCall', () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  let configDir: string
  let begun: number
  let finished: number
  let allowBegin: boolean
  const run: CuaDriverRun = {
    beginCall: async () => {
      if (!allowBegin) return false
      begun++
      return true
    },
    endCall: () => {
      finished++
    },
    end: async () => {},
  }

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'cua-guard-'))
    process.env.CLAUDE_CONFIG_DIR = configDir
    begun = 0
    finished = 0
    allowBegin = true
  })

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    rmSync(configDir, { recursive: true, force: true })
  })

  test('lets a cua-driver call run and finishes it through the run', async () => {
    const gate = await beginCuaDriverToolCall(
      'mcp__cua-driver__list_apps',
      {},
      run,
    )
    expect(gate?.kind).toBe('allowed')
    if (gate?.kind === 'allowed') gate.finish()
    expect(begun).toBe(1)
    expect(finished).toBe(1)
  })

  test('refuses a cua-driver call once the run has ended', async () => {
    allowBegin = false
    expect(
      await beginCuaDriverToolCall('mcp__cua-driver__list_apps', {}, run),
    ).toEqual({ kind: 'refused', message: CUA_DRIVER_RUN_ENDED_MESSAGE })
  })

  test('refuses every cua-driver call while the off switch exists', async () => {
    writeFileSync(getCuaDriverOffPath(), '')
    expect(
      await beginCuaDriverToolCall('mcp__cua-driver__list_apps', {}, run),
    ).toEqual({ kind: 'refused', message: CUA_DRIVER_OFF_MESSAGE })
    expect(
      await beginCuaDriverToolCall(
        'Bash',
        { command: 'cua-driver serve' },
        run,
      ),
    ).toEqual({ kind: 'refused', message: CUA_DRIVER_OFF_MESSAGE })
    expect(begun).toBe(0)
  })

  test('ignores unrelated calls even while the off switch exists', async () => {
    writeFileSync(getCuaDriverOffPath(), '')
    expect(
      await beginCuaDriverToolCall('Bash', { command: 'ls' }, run),
    ).toBeNull()
    expect(begun).toBe(0)
  })
})
