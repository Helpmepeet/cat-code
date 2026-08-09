/**
 * In-process teammate runner
 *
 * Wraps runAgent() for in-process teammates, providing:
 * - AsyncLocalStorage-based context isolation via runWithTeammateContext()
 * - Progress tracking and AppState updates
 * - Idle notification to leader when complete
 * - Plan mode approval flow support
 * - Cleanup on completion or abort
 */

import { feature } from 'bun:bundle'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { getSystemPrompt } from '../../constants/prompts.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import {
  processMailboxPermissionResponse,
  registerPermissionCallback,
  unregisterPermissionCallback,
} from '../../hooks/useSwarmPermissionPoller.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { getAutoCompactThreshold } from '../../services/compact/autoCompact.js'
import {
  buildPostCompactMessages,
  compactConversation,
  ERROR_MESSAGE_USER_ABORT,
} from '../../services/compact/compact.js'
import { resetMicrocompactState } from '../../services/compact/microCompact.js'
import type { AppState } from '../../state/AppState.js'
import type { Tool, Tools, ToolUseContext } from '../../Tool.js'
import { appendTeammateMessage } from '../../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import type {
  InProcessTeammateTaskState,
  TeammateIdentity,
} from '../../tasks/InProcessTeammateTask/types.js'
import { appendCappedMessage } from '../../tasks/InProcessTeammateTask/types.js'
import {
  createActivityDescriptionResolver,
  createProgressTracker,
  getProgressUpdate,
  updateProgressFromMessage,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { CustomAgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { resolveAgentTools } from '../../tools/AgentTool/agentToolUtils.js'
import { runAgent } from '../../tools/AgentTool/runAgent.js'
import { awaitClassifierAutoApproval } from '../../tools/BashTool/bashPermissions.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { SEND_MESSAGE_TOOL_NAME } from '../../tools/SendMessageTool/constants.js'
import { TASK_CREATE_TOOL_NAME } from '../../tools/TaskCreateTool/constants.js'
import { TASK_GET_TOOL_NAME } from '../../tools/TaskGetTool/constants.js'
import { TASK_LIST_TOOL_NAME } from '../../tools/TaskListTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from '../../tools/TaskUpdateTool/constants.js'
import { TEAM_CREATE_TOOL_NAME } from '../../tools/TeamCreateTool/constants.js'
import { TEAM_DELETE_TOOL_NAME } from '../../tools/TeamDeleteTool/constants.js'
import type { Message } from '../../types/message.js'
import type { PermissionDecision } from '../../types/permissions.js'
import {
  createAssistantAPIErrorMessage,
  createUserMessage,
} from '../../utils/messages.js'
import { evictTaskOutput } from '../../utils/task/diskOutput.js'
import { evictTerminalTask } from '../../utils/task/framework.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import { createAbortController } from '../abortController.js'
import { type AgentContext, runWithAgentContext } from '../agentContext.js'
import { count } from '../array.js'
import { logForDebugging } from '../debug.js'
import { cloneFileStateCache } from '../fileStateCache.js'
import {
  SUBAGENT_REJECT_MESSAGE,
  SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX,
} from '../messages.js'
import type { ModelAlias } from '../model/aliases.js'
import { getProviderForModel, type APIProvider } from '../model/providers.js'
import {
  applyPermissionUpdates,
  persistPermissionUpdates,
} from '../permissions/PermissionUpdate.js'
import type { PermissionUpdate } from '../permissions/PermissionUpdateSchema.js'
import { hasPermissionsToUseTool } from '../permissions/permissions.js'
import { emitTaskTerminatedSdk } from '../sdkEventQueue.js'
import { sleep } from '../sleep.js'
import { jsonStringify } from '../slowOperations.js'
import { asSystemPrompt } from '../systemPromptType.js'
import { claimTask, listTasks, type Task, updateTask } from '../tasks.js'
import type { TeammateContext } from '../teammateContext.js'
import { runWithTeammateContext } from '../teammateContext.js'
import {
  acknowledgeMailboxMessages,
  classifyMailboxMessage,
  createIdleNotification,
  getLastPeerDmSummary,
  type IdleNotificationMessage,
  isPermissionResponse,
  isShutdownRequest,
  type MailboxSignature,
  markMessageAsReadByIndex,
  readMailbox,
  readMailboxIfChanged,
  resolveTeamPrincipalByName,
  type ShutdownRequestMessage,
  type TeamPrincipal,
  writeToMailbox,
} from '../teammateMailbox.js'
import { readTeamSnapshot, type TeamFile } from './teamHelpers.js'
import {
  formatTeammateMessagesForModel,
  serializeTeammateMessage,
  type TeammateMessageContract,
} from '../teammateMessage.js'
import { unregisterAgent as unregisterPerfettoAgent } from '../telemetry/perfettoTracing.js'
import { createContentReplacementState } from '../toolResultStorage.js'
import { TEAM_LEAD_NAME } from './constants.js'
import {
  getLeaderSetToolPermissionContext,
  getLeaderToolUseConfirmQueue,
} from './leaderPermissionBridge.js'
import {
  createPermissionRequest,
  sendPermissionRequestViaMailbox,
} from './permissionSync.js'
import { TEAMMATE_SYSTEM_PROMPT_ADDENDUM } from './teammatePromptAddendum.js'

type SetAppStateFn = (updater: (prev: AppState) => AppState) => void

const PERMISSION_POLL_INTERVAL_MS = 500
const PERMISSION_RESPONSE_TIMEOUT_MS = 60_000
const PERMISSION_REQUEST_DELIVERY_FAILURE_MESSAGE =
  'Permission request could not be delivered to the team leader.'
const PERMISSION_RESPONSE_TIMEOUT_MESSAGE =
  'Timed out waiting for the team leader to respond to the permission request.'
const IDLE_POLL_INTERVAL_MS = 500
const IDLE_POLL_MAX_INTERVAL_MS = 2000
const IDLE_POLL_FAST_EMPTY_POLLS = 2

/**
 * Creates a canUseTool function for in-process teammates that properly resolves
 * 'ask' permissions via the UI rather than treating them as denials.
 *
 * Always uses the leader's ToolUseConfirm dialog with a worker badge when
 * the bridge is available, giving teammates the same tool-specific UI
 * (BashPermissionRequest, FileEditToolDiff, etc.) as the leader's own tools.
 *
 * Falls back to the mailbox system when the bridge is unavailable:
 * sends a permission request to the leader's inbox, waits for the response
 * in the teammate's own mailbox.
 */
function createInProcessCanUseTool(
  identity: TeammateIdentity,
  abortController: AbortController,
  onPermissionWaitMs?: (waitMs: number) => void,
  permissionResponseTimeoutMs = PERMISSION_RESPONSE_TIMEOUT_MS,
): CanUseToolFn {
  return async (
    tool,
    input,
    toolUseContext,
    assistantMessage,
    toolUseID,
    forceDecision,
  ) => {
    const result =
      forceDecision ??
      (await hasPermissionsToUseTool(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseID,
      ))

    // Pass through allow/deny decisions directly
    if (result.behavior !== 'ask') {
      return result
    }

    // For bash commands, try classifier auto-approval before showing leader dialog.
    // Agents await the classifier result (rather than racing it against user
    // interaction like the main agent).
    if (
      feature('BASH_CLASSIFIER') &&
      tool.name === BASH_TOOL_NAME &&
      result.pendingClassifierCheck
    ) {
      const classifierDecision = await awaitClassifierAutoApproval(
        result.pendingClassifierCheck,
        abortController.signal,
        toolUseContext.options.isNonInteractiveSession,
      )
      if (classifierDecision) {
        return {
          behavior: 'allow',
          updatedInput: input as Record<string, unknown>,
          decisionReason: classifierDecision,
        }
      }
    }

    // Check if aborted before showing UI
    if (abortController.signal.aborted) {
      return { behavior: 'ask', message: SUBAGENT_REJECT_MESSAGE }
    }

    const appState = toolUseContext.getAppState()

    const description = await (tool as Tool).description(input as never, {
      isNonInteractiveSession: toolUseContext.options.isNonInteractiveSession,
      toolPermissionContext: appState.toolPermissionContext,
      tools: toolUseContext.options.tools,
    })

    if (abortController.signal.aborted) {
      return { behavior: 'ask', message: SUBAGENT_REJECT_MESSAGE }
    }

    const setToolUseConfirmQueue = getLeaderToolUseConfirmQueue()

    // Standard path: use ToolUseConfirm dialog with worker badge
    if (setToolUseConfirmQueue) {
      return new Promise<PermissionDecision>(resolve => {
        let decisionMade = false
        const permissionStartMs = Date.now()

        // Report permission wait time to the caller so it can be
        // subtracted from the displayed elapsed time.
        const reportPermissionWait = () => {
          onPermissionWaitMs?.(Date.now() - permissionStartMs)
        }

        const onAbortListener = () => {
          if (decisionMade) return
          decisionMade = true
          reportPermissionWait()
          resolve({ behavior: 'ask', message: SUBAGENT_REJECT_MESSAGE })
          setToolUseConfirmQueue(queue =>
            queue.filter(item => item.toolUseID !== toolUseID),
          )
        }

        abortController.signal.addEventListener('abort', onAbortListener, {
          once: true,
        })

        setToolUseConfirmQueue(queue => [
          ...queue,
          {
            assistantMessage,
            tool: tool as Tool,
            description,
            input,
            toolUseContext,
            toolUseID,
            permissionResult: result,
            permissionPromptStartTimeMs: permissionStartMs,
            workerBadge: identity.color
              ? { name: identity.agentName, color: identity.color }
              : undefined,
            onUserInteraction() {
              // No-op for teammates (no classifier auto-approval)
            },
            onAbort() {
              if (decisionMade) return
              decisionMade = true
              abortController.signal.removeEventListener(
                'abort',
                onAbortListener,
              )
              reportPermissionWait()
              resolve({ behavior: 'ask', message: SUBAGENT_REJECT_MESSAGE })
            },
            async onAllow(
              updatedInput: Record<string, unknown>,
              permissionUpdates: PermissionUpdate[],
              feedback?: string,
              contentBlocks?: ContentBlockParam[],
            ) {
              if (decisionMade) return
              decisionMade = true
              abortController.signal.removeEventListener(
                'abort',
                onAbortListener,
              )
              reportPermissionWait()
              persistPermissionUpdates(permissionUpdates)
              // Write back permission updates to the leader's shared context
              if (permissionUpdates.length > 0) {
                const setToolPermissionContext =
                  getLeaderSetToolPermissionContext()
                if (setToolPermissionContext) {
                  const currentAppState = toolUseContext.getAppState()
                  const updatedContext = applyPermissionUpdates(
                    currentAppState.toolPermissionContext,
                    permissionUpdates,
                  )
                  // Preserve the leader's mode to prevent workers'
                  // transformed 'acceptEdits' context from leaking back
                  // to the coordinator
                  setToolPermissionContext(updatedContext, {
                    preserveMode: true,
                  })
                }
              }
              const trimmedFeedback = feedback?.trim()
              resolve({
                behavior: 'allow',
                updatedInput,
                userModified: false,
                acceptFeedback: trimmedFeedback || undefined,
                ...(contentBlocks &&
                  contentBlocks.length > 0 && { contentBlocks }),
              })
            },
            onReject(feedback?: string, contentBlocks?: ContentBlockParam[]) {
              if (decisionMade) return
              decisionMade = true
              abortController.signal.removeEventListener(
                'abort',
                onAbortListener,
              )
              reportPermissionWait()
              const message = feedback
                ? `${SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX}${feedback}`
                : SUBAGENT_REJECT_MESSAGE
              resolve({ behavior: 'ask', message, contentBlocks })
            },
            async recheckPermission() {
              if (decisionMade) return
              const freshResult = await hasPermissionsToUseTool(
                tool,
                input,
                toolUseContext,
                assistantMessage,
                toolUseID,
              )
              if (freshResult.behavior === 'allow') {
                decisionMade = true
                abortController.signal.removeEventListener(
                  'abort',
                  onAbortListener,
                )
                reportPermissionWait()
                setToolUseConfirmQueue(queue =>
                  queue.filter(item => item.toolUseID !== toolUseID),
                )
                resolve({
                  ...freshResult,
                  updatedInput: input,
                  userModified: false,
                })
              }
            },
          },
        ])
      })
    }

    // Fallback: use mailbox system when leader UI queue is unavailable
    return new Promise<PermissionDecision>(resolve => {
      let settled = false
      let pollInterval: ReturnType<typeof setInterval> | undefined
      let responseTimeout: ReturnType<typeof setTimeout> | undefined

      const settle = (decision: PermissionDecision) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(decision)
      }

      const request = createPermissionRequest({
        toolName: (tool as Tool).name,
        toolUseId: toolUseID,
        input,
        description,
        permissionSuggestions: result.suggestions,
        workerId: identity.agentId,
        workerName: identity.agentName,
        workerColor: identity.color,
        teamName: identity.teamName,
      })

      // Register callback to be invoked when the leader responds
      registerPermissionCallback({
        requestId: request.id,
        toolUseId: toolUseID,
        onAllow(
          updatedInput: Record<string, unknown> | undefined,
          permissionUpdates: PermissionUpdate[],
          _feedback?: string,
          contentBlocks?: ContentBlockParam[],
        ) {
          if (settled) return
          persistPermissionUpdates(permissionUpdates)
          const finalInput =
            updatedInput && Object.keys(updatedInput).length > 0
              ? updatedInput
              : input
          settle({
            behavior: 'allow',
            updatedInput: finalInput,
            userModified: false,
            ...(contentBlocks && contentBlocks.length > 0 && { contentBlocks }),
          })
        },
        onReject(feedback?: string, contentBlocks?: ContentBlockParam[]) {
          if (settled) return
          const message = feedback
            ? `${SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX}${feedback}`
            : SUBAGENT_REJECT_MESSAGE
          settle({ behavior: 'ask', message, contentBlocks })
        },
      })

      // Poll teammate's mailbox for the response
      pollInterval = setInterval(async () => {
        if (abortController.signal.aborted) {
          settle({ behavior: 'ask', message: SUBAGENT_REJECT_MESSAGE })
          return
        }

        const allMessages = await readMailbox(
          identity.agentName,
          identity.teamName,
        )
        for (let i = 0; i < allMessages.length; i++) {
          const msg = allMessages[i]
          if (msg && !msg.read) {
            const parsed = isPermissionResponse(msg.text)
            if (parsed && parsed.request_id === request.id) {
              await markMessageAsReadByIndex(
                identity.agentName,
                identity.teamName,
                i,
              )
              if (parsed.subtype === 'success') {
                processMailboxPermissionResponse({
                  requestId: parsed.request_id,
                  decision: 'approved',
                  updatedInput: parsed.response?.updated_input,
                  permissionUpdates: parsed.response?.permission_updates,
                })
              } else {
                processMailboxPermissionResponse({
                  requestId: parsed.request_id,
                  decision: 'rejected',
                  feedback: parsed.error,
                })
              }
              return // Callback already resolves the promise
            }
          }
        }
      }, PERMISSION_POLL_INTERVAL_MS)

      const onAbortListener = () => {
        settle({ behavior: 'ask', message: SUBAGENT_REJECT_MESSAGE })
      }

      abortController.signal.addEventListener('abort', onAbortListener, {
        once: true,
      })

      responseTimeout = setTimeout(() => {
        settle({
          behavior: 'ask',
          message: PERMISSION_RESPONSE_TIMEOUT_MESSAGE,
        })
      }, permissionResponseTimeoutMs)
      responseTimeout.unref?.()

      // Start delivery only after polling and cancellation are armed. If the
      // control write fails, there is no mailbox record or retry path, so end
      // the permission wait immediately instead of polling indefinitely.
      void sendPermissionRequestViaMailbox(request).then(sent => {
        if (sent) return
        settle({
          behavior: 'ask',
          message: PERMISSION_REQUEST_DELIVERY_FAILURE_MESSAGE,
        })
      })

      function cleanup() {
        if (pollInterval) clearInterval(pollInterval)
        if (responseTimeout) clearTimeout(responseTimeout)
        unregisterPermissionCallback(request.id)
        abortController.signal.removeEventListener('abort', onAbortListener)
      }
    })
  }
}

function createTeammateMessage(
  from: string,
  text: string,
  color?: string,
  summary?: string,
): TeammateMessageContract {
  return {
    kind: 'teammate',
    from,
    text,
    color,
    summary,
  }
}

function formatAsTranscriptTeammateMessage(
  from: string,
  text: string,
  color?: string,
  summary?: string,
  provider?: APIProvider,
): string {
  return serializeTeammateMessage(
    createTeammateMessage(from, text, color, summary),
    provider === 'openai' ? 'openai' : 'claude',
  )
}

/**
 * Configuration for running an in-process teammate.
 */
export type InProcessRunnerConfig = {
  /** Teammate identity for context */
  identity: TeammateIdentity
  /** Task ID in AppState */
  taskId: string
  /** Initial prompt for the teammate */
  prompt: string
  /** Optional agent definition (for specialized agents) */
  agentDefinition?: CustomAgentDefinition
  /** Teammate context for AsyncLocalStorage */
  teammateContext: TeammateContext
  /** Parent's tool use context */
  toolUseContext: ToolUseContext
  /** Abort controller linked to parent */
  abortController: AbortController
  /** Optional model override for this teammate */
  model?: string
  /** Optional system prompt override for this teammate */
  systemPrompt?: string
  /** How to apply the system prompt: 'replace' or 'append' to default */
  systemPromptMode?: 'default' | 'replace' | 'append'
  /** Tool permissions to auto-allow for this teammate */
  allowedTools?: string[]
  /** Whether this teammate can show permission prompts for unlisted tools.
   * When false (default), unlisted tools are auto-denied. */
  allowPermissionPrompts?: boolean
  /** Short description of the task (used as summary for the initial prompt header) */
  description?: string
  /** request_id of the API call that spawned this teammate, for lineage
   *  tracing on tengu_api_* events. */
  invokingRequestId?: string
}

/**
 * Result from running an in-process teammate.
 */
export type InProcessRunnerResult = {
  /** Whether the run completed successfully */
  success: boolean
  /** Error message if failed */
  error?: string
  /** Messages produced by the agent */
  messages: Message[]
}

/**
 * Updates task state in AppState.
 */
function updateTaskState(
  taskId: string,
  updater: (task: InProcessTeammateTaskState) => InProcessTeammateTaskState,
  setAppState: SetAppStateFn,
): void {
  setAppState(prev => {
    const task = prev.tasks[taskId]
    if (!task || task.type !== 'in_process_teammate') {
      return prev
    }
    const updated = updater(task)
    if (updated === task) {
      return prev
    }
    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [taskId]: updated,
      },
    }
  })
}

