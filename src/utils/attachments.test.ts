import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { ToolUseContext } from '../Tool.js'
import { getProjectRoot, setProjectRoot } from '../bootstrap/state.js'
import { clearCommandsCache } from '../commands.js'
import { SkillTool } from '../tools/SkillTool/SkillTool.js'
import { TEAM_LEAD_NAME } from './swarm/constants.js'
import {
  readTeamSnapshot,
  transactTeamFile,
  writeTeamFileAsync,
  type TeamFile,
} from './swarm/teamHelpers.js'
import { clearDynamicTeamContext, setDynamicTeamContext } from './teammate.js'
import {
  createShutdownApprovedMessage,
  createShutdownRequestMessage,
  readMailbox,
  writeControlToMailbox,
  writeToMailbox,
  type TeamPrincipal,
} from './teammateMailbox.js'
import {
  _attachmentsForTest,
  createAttachmentMessage,
  getAttachments,
  getQueuedCommandAttachments,
  getSkillListingAttachments,
  getTaskReminderAttachments,
  getTodoReminderAttachments,
  resetSentSkillNames,
  TODO_REMINDER_CONFIG,
  type Attachment,
} from './attachments.js'
import {
  createAssistantMessage,
  createCompactBoundaryMessage,
  createUserMessage,
  normalizeAttachmentForAPI,
} from './messages.js'
import { restoreSkillStateFromMessages } from './conversationRecovery.js'
import { translateToCodexBody } from '../services/api/codex-fetch-adapter.js'
import { createTask, getTaskListId, updateTask } from './tasks.js'
import { TodoWriteTool } from '../tools/TodoWriteTool/TodoWriteTool.js'
import { TaskUpdateTool } from '../tools/TaskUpdateTool/TaskUpdateTool.js'
import { capturePriorAssistantContext } from './permissions/priorAssistantContext.js'

test('mid-turn attachment retains submission proposal A after proposal B arrives', async () => {
  const a = createAssistantMessage({ content: 'May I read the file?' })
  a.message.model = 'test-model'
  const binding = capturePriorAssistantContext([a])
  expect(binding).not.toBeNull()
  const command = { value: 'Sure', mode: 'prompt' as const, priorAssistantContext: binding }
  const b = createAssistantMessage({ content: 'May I also delete the directory?' })
  b.message.model = 'test-model'
  expect(capturePriorAssistantContext([a, b])).not.toEqual(binding)
  const [attachment] = await getQueuedCommandAttachments([command])
  const [message] = normalizeAttachmentForAPI(attachment!)
  expect(message!.priorAssistantContext).toEqual(binding)
  expect(JSON.stringify(message!.message.content)).not.toContain(binding!.textHash)
})

test('queued attachment missing or explicitly null binding never recaptures', async () => {
  for (const priorAssistantContext of [undefined, null]) {
    const [attachment] = await getQueuedCommandAttachments([
      { value: 'Sure', mode: 'prompt', priorAssistantContext },
    ])
    expect(normalizeAttachmentForAPI(attachment!)[0]!.priorAssistantContext).toBeNull()
  }
})

type FakeAppState = {
  teamContext?: {
    teamName: string
    leadAgentId: string
    teammates: Record<string, { name: string; color?: string }>
  }
  viewingAgentTaskId?: string
  tasks: Record<string, unknown>
  inbox: { messages: Array<{ id: string; status: string }> }
}

