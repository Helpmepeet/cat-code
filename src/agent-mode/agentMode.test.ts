import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { randomUUID } from 'crypto'
import { getAgentModeUserContext } from './agentMode.js'
import { getTranscriptPathForSession } from '../utils/sessionStorage.js'

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
})

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

  test('returns an empty context when Agent Mode is off', async () => {
    const sessionId = `agent-mode-context-${randomUUID()}`
    await expect(getAgentModeUserContext([], undefined, sessionId)).resolves.toEqual({})
  })
})