/**
 * Sends a message to the leader's file-based mailbox.
 * Uses the same mailbox system as tmux teammates for consistency.
 */
async function sendMessageToLeader(
  from: string,
  text: string,
  color: string | undefined,
  teamName: string,
  notification?: IdleNotificationMessage,
): Promise<void> {
  await writeToMailbox(
    TEAM_LEAD_NAME,
    {
      from,
      text,
      timestamp: new Date().toISOString(),
      color,
      ...(notification
        ? { payloadClass: 'notification' as const, notification }
        : {}),
    },
    teamName,
  )
}

/**
 * Sends idle notification to the leader via file-based mailbox.
 * Uses agentName (not agentId) for consistency with process-based teammates.
 * idle_notification "remains a notification with its existing behavior"
 * (Design Decisions) — explicit typed `notification` payload alongside the
 * existing `text`, still on the legacy positional write path.
 */
async function sendIdleNotification(
  agentName: string,
  agentColor: string | undefined,
  teamName: string,
  options?: {
    idleReason?: 'available' | 'interrupted' | 'failed'
    summary?: string
    completedTaskId?: string
    completedStatus?: 'resolved' | 'blocked' | 'failed'
    failureReason?: string
  },
): Promise<void> {
  const notification = createIdleNotification(agentName, options)

  await sendMessageToLeader(
    agentName,
    jsonStringify(notification),
    agentColor,
    teamName,
    notification,
  )
}