describe('turn-start runtime attachments', () => {
  const keys = ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_DISABLE_ATTACHMENTS', 'CLAUDE_CODE_SIMPLE'] as const
  let previous: Array<string | undefined>
  let directory: string

  beforeEach(() => {
    previous = keys.map(key => process.env[key])
    directory = mkdtempSync(join(tmpdir(), 'turn-start-attachments-'))
    process.env.CLAUDE_CONFIG_DIR = directory
    delete process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS
    delete process.env.CLAUDE_CODE_SIMPLE
  })

  afterEach(() => {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key]
      else process.env[key] = previous[index]
    })
    rmSync(directory, { recursive: true, force: true })
  })

  function context(hook: NonNullable<ToolUseContext['getTurnStartRuntimeAttachments']>, agentId?: string): ToolUseContext {
    return {
      agentId,
      getTurnStartRuntimeAttachments: hook,
      abortController: new AbortController(),
      options: {
        tools: [], commands: [], mcpClients: [], mcpResources: {},
        mainLoopModel: 'test', agentDefinitions: { activeAgents: [], allAgents: [] },
      },
      getAppState: () => ({
        tasks: {}, todos: {}, inbox: { messages: [] },
        toolPermissionContext: { mode: 'default' },
      }),
      readFileState: new Map(),
      nestedMemoryAttachmentTriggers: new Set(),
      dynamicSkillDirTriggers: new Set(),
    } as unknown as ToolUseContext
  }

  test('invokes the hook with main-thread messages, but not for subagents', async () => {
    const snapshot: Attachment = {
      type: 'peer_roster_snapshot', workspace: '/workspace',
      asOf: '2026-10-18T00:00:00Z', quotedRoster: '> Bear: tests',
    }
    const messages = [createAssistantMessage({ content: 'Hello' })]
    const calls: unknown[] = []
    const hook = async (input: unknown) => { calls.push(input); return [snapshot] }
    const main = await getAttachments(null, context(hook), null, [], messages)
    expect(main).toContainEqual(snapshot)
    expect(calls).toEqual([{ agentId: undefined, messages }])
    const subagent = await getAttachments(null, context(hook, 'worker'), null, [], messages)
    expect(subagent).not.toContainEqual(snapshot)
    expect(calls).toHaveLength(1)
  })

  test('throwing hooks fail soft', async () => {
    const result = await getAttachments(null, context(async () => {
      throw new Error('runtime snapshot unavailable')
    }), null, [])
    expect(result.filter(a => a.type === 'peer_roster_snapshot')).toEqual([])
  })

  test('never-settling hooks return no runtime attachments at the attachment deadline', async () => {
    const start = Date.now()
    const result = await getAttachments(null, context(() => new Promise(() => {})), null, [])
    expect(result.filter(a => a.type === 'peer_roster_snapshot')).toEqual([])
    expect(Date.now() - start).toBeLessThan(2000)
  })
})

