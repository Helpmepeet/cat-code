import { promises as fsp } from 'fs'
import { getSdkAgentProgressSummariesEnabled, getSessionId } from '../../bootstrap/state.js'
import { getSessionStatePathFromTranscriptPath } from '../../agent-mode/sessionState.js'
import { getCurrentSessionMode } from '../../agent-mode/agentMode.js'
import { getSystemPrompt } from '../../constants/prompts.js'
import { isCoordinatorMode } from '../../coordinator/coordinatorMode.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { ToolUseContext } from '../../Tool.js'
import { registerActiveSubagent } from '../../utils/cleanupRegistry.js'
import {
  markAgentTaskResumed,
  registerAsyncAgent,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { assembleToolPool } from '../../tools.js'
import { asAgentId } from '../../types/ids.js'
import { runWithAgentContext } from '../../utils/agentContext.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  createUserMessage,
  filterOrphanedThinkingOnlyMessages,
  filterUnresolvedToolUses,
  filterWhitespaceOnlyAssistantMessages,
} from '../../utils/messages.js'
import { getAgentModel } from '../../utils/model/agent.js'
import { getQuerySourceForAgent } from '../../utils/promptCategory.js'
import {
  getAgentTranscriptForSession,
  getAgentTranscript,
  getAgentTranscriptPath,
  getTranscriptPath,
  appendSubagentSpawned,
  readAgentMetadata,
  readAgentMetadataForSession,
} from '../../utils/sessionStorage.js'
import { buildEffectiveSystemPrompt } from '../../utils/systemPrompt.js'
import type { SystemPrompt } from '../../utils/systemPromptType.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import { getParentSessionId } from '../../utils/teammate.js'
import { reconstructForSubagentResume } from '../../utils/toolResultStorage.js'
import { runAsyncAgentLifecycle } from './agentToolUtils.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'
import { FORK_AGENT, isForkSubagentEnabled } from './forkSubagent.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import { isBuiltInAgent } from './loadAgentsDir.js'
import { runAgent } from './runAgent.js'

export type ResumeAgentResult = {
  agentId: string
  description: string
  outputFile: string
}

export class TranscriptNotFoundError extends Error {
  constructor(agentId: string) {
    super(`No transcript found for agent ID: ${agentId}`)
    this.name = 'TranscriptNotFoundError'
  }
}

export class AgentResumeInProgressError extends Error {
  constructor(agentId: string) {
    super(`Agent ${agentId} is already running or being resumed`)
    this.name = 'AgentResumeInProgressError'
  }
}

type ResumeAgentBackgroundArgs = {
  agentId: string
  prompt: string
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  invokingRequestId?: string
  sourceSessionId?: string
}

const activeResumeLaunches = new Set<string>()

export async function resumeAgentBackground(
  args: ResumeAgentBackgroundArgs,
): Promise<ResumeAgentResult> {
  if (activeResumeLaunches.has(args.agentId)) {
    throw new AgentResumeInProgressError(args.agentId)
  }
  activeResumeLaunches.add(args.agentId)
  try {
    return await resumeAgentBackgroundLocked(args)
  } finally {
    activeResumeLaunches.delete(args.agentId)
  }
}

