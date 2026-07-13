import { randomUUID } from 'crypto'
import { useCallback, useEffect, useRef } from 'react'
import { useInterval } from 'usehooks-ts'
import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js'
import {
  formatTeammateMessagesForModel,
  toTeammateMessageContract,
  type TeammateMessageContract,
} from '../utils/teammateMessage.js'
import { useTerminalNotification } from '../ink/useTerminalNotification.js'
import { sendNotification } from '../services/notifier.js'
import {
  type AppState,
  useAppState,
  useAppStateStore,
  useSetAppState,
} from '../state/AppState.js'
import { findToolByName } from '../Tool.js'
import { isInProcessTeammateTask } from '../tasks/InProcessTeammateTask/types.js'
import { getAllBaseTools } from '../tools.js'
import type { PermissionUpdate } from '../types/permissions.js'
import { logForDebugging } from '../utils/debug.js'
import {
  findInProcessTeammateTaskId,
  handlePlanApprovalResponse,
} from '../utils/inProcessTeammateHelpers.js'
import { createAssistantMessage } from '../utils/messages.js'
import {
  permissionModeFromString,
  toExternalPermissionMode,
} from '../utils/permissions/PermissionMode.js'
import { applyPermissionUpdate } from '../utils/permissions/PermissionUpdate.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { isInsideTmux } from '../utils/swarm/backends/detection.js'
import {
  ensureBackendsRegistered,
  getBackendByType,
} from '../utils/swarm/backends/registry.js'
import type { PaneBackendType } from '../utils/swarm/backends/types.js'
import { TEAM_LEAD_NAME } from '../utils/swarm/constants.js'
import { getLeaderToolUseConfirmQueue } from '../utils/swarm/leaderPermissionBridge.js'
import { sendPermissionResponseViaMailbox } from '../utils/swarm/permissionSync.js'
import {
  removeTeammateFromTeamFile,
  setMemberMode,
} from '../utils/swarm/teamHelpers.js'
import { unassignTeammateTasks } from '../utils/tasks.js'
import {
  getAgentName,
  isPlanModeRequired,
  isTeamLead,
  isTeammate,
} from '../utils/teammate.js'
import { isInProcessTeammate } from '../utils/teammateContext.js'
import {
  claimPendingControl,
  classifyMailboxMessage,
  createPlanApprovalResponseMessage,
  finishPendingControl,
  isPlanApprovalResponse,
  isStructuredProtocolMessage,
  markMessagesAsReadByPredicate,
  type MailboxSignature,
  type ModeSetRequestMessage,
  type PermissionRequestMessage,
  type PermissionResponseMessage,
  type PlanApprovalRequestMessage,
  readMailboxIfChanged,
  resolveCurrentTeamPrincipal,
  resolveTeamPrincipalByName,
  type SandboxPermissionRequestMessage,
  type SandboxPermissionResponseMessage,
  type ShutdownApprovedMessage,
  type ShutdownRequestMessage,
  type TeammateMessage,
  type TeamPermissionUpdateMessage,
  type TeamPrincipal,
  writeControlToMailbox,
} from '../utils/teammateMailbox.js'
import { readTeamSnapshot, type TeamFile } from '../utils/swarm/teamHelpers.js'
import {
  hasPermissionCallback,
  hasSandboxPermissionCallback,
  processMailboxPermissionResponse,
  processSandboxPermissionResponse,
} from './useSwarmPermissionPoller.js'

/**
 * Get the agent name to poll for messages.
 * - In-process teammates return undefined (they use waitForNextPromptOrShutdown instead)
 * - Process-based teammates use their CLAUDE_CODE_AGENT_NAME
 * - Team leads use their name from teamContext.teammates
 * - Standalone sessions return undefined
 */
function getAgentNameToPoll(appState: AppState): string | undefined {
  // In-process teammates should NOT use useInboxPoller - they have their own
  // polling mechanism via waitForNextPromptOrShutdown() in inProcessRunner.ts.
  // Using useInboxPoller would cause message routing issues since in-process
  // teammates share the same React context and AppState with the leader.
  //
  // Note: This can be called when the leader's REPL re-renders while an
  // in-process teammate's AsyncLocalStorage context is active (due to shared
  // setAppState). We return undefined to gracefully skip polling rather than
  // throwing, since this is a normal occurrence during concurrent execution.
  if (isInProcessTeammate()) {
    return undefined
  }
  if (isTeammate()) {
    return getAgentName()
  }
  // Team lead polls using their agent name (not ID)
  if (isTeamLead(appState.teamContext)) {
    const leadAgentId = appState.teamContext!.leadAgentId
    // Look up the lead's name from teammates map
    const leadName = appState.teamContext!.teammates[leadAgentId]?.name
    return leadName || 'team-lead'
  }
  return undefined
}

const INBOX_POLL_INTERVAL_MS = 1000

/**
 * Authority-checked dispatch buckets for one poll's unread messages. Pure
 * and synchronous — takes an already-fetched team snapshot (or `null` for a
 * legacy/absent team or a session outside any team) so `useInboxPoller.test.ts`
 * can exercise it without rendering React or touching the filesystem.
 */