describe('resumed skill listings', () => {
  const keys = ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_DISABLE_POLICY_SKILLS'] as const
  let previous: Array<string | undefined>
  let directory: string
  let originalProjectRoot: string

  beforeEach(() => {
    previous = keys.map(key => process.env[key])
    directory = mkdtempSync(join(tmpdir(), 'resume-skill-listing-'))
    originalProjectRoot = getProjectRoot()
    setProjectRoot(directory)
    process.env.ANTHROPIC_API_KEY = 'test-skill-listing-key'
    process.env.CLAUDE_CONFIG_DIR = directory
    process.env.CLAUDE_CODE_DISABLE_POLICY_SKILLS = '1'
    resetSentSkillNames()
    clearCommandsCache()
  })

  afterEach(() => {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key]
      else process.env[key] = previous[index]
    })
    setProjectRoot(originalProjectRoot)
    resetSentSkillNames()
    clearCommandsCache()
    rmSync(directory, { recursive: true, force: true })
  })

  function addSkill(name: string, description: string) {
    const path = join(directory, 'skills', name)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'SKILL.md'), `---\ndescription: ${description}\n---\nFollow the skill instructions.\n`)
    clearCommandsCache()
  }

  function context(agentId?: string): ToolUseContext {
    return {
      agentId,
      options: { tools: [SkillTool], mainLoopModel: 'gpt-6.1-sol' },
      getAppState: () => ({ mcp: { commands: [] } }),
    } as unknown as ToolUseContext
  }

  function listingContent(attachments: Attachment[]) {
    return attachments.flatMap(attachment =>
      attachment.type === 'skill_listing' ? [attachment.content] : [],
    ).join('\n')
  }

  test('newly installed skills reach resumed model input without repeating unchanged skills', async () => {
    addSkill('resume-original-skill', 'An existing capability')
    const original = await getSkillListingAttachments(context())
    expect(listingContent(original)).toContain('- resume-original-skill:')
    addSkill('resume-added-skill', 'A newly available capability')
    resetSentSkillNames()
    restoreSkillStateFromMessages(original.map(createAttachmentMessage))

    const delta = await getSkillListingAttachments(context())
    expect(listingContent(delta)).toContain('- resume-added-skill: A newly available capability')
    expect(listingContent(delta)).not.toContain('- resume-original-skill:')
    const normalized = delta.flatMap(normalizeAttachmentForAPI)
    expect(JSON.stringify(normalized)).toContain('resume-added-skill')
    const { codexBody } = translateToCodexBody({
      model: 'gpt-6.1-sol',
      _openaiInstructionAssembly: {
        instructions: 'Use available skills when appropriate.',
        inputMessages: normalized.map(message => message.message),
      },
    })
    expect(JSON.stringify(codexBody.input)).toContain('resume-added-skill')
    expect(await getSkillListingAttachments(context())).toEqual([])
  })

  test('unchanged resume does not repeat the existing listing', async () => {
    addSkill('resume-original-skill', 'An existing capability')
    const original = await getSkillListingAttachments(context())
    resetSentSkillNames()
    restoreSkillStateFromMessages(original.map(createAttachmentMessage))
    expect(await getSkillListingAttachments(context())).toEqual([])
  })

  test('a child attachment pass cannot consume the main-thread resume state', async () => {
    addSkill('resume-original-skill', 'An existing capability')
    const original = await getSkillListingAttachments(context())
    addSkill('resume-added-skill', 'A newly available capability')
    resetSentSkillNames()
    restoreSkillStateFromMessages(original.map(createAttachmentMessage))

    const child = await getSkillListingAttachments(context('resume-child'))
    expect(listingContent(child)).toContain('- resume-original-skill:')
    expect(listingContent(child)).toContain('- resume-added-skill:')
    const main = await getSkillListingAttachments(context())
    expect(listingContent(main)).toContain('- resume-added-skill:')
    expect(listingContent(main)).not.toContain('- resume-original-skill:')
  })

  test('resuming without a listing does not inherit a previous conversation announcement', async () => {
    addSkill('resume-original-skill', 'An existing capability')
    await getSkillListingAttachments(context())
    restoreSkillStateFromMessages([])
    expect(listingContent(await getSkillListingAttachments(context()))).toContain('- resume-original-skill:')
  })

  test('legacy names-only and namespaced listings suppress only their advertised names', async () => {
    addSkill('resume-original-skill', 'An existing capability')
    addSkill('resume:namespace:skill', 'A namespaced capability')
    addSkill('resume-added-skill', 'A newly available capability')
    restoreSkillStateFromMessages([createAttachmentMessage({
      type: 'skill_listing',
      content: '- resume-original-skill\n- resume:namespace:skill: A namespaced capability',
      skillCount: 2,
      isInitial: true,
    })])

    const content = listingContent(await getSkillListingAttachments(context()))
    expect(content).toContain('- resume-added-skill:')
    expect(content).not.toContain('- resume-original-skill:')
    expect(content).not.toContain('- resume:namespace:skill:')
  })

  test('resume merges initial and delta listings without reannouncing either batch', async () => {
    addSkill('resume-original-skill', 'An existing capability')
    const original = await getSkillListingAttachments(context())
    addSkill('resume-added-skill', 'A newly available capability')
    const delta = await getSkillListingAttachments(context())
    resetSentSkillNames()
    restoreSkillStateFromMessages([...original, ...delta].map(createAttachmentMessage))

    expect(await getSkillListingAttachments(context())).toEqual([])
  })

  test('a listing before the compact boundary does not suppress resumed announcements', async () => {
    addSkill('resume-original-skill', 'An existing capability')
    const original = await getSkillListingAttachments(context())
    resetSentSkillNames()
    restoreSkillStateFromMessages([
      ...original.map(createAttachmentMessage),
      createCompactBoundaryMessage('auto', 100_000),
      createUserMessage({ content: 'Continue the task.', isCompactSummary: true }),
    ])

    expect(listingContent(await getSkillListingAttachments(context()))).toContain('- resume-original-skill:')
  })

  test('restoring main-thread listings leaves an existing child announcement intact', async () => {
    addSkill('resume-original-skill', 'An existing capability')
    const original = await getSkillListingAttachments(context())
    await getSkillListingAttachments(context('resume-child'))
    restoreSkillStateFromMessages(original.map(createAttachmentMessage))

    expect(await getSkillListingAttachments(context('resume-child'))).toEqual([])
  })

  test('malformed historical listing content does not break recovery', async () => {
    addSkill('resume-original-skill', 'An existing capability')
    restoreSkillStateFromMessages([{
      ...createAttachmentMessage({ type: 'skill_listing', content: '', skillCount: 1, isInitial: true }),
      attachment: { type: 'skill_listing', content: null, skillCount: 1, isInitial: true },
    } as unknown as Parameters<typeof restoreSkillStateFromMessages>[0][number]])

    expect(listingContent(await getSkillListingAttachments(context()))).toContain('- resume-original-skill:')
  })
})

