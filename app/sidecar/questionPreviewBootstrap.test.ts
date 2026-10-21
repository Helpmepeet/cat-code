import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('desktop engine bootstrap advertises markdown question previews', async () => {
  const home = mkdtempSync(join(tmpdir(), 'catcode-question-preview-'))
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const script = `
    import { getQuestionPreviewFormat } from './src/bootstrap/state.ts'
    import { AskUserQuestionTool } from './src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx'
    import { createNormalSidecarQueryEngineConfig } from './app/sidecar/sessionController.ts'
    const before = getQuestionPreviewFormat() ?? null
    const { queryEngineConfig, mcpLifecycle } = await createNormalSidecarQueryEngineConfig(${JSON.stringify(home)})
    console.log(JSON.stringify({
      before,
      after: getQuestionPreviewFormat() ?? null,
      toolPresent: queryEngineConfig.tools.some(tool => tool.name === AskUserQuestionTool.name),
      markdownPrompt: (await AskUserQuestionTool.prompt()).includes('Preview content is rendered as markdown'),
    }))
    await mcpLifecycle.dispose()
    process.exit(0)
  `
  try {
    const child = Bun.spawn([process.execPath, '--eval', script], {
      cwd: root,
      env: { PATH: process.env.PATH ?? '', HOME: home, CLAUDE_CONFIG_DIR: home, TMPDIR: tmpdir(), NODE_ENV: 'test' },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10_000,
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ exitCode, stderr: exitCode === 0 ? '' : stderr }).toEqual({ exitCode: 0, stderr: '' })
    expect(JSON.parse(stdout.trim())).toEqual({
      before: null,
      after: 'markdown',
      toolPresent: true,
      markdownPrompt: true,
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}, 15_000)
