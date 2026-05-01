import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import {
  getSessionId,
  getSessionProjectDir,
  switchSession,
} from '../../bootstrap/state.js'
import { getTranscriptPathForSession } from '../../utils/sessionStorage.js'

type SendMessageToolModule = typeof import('./SendMessageTool.js')

let SendMessageTool: SendMessageToolModule['SendMessageTool']
let resumeAgentBackground: ReturnType<typeof mock>

const createdFiles: string[] = []

function getSessionStatePath(sessionId: string): string {
  return getTranscriptPathForSession(sessionId).replace(
    /\.jsonl$/,
    '.agent-mode-state.json',
  )
}

function writeSessionState(sessionId: string, state: unknown): void {
  const path = getSessionStatePath(sessionId)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state), 'utf-8')
  createdFiles.push(path)
}

describe('SendMessageTool durable worker handle fallback', () => {
  const originalSessionId = getSessionId()
  const originalProjectDir = getSessionProjectDir()
  let tempDir: string

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'send-message-tool-'))
    const sessionId = randomUUID()
    switchSession(sessionId, tempDir)

    writeSessionState(sessionId, {
      sessionId,
      mode: 'agent',
      objective: 'Follow-up durable handle resume test',
      activeWorkers: {},
      knownWorkers: {
        'agent-persistent': {
          agentId: 'agent-persistent',
          role: 'explorer',
          description: 'Explore target topic',
          status: 'completed',
          resumable: true,
          worktreePath: null,
          handle: 'explore-1',
        },
      },
    })

    resumeAgentBackground = mock(async () => ({
      agentId: 'agent-persistent',
      description: 'Resumed worker',
      outputFile: join(tempDir, 'agent-output.txt'),
    }))

    await mock.module('../AgentTool/resumeAgent.js', () => ({
      resumeAgentBackground,
    }))
    SendMessageTool = (await import('./SendMessageTool.js')).SendMessageTool
  })

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
    while (createdFiles.length > 0) {
      const file = createdFiles.pop()
      if (!file) continue
      rmSync(file, { force: true })
    }
    switchSession(originalSessionId, originalProjectDir)
  })

  test('resolves durable handle to agent id and resumes in background', async () => {
    const context = {
      getAppState: () => ({
        agentNameRegistry: new Map(),
        tasks: {},
      }),
    } as never

    const result = await SendMessageTool.call(
      { to: 'explore-1', summary: 'follow up', message: 'go deeper' },
      context,
      undefined as never,
      { requestId: 'req-1' } as never,
    )

    expect(resumeAgentBackground).toHaveBeenCalledTimes(1)
    expect(resumeAgentBackground).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-persistent',
        prompt: 'go deeper',
      }),
    )
    expect(result).toMatchObject({
      data: {
        success: true,
        message: expect.stringContaining(
          'had no active task; resumed from transcript in the background',
        ),
      },
    })
  })
})