export type InboxDispatch = {
  permissionRequests: Array<{ message: TeammateMessage; control: PermissionRequestMessage }>
  permissionResponses: Array<{ message: TeammateMessage; control: PermissionResponseMessage }>
  sandboxPermissionRequests: Array<{
    message: TeammateMessage
    control: SandboxPermissionRequestMessage
  }>
  sandboxPermissionResponses: Array<{
    message: TeammateMessage
    control: SandboxPermissionResponseMessage
  }>
  shutdownRequests: Array<{ message: TeammateMessage; control: ShutdownRequestMessage }>
  shutdownApprovals: Array<{ message: TeammateMessage; control: ShutdownApprovedMessage }>
  teamPermissionUpdates: Array<{
    message: TeammateMessage
    control: TeamPermissionUpdateMessage
  }>
  modeSetRequests: Array<{ message: TeammateMessage; control: ModeSetRequestMessage }>
  planApprovalRequests: Array<{ message: TeammateMessage; control: PlanApprovalRequestMessage }>
  // Plain chat, notifications (idle/task-assignment), and any control type
  // with no dedicated UI queue here (shutdown_rejected, plan_approval_response
  // — both handled elsewhere) fall through to the model-visible message path,
  // same as before Task 3.
  regularMessages: TeammateMessage[]
  // Invalid/mismatched controls, and stale-recipient chat/notifications —
  // acknowledged by exact ID below, never delivered or dispatched.
  acknowledgeOnlyIds: string[]
}

function emptyInboxDispatch(): InboxDispatch {
  return {
    permissionRequests: [],
    permissionResponses: [],
    sandboxPermissionRequests: [],
    sandboxPermissionResponses: [],
    shutdownRequests: [],
    shutdownApprovals: [],
    teamPermissionUpdates: [],
    modeSetRequests: [],
    planApprovalRequests: [],
    regularMessages: [],
    acknowledgeOnlyIds: [],
  }
}

/**
 * Classifies a batch of raw unread mailbox messages into authority-checked
 * dispatch buckets. A `null` snapshot/receiver (legacy team, or no team
 * context at all) falls back to the pre-Task-3 text-sniff exclusion —
 * anything control-shaped is dropped rather than delivered as chat, matching
 * `getTeammateMailboxAttachments`'s same fallback in attachments.ts.
 */
export function classifyInboxMessages(args: {
  messages: readonly TeammateMessage[]
  snapshot: Readonly<TeamFile> | null
  receiver: TeamPrincipal | null
}): InboxDispatch {
  const dispatch = emptyInboxDispatch()
  const { messages, snapshot, receiver } = args

  for (const m of messages) {
    const senderPrincipal =
      snapshot && resolveTeamPrincipalByName(snapshot, m.from)
    const classified =
      snapshot && receiver && senderPrincipal
        ? classifyMailboxMessage({
            message: m,
            sender: senderPrincipal,
            receiver,
            pendingControls: snapshot.pendingControls ?? [],
          })
        : null

    if (!classified) {
      if (isStructuredProtocolMessage(m.text)) continue
      dispatch.regularMessages.push(m)
      continue
    }

    switch (classified.kind) {
      case 'invalid_control':
      case 'protocol_mismatch':
        if (m.messageId) dispatch.acknowledgeOnlyIds.push(m.messageId)
        break
      case 'notification':
        dispatch.regularMessages.push(m)
        break
      case 'chat': {
        const isStaleRecipient =
          m.protocolVersion === 2 &&
          m.recipientAllocationId !== undefined &&
          receiver !== null &&
          m.recipientAllocationId !== receiver.allocationId
        if (isStaleRecipient) {
          if (m.messageId) dispatch.acknowledgeOnlyIds.push(m.messageId)
        } else {
          dispatch.regularMessages.push(m)
        }
        break
      }
      case 'control': {
        const control = classified.control
        switch (control.type) {
          case 'permission_request':
            dispatch.permissionRequests.push({ message: m, control })
            break
          case 'permission_response':
            dispatch.permissionResponses.push({ message: m, control })
            break
          case 'sandbox_permission_request':
            dispatch.sandboxPermissionRequests.push({ message: m, control })
            break
          case 'sandbox_permission_response':
            dispatch.sandboxPermissionResponses.push({ message: m, control })
            break
          case 'shutdown_request':
            dispatch.shutdownRequests.push({ message: m, control })
            break
          case 'shutdown_approved':
            dispatch.shutdownApprovals.push({ message: m, control })
            break
          case 'team_permission_update':
            dispatch.teamPermissionUpdates.push({ message: m, control })
            break
          case 'mode_set_request':
            dispatch.modeSetRequests.push({ message: m, control })
            break
          case 'plan_approval_request':
            dispatch.planApprovalRequests.push({ message: m, control })
            break
          // shutdown_rejected and plan_approval_response have no dedicated
          // queue here (handled by SendMessageTool/inProcessTeammateHelpers
          // and the plan-approval-response scan above poll(), respectively)
          // — pass through as before Task 3.
          case 'shutdown_rejected':
          case 'plan_approval_response':
            dispatch.regularMessages.push(m)
            break
        }
        break
      }
    }
  }

  return dispatch
}

