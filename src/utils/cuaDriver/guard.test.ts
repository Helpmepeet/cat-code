import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ConnectedMCPServer } from '../../services/mcp/types.js'
import type { CuaDriverToolContext } from './guard.js'
import {
  CUA_DRIVER_OFF_MESSAGE,
  CUA_DRIVER_RUN_ENDED_MESSAGE,
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
    ['open -n -g -a CuaDriver --args serve'],
    ['/usr/bin/open -n -g -a CuaDriver --args serve'],
    ['if true; then cua-driver call list_apps; fi'],
    [`for n in R1 R2; do cua-driver get_window_state '{"pid":1}'; done`],
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
  test.each(['cua-driver', 'cua-computer-use'])(
    'any %s MCP tool counts',
    serverName => {
      expect(isCuaDriverToolCall(`mcp__${serverName}__click`, {})).toBe(true)
    },
  )

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
  let runEnded: boolean
  const run: CuaDriverRun = {
    markUsed: () => {
      if (runEnded) return false
      marks++
      return true
    },
    end: async () => {},
  }

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'cua-guard-'))
    process.env.CLAUDE_CONFIG_DIR = configDir
    marks = 0
    runEnded = false
  })

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    rmSync(configDir, { recursive: true, force: true })
  })

  const driverServer = {
    name: 'desktop automation',
    type: 'connected',
    config: {
      command: '/Applications/CuaDriver.app/Contents/MacOS/cua-driver',
      args: ['mcp', '--claude-code-computer-use-compat'],
      scope: 'user',
    },
  } as ConnectedMCPServer
  const genericServer = {
    ...driverServer,
    name: 'desktop?automation',
    serverInfo: { name: 'unrelated', version: '1' },
    config: {
      type: 'stdio',
      command: '/bin/echo',
      args: ['cua-driver', 'mcp'],
      scope: 'user',
    },
  } as ConnectedMCPServer
  const guardedCalls: Array<{
    label: string
    name: string
    input?: unknown
    identity?: CuaDriverToolContext
  }> = [
    { label: 'standard MCP name', name: 'mcp__cua-driver__list_apps' },
    { label: 'compatibility MCP name', name: 'mcp__cua-computer-use__list_apps' },
    { label: 'CLI command', name: 'Bash', input: { command: 'cua-driver serve' } },
    {
      label: 'configured alias with colliding normalized display names',
      name: 'mcp__desktop_automation__list_apps',
      identity: {
        tool: {
          name: 'mcp__desktop_automation__list_apps',
          mcpInfo: { serverName: driverServer.name, toolName: 'list_apps' },
        },
        clients: [genericServer, driverServer],
      },
    },
    {
      label: 'retained aliased tool while its connection is retrying',
      name: 'mcp__desktop_automation__list_apps',
      identity: {
        tool: {
          name: 'mcp__desktop_automation__list_apps',
          mcpInfo: { serverName: driverServer.name, toolName: 'list_apps' },
        },
        clients: [
          {
            name: driverServer.name,
            type: 'failed',
            config: driverServer.config,
          },
        ],
      },
    },
    {
      label: 'unprefixed tool with negotiated CuaDriver identity',
      name: 'list_apps',
      identity: {
        tool: {
          name: 'list_apps',
          mcpInfo: { serverName: 'wrapped driver', toolName: 'list_apps' },
        },
        clients: [
          {
            ...driverServer,
            name: 'wrapped driver',
            config: { type: 'sdk', name: 'wrapper', scope: 'user' },
            serverInfo: { name: 'cua-driver', version: '0.1.9' },
          },
        ],
      },
    },
  ]

  test.each(guardedCalls)(
    'marks permitted use for $label',
    ({ name, input, identity }) => {
      expect(checkCuaDriverToolCall(name, input ?? {}, run, identity)).toBeNull()
      expect(marks).toBe(1)
    },
  )

  test.each(guardedCalls)(
    'refuses ended run for $label',
    ({ name, input, identity }) => {
      runEnded = true
      expect(checkCuaDriverToolCall(name, input ?? {}, run, identity)).toBe(
        CUA_DRIVER_RUN_ENDED_MESSAGE,
      )
      expect(marks).toBe(0)
    },
  )

  test.each(guardedCalls)(
    'refuses emergency stop for $label',
    ({ name, input, identity }) => {
      writeFileSync(getCuaDriverOffPath(), '')
      expect(checkCuaDriverToolCall(name, input ?? {}, run, identity)).toBe(
        CUA_DRIVER_OFF_MESSAGE,
      )
      expect(marks).toBe(0)
    },
  )

  test('ignores unrelated calls even while the off switch exists', () => {
    writeFileSync(getCuaDriverOffPath(), '')
    runEnded = true
    expect(checkCuaDriverToolCall('Bash', { command: 'ls' }, run)).toBeNull()
    expect(
      checkCuaDriverToolCall('mcp__desktop_automation__click', {}, run, {
        tool: {
          name: 'mcp__desktop_automation__click',
          mcpInfo: { serverName: genericServer.name, toolName: 'click' },
        },
        clients: [driverServer, genericServer],
      }),
    ).toBeNull()
    expect(
      checkCuaDriverToolCall('mcp__cua-driver__other__click', {}, run, {
        tool: {
          name: 'mcp__cua-driver__other__click',
          mcpInfo: { serverName: 'cua-driver__other', toolName: 'click' },
        },
        clients: [{ ...genericServer, name: 'cua-driver__other' }],
      }),
    ).toBeNull()
    expect(marks).toBe(0)
  })
})
