import { describe, expect, test } from 'bun:test'
import {
  buildMcpPermissionRuleName,
  buildMcpServerPermissionRuleName,
  buildMcpToolName,
  isUnambiguousLegacyMcpIdentity,
  mcpPermissionIdentityFromRuleName,
} from './mcpStringUtils.js'

describe('MCP permission identity names', () => {
  test('keeps delimiter partitions distinct', () => {
    const first = buildMcpPermissionRuleName('a__b', 'c')
    const second = buildMcpPermissionRuleName('a', 'b__c')

    expect(first).not.toBe(second)
    expect(mcpPermissionIdentityFromRuleName(first)).toEqual({
      scope: 'tool',
      serverName: 'a__b',
      toolName: 'c',
    })
    expect(mcpPermissionIdentityFromRuleName(second)).toEqual({
      scope: 'tool',
      serverName: 'a',
      toolName: 'b__c',
    })
  })

  test('encodes exact, server-wide, and wildcard scopes distinctly', () => {
    const exact = buildMcpPermissionRuleName('server', '*')
    const server = buildMcpServerPermissionRuleName('server')
    const wildcard = buildMcpServerPermissionRuleName('server', 'wildcard')

    expect(new Set([exact, server, wildcard]).size).toBe(3)
    expect(mcpPermissionIdentityFromRuleName(exact)).toEqual({
      scope: 'tool',
      serverName: 'server',
      toolName: '*',
    })
    expect(mcpPermissionIdentityFromRuleName(server)).toEqual({
      scope: 'server',
      serverName: 'server',
    })
    expect(mcpPermissionIdentityFromRuleName(wildcard)).toEqual({
      scope: 'wildcard',
      serverName: 'server',
    })
  })

  test('represents names that normalize to the same model-facing name', () => {
    expect(buildMcpToolName('a.b', 'tool')).toBe(
      buildMcpToolName('a_b', 'tool'),
    )
    expect(buildMcpPermissionRuleName('a.b', 'tool')).not.toBe(
      buildMcpPermissionRuleName('a_b', 'tool'),
    )
  })

  test('marks only lossless legacy identities as safe for allow rules', () => {
    expect(isUnambiguousLegacyMcpIdentity('server', 'tool')).toBe(true)
    expect(isUnambiguousLegacyMcpIdentity('a__b', 'tool')).toBe(false)
    expect(isUnambiguousLegacyMcpIdentity('server', 'tool__part')).toBe(false)
    expect(isUnambiguousLegacyMcpIdentity('a.b', 'tool')).toBe(false)
  })
})
