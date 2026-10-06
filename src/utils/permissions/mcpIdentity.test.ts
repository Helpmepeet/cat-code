import { describe, expect, test } from 'bun:test'
import type { ToolPermissionContext } from '../../Tool.js'
import {
  buildMcpServerPermissionRuleName,
  buildMcpToolName,
  buildMcpPermissionRuleName,
  getToolNameForPermissionCheck,
} from '../../services/mcp/mcpStringUtils.js'
import type { Tool } from '../../Tool.js'
import { assembleToolPool } from '../../tools.js'
import {
  getDenyRuleForTool,
  toolAlwaysAllowedRule,
} from './permissions.js'
import { applyPermissionUpdate } from './PermissionUpdate.js'
import {
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from './permissionRuleParser.js'
import { validatePermissionRule } from '../settings/permissionValidation.js'

function context(
  allow: string[] = [],
  deny: string[] = [],
): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: { session: allow },
    alwaysDenyRules: { session: deny },
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  }
}

function mcpTool(serverName: string, toolName: string): Pick<Tool, 'name' | 'mcpInfo'> {
  return {
    name: getToolNameForPermissionCheck({
      name: toolName,
      mcpInfo: { serverName, toolName },
    }),
    mcpInfo: { serverName, toolName },
  }
}

const identityRule = (serverName: string, toolName: string) =>
  buildMcpPermissionRuleName(serverName, toolName)