describe('task reminders', () => {
  const envKeys = [
    'CLAUDE_CONFIG_DIR',
    'USER_TYPE',
    'CLAUDE_CODE_ENABLE_TASKS',
    'CLAUDE_CODE_TASK_LIST_ID',
  ] as const
  let originalEnv: Array<string | undefined>
  let tempDir: string
  type Todos = Extract<Attachment, { type: 'todo_reminder' }>['content']
  let todos: Todos
  let taskId: string | undefined

  beforeEach(() => {
    originalEnv = envKeys.map(key => process.env[key])
    tempDir = mkdtempSync(join(tmpdir(), 'attachments-reminders-'))
    process.env.CLAUDE_CONFIG_DIR = tempDir
    process.env.USER_TYPE = 'external'
    process.env.CLAUDE_CODE_ENABLE_TASKS = 'true'
    process.env.CLAUDE_CODE_TASK_LIST_ID = randomUUID()
    todos = []
    taskId = undefined
  })

  afterEach(() => {
    for (const [index, key] of envKeys.entries()) {
      const value = originalEnv[index]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  const idleTurns = (
    count = Math.max(
      TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE,
      TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS,
    ),
  ) => Array.from({ length: count }, () =>
    createAssistantMessage({ content: 'Continuing the requested work.' }),
  )

  function context(tools = [TodoWriteTool, TaskUpdateTool]): ToolUseContext {
    return {
      agentId: 'reminder-test',
      options: { tools },
      getAppState: () => ({ todos: { 'reminder-test': todos } }),
    } as unknown as ToolUseContext
  }

  for (const kind of ['todo', 'task'] as const) {
    const reminders = kind === 'todo'
      ? getTodoReminderAttachments
      : getTaskReminderAttachments

    async function setStatus(status: 'pending' | 'in_progress' | 'completed') {
      if (kind === 'todo') {
        todos = [{ content: 'Run checks', activeForm: 'Running checks', status }]
      } else if (taskId) {
        await updateTask(getTaskListId(), taskId, { status })
      } else {
        taskId = await createTask(getTaskListId(), {
          subject: 'Run checks',
          description: 'Run the applicable project checks.',
          activeForm: 'Running checks',
          status,
          blocks: [],
          blockedBy: [],
        })
      }
    }

    test(`${kind}: no reminder for an empty or completed list`, async () => {
      expect(await reminders(idleTurns(), context())).toEqual([])
      await setStatus('completed')
      expect(await reminders(idleTurns(), context())).toEqual([])
    })

    test(`${kind}: preserves tool availability and turn-delay gates`, async () => {
      await setStatus('pending')
      expect(await reminders(idleTurns(), context([]))).toEqual([])
      expect(await reminders(idleTurns(1), context())).toEqual([])
      const result = await reminders(idleTurns(), context())
      expect(result).toHaveLength(1)
      const [message] = normalizeAttachmentForAPI(result[0]!)
      const text = String(message?.message.content)
      expect(text).toContain('Run checks')
      expect(text).toContain('Do not mention this reminder to the user')
      expect(text).not.toContain("haven't been used recently")
      expect(text).not.toContain("hasn't been used recently")
    })

    test(`${kind}: does not repeat unchanged work but permits a changed list`, async () => {
      await setStatus('pending')
      const [first] = await reminders(idleTurns(), context())
      expect(first).toBeDefined()
      const history = [createAttachmentMessage(first!), ...idleTurns()]
      expect(await reminders(history, context())).toEqual([])
      await setStatus('in_progress')
      expect(await reminders(
        [createAttachmentMessage(first!), ...idleTurns(1)],
        context(),
      )).toEqual([])
      const [second] = await reminders(history, context())
      expect(second).toBeDefined()

      // Returning to an older state is a change from the most recent reminder.
      await setStatus('pending')
      expect(await reminders([
        ...history,
        createAttachmentMessage(second!),
        ...idleTurns(),
      ], context())).toHaveLength(1)
    })
  }
})

describe('getTeammateMailboxAttachments (via _attachmentsForTest)', () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalUserType = process.env.USER_TYPE
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'attachments-mailbox-'))
    process.env.CLAUDE_CONFIG_DIR = tempDir
    process.env.USER_TYPE = 'ant'
  })

  afterEach(() => {
    clearDynamicTeamContext()
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    if (originalUserType === undefined) {
      delete process.env.USER_TYPE
    } else {
      process.env.USER_TYPE = originalUserType
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  const leaderAgentId = `${TEAM_LEAD_NAME}@review-team`
  const aliceAgentId = 'alice@review-team'
  const bobAgentId = 'bob@review-team'

  async function seedTeam(): Promise<void> {
    const now = Date.now()
    const teamFile: TeamFile = {
      name: 'review-team',
      createdAt: now,
      leadAgentId: leaderAgentId,
      teamProtocolVersion: 2,
      recipientRecords: [
        {
          allocationId: 'allocation-lead',
          key: TEAM_LEAD_NAME,
          name: TEAM_LEAD_NAME,
          kind: 'leader',
          agentId: leaderAgentId,
          sessionId: 'session-lead',
          status: 'active',
          launcherPid: process.pid,
          launcherInstanceId: 'test-instance',
          createdAt: now,
          updatedAt: now,
        },
        {
          allocationId: 'allocation-alice',
          key: 'alice',
          name: 'alice',
          kind: 'teammate',
          agentId: aliceAgentId,
          sessionId: 'session-alice',
          status: 'active',
          launcherPid: process.pid,
          launcherInstanceId: 'test-instance',
          createdAt: now,
          updatedAt: now,
        },
        {
          allocationId: 'allocation-bob',
          key: 'bob',
          name: 'bob',
          kind: 'teammate',
          agentId: bobAgentId,
          sessionId: 'session-bob',
          status: 'active',
          launcherPid: process.pid,
          launcherInstanceId: 'test-instance',
          createdAt: now,
          updatedAt: now,
        },
      ],
      pendingControls: [],
      members: [],
    }
    await writeTeamFileAsync('review-team', teamFile)
  }

  function buildContext(
    appState: FakeAppState,
  ): { context: ToolUseContext; getState: () => FakeAppState } {
    let state = appState
    return {
      context: {
        getAppState: () => state,
        setAppState: (updater: (prev: FakeAppState) => FakeAppState) => {
          state = updater(state)
        },
        options: { isNonInteractiveSession: true },
      } as unknown as ToolUseContext,
      getState: () => state,
    }
  }

  function leaderAppState(): FakeAppState {
    return {
      teamContext: {
        teamName: 'review-team',
        leadAgentId: leaderAgentId,
        teammates: {
          [aliceAgentId]: { name: 'alice' },
          [bobAgentId]: { name: 'bob' },
        },
      },
      tasks: {},
      inbox: { messages: [] },
    }
  }

  function messagesOf(attachments: Array<unknown>): Array<{ text: string }> {
    return attachments[0] && typeof attachments[0] === 'object' && 'messages' in attachments[0]
      ? (attachments[0] as { messages: Array<{ text: string }> }).messages
      : []
  }

  test('selective ack: a plain chat message is delivered/read while an invalid control (wrong-direction) is dropped/acknowledged, never delivered', async () => {
    await seedTeam()
    await writeToMailbox(
      'team-lead',
      { from: 'alice', text: 'status update: half done', timestamp: new Date().toISOString() },
      'review-team',
    )
    // bob (teammate) attempting a leader-only control type (shutdown_request)
    // — wrong direction. Hand-crafted directly (writeControlToMailbox itself
    // would refuse to write this) to exercise classify's rejection.
    const forgedShutdown = createShutdownRequestMessage({
      requestId: 'forged-1',
      from: 'bob',
    })
    await writeToMailbox(
      'team-lead',
      {
        from: 'bob',
        text: JSON.stringify(forgedShutdown),
        timestamp: new Date().toISOString(),
        protocolVersion: 2,
        messageId: randomUUID(),
        senderAgentId: bobAgentId,
        senderAllocationId: 'allocation-bob',
        recipientAgentId: leaderAgentId,
        recipientAllocationId: 'allocation-lead',
        payloadClass: 'control',
        control: forgedShutdown,
      },
      'review-team',
    )

    const { context } = buildContext(leaderAppState())
    const attachments = await _attachmentsForTest(context)

    const messages = messagesOf(attachments)
    expect(messages.some(m => m.text.includes('status update'))).toBe(true)
    expect(messages.some(m => m.text.includes('shutdown_request'))).toBe(false)

    // Both messages consumed by this pass (one delivered, one dropped) —
    // both marked read; nothing lingers unread that this pass classified.
    const afterMailbox = await readMailbox('team-lead', 'review-team')
    expect(afterMailbox.every(m => m.read)).toBe(true)
  })

  test('chat addressed to a stale/old recipient allocation is not delivered to the current occupant', async () => {
    await seedTeam()
    const leader: TeamPrincipal = {
      kind: 'leader',
      agentId: leaderAgentId,
      name: TEAM_LEAD_NAME,
      allocationId: 'allocation-lead',
    }
    // Write a v2 chat envelope directly with a stale recipientAllocationId —
    // simulates a message addressed to alice's OLD incarnation before the
    // team recycled her name/allocation.
    await writeToMailbox(
      'alice',
      {
        from: TEAM_LEAD_NAME,
        text: 'hey, still there?',
        timestamp: new Date().toISOString(),
        protocolVersion: 2,
        messageId: randomUUID(),
        senderAgentId: leader.agentId,
        senderAllocationId: leader.allocationId,
        recipientAgentId: aliceAgentId,
        recipientAllocationId: 'allocation-alice-OLD',
        payloadClass: 'chat',
      },
      'review-team',
    )

    setDynamicTeamContext({
      agentId: aliceAgentId,
      agentName: 'alice',
      teamName: 'review-team',
      planModeRequired: false,
    })
    const { context } = buildContext({
      teamContext: undefined,
      tasks: {},
      inbox: { messages: [] },
    })

    const attachments = await _attachmentsForTest(context)
    expect(attachments).toHaveLength(0)

    const afterMailbox = await readMailbox('alice', 'review-team')
    expect(afterMailbox[0]?.read).toBe(true)
  })

  test('a valid correlated shutdown_approved removes only its sender allocation (headless mode)', async () => {
    await seedTeam()
    await transactTeamFile('review-team', teamFile => ({
      teamFile: {
        ...teamFile,
        pendingControls: [
          {
            requestId: 'shutdown-2',
            requestType: 'shutdown' as const,
            senderAgentId: leaderAgentId,
            senderAllocationId: 'allocation-lead',
            recipientAgentId: aliceAgentId,
            recipientAllocationId: 'allocation-alice',
            state: 'written' as const,
          },
        ],
      },
      result: undefined,
    }))

    const leader: TeamPrincipal = {
      kind: 'leader',
      agentId: leaderAgentId,
      name: TEAM_LEAD_NAME,
      allocationId: 'allocation-lead',
    }
    // Alice is the one sending shutdown_approved.
    setDynamicTeamContext({
      agentId: aliceAgentId,
      agentName: 'alice',
      teamName: 'review-team',
      planModeRequired: false,
    })
    const approved = createShutdownApprovedMessage({ requestId: 'shutdown-2', from: 'alice' })
    await writeControlToMailbox({ recipient: leader, control: approved, teamName: 'review-team' })
    clearDynamicTeamContext()

    // Now read as the leader (headless mode — no useInboxPoller running).
    const { context, getState } = buildContext(leaderAppState())
    await _attachmentsForTest(context)

    const snapshotAfter = await readTeamSnapshot('review-team')
    expect(
      snapshotAfter.recipientRecords?.find(r => r.name === 'alice')?.status,
    ).toBe('terminated')
    expect(
      snapshotAfter.recipientRecords?.find(r => r.name === 'bob')?.status,
    ).toBe('active')
    expect(aliceAgentId in getState().teamContext!.teammates).toBe(false)
    expect(bobAgentId in getState().teamContext!.teammates).toBe(true)
  })

  test('idle_notification retains existing behavior (delivered, not dropped)', async () => {
    await seedTeam()
    await writeToMailbox(
      'team-lead',
      {
        from: 'alice',
        text: JSON.stringify({
          type: 'idle_notification',
          from: 'alice',
          timestamp: new Date().toISOString(),
        }),
        timestamp: new Date().toISOString(),
      },
      'review-team',
    )

    const { context } = buildContext(leaderAppState())
    const attachments = await _attachmentsForTest(context)
    const messages = messagesOf(attachments)
    expect(messages.some(m => m.text.includes('idle_notification'))).toBe(true)
  })
})
