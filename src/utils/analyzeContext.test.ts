import { expect, test } from 'bun:test'

const source = await Bun.file(new URL('./analyzeContext.ts', import.meta.url)).text()

test('/context resolves the Plan-mode runtime model with the request path\'s 200k condition', () => {
  expect(source).toMatch(
    /exceeds200kTokens:\s*toolPermissionContext\.mode === 'plan' &&\s*doesMostRecentAssistantMessageExceed200k\(messages\),/,
  )
})
