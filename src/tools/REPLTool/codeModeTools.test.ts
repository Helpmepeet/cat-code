import { expect, test } from 'bun:test'
import { BashTool } from '../BashTool/BashTool.js'
import { AskParentSessionTool } from '../AskParentSessionTool/AskParentSessionTool.js'
import { codeModeExclusion, resolveCodeModeTool } from './codeModeTools.js'
import type { Tool, ToolUseContext } from '../../Tool.js'

test('ToolSearch recovery text names the actual guest discovery API', () => {
  const reason = codeModeExclusion({ ...BashTool, name: 'ToolSearch' } as Tool)
  expect(reason).toContain('tools.discover({op:"search",query:"..."})')
  expect(reason).toContain('tools.discover({op:"describe",name:"..."})')
})

test('computer compatibility uses current MCP identity even with unprefixed names and aliases', () => {
  for (const name of ['computer_use_status', 'js', 'js_complete', 'js_reset']) {
    const tool = { ...BashTool, name, aliases: ['friendly_alias'], mcpInfo: { serverName: 'codex-computer-use', toolName: name } } as Tool
    expect(codeModeExclusion(tool)).toContain('direct interaction')
    const context = { options: { tools: [tool] } } as unknown as ToolUseContext
    expect(() => resolveCodeModeTool(context, 'friendly_alias')).toThrow('direct-only')
    expect(() => resolveCodeModeTool(context, name)).toThrow('direct-only')
  }
})

test('unfamiliar write MCP identities are not excluded and revoked identities cannot fall back to a registry', () => {
  const tool = { ...BashTool, name: 'custom_write', aliases: ['friendly_alias'], mcpInfo: { serverName: 'fixture-database', toolName: 'write_record' } } as Tool
  expect(codeModeExclusion(tool)).toBeUndefined()
  const context = { options: { tools: [tool] } } as unknown as ToolUseContext
  expect(resolveCodeModeTool(context, 'friendly_alias')).toBe(tool)
  context.options.tools = []
  expect(() => resolveCodeModeTool(context, 'friendly_alias')).toThrow('not available')
  expect(codeModeExclusion(AskParentSessionTool)).toContain('new model decision')
})