type Props = {
  enabled: boolean
  isLoading: boolean
  focusedInputDialog: string | undefined
  // Returns true if submission succeeded, false if rejected (e.g., query already running)
  // Dead code elimination: parameter named onSubmitMessage to avoid "teammate" string in external builds
  onSubmitMessage: (
    formatted: string,
    options?: { teammateMessages?: TeammateMessageContract[] },
  ) => boolean
}

/**
 * Polls the teammate inbox for new messages and submits them as turns.
 *
 * This hook:
 * 1. Polls every 1s for unread messages (teammates or team leads)
 * 2. When idle: submits messages immediately as a new turn
 * 3. When busy: queues messages in AppState.inbox for UI display, delivers when turn ends
 */
export function useInboxPoller({
  enabled,
  isLoading,
  focusedInputDialog,
  onSubmitMessage,
}: Props): void {
  // Assign to original name for clarity within the function
  const onSubmitTeammateMessage = onSubmitMessage
  const store = useAppStateStore()
  const setAppState = useSetAppState()
  const inboxMessageCount = useAppState(s => s.inbox.messages.length)
  const terminal = useTerminalNotification()
  const mailboxSignatureRef = useRef<MailboxSignature | undefined>(undefined)
  const mailboxKeyRef = useRef<string | undefined>(undefined)

  const poll = useCallback(async () => {
    if (!enabled) return

    // Use ref to avoid dependency on appState object (prevents infinite loop)
    const currentAppState = store.getState()
    const agentName = getAgentNameToPoll(currentAppState)
    if (!agentName) return
    const teamName = currentAppState.teamContext?.teamName
    const mailboxKey = `${teamName ?? ''}\0${agentName}`
    if (mailboxKeyRef.current !== mailboxKey) {
      mailboxKeyRef.current = mailboxKey
      mailboxSignatureRef.current = undefined
    }

    const mailbox = await readMailboxIfChanged(
      agentName,
      teamName,
      mailboxSignatureRef.current,
    )
    mailboxSignatureRef.current = mailbox.signature
    if (!mailbox.changed) return

    const unread = mailbox.messages.filter(m => !m.read)

    if (unread.length === 0) return

    logForDebugging(`[InboxPoller] Found ${unread.length} unread message(s)`)

    // Resolve a versioned team snapshot once per poll for authority-checked
    // classification. `null` for a legacy/absent team — classifyInboxMessages
    // falls back to the pre-Task-3 text-sniff exclusion in that case.
    let controlSnapshot: Readonly<TeamFile> | null = null
    let receiverPrincipal: TeamPrincipal | null = null
    if (teamName) {
      try {
        controlSnapshot = await readTeamSnapshot(teamName)
        receiverPrincipal = await resolveCurrentTeamPrincipal(
          teamName,
          controlSnapshot,
        )
      } catch {
        controlSnapshot = null
        receiverPrincipal = null
      }
    }

    // Check for plan approval responses and transition out of plan mode if approved
    // Security: only accept approval responses whose resolved sender identity
    // is the team lead — a version-2 snapshot makes this an actual identity
    // check rather than trusting the unvalidated `from` string.
    if (isTeammate() && isPlanModeRequired()) {
      for (const msg of unread) {
        const approvalResponse = isPlanApprovalResponse(msg.text)
        if (!approvalResponse) continue
        const senderPrincipal =
          controlSnapshot && resolveTeamPrincipalByName(controlSnapshot, msg.from)
        const isFromLeader = senderPrincipal
          ? senderPrincipal.kind === 'leader'
          : msg.from === TEAM_LEAD_NAME
        if (isFromLeader) {
          logForDebugging(
            `[InboxPoller] Received plan approval response from team-lead: approved=${approvalResponse.approved}`,
          )
          if (approvalResponse.approved) {
            // Use leader's permission mode if provided, otherwise default
            const targetMode = approvalResponse.permissionMode ?? 'default'

            // Transition out of plan mode
            setAppState(prev => ({
              ...prev,
              toolPermissionContext: applyPermissionUpdate(
                prev.toolPermissionContext,
                {
                  type: 'setMode',
                  mode: toExternalPermissionMode(targetMode),
                  destination: 'session',
                },
              ),
            }))
            logForDebugging(
              `[InboxPoller] Plan approved by team lead, exited plan mode to ${targetMode}`,
            )
          } else {
            logForDebugging(
              `[InboxPoller] Plan rejected by team lead: ${approvalResponse.feedback || 'No feedback provided'}`,
            )
          }
        } else {
          logForDebugging(
            `[InboxPoller] Ignoring plan approval response from non-team-lead: ${msg.from}`,
          )
        }
      }
    }

    const dispatch = classifyInboxMessages({
      messages: unread,
      snapshot: controlSnapshot,
      receiver: receiverPrincipal,
    })
    const {
      permissionRequests,
      permissionResponses,
      sandboxPermissionRequests,
      sandboxPermissionResponses,
      shutdownRequests,
      shutdownApprovals,
      teamPermissionUpdates,
      modeSetRequests,
      planApprovalRequests,
    } = dispatch
    const regularMessages: TeammateMessage[] = [...dispatch.regularMessages]

    // Invalid/mismatched controls and stale-recipient chat are acknowledged
    // by exact identity — dropped, never delivered or dispatched. Every
    // other message this poll dispatches (regular, or to one of the queues
    // below) is also tracked here so the final ack only ever touches
    // messages this pass actually classified, never a concurrent append.
    // Keyed by messageId when present, else the same from/timestamp/text key
    // `getTeammateMailboxAttachments` uses — legacy call sites (still ~15
    // across the repo) write chat with no messageId at all.
    const messageKey = (m: TeammateMessage): string =>
      m.messageId ?? `${m.from} ${m.timestamp} ${m.text}`
    const consumedKeys = new Set<string>(dispatch.acknowledgeOnlyIds)
    const trackForAck = (m: TeammateMessage) => {
      consumedKeys.add(messageKey(m))
    }
    for (const m of regularMessages) trackForAck(m)

    // Marks only messages this pass actually classified and consumed as
    // read. A brand-new message that arrived concurrently (after the
    // classification above) won't match any key here and stays unread for
    // the next poll — never silently swallowed.
    const markRead = () => {
      if (consumedKeys.size === 0) return
      void markMessagesAsReadByPredicate(
        agentName,
        m => consumedKeys.has(messageKey(m)),
        currentAppState.teamContext?.teamName,
      )
    }

    // Handle permission requests (leader side) - route to ToolUseConfirmQueue
    if (
      permissionRequests.length > 0 &&
      isTeamLead(currentAppState.teamContext)
    ) {
      logForDebugging(
        `[InboxPoller] Found ${permissionRequests.length} permission request(s)`,
      )

      const setToolUseConfirmQueue = getLeaderToolUseConfirmQueue()
      const teamName = currentAppState.teamContext?.teamName

      for (const { message: m, control: parsed } of permissionRequests) {
        trackForAck(m)

        if (setToolUseConfirmQueue) {
          // Route through the standard ToolUseConfirmQueue so tmux workers
          // get the same tool-specific UI (BashPermissionRequest, FileEditToolDiff, etc.)
          // as in-process teammates.
          const tool = findToolByName(getAllBaseTools(), parsed.tool_name)
          if (!tool) {
            logForDebugging(
              `[InboxPoller] Unknown tool ${parsed.tool_name}, skipping permission request`,
            )
            continue
          }

          const entry: ToolUseConfirm = {
            assistantMessage: createAssistantMessage({ content: '' }),
            tool,
            description: parsed.description,
            input: parsed.input,
            toolUseContext: {} as ToolUseConfirm['toolUseContext'],
            toolUseID: parsed.tool_use_id,
            permissionResult: {
              behavior: 'ask',
              message: parsed.description,
            },
            permissionPromptStartTimeMs: Date.now(),
            workerBadge: {
              name: parsed.agent_id,
              color: 'cyan',
            },
            onUserInteraction() {
              // No-op for tmux workers (no classifier auto-approval)
            },
            onAbort() {
              void sendPermissionResponseViaMailbox(
                parsed.agent_id,
                { decision: 'rejected', resolvedBy: 'leader' },
                parsed.request_id,
                teamName,
              )
            },
            onAllow(
              updatedInput: Record<string, unknown>,
              permissionUpdates: PermissionUpdate[],
            ) {
              void sendPermissionResponseViaMailbox(
                parsed.agent_id,
                {
                  decision: 'approved',
                  resolvedBy: 'leader',
                  updatedInput,
                  permissionUpdates,
                },
                parsed.request_id,
                teamName,
              )
            },
            onReject(feedback?: string) {
              void sendPermissionResponseViaMailbox(
                parsed.agent_id,
                {
                  decision: 'rejected',
                  resolvedBy: 'leader',
                  feedback,
                },
                parsed.request_id,
                teamName,
              )
            },
            async recheckPermission() {
              // No-op for tmux workers — permission state is on the worker side
            },
          }

          // Deduplicate: if the mark-read ack failed on a prior poll,
          // the same message will be re-read — skip if already queued.
          setToolUseConfirmQueue(queue => {
            if (queue.some(q => q.toolUseID === parsed.tool_use_id)) {
              return queue
            }
            return [...queue, entry]
          })
        } else {
          logForDebugging(
            `[InboxPoller] ToolUseConfirmQueue unavailable, dropping permission request from ${parsed.agent_id}`,
          )
        }
      }

      // Send desktop notification for the first request
      const firstParsed = permissionRequests[0]?.control
      if (firstParsed && !isLoading && !focusedInputDialog) {
        void sendNotification(
          {
            message: `${firstParsed.agent_id} needs permission for ${firstParsed.tool_name}`,
            notificationType: 'worker_permission_prompt',
          },
          terminal,
        )
      }
    }

    // Handle permission responses (worker side) - invoke registered callbacks
    if (permissionResponses.length > 0 && isTeammate()) {
      logForDebugging(
        `[InboxPoller] Found ${permissionResponses.length} permission response(s)`,
      )

      for (const { message: m, control: parsed } of permissionResponses) {
        // Claim the outstanding request record so a duplicate/racing delivery
        // of the same response can't invoke the callback twice. An unclaimed
        // response (already consumed elsewhere) is still acknowledged —
        // the request has already been resolved, this delivery is stale.
        const claimed = teamName
          ? await claimPendingControl({ teamName, response: m, control: parsed })
          : null
        trackForAck(m)
        if (teamName && !claimed) {
          logForDebugging(
            `[InboxPoller] permission_response for ${parsed.request_id} already claimed/consumed elsewhere — skipping`,
          )
          continue
        }

        if (hasPermissionCallback(parsed.request_id)) {
          logForDebugging(
            `[InboxPoller] Processing permission response for ${parsed.request_id}: ${parsed.subtype}`,
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
        }

        if (teamName && claimed) {
          await finishPendingControl({
            teamName,
            requestId: parsed.request_id,
            outcome: 'consumed',
          }).catch(() => {})
        }
      }
    }

    // Handle sandbox permission requests (leader side) - add to workerSandboxPermissions queue
    if (
      sandboxPermissionRequests.length > 0 &&
      isTeamLead(currentAppState.teamContext)
    ) {
      logForDebugging(
        `[InboxPoller] Found ${sandboxPermissionRequests.length} sandbox permission request(s)`,
      )

      const newSandboxRequests: Array<{
        requestId: string
        workerId: string
        workerName: string
        workerColor?: string
        host: string
        createdAt: number
      }> = []

      for (const { message: m, control: parsed } of sandboxPermissionRequests) {
        trackForAck(m)

        // Validate required nested fields to prevent crashes from malformed messages
        if (!parsed.hostPattern?.host) {
          logForDebugging(
            `[InboxPoller] Invalid sandbox permission request: missing hostPattern.host`,
          )
          continue
        }

        newSandboxRequests.push({
          requestId: parsed.requestId,
          workerId: parsed.workerId,
          workerName: parsed.workerName,
          workerColor: parsed.workerColor,
          host: parsed.hostPattern.host,
          createdAt: parsed.createdAt,
        })
      }

      if (newSandboxRequests.length > 0) {
        setAppState(prev => ({
          ...prev,
          workerSandboxPermissions: {
            ...prev.workerSandboxPermissions,
            queue: [
              ...prev.workerSandboxPermissions.queue,
              ...newSandboxRequests,
            ],
          },
        }))

        // Send desktop notification for the first new request
        const firstRequest = newSandboxRequests[0]
        if (firstRequest && !isLoading && !focusedInputDialog) {
          void sendNotification(
            {
              message: `${firstRequest.workerName} needs network access to ${firstRequest.host}`,
              notificationType: 'worker_permission_prompt',
            },
            terminal,
          )
        }
      }
    }

    // Handle sandbox permission responses (worker side) - invoke registered callbacks
    if (sandboxPermissionResponses.length > 0 && isTeammate()) {
      logForDebugging(
        `[InboxPoller] Found ${sandboxPermissionResponses.length} sandbox permission response(s)`,
      )

      for (const { message: m, control: parsed } of sandboxPermissionResponses) {
        const claimed = teamName
          ? await claimPendingControl({ teamName, response: m, control: parsed })
          : null
        trackForAck(m)
        if (teamName && !claimed) {
          logForDebugging(
            `[InboxPoller] sandbox_permission_response for ${parsed.requestId} already claimed/consumed elsewhere — skipping`,
          )
          continue
        }

        // Check if we have a registered callback for this request
        if (hasSandboxPermissionCallback(parsed.requestId)) {
          logForDebugging(
            `[InboxPoller] Processing sandbox permission response for ${parsed.requestId}: allow=${parsed.allow}`,
          )

          // Process the response using the exported function
          processSandboxPermissionResponse({
            requestId: parsed.requestId,
            host: parsed.host,
            allow: parsed.allow,
          })

          // Clear the pending sandbox request indicator
          setAppState(prev => ({
            ...prev,
            pendingSandboxRequest: null,
          }))
        }

        if (teamName && claimed) {
          await finishPendingControl({
            teamName,
            requestId: parsed.requestId,
            outcome: 'consumed',
          }).catch(() => {})
        }
      }
    }

    // Handle team permission updates (teammate side) - apply permission to context
    if (teamPermissionUpdates.length > 0 && isTeammate()) {
      logForDebugging(
        `[InboxPoller] Found ${teamPermissionUpdates.length} team permission update(s)`,
      )

      for (const { message: m, control: parsed } of teamPermissionUpdates) {
        trackForAck(m)

        // Validate required nested fields to prevent crashes from malformed messages
        if (
          !parsed.permissionUpdate?.rules ||
          !parsed.permissionUpdate?.behavior
        ) {
          logForDebugging(
            `[InboxPoller] Invalid team permission update: missing permissionUpdate.rules or permissionUpdate.behavior`,
          )
          continue
        }

        // Apply the permission update to the teammate's context
        logForDebugging(
          `[InboxPoller] Applying team permission update: ${parsed.toolName} allowed in ${parsed.directoryPath}`,
        )
        logForDebugging(
          `[InboxPoller] Permission update rules: ${jsonStringify(parsed.permissionUpdate.rules)}`,
        )

        setAppState(prev => {
          const updated = applyPermissionUpdate(prev.toolPermissionContext, {
            type: 'addRules',
            rules: parsed.permissionUpdate.rules,
            behavior: parsed.permissionUpdate.behavior,
            destination: 'session',
          })
          logForDebugging(
            `[InboxPoller] Updated session allow rules: ${jsonStringify(updated.alwaysAllowRules.session)}`,
          )
          return {
            ...prev,
            toolPermissionContext: updated,
          }
        })
      }
    }

    // Handle mode set requests (teammate side) - team lead changing teammate's mode
    if (modeSetRequests.length > 0 && isTeammate()) {
      logForDebugging(
        `[InboxPoller] Found ${modeSetRequests.length} mode set request(s)`,
      )

      for (const { message: m, control: parsed } of modeSetRequests) {
        trackForAck(m)
        // Sender authority (must be the team lead) and field-identity binding
        // (control.from === resolved sender name) are already enforced by
        // classifyMailboxMessage — a message only reaches this bucket once
        // both have passed.
        const targetMode = permissionModeFromString(parsed.mode)
        logForDebugging(
          `[InboxPoller] Applying mode change from team-lead: ${targetMode}`,
        )

        // Update local permission context
        setAppState(prev => ({
          ...prev,
          toolPermissionContext: applyPermissionUpdate(
            prev.toolPermissionContext,
            {
              type: 'setMode',
              mode: toExternalPermissionMode(targetMode),
              destination: 'session',
            },
          ),
        }))

        // Update config.json so team lead can see the new mode
        const teamName = currentAppState.teamContext?.teamName
        const agentName = getAgentName()
        if (teamName && agentName) {
          await setMemberMode(teamName, agentName, targetMode)
        }
      }
    }

    // Handle plan approval requests (leader side) - auto-approve and write response to teammate inbox
    if (
      planApprovalRequests.length > 0 &&
      isTeamLead(currentAppState.teamContext)
    ) {
      logForDebugging(
        `[InboxPoller] Found ${planApprovalRequests.length} plan approval request(s), auto-approving`,
      )

      const teamName = currentAppState.teamContext?.teamName
      const leaderExternalMode = toExternalPermissionMode(
        currentAppState.toolPermissionContext.mode,
      )
      const modeToInherit =
        leaderExternalMode === 'plan' ? 'default' : leaderExternalMode

      for (const { message: m, control: parsed } of planApprovalRequests) {
        trackForAck(m)

        if (!teamName) continue
        const recipient =
          controlSnapshot && resolveTeamPrincipalByName(controlSnapshot, m.from)
        if (!recipient) {
          logForDebugging(
            `[InboxPoller] Cannot auto-approve plan for ${m.from}: not in the current roster`,
          )
          regularMessages.push(m)
          continue
        }

        const approvalResponse = createPlanApprovalResponseMessage({
          requestId: parsed.requestId,
          approved: true,
          permissionMode: modeToInherit,
        })

        writeControlToMailbox({
          recipient,
          control: approvalResponse,
          teamName,
        }).catch(error => {
          logForDebugging(
            `[InboxPoller] Failed to send plan approval to ${m.from}: ${error}`,
          )
        })

        // Update in-process teammate task state if applicable
        const taskId = findInProcessTeammateTaskId(m.from, currentAppState)
        if (taskId) {
          handlePlanApprovalResponse(taskId, approvalResponse, setAppState)
        }

        logForDebugging(
          `[InboxPoller] Auto-approved plan from ${m.from} (request ${parsed.requestId})`,
        )

        // Still pass through as a regular message so the model has context
        // about what the teammate is doing, but the approval is already sent
        regularMessages.push(m)
      }
    }

    // Handle shutdown requests (teammate side) - preserve JSON for UI rendering
    if (shutdownRequests.length > 0 && isTeammate()) {
      logForDebugging(
        `[InboxPoller] Found ${shutdownRequests.length} shutdown request(s)`,
      )

      // Pass through shutdown requests - the UI component will render them nicely
      // and the model will receive instructions via the tool prompt documentation
      for (const { message: m } of shutdownRequests) {
        trackForAck(m)
        regularMessages.push(m)
      }
    }

    // Handle shutdown approvals (leader side) - kill the teammate's pane
    if (
      shutdownApprovals.length > 0 &&
      isTeamLead(currentAppState.teamContext)
    ) {
      logForDebugging(
        `[InboxPoller] Found ${shutdownApprovals.length} shutdown approval(s)`,
      )

      for (const { message: m, control: parsed } of shutdownApprovals) {
        // Compare-and-swap the outstanding shutdown_request record so a
        // concurrently racing consumer (a previous/overlapping poll, or the
        // headless attachments.ts path) can't double-process the same
        // approval. Only the claim winner removes the teammate/kills the
        // pane; the message stays unread (not tracked for ack) on failure,
        // so a later poll retries.
        const teamNameForClaim = currentAppState.teamContext?.teamName
        const claimed = teamNameForClaim
          ? await claimPendingControl({
              teamName: teamNameForClaim,
              response: m,
              control: parsed,
            })
          : null
        if (!claimed) {
          logForDebugging(
            `[InboxPoller] shutdown_approved for request ${parsed.requestId} already claimed/consumed elsewhere — skipping`,
          )
          regularMessages.push(m)
          continue
        }

        try {
          // Kill the pane if we have the info (pane-based teammates)
          if (parsed.paneId && parsed.backendType) {
            try {
              // Ensure backend classes are imported (no subprocess probes)
              await ensureBackendsRegistered()
              const insideTmux = await isInsideTmux()
              const backend = getBackendByType(
                parsed.backendType as PaneBackendType,
              )
              const success = await backend?.killPane(
                parsed.paneId!,
                !insideTmux,
              )
              logForDebugging(
                `[InboxPoller] Killed pane ${parsed.paneId} for ${parsed.from}: ${success}`,
              )
            } catch (error) {
              logForDebugging(
                `[InboxPoller] Failed to kill pane for ${parsed.from}: ${error}`,
              )
            }
          }

          // Remove the teammate from teamContext.teammates so the count is
          // accurate. Uses the envelope's SENDER identity (validated by
          // classifyMailboxMessage against the current roster), never
          // `control.from` independently.
          const teammateId = m.senderAgentId
          const teammateToRemove = m.from
          if (teammateId && currentAppState.teamContext?.teammates) {
            // Remove from team file (leader owns team file mutations)
            const teamName = currentAppState.teamContext?.teamName
            if (teamName) {
              await removeTeammateFromTeamFile(teamName, {
                agentId: teammateId,
                name: teammateToRemove,
              })
            }

            // Unassign tasks and build notification message
            const { notificationMessage } = teamName
              ? await unassignTeammateTasks(
                  teamName,
                  teammateId,
                  teammateToRemove,
                  'shutdown',
                )
              : { notificationMessage: `${teammateToRemove} has shut down.` }

            setAppState(prev => {
              if (!prev.teamContext?.teammates) return prev
              if (!(teammateId in prev.teamContext.teammates)) return prev
              const { [teammateId]: _, ...remainingTeammates } =
                prev.teamContext.teammates

              // Mark the teammate's task as completed so hasRunningTeammates
              // becomes false and the spinner stops. Without this, out-of-process
              // (tmux) teammate tasks stay status:'running' forever because
              // only in-process teammates have a runner that sets 'completed'.
              const updatedTasks = { ...prev.tasks }
              for (const [tid, task] of Object.entries(updatedTasks)) {
                if (
                  isInProcessTeammateTask(task) &&
                  task.identity.agentId === teammateId
                ) {
                  updatedTasks[tid] = {
                    ...task,
                    status: 'completed' as const,
                    endTime: Date.now(),
                  }
                }
              }

              return {
                ...prev,
                tasks: updatedTasks,
                teamContext: {
                  ...prev.teamContext,
                  teammates: remainingTeammates,
                },
                inbox: {
                  messages: [
                    ...prev.inbox.messages,
                    {
                      id: randomUUID(),
                      from: 'system',
                      text: jsonStringify({
                        type: 'teammate_terminated',
                        message: notificationMessage,
                      }),
                      timestamp: new Date().toISOString(),
                      status: 'pending' as const,
                    },
                  ],
                },
              }
            })
            logForDebugging(
              `[InboxPoller] Removed ${teammateToRemove} (${teammateId}) from teamContext`,
            )
          }

          await finishPendingControl({
            teamName: teamNameForClaim!,
            requestId: parsed.requestId,
            outcome: 'consumed',
          })
          trackForAck(m)
        } catch (error) {
          logForDebugging(
            `[InboxPoller] Failed handling shutdown_approved for request ${parsed.requestId}: ${error}`,
          )
          await finishPendingControl({
            teamName: teamNameForClaim!,
            requestId: parsed.requestId,
            outcome: 'retry',
          }).catch(() => {})
          // Leave unread (not tracked for ack) for a later poll to retry.
        }

        // Pass through for UI rendering - the component will render it nicely
        regularMessages.push(m)
      }
    }

    // Process regular teammate messages (existing logic)
    if (regularMessages.length === 0) {
      // No regular messages, but we may have processed non-regular messages
      // (permissions, shutdown requests, etc.) above — mark those as read.
      markRead()
      return
    }

    const teammateMessages = regularMessages.map(message =>
      toTeammateMessageContract({
        from: message.from,
        text: message.text,
        color: message.color,
        summary: message.summary,
        structured: message.structured,
      }),
    )
    const formatted = formatTeammateMessagesForModel(teammateMessages)

    // Helper to queue messages in AppState for later delivery
    const queueMessages = () => {
      setAppState(prev => ({
        ...prev,
        inbox: {
          messages: [
            ...prev.inbox.messages,
            ...regularMessages.map(m => ({
              id: randomUUID(),
              from: m.from,
              text: m.text,
              timestamp: m.timestamp,
              status: 'pending' as const,
              color: m.color,
              summary: m.summary,
              structured: m.structured,
              kind: 'teammate' as const,
            })),
          ],
        },
      }))
    }

    if (!isLoading && !focusedInputDialog) {
      // IDLE: Submit as new turn immediately
      logForDebugging(`[InboxPoller] Session idle, submitting immediately`)
      const submitted = onSubmitTeammateMessage(formatted, {
        teammateMessages,
      })
      if (!submitted) {
        // Submission rejected (query already running), queue for later
        logForDebugging(
          `[InboxPoller] Submission rejected, queuing for later delivery`,
        )
        queueMessages()
      }
    } else {
      // BUSY: Add to inbox queue for UI display + later delivery
      logForDebugging(`[InboxPoller] Session busy, queuing for later delivery`)
      queueMessages()
    }

    // Mark messages as read only after they have been successfully delivered
    // or reliably queued in AppState. This prevents permanent message loss
    // when the session is busy — if we crash before this point, the messages
    // will be re-read on the next poll cycle instead of being silently dropped.
    markRead()
  }, [
    enabled,
    isLoading,
    focusedInputDialog,
    onSubmitTeammateMessage,
    setAppState,
    terminal,
    store,
  ])

  // When session becomes idle, deliver any pending messages and clean up processed ones
  useEffect(() => {
    if (!enabled) return

    // Skip if busy or in a dialog
    if (isLoading || focusedInputDialog) {
      return
    }

    // Use ref to avoid dependency on appState object (prevents infinite loop)
    const currentAppState = store.getState()
    const agentName = getAgentNameToPoll(currentAppState)
    if (!agentName) return

    const pendingMessages = currentAppState.inbox.messages.filter(
      m => m.status === 'pending',
    )
    const processedMessages = currentAppState.inbox.messages.filter(
      m => m.status === 'processed',
    )

    // Clean up processed messages (they were already delivered mid-turn as attachments)
    if (processedMessages.length > 0) {
      logForDebugging(
        `[InboxPoller] Cleaning up ${processedMessages.length} processed message(s) that were delivered mid-turn`,
      )
      const processedIds = new Set(processedMessages.map(m => m.id))
      setAppState(prev => ({
        ...prev,
        inbox: {
          messages: prev.inbox.messages.filter(m => !processedIds.has(m.id)),
        },
      }))
    }

    // No pending messages to deliver
    if (pendingMessages.length === 0) return

    logForDebugging(
      `[InboxPoller] Session idle, delivering ${pendingMessages.length} pending message(s)`,
    )

    const teammateMessages = pendingMessages.map(m => ({
      kind: 'teammate' as const,
      from: m.from,
      text: m.text,
      color: m.color,
      summary: m.summary,
      structured: 'structured' in m ? m.structured : undefined,
    }))
    const formatted = formatTeammateMessagesForModel(teammateMessages)

    // Try to submit - only clear messages if successful
    const submitted = onSubmitTeammateMessage(formatted, {
      teammateMessages,
    })
    if (submitted) {
      // Clear the specific messages we just submitted by their IDs
      const submittedIds = new Set(pendingMessages.map(m => m.id))
      setAppState(prev => ({
        ...prev,
        inbox: {
          messages: prev.inbox.messages.filter(m => !submittedIds.has(m.id)),
        },
      }))
    } else {
      logForDebugging(
        `[InboxPoller] Submission rejected, keeping messages queued`,
      )
    }
  }, [
    enabled,
    isLoading,
    focusedInputDialog,
    onSubmitTeammateMessage,
    setAppState,
    inboxMessageCount,
    store,
  ])

  // Poll if running as a teammate or as a team lead
  const shouldPoll = enabled && !!getAgentNameToPoll(store.getState())
  useInterval(() => void poll(), shouldPoll ? INBOX_POLL_INTERVAL_MS : null)

  // Initial poll on mount (only once)
  const hasDoneInitialPollRef = useRef(false)
  useEffect(() => {
    if (!enabled) return
    if (hasDoneInitialPollRef.current) return
    // Use store.getState() to avoid dependency on appState object
    if (getAgentNameToPoll(store.getState())) {
      hasDoneInitialPollRef.current = true
      void poll()
    }
    // Note: poll uses store.getState() (not appState) so it won't re-run on appState changes
    // The ref guard is a safety measure to ensure initial poll only happens once
  }, [enabled, poll, store])
}