describe('MCP permission identity matching', () => {
  test('distinguishes exact allows and denies across delimiter partitions', () => {
    const first = mcpTool('a__b', 'c')
    const second = mcpTool('a', 'b__c')

    expect(toolAlwaysAllowedRule(context([identityRule('a__b', 'c')]), first)).not.toBeNull()
    expect(toolAlwaysAllowedRule(context([identityRule('a__b', 'c')]), second)).toBeNull()
    expect(getDenyRuleForTool(context([], [identityRule('a', 'b__c')]), second)).not.toBeNull()
    expect(getDenyRuleForTool(context([], [identityRule('a', 'b__c')]), first)).toBeNull()
  })

  test('applies legacy server-wide denies and wildcard denies', () => {
    expect(getDenyRuleForTool(context([], ['mcp__server']), mcpTool('server', 'read'))).not.toBeNull()
    expect(getDenyRuleForTool(context([], ['mcp__server__*']), mcpTool('server', 'read'))).not.toBeNull()
    expect(getDenyRuleForTool(context([], ['mcp__server']), mcpTool('other', 'read'))).toBeNull()
  })

  test('matches ambiguous legacy server-wide denies by the live server identity', () => {
    const legacyServerDeny = context([], ['mcp__a__b'])
    const legacyWildcardDeny = context([], ['mcp__a__b__*'])

    expect(getDenyRuleForTool(legacyServerDeny, mcpTool('a__b', 'c'))).not.toBeNull()
    expect(getDenyRuleForTool(legacyWildcardDeny, mcpTool('a__b', 'c'))).not.toBeNull()
    expect(getDenyRuleForTool(legacyServerDeny, mcpTool('a', 'b__c'))).toBeNull()
    expect(getDenyRuleForTool(legacyWildcardDeny, mcpTool('a', 'b__c'))).toBeNull()
  })

  test('matches structured server and wildcard scopes without treating literal star as a scope', () => {
    const tool = mcpTool('a__b', 'c')
    const literalStarTool = mcpTool('a__b', '*')

    expect(
      getDenyRuleForTool(
        context([], [buildMcpServerPermissionRuleName('a__b')]),
        tool,
      ),
    ).not.toBeNull()
    expect(
      getDenyRuleForTool(
        context([], [
          buildMcpServerPermissionRuleName('a__b', 'wildcard'),
        ]),
        tool,
      ),
    ).not.toBeNull()
    expect(
      getDenyRuleForTool(
        context([], [identityRule('a__b', '*')]),
        literalStarTool,
      ),
    ).not.toBeNull()
    expect(
      getDenyRuleForTool(
        context([], [identityRule('a__b', '*')]),
        tool,
      ),
    ).toBeNull()
  })

  test('preserves safe ordinary legacy exact allow rules', () => {
    expect(toolAlwaysAllowedRule(context(['mcp__server__read']), mcpTool('server', 'read'))).not.toBeNull()
    expect(getDenyRuleForTool(context([], ['mcp__server__read']), mcpTool('server', 'read_more'))).toBeNull()
  })

  test('does not honor ambiguous legacy allow rules but keeps their deny conservative', () => {
    const rule = 'mcp__a__b__c'
    const first = mcpTool('a__b', 'c')
    const second = mcpTool('a', 'b__c')

    expect(toolAlwaysAllowedRule(context([rule]), first)).toBeNull()
    expect(toolAlwaysAllowedRule(context([rule]), second)).toBeNull()
    expect(getDenyRuleForTool(context([], [rule]), first)).not.toBeNull()
    expect(getDenyRuleForTool(context([], [rule]), second)).not.toBeNull()
  })

  test('fails closed on lossy legacy allow names and keeps lossy denies', () => {
    const legacyRule = 'mcp__a_b__tool'
    expect(
      toolAlwaysAllowedRule(context([legacyRule]), mcpTool('a_b', 'tool')),
    ).toBeNull()
    expect(
      getDenyRuleForTool(context([], [legacyRule]), mcpTool('a.b', 'tool')),
    ).not.toBeNull()
    expect(
      getDenyRuleForTool(context([], [legacyRule]), mcpTool('a_b', 'tool')),
    ).not.toBeNull()
  })

  test('separates lossy normalized identities and builtin names', () => {
    const dotted = mcpTool('a.b', 'Write')
    const underscored = mcpTool('a_b', 'Write')
    expect(toolAlwaysAllowedRule(context([identityRule('a.b', 'Write')]), dotted)).not.toBeNull()
    expect(toolAlwaysAllowedRule(context([identityRule('a.b', 'Write')]), underscored)).toBeNull()
    expect(getDenyRuleForTool(context([], ['Write']), dotted)).toBeNull()
    expect(getDenyRuleForTool(context([], ['Write']), { name: 'Write' })).not.toBeNull()
  })

  test('persists and reloads the reversible identity rule', () => {
    const value = permissionRuleValueFromString(identityRule('a__b', 'c'))
    expect(value.toolName).toBe(identityRule('a__b', 'c'))
    expect(permissionRuleValueToString(value)).toBe(identityRule('a__b', 'c'))
    const persistedContext = applyPermissionUpdate(context(), {
      type: 'addRules',
      destination: 'session',
      behavior: 'allow',
      rules: [value],
    })
    expect(persistedContext.alwaysAllowRules.session).toEqual([
      identityRule('a__b', 'c'),
    ])
    expect(toolAlwaysAllowedRule(persistedContext, mcpTool('a__b', 'c'))).not.toBeNull()
    expect(validatePermissionRule(identityRule('a__b', 'c')).valid).toBe(true)
  })

  test('persists encoded punctuation and unicode without rule syntax ambiguity', () => {
    const serverName = 'server(x):%雪__'
    const toolName = 'tool(y):%猫__'
    const encoded = identityRule(serverName, toolName)
    expect(encoded).not.toContain('(')
    expect(encoded).not.toContain(')')
    expect(permissionRuleValueFromString(encoded).toolName).toBe(encoded)
    expect(
      permissionRuleValueToString(permissionRuleValueFromString(encoded)),
    ).toBe(encoded)
    expect(validatePermissionRule(encoded).valid).toBe(true)
    expect(
      toolAlwaysAllowedRule(
        context([encoded]),
        mcpTool(serverName, toolName),
      ),
    ).not.toBeNull()
  })

  test('keeps colliding discovered MCP tools routable without changing display names', () => {
    const first = {
      name: buildMcpToolName('a.b', 'run'),
      mcpInfo: { serverName: 'a.b', toolName: 'run' },
      userFacingName: () => 'a.b - run (MCP)',
      call: () => ({ data: 'first' }),
    } as unknown as Tool
    const second = {
      name: buildMcpToolName('a_b', 'run'),
      mcpInfo: { serverName: 'a_b', toolName: 'run' },
      userFacingName: () => 'a_b - run (MCP)',
      call: () => ({ data: 'second' }),
    } as unknown as Tool
    const pool = assembleToolPool(context(), [first, second], [])

    expect(pool).toHaveLength(2)
    expect(new Set(pool.map(tool => tool.name)).size).toBe(2)
    expect(pool.map(tool => tool.userFacingName({})).sort()).toEqual([
      'a.b - run (MCP)',
      'a_b - run (MCP)',
    ])
    expect(
      pool.find(tool => tool.mcpInfo?.serverName === 'a.b')?.call,
    ).toBe(first.call)
    expect(
      pool.find(tool => tool.mcpInfo?.serverName === 'a_b')?.call,
    ).toBe(second.call)
    expect(pool.some(tool => tool.name === buildMcpToolName('a.b', 'run'))).toBe(
      true,
    )
  })

  test('renames every MCP tool that would be dropped behind a builtin collision', () => {
    const collidingMcpTools = [
      {
        name: 'Write',
        mcpInfo: { serverName: 'first', toolName: 'write' },
        isMcp: true,
      },
      {
        name: 'Write',
        mcpInfo: { serverName: 'second', toolName: 'write' },
        isMcp: true,
      },
    ] as unknown as Tool[]
    const builtIn = { name: 'Write' } as Tool
    const pool = assembleToolPool(context(), collidingMcpTools, [builtIn])

    expect(pool).toHaveLength(3)
    expect(pool.filter(tool => tool.mcpInfo)).toHaveLength(2)
    expect(new Set(pool.map(tool => tool.name)).size).toBe(3)
  })

  test('retains a single skip-prefix MCP tool colliding with a builtin name', () => {
    const mcpCall = async () => ({ data: 'mcp' })
    const mcpTool = {
      name: 'Write',
      mcpInfo: { serverName: 'sdk-server', toolName: 'Write' },
      isMcp: true,
      call: mcpCall,
    } as unknown as Tool
    const builtIn = { name: 'Write' } as Tool

    const pool = assembleToolPool(context(), [mcpTool], [builtIn])
    const retainedMcp = pool.find(tool => tool.mcpInfo)

    expect(pool).toHaveLength(2)
    expect(retainedMcp?.name).toBe('Write__identity_1')
    expect(retainedMcp?.mcpInfo).toEqual({
      serverName: 'sdk-server',
      toolName: 'Write',
    })
    expect(retainedMcp?.call).toBe(mcpCall)
    expect(pool.find(tool => !tool.mcpInfo)).toBe(builtIn)
  })

  test('keeps max-length colliding MCP invocation names within the API limit', () => {
    const toolName = 'x'.repeat(49)
    const first = {
      name: buildMcpToolName('server.a', toolName),
      mcpInfo: { serverName: 'server.a', toolName },
      call: () => ({ data: 'first' }),
    } as unknown as Tool
    const second = {
      name: buildMcpToolName('server_a', toolName),
      mcpInfo: { serverName: 'server_a', toolName },
      call: () => ({ data: 'second' }),
    } as unknown as Tool
    expect(first.name).toHaveLength(64)
    expect(second.name).toBe(first.name)

    const pool = assembleToolPool(context(), [first, second], [])
    expect(pool).toHaveLength(2)
    expect(new Set(pool.map(tool => tool.name)).size).toBe(2)
    expect(
      pool.every(tool => /^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)),
    ).toBe(true)
    expect(pool.find(tool => tool.mcpInfo?.serverName === 'server.a')?.call).toBe(
      first.call,
    )
    expect(pool.find(tool => tool.mcpInfo?.serverName === 'server_a')?.call).toBe(
      second.call,
    )
  })
})
