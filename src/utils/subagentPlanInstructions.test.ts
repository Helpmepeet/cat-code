import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../Tool.js'
import { asAgentId } from '../types/ids.js'
import { getAttachments } from './attachments.js'
import { filterToolsForAgent } from '../tools/AgentTool/agentToolUtils.js'
import { AskUserQuestionTool } from '../tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { FileReadTool } from '../tools/FileReadTool/FileReadTool.js'
import { normalizeAttachmentForAPI } from './messages.js'
import { getPlanFilePath, getPlansDirectory } from './plans.js'

const envKeys = ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_DISABLE_ATTACHMENTS', 'CLAUDE_CODE_SIMPLE'] as const
let previous: Array<string | undefined>
let directory: string

beforeEach(() => {
  previous = envKeys.map(key => process.env[key])
  directory = mkdtempSync(join(tmpdir(), 'subagent-plan-instructions-'))
  process.env.CLAUDE_CONFIG_DIR = directory
  delete process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS
  delete process.env.CLAUDE_CODE_SIMPLE
  getPlansDirectory.cache.clear?.()
})

afterEach(() => {
  envKeys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key]
    else process.env[key] = previous[index]
  })
  getPlansDirectory.cache.clear?.()
  rmSync(directory, { recursive: true, force: true })
})

for (const planExists of [false, true]) {
  test(`runtime subagent plan reminder respects filtered tools (existing plan: ${planExists})`, async () => {
    const agentId = asAgentId('plan-worker')
    const tools = filterToolsForAgent({
      tools: [AskUserQuestionTool, FileReadTool],
      isBuiltIn: true,
      permissionMode: 'plan',
    })
    expect(tools.map(tool => tool.name)).toContain(FileReadTool.name)
    expect(tools.map(tool => tool.name)).not.toContain(AskUserQuestionTool.name)
    const planFilePath = getPlanFilePath(agentId)
    expect(planFilePath.startsWith(directory)).toBe(true)
    if (planExists) writeFileSync(planFilePath, '# Plan\n')
    const context = {
      agentId,
      abortController: new AbortController(),
      options: {
        tools, commands: [], mcpClients: [], mcpResources: {},
        mainLoopModel: 'test', agentDefinitions: { activeAgents: [], allAgents: [] },
      },
      getAppState: () => ({
        tasks: {}, todos: {}, inbox: { messages: [] },
        toolPermissionContext: { mode: 'plan' },
      }),
      readFileState: new Map(),
      nestedMemoryAttachmentTriggers: new Set(),
      dynamicSkillDirTriggers: new Set(),
    } as unknown as ToolUseContext
    const attachments = await getAttachments(null, context, null, [], [])
    const attachment = attachments.find(item => item.type === 'plan_mode')
    expect(attachment).toMatchObject({ isSubAgent: true, planExists, planFilePath })
    if (!attachment) throw new Error('Missing production plan-mode attachment')
    const reminder = JSON.stringify(normalizeAttachmentForAPI(attachment))
    expect(reminder).not.toContain(AskUserQuestionTool.name)
    expect(reminder).not.toContain('returns immediately without an answer')
    expect(reminder).toContain('report the unresolved question to your caller')
    expect(reminder).toContain('Stop work that depends on the answer')
    expect(reminder).toContain('resume that work only when your caller supplies the answer')
    expect(reminder).toContain(planFilePath)
    expect(reminder).toContain('only file you are allowed to edit')
    expect(reminder).toContain('READ-ONLY actions')
    expect(reminder).toContain(planExists ? 'A plan file already exists' : 'No plan file exists yet')
  })
}