/**
 * Find an available task from the team's task list.
 * A task is available if it's pending, has no owner, and is not blocked.
 */
function findAvailableTask(tasks: Task[]): Task | undefined {
  const unresolvedTaskIds = new Set(
    tasks.filter(t => t.status !== 'completed').map(t => t.id),
  )

  return tasks.find(task => {
    if (task.status !== 'pending') return false
    if (task.owner) return false
    return task.blockedBy.every(id => !unresolvedTaskIds.has(id))
  })
}

/**
 * Format a task as a prompt for the teammate to work on.
 */
function formatTaskAsPrompt(task: Task): string {
  let prompt = `Complete all open tasks. Start with task #${task.id}: \n\n ${task.subject}`

  if (task.description) {
    prompt += `\n\n${task.description}`
  }

  return prompt
}

/**
 * Try to claim an available task from the team's task list.
 * Returns the formatted prompt if a task was claimed, or undefined if none available.
 */
async function tryClaimNextTask(
  taskListId: string,
  agentName: string,
): Promise<string | undefined> {
  try {
    const tasks = await listTasks(taskListId)
    const availableTask = findAvailableTask(tasks)

    if (!availableTask) {
      return undefined
    }

    const result = await claimTask(taskListId, availableTask.id, agentName)

    if (!result.success) {
      logForDebugging(
        `[inProcessRunner] Failed to claim task #${availableTask.id}: ${result.reason}`,
      )
      return undefined
    }

    // Also set status to in_progress so the UI reflects it immediately
    await updateTask(taskListId, availableTask.id, { status: 'in_progress' })

    logForDebugging(
      `[inProcessRunner] Claimed task #${availableTask.id}: ${availableTask.subject}`,
    )

    return formatTaskAsPrompt(availableTask)
  } catch (err) {
    logForDebugging(`[inProcessRunner] Error checking task list: ${err}`)
    return undefined
  }
}

