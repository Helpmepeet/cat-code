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

  test(`${kind} desktop prompt routes external browser and native control to the supported MCP`, () => {
    const prompt = buildDesktopSystemPrompt({ name: null, createdByName: null, createdById: null }, directory)
    expect(prompt).toContain('For public websites, signed-in browser sessions, and native macOS app control, use the codex-computer-use MCP tools.')
    for (const tool of ['mcp__codex-computer-use__computer_use_status', 'mcp__codex-computer-use__js']) expect(prompt).toContain(tool)
    expect(prompt).toContain('directly when available')
    expect(prompt).toContain('ToolSearch when deferred')
    expect(prompt).toContain('Do not load the cua-driver skill or start or use cua-driver through Bash or MCP')
    expect(prompt).toContain('unless the user explicitly requests that driver, even if a skill recommends it')
    expect(prompt).toContain('report the blocker instead of substituting cua-driver')
    expect(prompt).toContain('If computer use is disabled or refused, stop; do not switch tools to bypass it')
  })

  test(`${kind} desktop prompt keeps metadata maintenance small and descriptions stable`, () => {
    const prompt = buildDesktopSystemPrompt({ name: null, createdByName: null, createdById: null }, directory)
    expect(prompt).toContain('.cat-code/project.json')
    expect(prompt).toContain('once per conversation')
    expect(prompt).toContain("The description captures the project's core purpose")
    expect(prompt).toContain('add it as an alias if the intended workspace is clear')
    expect(prompt).toContain('preserve unrelated fields')
    expect(prompt).not.toContain('UpdateProjectMetadata')
    expect(prompt).not.toContain('Learn aliases actively early on')
  })
}

test('managed project selection uses paths and honors the configured instruction mode', () => {
  const prompt = buildDesktopSystemPrompt({ name: null, createdByName: null, createdById: null }, '/workspace/chat')
  expect(prompt).toContain('exact project path')
  expect(prompt).toContain('configured Project instructions mode')
  expect(prompt).toContain('aliases, descriptions, and paths')
  expect(prompt).not.toContain('known-project handle')
})
