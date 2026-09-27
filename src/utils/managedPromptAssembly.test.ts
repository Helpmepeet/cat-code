import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSystemPrompt } from '../constants/prompts.js'
import { clearSystemPromptSections } from '../constants/systemPromptSections.js'
import { getSystemContext, getUserContext } from '../context.js'
import { buildProviderInstructionAssembly } from '../services/api/instructionAssembly.js'
import { setOriginalCwd } from '../bootstrap/state.js'
import { getMemoryFiles } from './claudemd.js'
import { setManagedSessionPolicy } from './managedSessionPolicy.js'
import { createUserMessage } from './messages.js'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalNodeEnv = process.env.NODE_ENV
const originalCwd = process.cwd()
process.env.ANTHROPIC_API_KEY ??= 'test-key'
process.env.OPENAI_API_KEY ??= 'test-key'

afterEach(() => {
  setManagedSessionPolicy(null)
  setOriginalCwd(originalCwd)
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
  getMemoryFiles.cache.clear?.()
  getUserContext.cache.clear?.()
  getSystemContext.cache.clear?.()
  clearSystemPromptSections()
})

test('serialized provider instructions keep global guidance but exclude managed-folder project rules and Git context', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-managed-assembly-'))
  try {
    const config = join(root, 'config')
    const cwd = join(root, 'Chat Files', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')
    mkdirSync(config)
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(config, 'CLAUDE.md'), 'GLOBAL_GUIDANCE_MARKER')
    writeFileSync(join(root, 'Chat Files', 'CLAUDE.md'), 'PARENT_PROJECT_MARKER')
    writeFileSync(join(cwd, 'CLAUDE.md'), 'CHAT_PROJECT_MARKER')
    writeFileSync(join(cwd, 'CLAUDE.local.md'), 'CHAT_LOCAL_MARKER')
    process.env.CLAUDE_CONFIG_DIR = config
    setOriginalCwd(cwd)
    setManagedSessionPolicy({
      workingDirectory: cwd,
      temporaryDirectory: join(cwd, 'tmp'),
      storageRootId: '11111111-1111-4111-8111-111111111111',
      storageId: '22222222-2222-4222-8222-222222222222',
    })

    for (const [provider, model] of [
      ['anthropic', 'claude-opus-5'],
      ['openai', 'gpt-5.6-terra'],
    ] as const) {
      getMemoryFiles.cache.clear?.()
      getUserContext.cache.clear?.()
      getSystemContext.cache.clear?.()
      clearSystemPromptSections()
      const userContext = await getUserContext()
      expect(userContext.claudeMd).toContain('GLOBAL_GUIDANCE_MARKER')
      // The API helper intentionally elides the Anthropic meta message in
      // NODE_ENV=test; exercise its production serialization branch here.
      process.env.NODE_ENV = 'development'
      const assembly = buildProviderInstructionAssembly({
        provider,
        messages: [createUserMessage({ content: 'Please help with this task.' })],
        systemPrompt: await getSystemPrompt([], model),
        userContext,
        systemContext: await getSystemContext(),
      })
      const serialized = provider === 'openai'
        ? assembly.openAIInstructionAssembly!.instructions
        : `${assembly.systemPrompt.join('\n')}\n${JSON.stringify(assembly.messages)}`
      expect(serialized).toContain('GLOBAL_GUIDANCE_MARKER')
      expect(serialized).not.toContain('PARENT_PROJECT_MARKER')
      expect(serialized).not.toContain('CHAT_PROJECT_MARKER')
      expect(serialized).not.toContain('CHAT_LOCAL_MARKER')
      expect(serialized).not.toContain('Current branch:')
      process.env.NODE_ENV = originalNodeEnv
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