async function resumeAgentBackgroundLocked({
  agentId,
  prompt,
  toolUseContext,
  canUseTool,
  invokingRequestId,
  sourceSessionId,
}: ResumeAgentBackgroundArgs): Promise<ResumeAgentResult> {
  const startTime = Date.now()
  const appState = toolUseContext.getAppState()
  // In-process teammates get a no-op setAppState; setAppStateForTasks
  // reaches the root store so task registration/progress/kill stay visible.
  const rootSetAppState =
    toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState
  const permissionMode = appState.toolPermissionContext.mode

  const sourceSession = sourceSessionId ?? getSessionId()
  const currentSession = getSessionId()
  const [transcript, meta] = await Promise.all([
    sourceSession === currentSession
      ? getAgentTranscript(asAgentId(agentId))
      : getAgentTranscriptForSession(sourceSession, asAgentId(agentId)),
    sourceSession === currentSession
      ? readAgentMetadata(asAgentId(agentId))
      : readAgentMetadataForSession(sourceSession, asAgentId(agentId)),
  ])
  if (!transcript) {
    throw new TranscriptNotFoundError(agentId)
  }
  const resumedMessages = filterWhitespaceOnlyAssistantMessages(
    filterOrphanedThinkingOnlyMessages(
      filterUnresolvedToolUses(transcript.messages),
    ),
  )
  const resumedReplacementState = reconstructForSubagentResume(
    toolUseContext.contentReplacementState,
    resumedMessages,
    transcript.contentReplacements,
  )
  // Best-effort: if the original worktree was removed externally, fall back
  // to parent cwd rather than crashing on chdir later.
  const resumedWorktreePath = meta?.worktreePath
    ? await fsp.stat(meta.worktreePath).then(
        s => (s.isDirectory() ? meta.worktreePath : undefined),
        () => {
          logForDebugging(
            `Resumed worktree ${meta.worktreePath} no longer exists; falling back to parent cwd`,
          )
          return undefined
        },
      )
    : undefined
  if (resumedWorktreePath) {
    // Bump mtime so stale-worktree cleanup doesn't delete a just-resumed worktree (#22355)
    const now = new Date()
    await fsp.utimes(resumedWorktreePath, now, now)
  }

  // Skip filterDeniedAgents re-gating — original spawn already passed permission checks
  let selectedAgent: AgentDefinition
  let isResumedFork = false
  if (meta?.agentType === FORK_AGENT.agentType) {
    selectedAgent = FORK_AGENT
    isResumedFork = true
  } else if (meta?.agentType) {
    const found = toolUseContext.options.agentDefinitions.activeAgents.find(
      a => a.agentType === meta.agentType,
    )
    selectedAgent = found ?? GENERAL_PURPOSE_AGENT
  } else {
    selectedAgent = GENERAL_PURPOSE_AGENT
  }

  const uiDescription = meta?.description ?? '(resumed)'

  let forkParentSystemPrompt: SystemPrompt | undefined
  if (isResumedFork) {
    if (toolUseContext.renderedSystemPrompt) {
      forkParentSystemPrompt = toolUseContext.renderedSystemPrompt
    } else {
      const mainThreadAgentDefinition = appState.agent
        ? appState.agentDefinitions.activeAgents.find(
            a => a.agentType === appState.agent,
          )
        : undefined
      const additionalWorkingDirectories = Array.from(
        appState.toolPermissionContext.additionalWorkingDirectories.keys(),
      )
      const defaultSystemPrompt = await getSystemPrompt(
        toolUseContext.options.tools,
        toolUseContext.options.mainLoopModel,
        additionalWorkingDirectories,
        toolUseContext.options.mcpClients,
      )
      forkParentSystemPrompt = buildEffectiveSystemPrompt({
        mainThreadAgentDefinition,
        toolUseContext,
        customSystemPrompt: toolUseContext.options.customSystemPrompt,
        defaultSystemPrompt,
        appendSystemPrompt: toolUseContext.options.appendSystemPrompt,
      })
    }
    if (!forkParentSystemPrompt) {
      throw new Error(
        'Cannot resume fork agent: unable to reconstruct parent system prompt',
      )
    }
  }

  // Resolve model for analytics metadata (runAgent resolves its own internally)
  const resolvedAgentModel = getAgentModel(
    selectedAgent.model,
    toolUseContext.options.mainLoopModel,
    undefined,
    permissionMode,
  )

  const workerPermissionContext = {
    ...appState.toolPermissionContext,
    mode: selectedAgent.permissionMode ?? 'acceptEdits',
  }
  const workerTools = isResumedFork
    ? toolUseContext.options.tools
    : assembleToolPool(workerPermissionContext, appState.mcp.tools)

  const currentSessionMode = getCurrentSessionMode()
  const parentTranscriptPath = getTranscriptPath()
  const parentSessionId = getSessionId()
  const sessionStateTracking =
    currentSessionMode === 'agent' || currentSessionMode === 'coordinator'
      ? {
          sessionId: parentSessionId,
          mode: currentSessionMode,
          objective: meta?.description ?? 'Continue current objective',
          statePath: getSessionStatePathFromTranscriptPath(parentTranscriptPath),
        }
      : undefined

  const runAgentParams: Parameters<typeof runAgent>[0] = {
    agentDefinition: selectedAgent,
    promptMessages: [
      ...resumedMessages,
      createUserMessage({ content: prompt }),
    ],
    toolUseContext,
    canUseTool,
    isAsync: true,
    querySource: getQuerySourceForAgent(
      selectedAgent.agentType,
      isBuiltInAgent(selectedAgent),
    ),
    model: undefined,
    // Fork resume: pass parent's system prompt (cache-identical prefix).
    // Non-fork: undefined → runAgent recomputes under wrapWithCwd so
    // getCwd() sees resumedWorktreePath.
    override: isResumedFork
      ? { systemPrompt: forkParentSystemPrompt }
      : undefined,
    availableTools: workerTools,
    // Transcript already contains the parent context slice from the
    // original fork. Re-supplying it would cause duplicate tool_use IDs.
    forkContextMessages: undefined,
    ...(isResumedFork && { useExactTools: true }),
    // Re-persist so metadata survives runAgent's writeAgentMetadata overwrite
    worktreePath: resumedWorktreePath,
    description: meta?.description,
    agentName: meta?.agentName,
    contentReplacementState: resumedReplacementState,
    sessionStateTracking,
  }

  const spawnedAt = new Date().toISOString()
  const agentTranscriptPath = getAgentTranscriptPath(asAgentId(agentId))
  appendSubagentSpawned(parentTranscriptPath, {
    sessionId: parentSessionId,
    agentId: asAgentId(agentId),
    ...(meta?.agentName ? { agentName: meta.agentName } : {}),
    agentType: selectedAgent.agentType,
    description: uiDescription,
    transcriptPath: agentTranscriptPath,
    toolUseId: toolUseContext.toolUseId,
    spawnedAt,
  })
  registerActiveSubagent(agentId, {
    startedAt: startTime,
    toolUseId: toolUseContext.toolUseId,
    transcriptPath: agentTranscriptPath,
    agentType: selectedAgent.agentType,
    description: uiDescription,
    sessionId: parentSessionId,
  })

  // Restore the friendly name in case this resume is happening after task
  // eviction or session restore, when the live registry may be empty.
  if (meta?.agentName) {
    rootSetAppState(prev => {
      const next = new Map(prev.agentNameRegistry)
      next.set(meta.agentName!, asAgentId(agentId))
      return {
        ...prev,
        agentNameRegistry: next,
      }
    })
  }
  const agentBackgroundTask = registerAsyncAgent({
    agentId,
    description: uiDescription,
    prompt,
    selectedAgent,
    agentName: meta?.agentName,
    setAppState: rootSetAppState,
    toolUseId: toolUseContext.toolUseId,
  })
  markAgentTaskResumed(agentId, rootSetAppState)

  const metadata = {
    prompt,
    resolvedAgentModel,
    isBuiltInAgent: isBuiltInAgent(selectedAgent),
    startTime,
    agentType: selectedAgent.agentType,
    isAsync: true,
  }

  const asyncAgentContext = {
    agentId,
    parentSessionId: getParentSessionId(),
    agentType: 'subagent' as const,
    subagentName: selectedAgent.agentType,
    isBuiltIn: isBuiltInAgent(selectedAgent),
    invokingRequestId,
    invocationKind: 'resume' as const,
    invocationEmitted: false,
  }

  const wrapWithCwd = <T>(fn: () => T): T =>
    resumedWorktreePath ? runWithCwdOverride(resumedWorktreePath, fn) : fn()

  void runWithAgentContext(asyncAgentContext, () =>
    wrapWithCwd(() =>
      runAsyncAgentLifecycle({
        taskId: agentBackgroundTask.agentId,
        abortController: agentBackgroundTask.abortController!,
        makeStream: onCacheSafeParams =>
          runAgent({
            ...runAgentParams,
            override: {
              ...runAgentParams.override,
              agentId: asAgentId(agentBackgroundTask.agentId),
              abortController: agentBackgroundTask.abortController!,
            },
            onCacheSafeParams,
          }),
        metadata: {
          ...metadata,
          ...(meta?.agentName ? { agentName: meta.agentName } : {}),
        },
        description: uiDescription,
        toolUseContext,
        rootSetAppState,
        agentIdForCleanup: agentId,
        enableSummarization:
          isCoordinatorMode() ||
          isForkSubagentEnabled() ||
          getSdkAgentProgressSummariesEnabled(),
        getWorktreeResult: async () =>
          resumedWorktreePath ? { worktreePath: resumedWorktreePath } : {},
        parentTranscriptPath,
        parentSessionId,
        sessionStateTracking: runAgentParams.sessionStateTracking,
      }),
    ),
  )

  return {
    agentId,
    description: uiDescription,
    outputFile: getTaskOutputPath(agentId),
  }
}
