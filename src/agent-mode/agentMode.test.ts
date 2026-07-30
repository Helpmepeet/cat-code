import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { randomUUID } from 'crypto'
import { getAgentModeUserContext } from './agentMode.js'
import { getTranscriptPathForSession } from '../utils/sessionStorage.js'
import {
  resetStateForTests,
  setSessionProvider,
} from '../bootstrap/state.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FILE_PATCH_TOOL_NAME } from '../tools/FilePatchTool/constants.js'
import { SKILL_TOOL_NAME } from '../tools/SkillTool/constants.js'

const createdFiles: string[] = []

function getSessionStatePath(sessionId: string): string {
  return getTranscriptPathForSession(sessionId).replace(/\.jsonl$/, '.agent-mode-state.json')
}

function writeSessionState(sessionId: string, state: unknown): void {
  const path = getSessionStatePath(sessionId)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state), 'utf-8')
  createdFiles.push(path)
}

afterEach(() => {
  while (createdFiles.length > 0) {
    const file = createdFiles.pop()
    if (!file) continue
    rmSync(file, { force: true })
  }
  delete process.env.CLAUDE_CODE_AGENT_MODE
  resetStateForTests()
})

/** The advertised tool list, parsed out of the capability sentence. */
function listedWorkerTools(content: string | undefined): string[] {
  const list = content?.match(/can receive these tools: (.+?)\. That is/)?.[1]
  if (!list) throw new Error(`no worker tool list in: ${content}`)
  return list.split(', ')
}

describe('getAgentModeUserContext', () => {
  test('includes formatted live session state in Agent Mode', async () => {
    const sessionId = `agent-mode-context-${randomUUID()}`
    writeSessionState(sessionId, {
      sessionId,
      mode: 'agent',
      objective: 'Explore the codebase',
      activeWorkers: {},
      knownWorkers: {
        'worker-1': {
          agentId: 'worker-1',
          role: 'explorer',
          description: 'find entry points',
          status: 'completed',
          resumable: true,
          worktreePath: null,
          handle: 'explore-1',
        },
      },
    })

    process.env.CLAUDE_CODE_AGENT_MODE = '1'
    const context = await getAgentModeUserContext([], undefined, sessionId)

    expect(context.workerToolsContext).toContain('Delegated workers')
    expect(context.agentModeSessionState).toContain('Agent Mode session state:')
    expect(context.agentModeSessionState).toContain('Known workers:')
  })

  test('advertises the provider tool set as a candidate set, without Skill', async () => {
    process.env.CLAUDE_CODE_AGENT_MODE = '1'

    setSessionProvider('openai')
    const openai = await getAgentModeUserContext(
      [],
      undefined,
      `agent-mode-context-${randomUUID()}`,
    )
    expect(listedWorkerTools(openai.workerToolsContext)).toContain(
      FILE_PATCH_TOOL_NAME,
    )
    expect(listedWorkerTools(openai.workerToolsContext)).not.toContain(
      FILE_EDIT_TOOL_NAME,
    )
    expect(openai.workerToolsContext).toContain('not a per-worker guarantee')

    setSessionProvider('firstParty')
    const anthropic = await getAgentModeUserContext(
      [],
      undefined,
      `agent-mode-context-${randomUUID()}`,
    )
    expect(listedWorkerTools(anthropic.workerToolsContext)).toContain(
      FILE_EDIT_TOOL_NAME,
    )
    expect(listedWorkerTools(anthropic.workerToolsContext)).not.toContain(
      FILE_PATCH_TOOL_NAME,
    )

    // Skill is orchestrator-only by default, so it must not be advertised as a
    // worker capability (it contradicted the orchestrator doctrine).
    for (const context of [openai, anthropic]) {
      expect(listedWorkerTools(context.workerToolsContext)).not.toContain(
        SKILL_TOOL_NAME,
      )
    }
  })

  test('returns an empty context when Agent Mode is off', async () => {
    const sessionId = `agent-mode-context-${randomUUID()}`
    await expect(getAgentModeUserContext([], undefined, sessionId)).resolves.toEqual({})
  })
})
