import { expect, test } from 'bun:test'
import { buildDesktopSystemPrompt } from './desktopSystemPrompt.js'

for (const [kind, directory] of [['managed', '/workspace/chat'], ['project', undefined]] as const) {
  test(`${kind} desktop prompt explains the session browser and touch hand-back`, () => {
    const prompt = buildDesktopSystemPrompt({ name: null, createdByName: null, createdById: null }, directory)
    for (const tool of ['BrowserNavigate', 'BrowserRead', 'BrowserAct', 'BrowserScreenshot']) expect(prompt).toContain(tool)
    expect(prompt).toContain('localhost pages and local HTML files')
    expect(prompt).toContain('touch the page to take over')
    expect(prompt).toContain('next message hands it back')
  })
}