function getIdlePollDelayMs(consecutiveEmptyPolls: number): number {
  const backoffSteps = Math.max(
    0,
    consecutiveEmptyPolls - IDLE_POLL_FAST_EMPTY_POLLS,
  )
  return Math.min(
    IDLE_POLL_MAX_INTERVAL_MS,
    IDLE_POLL_INTERVAL_MS * 2 ** backoffSteps,
  )
}

/**
 * Result of waiting for messages.
 */
type WaitResult =
  | {
      type: 'shutdown_request'
      request: ReturnType<typeof isShutdownRequest>
      originalMessage: string
    }
  | {
      type: 'new_message'
      message: string
      from: string
      color?: string
      summary?: string
    }
  | {
      type: 'aborted'
    }

type IdleWaitDeps = {
  sleep: typeof sleep
  readMailboxIfChanged: typeof readMailboxIfChanged
  markMessageAsReadByIndex: typeof markMessageAsReadByIndex
  tryClaimNextTask: typeof tryClaimNextTask
  readTeamSnapshot: typeof readTeamSnapshot
  acknowledgeMailboxMessages: typeof acknowledgeMailboxMessages
}

const defaultIdleWaitDeps: IdleWaitDeps = {
  sleep,
  readMailboxIfChanged,
  markMessageAsReadByIndex,
  tryClaimNextTask,
  readTeamSnapshot,
  acknowledgeMailboxMessages,
}

/**
 * Waits for new prompts or shutdown request.
 * Polls the teammate's mailbox, checking for:
 * - Shutdown request from leader (returned to caller for model decision)
 * - New messages/prompts from leader
 * - Abort signal
 *
 * This keeps the teammate alive in 'idle' state instead of terminating.
 * Does NOT auto-approve shutdown - the model should make that decision.
 */
async function waitForNextPromptOrShutdown(
  identity: TeammateIdentity,
  abortController: AbortController,
  taskId: string,
  getAppState: () => AppState,
  setAppState: SetAppStateFn,
  taskListId: string,
  deps: IdleWaitDeps = defaultIdleWaitDeps,
): Promise<WaitResult> {
  logForDebugging(
    `[inProcessRunner] ${identity.agentName} starting poll loop (abort=${abortController.signal.aborted})`,
  )

  let pollCount = 0
  let consecutiveEmptyPolls = 0
  let mailboxSignature: MailboxSignature | undefined
  while (!abortController.signal.aborted) {
    // Check for in-memory pending messages on every iteration (from transcript viewing)
    const appState = getAppState()
    const task = appState.tasks[taskId]
    if (
      task &&
      task.type === 'in_process_teammate' &&
      task.pendingUserMessages.length > 0
    ) {
      const message = task.pendingUserMessages[0]! // Safe: checked length > 0
      // Pop the message from the queue
      setAppState(prev => {
        const prevTask = prev.tasks[taskId]
        if (!prevTask || prevTask.type !== 'in_process_teammate') {
          return prev
        }
        return {
          ...prev,
          tasks: {
            ...prev.tasks,
            [taskId]: {
              ...prevTask,
              pendingUserMessages: prevTask.pendingUserMessages.slice(1),
            },
          },
        }
      })
      logForDebugging(
        `[inProcessRunner] ${identity.agentName} found pending user message (poll #${pollCount})`,
      )
      return {
        type: 'new_message',
        message,
        from: 'user',
      }
    }

    // Wait before next poll (skip on first iteration to check immediately)
    if (pollCount > 0) {
      await deps.sleep(
        getIdlePollDelayMs(consecutiveEmptyPolls),
        abortController.signal,
      )
    }
    pollCount++

    // Check for abort
    if (abortController.signal.aborted) {
      logForDebugging(
        `[inProcessRunner] ${identity.agentName} aborted while waiting (poll #${pollCount})`,
      )
      return { type: 'aborted' }
    }

    // Check for messages in mailbox
    logForDebugging(
      `[inProcessRunner] ${identity.agentName} poll #${pollCount}: checking mailbox`,
    )
    try {
      // Read all messages and scan unread for shutdown requests first.
      // Shutdown requests are prioritized over regular messages to prevent
      // starvation when peer-to-peer messages flood the queue.
      const mailbox = await deps.readMailboxIfChanged(
        identity.agentName,
        identity.teamName,
        mailboxSignature,
      )
      mailboxSignature = mailbox.signature
      const allMessages = mailbox.changed ? mailbox.messages : []

      // Resolve a versioned snapshot once per poll for authority-checked
      // shutdown detection. `null` (legacy/absent team) falls back to the
      // pre-Task-3 raw isShutdownRequest text-sniff below — no worse than
      // before, and version-2 controls are never accepted against a legacy
      // team anyway (Design Decisions).
      //
      // Resolved by NAME from `identity.agentName` — never
      // `resolveCurrentTeamPrincipal` (which reads getAgentId() off
      // AsyncLocalStorage/dynamicTeamContext). This poll loop runs between
      // `runWithTeammateContext`-wrapped prompt iterations, outside that
      // context's scope, so getAgentId() would silently return undefined
      // and fall back to resolving the LEADER instead of this teammate.
      let snapshot: Readonly<TeamFile> | null = null
      let receiverPrincipal: TeamPrincipal | null = null
      try {
        snapshot = await deps.readTeamSnapshot(identity.teamName)
        receiverPrincipal = resolveTeamPrincipalByName(
          snapshot,
          identity.agentName,
        )
      } catch {
        snapshot = null
        receiverPrincipal = null
      }

      // Scan all unread messages for shutdown requests (highest priority).
      // readMailbox() already reads all messages from disk, so this scan
      // adds only ~1-2ms of JSON parsing overhead. Only a valid LEADER
      // control addressed to THIS teammate's current allocation may return
      // shutdown — a peer's forged/mismatched attempt classifies as
      // invalid_control/protocol_mismatch and is acknowledged (dropped),
      // never treated as shutdown.
      let shutdownIndex = -1
      let shutdownParsed: ShutdownRequestMessage | null = null
      const droppedMessageIds: string[] = []
      for (let i = 0; i < allMessages.length; i++) {
        const m = allMessages[i]
        if (!m || m.read) continue

        // No usable version-2 snapshot at all (legacy/absent team) — fall
        // back to the pre-Task-3 raw text-sniff. This is distinct from "the
        // sender name isn't in the roster": an unresolvable SENDER with a
        // perfectly good snapshot must never fall back to trusting raw text
        // (that would let an unregistered/forged `from` bypass authority
        // entirely) — it's simply not a valid shutdown, full stop.
        if (!snapshot || !receiverPrincipal) {
          const parsed = isShutdownRequest(m.text)
          if (parsed) {
            shutdownIndex = i
            shutdownParsed = parsed
            break
          }
          continue
        }

        const senderPrincipal = resolveTeamPrincipalByName(snapshot, m.from)
        if (!senderPrincipal) continue

        const classified = classifyMailboxMessage({
          message: m,
          sender: senderPrincipal,
          receiver: receiverPrincipal,
          pendingControls: snapshot.pendingControls ?? [],
        })

        if (
          classified.kind === 'control' &&
          classified.control.type === 'shutdown_request'
        ) {
          shutdownIndex = i
          shutdownParsed = classified.control
          break
        }
        if (
          classified.kind === 'invalid_control' ||
          classified.kind === 'protocol_mismatch'
        ) {
          logForDebugging(
            `[inProcessRunner] ${identity.agentName} dropping ${classified.kind} message from ${m.from}: ${classified.reason}`,
          )
          if (m.messageId) droppedMessageIds.push(m.messageId)
        }
      }

      if (droppedMessageIds.length > 0 && receiverPrincipal) {
        await deps
          .acknowledgeMailboxMessages({
            recipient: receiverPrincipal,
            teamName: identity.teamName,
            messageIds: droppedMessageIds,
          })
          .catch(() => {})
      }

      if (shutdownIndex !== -1) {
        const msg = allMessages[shutdownIndex]!
        const skippedUnread = count(
          allMessages.slice(0, shutdownIndex),
          m => !m.read,
        )
        logForDebugging(
          `[inProcessRunner] ${identity.agentName} received shutdown request from ${shutdownParsed?.from} (prioritized over ${skippedUnread} unread messages)`,
        )
        await deps.markMessageAsReadByIndex(
          identity.agentName,
          identity.teamName,
          shutdownIndex,
        )
        return {
          type: 'shutdown_request',
          request: shutdownParsed,
          originalMessage: msg.text,
        }
      }

      // No shutdown request found. Prioritize team-lead messages over peer
      // messages — the leader represents user intent and coordination, so
      // their messages should not be starved behind peer-to-peer chatter.
      // Fall back to FIFO for peer messages.
      let selectedIndex = -1

      // Check for unread team-lead messages first
      for (let i = 0; i < allMessages.length; i++) {
        const m = allMessages[i]
        if (m && !m.read && m.from === TEAM_LEAD_NAME) {
          selectedIndex = i
          break
        }
      }

      // Fall back to first unread message (any sender)
      if (selectedIndex === -1) {
        selectedIndex = allMessages.findIndex(m => !m.read)
      }

      if (selectedIndex !== -1) {
        const msg = allMessages[selectedIndex]
        if (msg) {
          logForDebugging(
            `[inProcessRunner] ${identity.agentName} received new message from ${msg.from} (index ${selectedIndex})`,
          )
          await deps.markMessageAsReadByIndex(
            identity.agentName,
            identity.teamName,
            selectedIndex,
          )
          return {
            type: 'new_message',
            message: msg.text,
            from: msg.from,
            color: msg.color,
            summary: msg.summary,
          }
        }
      }
    } catch (err) {
      logForDebugging(
        `[inProcessRunner] ${identity.agentName} poll error: ${err}`,
      )
      // Continue polling even if one read fails
    }

    // Check the team's task list for unclaimed tasks
    const taskPrompt = await deps.tryClaimNextTask(
      taskListId,
      identity.agentName,
    )
    if (taskPrompt) {
      return {
        type: 'new_message',
        message: taskPrompt,
        from: 'task-list',
      }
    }
    consecutiveEmptyPolls++
  }

  logForDebugging(
    `[inProcessRunner] ${identity.agentName} exiting poll loop (abort=${abortController.signal.aborted}, polls=${pollCount})`,
  )
  return { type: 'aborted' }
}

