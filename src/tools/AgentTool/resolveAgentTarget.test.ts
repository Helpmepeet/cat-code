import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  getSessionId,
  getSessionProjectDir,
  switchSession,
} from '../../bootstrap/state.js'
import { asAgentId } from '../../types/ids.js'
import {
  getAgentTranscriptPath,
  getTranscriptPathForSession,
  writeAgentMetadata,
} from '../../utils/sessionStorage.js'
import { createAgentId } from '../../utils/uuid.js'
import {
  displayNameForAgent,
  formatContextSizeHint,
  resolveAgentTarget,
} from './resolveAgentTarget.js'

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

function writePriorSessionState(
  projectDir: string,
  sessionId: string,
  state: unknown,
): void {
  const path = join(projectDir, `${sessionId}.agent-mode-state.json`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state), 'utf-8')
  createdFiles.push(path)
}

function writeCurrentAgentTranscript(agentId: string): void {
  const path = getAgentTranscriptPath(asAgentId(agentId))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '', 'utf-8')
  createdFiles.push(path)
}

function writePriorAgentTranscript(
  projectDir: string,
  sessionId: string,
  agentId: string,
): void {
  const path = join(projectDir, sessionId, 'subagents', `agent-${agentId}.jsonl`)
  mkdirSync(dirname(path), { recursive: true })
  const userUuid = randomUUID()
  const assistantUuid = randomUUID()
  writeFileSync(
    path,
    [
      JSON.stringify({
        type: 'user',
        uuid: userUuid,
        parentUuid: null,
        isSidechain: true,
        sessionId,
        agentId,
        timestamp: '2026-05-01T00:00:00.000Z',
        message: { role: 'user', content: 'continue' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: assistantUuid,
        parentUuid: userUuid,
        isSidechain: true,
        sessionId,
        agentId,
        timestamp: '2026-05-01T00:00:01.000Z',
        message: {
          id: `msg-${assistantUuid}`,
          type: 'message',
          role: 'assistant',
          model: 'gpt-5.3-codex',
          content: [{ type: 'text', text: 'prior result' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      }),
      '',
    ].join('\n'),
    'utf-8',
  )
  createdFiles.push(path)
}

function writePriorAgentMetadata(
  projectDir: string,
  sessionId: string,
  agentId: string,
  description: string,
  agentName?: string,
): void {
  const path = join(projectDir, sessionId, 'subagents', `agent-${agentId}.meta.json`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify({ agentType: 'general-purpose', description, agentName }),
    'utf-8',
  )
  createdFiles.push(path)
}

function appState({
  registry = new Map(),
  tasks = {},
}: {
  registry?: Map<string, string>
  tasks?: Record<string, unknown>
} = {}) {
  return {
    agentNameRegistry: registry,
    tasks,
  } as never
}

describe('resolveAgentTarget', () => {
  const originalSessionId = getSessionId()
  const originalProjectDir = getSessionProjectDir()
  let tempDir: string
  let sessionId: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'resolve-agent-target-'))
    sessionId = randomUUID()
    switchSession(sessionId, tempDir)
  })

  afterEach(() => {
    while (createdFiles.length > 0) {
      const file = createdFiles.pop()
      if (file) rmSync(file, { force: true })
    }
    rmSync(tempDir, { recursive: true, force: true })
    switchSession(originalSessionId, originalProjectDir)
  })

  test('resolves registered aliases before durable handles', async () => {
    const state = appState({
      registry: new Map([['worker-one', 'agent-registered']]),
      tasks: {
        'agent-registered': {
          id: 'agent-registered',
          type: 'local_agent',
          description: 'Registered task',
        },
      },
    })

    await expect(
      resolveAgentTarget({ input: 'worker-one', appState: state, sessionId }),
    ).resolves.toEqual({
      agentId: 'agent-registered',
      sourceSessionId: sessionId,
      displayName: '@worker-one',
    })
  })

  test('resolves displayed aliases with a leading @', async () => {
    const state = appState({
      registry: new Map([['worker-one', 'agent-registered']]),
      tasks: {
        'agent-registered': {
          id: 'agent-registered',
          type: 'local_agent',
          description: 'Registered task',
        },
      },
    })

    await expect(
      resolveAgentTarget({ input: '@worker-one', appState: state, sessionId }),
    ).resolves.toEqual({
      agentId: 'agent-registered',
      sourceSessionId: sessionId,
      displayName: '@worker-one',
    })
  })

  test('resolves current-session durable worker handles', async () => {
    writeSessionState(sessionId, {
      sessionId,
      mode: 'agent',
      objective: 'Current target',
      activeWorkers: {},
      knownWorkers: {
        'agent-current': {
          agentId: 'agent-current',
          role: 'explorer',
          description: 'Current durable worker',
          status: 'completed',
          resumable: true,
          worktreePath: null,
          handle: 'explore-current',
        },
      },
    })

    await expect(
      resolveAgentTarget({
        input: 'explore-current',
        appState: appState(),
        sessionId,
      }),
    ).resolves.toMatchObject({
      agentId: 'agent-current',
      sourceSessionId: sessionId,
    })
  })

  test('resolves displayed durable worker handles with a leading @', async () => {
    writeSessionState(sessionId, {
      sessionId,
      mode: 'agent',
      objective: 'Current target',
      activeWorkers: {},
      knownWorkers: {
        'agent-current': {
          agentId: 'agent-current',
          role: 'explorer',
          description: 'Current durable worker',
          status: 'completed',
          resumable: true,
          worktreePath: null,
          handle: 'explore-current',
        },
      },
    })

    await expect(
      resolveAgentTarget({
        input: '@explore-current',
        appState: appState(),
        sessionId,
      }),
    ).resolves.toMatchObject({
      agentId: 'agent-current',
      sourceSessionId: sessionId,
    })
  })

  test('resolves prior-session durable worker handles with origin session', async () => {
    const freshSessionId = randomUUID()
    const priorSessionId = randomUUID()
    switchSession(freshSessionId, tempDir)
    sessionId = freshSessionId

    writePriorSessionState(tempDir, priorSessionId, {
      sessionId: priorSessionId,
      mode: 'agent',
      objective: 'Prior target',
      activeWorkers: {},
      knownWorkers: {
        'agent-prior': {
          agentId: 'agent-prior',
          role: 'explorer',
          description: 'Prior durable worker',
          status: 'completed',
          resumable: true,
          worktreePath: null,
          handle: 'explore-prior',
        },
      },
    })
    writePriorAgentTranscript(tempDir, priorSessionId, 'agent-prior')
    writePriorAgentMetadata(
      tempDir,
      priorSessionId,
      'agent-prior',
      'Prior metadata worker',
    )

    await expect(
      resolveAgentTarget({
        input: 'explore-prior',
        appState: appState(),
        sessionId,
      }),
    ).resolves.toEqual({
      agentId: 'agent-prior',
      sourceSessionId: priorSessionId,
      displayName: 'Prior metadata worker',
      contextTokens: expect.any(Number),
    })
  })

  test('resolves raw agent IDs only when the current transcript exists', async () => {
    const agentId = createAgentId()
    writeCurrentAgentTranscript(agentId)

    await expect(
      resolveAgentTarget({ input: agentId, appState: appState(), sessionId }),
    ).resolves.toMatchObject({
      agentId,
      sourceSessionId: sessionId,
    })

    await expect(
      resolveAgentTarget({
        input: createAgentId(),
        appState: appState(),
        sessionId,
      }),
    ).resolves.toBeNull()
  })

  test('resolves current-session metadata names outside Agent Mode state', async () => {
    const agentId = createAgentId()
    writeCurrentAgentTranscript(agentId)
    await writeAgentMetadata(asAgentId(agentId), {
      agentType: 'general-purpose',
      description: 'Metadata worker',
      agentName: 'Ada',
    })

    await expect(
      resolveAgentTarget({ input: 'Ada', appState: appState(), sessionId }),
    ).resolves.toEqual({
      agentId,
      sourceSessionId: sessionId,
      displayName: '@Ada',
    })

    await expect(
      resolveAgentTarget({ input: '@Ada', appState: appState(), sessionId }),
    ).resolves.toMatchObject({
      agentId,
      sourceSessionId: sessionId,
      displayName: '@Ada',
    })
  })

  test('does not resolve ambiguous duplicate metadata names', async () => {
    const firstAgentId = createAgentId()
    const secondAgentId = createAgentId()
    writeCurrentAgentTranscript(firstAgentId)
    writeCurrentAgentTranscript(secondAgentId)
    await writeAgentMetadata(asAgentId(firstAgentId), {
      agentType: 'general-purpose',
      description: 'First metadata worker',
      agentName: 'Ada',
    })
    await writeAgentMetadata(asAgentId(secondAgentId), {
      agentType: 'general-purpose',
      description: 'Second metadata worker',
      agentName: 'Ada',
    })

    await expect(
      resolveAgentTarget({ input: '@Ada', appState: appState(), sessionId }),
    ).resolves.toBeNull()
  })

  test('resolves raw agent IDs for live in-memory tasks before transcript creation', async () => {
    const agentId = createAgentId()

    await expect(
      resolveAgentTarget({
        input: agentId,
        appState: appState({
          tasks: {
            [agentId]: {
              id: agentId,
              type: 'local_agent',
              status: 'running',
              agentId,
              agentType: 'general-purpose',
            },
          },
        }),
        sessionId,
      }),
    ).resolves.toMatchObject({
      agentId,
      sourceSessionId: sessionId,
    })
  })

  test('resolves prior-session raw agent IDs through durable session state', async () => {
    const freshSessionId = randomUUID()
    const priorSessionId = randomUUID()
    const priorAgentId = createAgentId()
    switchSession(freshSessionId, tempDir)
    sessionId = freshSessionId

    writePriorSessionState(tempDir, priorSessionId, {
      sessionId: priorSessionId,
      mode: 'agent',
      objective: 'Prior raw target',
      activeWorkers: {},
      knownWorkers: {
        [priorAgentId]: {
          agentId: priorAgentId,
          role: 'explorer',
          description: 'Prior raw worker',
          status: 'completed',
          resumable: true,
          worktreePath: null,
          handle: 'explore-prior',
        },
      },
    })
    writePriorAgentTranscript(tempDir, priorSessionId, priorAgentId)

    await expect(
      resolveAgentTarget({
        input: priorAgentId,
        appState: appState(),
        sessionId,
      }),
    ).resolves.toMatchObject({
      agentId: priorAgentId,
      sourceSessionId: priorSessionId,
    })
  })

  test('returns null when no registry, durable handle, or transcript matches', async () => {
    await expect(
      resolveAgentTarget({
        input: 'missing-worker',
        appState: appState(),
        sessionId,
      }),
    ).resolves.toBeNull()
  })

  test('display name falls back through alias, metadata, task description, and short ID', async () => {
    const metadataAgentId = createAgentId()
    await writeAgentMetadata(asAgentId(metadataAgentId), {
      agentType: 'general-purpose',
      description: 'Metadata worker',
      agentName: 'Ada',
    })

    await expect(
      displayNameForAgent({
        agentId: 'agent-alias',
        appState: appState({
          registry: new Map([['alias', 'agent-alias']]),
        }),
      }),
    ).resolves.toBe('@alias')

    await expect(
      displayNameForAgent({
        agentId: metadataAgentId,
        appState: appState(),
      }),
    ).resolves.toBe('@Ada')

    await expect(
      displayNameForAgent({
        agentId: 'agent-task',
        appState: appState({
          tasks: {
            'agent-task': {
              id: 'agent-task',
              type: 'local_agent',
              description: 'Task worker',
            },
          },
        }),
      }),
    ).resolves.toBe('Task worker')

    await expect(
      displayNameForAgent({
        agentId: 'agent-1234567890abcdef',
        appState: appState(),
      }),
    ).resolves.toBe('agent-123456...')
  })
})

describe('formatContextSizeHint', () => {
  test('returns empty string when size is unknown', () => {
    expect(formatContextSizeHint(undefined)).toBe('')
  })

  test('returns empty string for zero or negative', () => {
    expect(formatContextSizeHint(0)).toBe('')
    expect(formatContextSizeHint(-5)).toBe('')
  })

  test('suppresses the hint below the 1k floor (avoids "~2 tokens" noise)', () => {
    expect(formatContextSizeHint(2)).toBe('')
    expect(formatContextSizeHint(999)).toBe('')
  })

  test('renders a rounded k-token hint at and above the floor', () => {
    expect(formatContextSizeHint(1000)).toContain('~1k tokens')
    expect(formatContextSizeHint(1500)).toContain('~2k tokens')
    expect(formatContextSizeHint(148_000)).toContain('~148k tokens')
  })

  test('the hint is a leading-space trailing clause callers can append unconditionally', () => {
    const hint = formatContextSizeHint(150_000)
    expect(hint.startsWith(' ')).toBe(true)
    expect(hint).toContain('a fresh agent may be cheaper than resuming')
  })
})
