import { expect, test } from 'bun:test'

const source = await Bun.file(new URL('./REPL.tsx', import.meta.url)).text()

test('all REPL prompt builders use the request runtime model', () => {
  expect(source).toContain(
    'getAgentModeSystemPromptSections(freshTools, runtimeMainLoopModel, additionalWorkingDirectories, freshMcpClients)',
  )
  expect(source).toContain('getSystemPrompt(toolUseContext.options.tools, bgRuntimeMainLoopModel')
  expect(source).toContain('getAgentModeSystemPromptSections(toolUseContext.options.tools, bgRuntimeMainLoopModel')
})