export function waitForNextPromptOrShutdownForTest(params: {
  identity: TeammateIdentity
  abortController: AbortController
  taskId: string
  getAppState: () => AppState
  setAppState: SetAppStateFn
  taskListId: string
  deps: IdleWaitDeps
}): Promise<WaitResult> {
  return waitForNextPromptOrShutdown(
    params.identity,
    params.abortController,
    params.taskId,
    params.getAppState,
    params.setAppState,
    params.taskListId,
    params.deps,
  )
}

export type InProcessRuntimeDeps = {
  getSystemPrompt: typeof getSystemPrompt
}

const defaultInProcessRuntimeDeps: InProcessRuntimeDeps = {
  getSystemPrompt,
}

type InProcessRuntime = {
  /** The teammate's actual resolved tool pool — same array used to build
   * `systemPrompt` below and passed to runAgent() as agentToolEnvironment
   * so per-turn resolution can't disagree with it (Task 5). */
  tools: Tools
  /** Tool NAME spec (agentDefinition.tools plus injected team-essential
   * tools, or ['*']) — the CustomAgentDefinition.tools this runtime was
   * resolved from. */
  agentToolNames: string[]
  systemPrompt: string
}

/**
 * Resolves the teammate's actual tool pool and builds its system prompt from
 * that SAME resolved pool.
 *
 * This runs BEFORE runWithTeammateContext()/runWithAgentContext() establish
 * the teammate's AsyncLocalStorage context, so tool resolution here must use
 * the EXPLICIT 'in-process-teammate' AgentToolEnvironment
 * (agentToolUtils.ts) rather than the ALS-based isInProcessTeammate() check
 * filterToolsForAgent falls back to for its 'default' environment —
 * otherwise the system prompt would be built from the LEADER's unfiltered
 * tool pool (enabledTools.has(AGENT_TOOL_NAME) etc. would answer for the
 * leader, not this teammate), diverging from what runAgent() actually
 * resolves once ALS is live (Task 5: prompt/tool-pool consistency).
 */
