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

/**
 * The token counters both need Anthropic, so on a Codex-only session they return
 * null and every `if (tokens > 0)` category guard dropped its category — `/context`
 * and the desktop popover listed only the locally-counted `Skills`.
 *
 * Two properties matter and are easy to regress in opposite directions:
 *  1. DISPLAY paths must fall back to an estimate rather than nothing.
 *  2. `countTokensWithFallback`'s `null` must SURVIVE, because `toolSearch.ts:141`
 *     reads a 0 from `countToolDefinitionTokens` as "API unavailable" before using
 *     its own denser char heuristic. Putting the estimate in the shared helper
 *     silently changed when tool search auto-enables.
 */
test('the display estimate is opt-in, so the tool-search sentinel survives', () => {
  // The shared helper still has a null return contract.
  expect(source).toContain('): Promise<number | null> {')
  // The estimate lives in the display wrapper, not the shared helper.
  expect(source).toMatch(
    /async function countTokensForDisplay[\s\S]*?return estimateTokensForDisplay/,
  )
  // countToolDefinitionTokens estimates only when explicitly asked.
  expect(source).toContain('options?: { estimateWhenUnavailable?: boolean }')
  expect(source).toMatch(
    /if \(options\?\.estimateWhenUnavailable\) \{\s*return estimateTokensForDisplay/,
  )
})

// Images and PDFs are base64 in the transcript; a chars/4 pass reports a 1MB PDF
// as ~325k tokens against the ~2000 the API charges. Delegating per block to the
// engine's own estimator is what keeps that out of the Messages category.
test('the local estimate delegates per content block instead of stringifying', () => {
  expect(source).toContain('roughTokenCountEstimationForContent')
  expect(source).not.toMatch(/JSON\.stringify\(message\.content/)
})
