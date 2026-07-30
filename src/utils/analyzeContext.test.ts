import { expect, test } from 'bun:test'

const source = await Bun.file(new URL('./analyzeContext.ts', import.meta.url)).text()

test('/context resolves the Plan-mode runtime model with the request path\'s 200k condition', () => {
  expect(source).toMatch(
    /exceeds200kTokens:\s*toolPermissionContext\.mode === 'plan' &&\s*doesMostRecentAssistantMessageExceed200k\(messages\),/,
  )
})

test('/context measures the Agent Mode prompt assembled for that runtime model', () => {
  expect(source).toContain('getAgentModeSystemPromptSections(\n          tools,\n          runtimeModel,')
  expect(source).toContain('agentModePromptSections,')
})

test('/context builds the prompt with the same working directories and MCP clients a turn passes', () => {
  // A partial-args build measures a prompt the session will never send, and
  // before the section cache was keyed it also poisoned the first real turn.
  expect(source).toMatch(
    /const additionalWorkingDirectories = Array\.from\(\s*toolPermissionContext\.additionalWorkingDirectories\.keys\(\),?\s*\)/,
  )
  expect(source).toMatch(
    /getSystemPrompt\(\s*tools,\s*runtimeModel,\s*additionalWorkingDirectories,\s*toolUseContext\?\.options\.mcpClients,?\s*\)/,
  )
})