async function resolveInProcessRuntime(
  args: {
    toolUseContext: ToolUseContext
    agentDefinition?: CustomAgentDefinition
    systemPromptMode?: 'default' | 'replace' | 'append'
    systemPrompt?: string
  },
  deps: InProcessRuntimeDeps = defaultInProcessRuntimeDeps,
): Promise<InProcessRuntime> {
  const { toolUseContext, agentDefinition, systemPromptMode, systemPrompt } =
    args

  // Inject team-essential tools so teammates can always respond to shutdown
  // requests, send messages, and coordinate via the task list, even with
  // explicit tool lists.
  const agentToolNames = agentDefinition?.tools
    ? [
        ...new Set([
          ...agentDefinition.tools,
          SEND_MESSAGE_TOOL_NAME,
          TEAM_CREATE_TOOL_NAME,
          TEAM_DELETE_TOOL_NAME,
          TASK_CREATE_TOOL_NAME,
          TASK_GET_TOOL_NAME,
          TASK_LIST_TOOL_NAME,
          TASK_UPDATE_TOOL_NAME,
        ]),
      ]
    : ['*']

  const tools = resolveAgentTools(
    {
      tools: agentToolNames,
      disallowedTools: agentDefinition?.disallowedTools,
      source: 'projectSettings',
      permissionMode: 'default',
    },
    toolUseContext.options.tools,
    true,
    'in-process-teammate',
  ).resolvedTools

  if (systemPromptMode === 'replace' && systemPrompt) {
    return { tools, agentToolNames, systemPrompt }
  }

  const fullSystemPromptParts = await deps.getSystemPrompt(
    tools,
    toolUseContext.options.mainLoopModel,
    undefined,
    toolUseContext.options.mcpClients,
  )

  const systemPromptParts = [
    ...fullSystemPromptParts,
    TEAMMATE_SYSTEM_PROMPT_ADDENDUM,
  ]

  // If custom agent definition provided, append its prompt
  if (agentDefinition) {
    const customPrompt = agentDefinition.getSystemPrompt()
    if (customPrompt) {
      systemPromptParts.push(`\n# Custom Agent Instructions\n${customPrompt}`)
    }

    // Log agent memory loaded event for in-process teammates
    if (agentDefinition.memory) {
      logEvent('tengu_agent_memory_loaded', {
        ...(process.env.USER_TYPE === 'ant'
          ? {
              agent_type:
                agentDefinition.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            }
          : {}),
        scope:
          agentDefinition.memory as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        source:
          'in-process-teammate' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }
  }

  // Append mode: add provided system prompt after default
  if (systemPromptMode === 'append' && systemPrompt) {
    systemPromptParts.push(systemPrompt)
  }

  return {
    tools,
    agentToolNames,
    systemPrompt: systemPromptParts.join('\n'),
  }
}

/** Test-only seam. Do not widen — see resolveInProcessRuntime's doc comment. */
export const _forTest = {
  createInProcessCanUseTool,
  resolveInProcessRuntime,
}

/**
 * Runs an in-process teammate with a continuous prompt loop.
 *
 * Executes runAgent() within the teammate's AsyncLocalStorage context,
 * tracks progress, updates task state, sends idle notification on completion,
 * then waits for new prompts or shutdown requests.
 *
 * Unlike background tasks, teammates stay alive and can receive multiple prompts.
 * The loop only exits on abort or after shutdown is approved by the model.
 *
 * @param config - Runner configuration
 * @returns Result with messages and success status
 */
export async function runInProcessTeammate(
  config: InProcessRunnerConfig,
): Promise<InProcessRunnerResult> {
  const {
    identity,
    taskId,
    prompt,
    description,
    agentDefinition,
    teammateContext,
    toolUseContext,
    abortController,
    model,
    systemPrompt,
    systemPromptMode,
    allowedTools,
    allowPermissionPrompts,
    invokingRequestId,
  } = config
  const { setAppState } = toolUseContext

  logForDebugging(
    `[inProcessRunner] Starting agent loop for ${identity.agentId}`,
  )

  // Create AgentContext for analytics attribution
  const agentContext: AgentContext = {
    agentId: identity.agentId,
    parentSessionId: identity.parentSessionId,
    agentName: identity.agentName,
    teamName: identity.teamName,
    agentColor: identity.color,
    planModeRequired: identity.planModeRequired,
    isTeamLead: false,
    agentType: 'teammate',
    invokingRequestId,
    invocationKind: 'spawn',
    invocationEmitted: false,
  }

  // Resolve the teammate's actual tool pool and build its system prompt from
  // that SAME resolved pool (Task 5: prompt/tool-pool consistency — see
  // resolveInProcessRuntime's doc comment above). The resolved `tools` array
  // itself is only needed to build the system prompt (done inside
  // resolveInProcessRuntime); the runAgent() call below re-derives the same
  // pool per turn from the live toolUseContext.options.tools plus the same
  // agentToolNames + 'in-process-teammate' environment, so newly connected
  // MCP tools remain visible on later turns instead of being frozen here.
  const { agentToolNames, systemPrompt: teammateSystemPrompt } =
    await resolveInProcessRuntime({
      toolUseContext,
      agentDefinition,
      systemPromptMode,
      systemPrompt,
    })

  // Resolve agent definition - use full system prompt with teammate addendum
  // IMPORTANT: Set permissionMode to 'default' so teammates always get full tool
  // access regardless of the leader's permission mode.
  const resolvedAgentDefinition: CustomAgentDefinition = {
    agentType: identity.agentName,
    whenToUse: `In-process teammate: ${identity.agentName}`,
    getSystemPrompt: () => teammateSystemPrompt,
    tools: agentToolNames,
    source: 'projectSettings',
    permissionMode: 'default',
    // Propagate model from custom agent definition so getAgentModel()
    // can use it as a fallback when no tool-level model is specified
    ...(agentDefinition?.model ? { model: agentDefinition.model } : {}),
  }

  const teammateProvider =
    getProviderForModel(model) ?? toolUseContext.options.mainLoopProvider

  // All messages across all prompts
  const allMessages: Message[] = []
  // Wrap initial prompt with provider-specific teammate formatting
  const initialTeammateMessage = createTeammateMessage(
    'team-lead',
    prompt,
    undefined,
    description,
  )
  const wrappedInitialPrompt = formatTeammateMessagesForModel(
    [initialTeammateMessage],
    teammateProvider,
  )
  let currentPrompt = wrappedInitialPrompt
  let shouldExit = false

  // Try to claim an available task immediately so the UI can show activity
  // from the very start. The idle loop handles claiming for subsequent tasks.
  // Use parentSessionId as the task list ID since the leader creates tasks
  // under its session ID, not the team name.
  await tryClaimNextTask(identity.parentSessionId, identity.agentName)

  try {
    // Add initial prompt to task.messages for display (wrapped with XML)
    updateTaskState(
      taskId,
      task => ({
        ...task,
        messages: appendCappedMessage(
          task.messages,
          createUserMessage({
            content: formatAsTranscriptTeammateMessage(
              initialTeammateMessage.from,
              initialTeammateMessage.text,
              initialTeammateMessage.color,
              initialTeammateMessage.summary,
              teammateProvider,
            ),
            origin: { kind: 'teammate', messages: [initialTeammateMessage] },
          }),
        ),
      }),
      setAppState,
    )

    // Per-teammate content replacement state. The while-loop below calls
    // runAgent repeatedly over an accumulating `allMessages` buffer (which
    // carries FULL original tool result content, not previews — query() yields
    // originals, enforcement is non-mutating). Without persisting state across
    // iterations, each call gets a fresh empty state from createSubagentContext
    // and makes holistic replace-globally-largest decisions, diverging from
    // earlier iterations' incremental frozen-first decisions → wire prefix
    // differs → cache miss. Gated on parent to inherit feature-flag-off.
    let teammateReplacementState = toolUseContext.contentReplacementState
      ? createContentReplacementState()
      : undefined

    // Main teammate loop - runs until abort or shutdown approved
    while (!abortController.signal.aborted && !shouldExit) {
      logForDebugging(
        `[inProcessRunner] ${identity.agentId} processing prompt: ${currentPrompt.substring(0, 50)}...`,
      )

      // Create a per-turn abort controller for this iteration.
      // This allows Escape to stop current work without killing the whole teammate.
      // The lifecycle abortController still kills the whole teammate if needed.
      const currentWorkAbortController = createAbortController()

      // Store the work controller in task state so UI can abort it
      updateTaskState(
        taskId,
        task => ({ ...task, currentWorkAbortController }),
        setAppState,
      )

      // Prepare prompt messages for this iteration
      // For the first iteration, start fresh
      // For subsequent iterations, pass accumulated messages as context
      const userMessage = createUserMessage({ content: currentPrompt })
      const promptMessages: Message[] = [userMessage]

      // Check if compaction is needed before building context
      let contextMessages = allMessages
      const tokenCount = tokenCountWithEstimation(allMessages)
      if (
        tokenCount >
        getAutoCompactThreshold(toolUseContext.options.mainLoopModel)
      ) {
        logForDebugging(
          `[inProcessRunner] ${identity.agentId} compacting history (${tokenCount} tokens)`,
        )
        // Create an isolated copy of toolUseContext so that compaction
        // does not clear the main session's readFileState cache or
        // trigger the main session's UI callbacks.
        const isolatedContext: ToolUseContext = {
          ...toolUseContext,
          readFileState: cloneFileStateCache(toolUseContext.readFileState),
          onCompactProgress: undefined,
          setStreamMode: undefined,
        }
        const compactedSummary = await compactConversation(
          allMessages,
          isolatedContext,
          {
            systemPrompt: asSystemPrompt([]),
            userContext: {},
            systemContext: {},
            toolUseContext: isolatedContext,
            forkContextMessages: [],
          },
          true, // suppressFollowUpQuestions
          undefined, // customInstructions
          true, // isAutoCompact
        )
        contextMessages = buildPostCompactMessages(compactedSummary)
        // Reset microcompact state since full compact replaces all
        // messages — old tool IDs are no longer relevant
        resetMicrocompactState()
        // Reset content replacement state — compact replaces all messages
        // so old tool_use_ids are gone. Stale Map entries are harmless
        // (UUID keys never match) but accumulate memory over long runs.
        if (teammateReplacementState) {
          teammateReplacementState = createContentReplacementState()
        }
        // Update allMessages in place with compacted version
        allMessages.length = 0
        allMessages.push(...contextMessages)

        // Mirror compaction into task.messages — otherwise the AppState
        // mirror grows unbounded (500 turns = 500+ messages, 10-50MB).
        // Replace with the compacted messages, matching allMessages.
        updateTaskState(
          taskId,
          task => ({ ...task, messages: [...contextMessages, userMessage] }),
          setAppState,
        )
      }

      // Pass previous messages as context to preserve conversation history
      // allMessages accumulates all previous messages (user + assistant) from prior iterations
      const forkContextMessages =
        contextMessages.length > 0 ? [...contextMessages] : undefined

      // Add the user message to allMessages so it's included in future context
      // This ensures the full conversation (user + assistant turns) is preserved
      allMessages.push(userMessage)

      // Create fresh progress tracker for this prompt
      const tracker = createProgressTracker()
      const resolveActivity = createActivityDescriptionResolver(
        toolUseContext.options.tools,
      )
      const iterationMessages: Message[] = []

      // Read current permission mode from task state (may have been cycled by leader via Shift+Tab)
      const currentAppState = toolUseContext.getAppState()
      const currentTask = currentAppState.tasks[taskId]
      const currentPermissionMode =
        currentTask && currentTask.type === 'in_process_teammate'
          ? currentTask.permissionMode
          : 'default'
      const iterationAgentDefinition = {
        ...resolvedAgentDefinition,
        permissionMode: currentPermissionMode,
      }

      // Track if this iteration was interrupted by work abort (not lifecycle abort)
      let workWasAborted = false

      // Run agent within contexts
      await runWithTeammateContext(teammateContext, async () => {
        return runWithAgentContext(agentContext, async () => {
          // Mark task as running (not idle)
          updateTaskState(
            taskId,
            task => ({ ...task, status: 'running', isIdle: false }),
            setAppState,
          )

          // Run the normal agent loop - same runAgent() used by AgentTool/subagents.
          // This calls query() internally, so we share the core API infrastructure.
          // Pass forkContextMessages to preserve conversation history across prompts.
          // In-process teammates are async but run in the same process as the leader,
          // so they CAN show permission prompts (unlike true background agents).
          // Use currentWorkAbortController so Escape stops this turn only, not the teammate.
          for await (const message of runAgent({
            agentDefinition: iterationAgentDefinition,
            promptMessages,
            toolUseContext,
            canUseTool: createInProcessCanUseTool(
              identity,
              currentWorkAbortController,
              (waitMs: number) => {
                updateTaskState(
                  taskId,
                  task => ({
                    ...task,
                    totalPausedMs: (task.totalPausedMs ?? 0) + waitMs,
                  }),
                  setAppState,
                )
              },
            ),
            isAsync: true,
            canShowPermissionPrompts: allowPermissionPrompts ?? true,
            forkContextMessages,
            querySource: 'agent:custom',
            override: { abortController: currentWorkAbortController },
            model: model as ModelAlias | undefined,
            preserveToolUseResults: true,
            availableTools: toolUseContext.options.tools,
            // Explicit — not ALS-derived — so this per-turn resolution
            // agrees with the tool pool resolveInProcessRuntime() used to
            // build the system prompt above (Task 5).
            agentToolEnvironment: 'in-process-teammate',
            allowedTools,
            contentReplacementState: teammateReplacementState,
          })) {
            // Check lifecycle abort first (kills whole teammate)
            if (abortController.signal.aborted) {
              logForDebugging(
                `[inProcessRunner] ${identity.agentId} lifecycle aborted`,
              )
              break
            }

            // Check work abort (stops current turn only)
            if (currentWorkAbortController.signal.aborted) {
              logForDebugging(
                `[inProcessRunner] ${identity.agentId} current work aborted (Escape pressed)`,
              )
              workWasAborted = true
              break
            }

            iterationMessages.push(message)
            allMessages.push(message)

            updateProgressFromMessage(
              tracker,
              message,
              resolveActivity,
              toolUseContext.options.tools,
            )
            const progress = getProgressUpdate(tracker)

            updateTaskState(
              taskId,
              task => {
                // Track in-progress tool use IDs for animation in transcript view
                let inProgressToolUseIDs = task.inProgressToolUseIDs
                if (message.type === 'assistant') {
                  for (const block of message.message.content) {
                    if (block.type === 'tool_use') {
                      inProgressToolUseIDs = new Set([
                        ...(inProgressToolUseIDs ?? []),
                        block.id,
                      ])
                    }
                  }
                } else if (message.type === 'user') {
                  const content = message.message.content
                  if (Array.isArray(content)) {
                    for (const block of content) {
                      if (
                        typeof block === 'object' &&
                        'type' in block &&
                        block.type === 'tool_result'
                      ) {
                        if (inProgressToolUseIDs) {
                          inProgressToolUseIDs = new Set(inProgressToolUseIDs)
                          inProgressToolUseIDs.delete(block.tool_use_id)
                        }
                      }
                    }
                  }
                }

                return {
                  ...task,
                  progress,
                  messages: appendCappedMessage(task.messages, message),
                  inProgressToolUseIDs,
                }
              },
              setAppState,
            )
          }

          return { success: true, messages: iterationMessages }
        })
      })

      // Clear the work controller from state (it's no longer valid)
      updateTaskState(
        taskId,
        task => ({ ...task, currentWorkAbortController: undefined }),
        setAppState,
      )

      // Check if lifecycle aborted during agent run (kills whole teammate)
      if (abortController.signal.aborted) {
        break
      }

      // If work was aborted (Escape), log it and add interrupt message, then continue to idle state
      if (workWasAborted) {
        logForDebugging(
          `[inProcessRunner] ${identity.agentId} work interrupted, returning to idle`,
        )

        // Add interrupt message to teammate's messages so it appears in their scrollback
        const interruptMessage = createAssistantAPIErrorMessage({
          content: ERROR_MESSAGE_USER_ABORT,
        })
        updateTaskState(
          taskId,
          task => ({
            ...task,
            messages: appendCappedMessage(task.messages, interruptMessage),
          }),
          setAppState,
        )
      }

      // Check if already idle before updating (to skip duplicate notification)
      const prevAppState = toolUseContext.getAppState()
      const prevTask = prevAppState.tasks[taskId]
      const wasAlreadyIdle =
        prevTask?.type === 'in_process_teammate' && prevTask.isIdle

      // Mark task as idle (NOT completed) and notify any waiters
      updateTaskState(
        taskId,
        task => {
          // Call any registered idle callbacks
          task.onIdleCallbacks?.forEach(cb => cb())
          return { ...task, isIdle: true, onIdleCallbacks: [] }
        },
        setAppState,
      )

      // Note: We do NOT automatically send the teammate's response to the leader.
      // Teammates should use the Teammate tool to communicate with the leader.
      // This matches process-based teammates where output is not visible to the leader.

      // Only send idle notification on transition to idle (not if already idle)
      if (!wasAlreadyIdle) {
        await sendIdleNotification(
          identity.agentName,
          identity.color,
          identity.teamName,
          {
            idleReason: workWasAborted ? 'interrupted' : 'available',
            summary: getLastPeerDmSummary(allMessages),
          },
        )
      } else {
        logForDebugging(
          `[inProcessRunner] Skipping duplicate idle notification for ${identity.agentName}`,
        )
      }

      logForDebugging(
        `[inProcessRunner] ${identity.agentId} finished prompt, waiting for next`,
      )

      // Wait for next message or shutdown
      const waitResult = await waitForNextPromptOrShutdown(
        identity,
        abortController,
        taskId,
        toolUseContext.getAppState,
        setAppState,
        identity.parentSessionId,
      )

      switch (waitResult.type) {
        case 'shutdown_request':
          // Pass shutdown request to model for decision
          // Format as teammate-message for consistency with how tmux teammates receive it
          // The model will use approveShutdown or rejectShutdown tool
          logForDebugging(
            `[inProcessRunner] ${identity.agentId} received shutdown request - passing to model`,
          )
          const shutdownMessage = createTeammateMessage(
            waitResult.request?.from || 'team-lead',
            waitResult.originalMessage,
          )
          currentPrompt = formatTeammateMessagesForModel(
            [shutdownMessage],
            teammateProvider,
          )
          // Add shutdown request to task.messages for transcript display
          appendTeammateMessage(
            taskId,
            createUserMessage({
              content: formatAsTranscriptTeammateMessage(
                shutdownMessage.from,
                shutdownMessage.text,
                shutdownMessage.color,
                shutdownMessage.summary,
                teammateProvider,
              ),
              origin: { kind: 'teammate', messages: [shutdownMessage] },
            }),
            setAppState,
          )
          break

        case 'new_message':
          // New prompt from leader or teammate
          logForDebugging(
            `[inProcessRunner] ${identity.agentId} received new message from ${waitResult.from}`,
          )
          // Messages from the user should be plain text (not wrapped in XML)
          // Messages from other teammates get XML wrapper for identification
          if (waitResult.from === 'user') {
            currentPrompt = waitResult.message
          } else {
            const teammateMessage = createTeammateMessage(
              waitResult.from,
              waitResult.message,
              waitResult.color,
              waitResult.summary,
            )
            currentPrompt = formatTeammateMessagesForModel(
              [teammateMessage],
              teammateProvider,
            )
            // Add to task.messages for transcript display (only for non-user messages)
            // Messages from 'user' come from pendingUserMessages which are already
            // added by injectUserMessageToTeammate
            appendTeammateMessage(
              taskId,
              createUserMessage({
                content: formatAsTranscriptTeammateMessage(
                  teammateMessage.from,
                  teammateMessage.text,
                  teammateMessage.color,
                  teammateMessage.summary,
                  teammateProvider,
                ),
                origin: { kind: 'teammate', messages: [teammateMessage] },
              }),
              setAppState,
            )
          }
          break

        case 'aborted':
          logForDebugging(
            `[inProcessRunner] ${identity.agentId} aborted while waiting`,
          )
          shouldExit = true
          break
      }
    }

    // Mark as completed when exiting the loop
    let alreadyTerminal = false
    let toolUseId: string | undefined
    updateTaskState(
      taskId,
      task => {
        // killInProcessTeammate may have already set status:killed +
        // notified:true + cleared fields. Don't overwrite (would flip
        // killed → completed and double-emit the SDK bookend).
        if (task.status !== 'running') {
          alreadyTerminal = true
          return task
        }
        toolUseId = task.toolUseId
        task.onIdleCallbacks?.forEach(cb => cb())
        task.unregisterCleanup?.()
        return {
          ...task,
          status: 'completed' as const,
          notified: true,
          endTime: Date.now(),
          messages: task.messages?.length ? [task.messages.at(-1)!] : undefined,
          pendingUserMessages: [],
          inProgressToolUseIDs: undefined,
          abortController: undefined,
          unregisterCleanup: undefined,
          currentWorkAbortController: undefined,
          onIdleCallbacks: [],
        }
      },
      setAppState,
    )
    void evictTaskOutput(taskId)
    // Eagerly evict task from AppState since it's been consumed
    evictTerminalTask(taskId, setAppState)
    // notified:true pre-set → no XML notification → print.ts won't emit
    // the SDK task_notification. Close the task_started bookend directly.
    if (!alreadyTerminal) {
      emitTaskTerminatedSdk(taskId, 'completed', {
        toolUseId,
        summary: identity.agentId,
      })
    }

    unregisterPerfettoAgent(identity.agentId)
    return { success: true, messages: allMessages }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error'

    logForDebugging(
      `[inProcessRunner] Agent ${identity.agentId} failed: ${errorMessage}`,
    )

    // Mark task as failed and notify any waiters
    let alreadyTerminal = false
    let toolUseId: string | undefined
    updateTaskState(
      taskId,
      task => {
        if (task.status !== 'running') {
          alreadyTerminal = true
          return task
        }
        toolUseId = task.toolUseId
        task.onIdleCallbacks?.forEach(cb => cb())
        task.unregisterCleanup?.()
        return {
          ...task,
          status: 'failed' as const,
          notified: true,
          error: errorMessage,
          isIdle: true,
          endTime: Date.now(),
          onIdleCallbacks: [],
          messages: task.messages?.length ? [task.messages.at(-1)!] : undefined,
          pendingUserMessages: [],
          inProgressToolUseIDs: undefined,
          abortController: undefined,
          unregisterCleanup: undefined,
          currentWorkAbortController: undefined,
        }
      },
      setAppState,
    )
    void evictTaskOutput(taskId)
    // Eagerly evict task from AppState since it's been consumed
    evictTerminalTask(taskId, setAppState)
    // notified:true pre-set → no XML notification → close SDK bookend directly.
    if (!alreadyTerminal) {
      emitTaskTerminatedSdk(taskId, 'failed', {
        toolUseId,
        summary: identity.agentId,
      })
    }

    // Send idle notification with failure via file-based mailbox
    await sendIdleNotification(
      identity.agentName,
      identity.color,
      identity.teamName,
      {
        idleReason: 'failed',
        completedStatus: 'failed',
        failureReason: errorMessage,
      },
    )

    unregisterPerfettoAgent(identity.agentId)
    return {
      success: false,
      error: errorMessage,
      messages: allMessages,
    }
  }
}

/**
 * Starts an in-process teammate in the background.
 *
 * This is the main entry point called after spawn. It starts the agent
 * execution loop in a fire-and-forget manner.
 *
 * @param config - Runner configuration
 */
export function startInProcessTeammate(config: InProcessRunnerConfig): void {
  // Extract agentId before the closure so the catch handler doesn't retain
  // the full config object (including toolUseContext) while the promise is
  // pending - which can be hours for a long-running teammate.
  const agentId = config.identity.agentId
  void runInProcessTeammate(config).catch(error => {
    logForDebugging(`[inProcessRunner] Unhandled error in ${agentId}: ${error}`)
  })
}
