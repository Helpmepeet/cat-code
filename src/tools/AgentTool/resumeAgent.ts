import { promises as fsp } from 'fs'
import { isAbsolute } from 'path'
import { getSdkAgentProgressSummariesEnabled, getSessionId } from '../../bootstrap/state.js'
import { getSessionStatePathFromTranscriptPath } from '../../utils/workerState.js'
import { getCurrentSessionMode } from '../../coordinator/coordinatorMode.js'
import { getSystemPrompt } from '../../constants/prompts.js'
import { isCoordinatorMode } from '../../coordinator/coordinatorMode.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { ToolUseContext } from '../../Tool.js'
import { registerActiveSubagent } from '../../utils/cleanupRegistry.js'
import {
  isLocalAgentTask,
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
import { pathInAllowedWorkingPath } from '../../utils/permissions/filesystem.js'
import { runAsyncAgentLifecycle } from './agentToolUtils.js'
import {
  acquireAgentLifecycleOwnership,
  releaseAgentLifecycleOwnership,
  type AgentLifecycleOwnership,
} from './agentLifecycleOwnership.js'
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

export async function resumeAgentBackground(
  args: ResumeAgentBackgroundArgs,
): Promise<ResumeAgentResult> {
  const lifecycleOwnership = acquireAgentLifecycleOwnership(args.agentId)
  if (!lifecycleOwnership) {
    throw new AgentResumeInProgressError(args.agentId)
  }
  let ownershipTransferred = false
  try {
    return await resumeAgentBackgroundLocked(args, lifecycleOwnership, lifecycle => {
      ownershipTransferred = true
      const release = () => {
        releaseAgentLifecycleOwnership(lifecycleOwnership)
      }
      void lifecycle.then(release, release)
    })
  } finally {
    if (!ownershipTransferred) {
      releaseAgentLifecycleOwnership(lifecycleOwnership)
    }
  }
}

async function resumeAgentBackgroundLocked(
  {
    agentId,
    prompt,
    toolUseContext,
    canUseTool,
    invokingRequestId,
    sourceSessionId,
  }: ResumeAgentBackgroundArgs,
  lifecycleOwnership: AgentLifecycleOwnership,
  onLifecycleStarted: (lifecycle: Promise<void>) => void,
): Promise<ResumeAgentResult> {
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
  const resumedCwd = meta?.assignedCwd
    ? await fsp.stat(meta.assignedCwd).then(
        s => {
          if (!s.isDirectory()) {
            throw new Error(
              `Cannot resume agent ${agentId}: recorded cwd ${meta.assignedCwd} is not a directory.`,
            )
          }
          if (!isAbsolute(meta.assignedCwd)) {
            throw new Error(
              `Cannot resume agent ${agentId}: recorded cwd ${meta.assignedCwd} is not an absolute path.`,
            )
          }
          if (!pathInAllowedWorkingPath(meta.assignedCwd, appState.toolPermissionContext)) {
            throw new Error(
              `Cannot resume agent ${agentId}: recorded cwd ${meta.assignedCwd} is outside allowed working directories.`,
            )
          }
          return meta.assignedCwd
        },
        () => {
          throw new Error(
            `Cannot resume agent ${agentId}: recorded cwd ${meta.assignedCwd} no longer exists.`,
          )
        },
      )
    : undefined
  if (meta?.assignedCwd !== undefined && meta.worktreePath !== undefined) {
    throw new Error(
      `Cannot resume agent ${agentId}: recorded metadata includes both assignedCwd and worktreePath.`,
    )
  }
  // Fail closed if the originally recorded worktree path disappeared. Falling
  // back to the parent cwd could run the resumed worker in the wrong tree.
  const resumedWorktreePath = meta?.worktreePath
    ? await fsp.stat(meta.worktreePath).then(
        s => {
          if (!s.isDirectory()) {
            throw new Error(
              `Cannot resume agent ${agentId}: recorded worktree ${meta.worktreePath} is not a directory.`,
            )
          }
          return meta.worktreePath
        },
        () => {
          throw new Error(
            `Cannot resume agent ${agentId}: recorded worktree ${meta.worktreePath} no longer exists.`,
          )
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
        toolUseContext.options.mainLoopProvider,
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
  const mcpRuntimeSnapshot = isResumedFork
    ? undefined
    : toolUseContext.options.getMcpRuntimeSnapshot?.()
  const workerTools = isResumedFork
    ? toolUseContext.options.tools
    : assembleToolPool(
        workerPermissionContext,
        mcpRuntimeSnapshot?.tools ?? appState.mcp.tools,
      )

  const currentSessionMode = getCurrentSessionMode()
  const parentTranscriptPath = getTranscriptPath()
  const parentSessionId = getSessionId()
  const sessionStateTracking =
    currentSessionMode === 'coordinator'
      ? {
          sessionId: parentSessionId,
          mode: currentSessionMode,
          statePath: getSessionStatePathFromTranscriptPath(parentTranscriptPath),
        }
      : undefined

  const runAgentParams: Parameters<typeof runAgent>[0] = {
    agentDefinition: selectedAgent,
    promptMessages: [
      ...resumedMessages,
      createUserMessage({ content: prompt }),
    ],
    ...(resumedMessages.length > 0
      ? { seededMessagesForPersistence: resumedMessages }
      : {}),
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
    mcpRuntimeSnapshot,
    ...(isResumedFork && {
      mcpRuntimeInputs: {
        tools: toolUseContext.options.tools,
        commands: toolUseContext.options.commands,
        mcpClients: toolUseContext.options.mcpClients,
        mcpResources: toolUseContext.options.mcpResources,
      },
    }),
    // Transcript already contains the parent context slice from the
    // original fork. Re-supplying it would cause duplicate tool_use IDs.
    forkContextMessages: undefined,
    ...(isResumedFork && { useExactTools: true }),
    // Re-persist so metadata survives runAgent's writeAgentMetadata overwrite
    ...(resumedCwd !== undefined ? { cwd: resumedCwd } : {}),
    worktreePath: resumedWorktreePath,
    description: meta?.description,
    agentName: meta?.agentName,
    contentReplacementState: resumedReplacementState,
    sessionStateTracking,
  }

  // Fresh-read root state right before committing this resume's side
  // effects. The transcript/metadata/worktree I/O above can take long
  // enough for the same task to have already been registered as running by
  // another path (a concurrent resume that reached here first, or the task
  // simply having started running through some other route). The
  // activeResumeLifecycles set only guards concurrent resumeAgentBackground
  // callers for this exact agentId; this check supplements it rather than
  // replacing it.
  const freshTask = toolUseContext.getAppState().tasks[agentId]
  if (isLocalAgentTask(freshTask) && freshTask.status === 'running') {
    throw new AgentResumeInProgressError(agentId)
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

  const resumedWorkingDirectory = resumedCwd ?? resumedWorktreePath
  const wrapWithCwd = <T>(fn: () => T): T =>
    resumedWorkingDirectory
      ? runWithCwdOverride(resumedWorkingDirectory, fn)
      : fn()

  // Capture the detached lifecycle promise (rather than fire-and-forgetting
  // it with `void`) and hand it to the caller's ownership-transfer callback
  // before returning, so activeResumeLifecycles stays held until this
  // background run actually settles.
  const lifecycle = runWithAgentContext(asyncAgentContext, () =>
    wrapWithCwd(() =>
      runAsyncAgentLifecycle({
        taskId: agentBackgroundTask.agentId,
        abortController: agentBackgroundTask.abortController!,
        runId: agentBackgroundTask.runId,
        makeStream: onCacheSafeParams =>
          runAgent({
            ...runAgentParams,
            override: {
              ...runAgentParams.override,
              agentId: asAgentId(agentBackgroundTask.agentId),
              agentRunId: agentBackgroundTask.runId,
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
        lifecycleOwnership,
      }),
    ),
  )
  onLifecycleStarted(lifecycle)

  return {
    agentId,
    description: uiDescription,
    outputFile: getTaskOutputPath(agentId),
  }
}
