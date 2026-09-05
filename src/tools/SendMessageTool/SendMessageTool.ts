import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { isReplBridgeActive } from '../../bootstrap/state.js'
import { getSessionId } from '../../bootstrap/state.js'
import { getReplBridgeHandle } from '../../bridge/replBridgeHandle.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { findTeammateTaskByAgentId } from '../../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import {
  isLocalAgentTask,
  queuePendingMessageIfRunning,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isMainSessionTask } from '../../tasks/LocalMainSessionTask.js'
import { generateRequestId } from '../../utils/agentId.js'
import {
  isAgentSwarmsEnabled,
  isAgentTeamsOptedIn,
} from '../../utils/agentSwarmsEnabled.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { truncate } from '../../utils/format.js'
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { parseAddress } from '../../utils/peerAddress.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import type { BackendType } from '../../utils/swarm/backends/types.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import {
  readTeamFileAsync,
  readTeamSnapshot,
  type TeamFile,
} from '../../utils/swarm/teamHelpers.js'
import { sanitizePathComponent } from '../../utils/tasks.js'
import {
  getAgentName,
  getTeammateColor,
  getTeamName,
  isTeamLead,
  isTeammate,
} from '../../utils/teammate.js'
import {
  createPlanApprovalResponseMessage,
  createShutdownApprovedMessage,
  createShutdownRejectedMessage,
  createShutdownRequestMessage,
  MailboxWriteError,
  type PendingControlRecord,
  resolveCurrentTeamPrincipal,
  resolveLeaderPrincipal,
  resolveTeamPrincipalByName,
  type TeamPrincipal,
  writeControlRequestToMailbox,
  writeControlToMailbox,
  writeToMailbox,
} from '../../utils/teammateMailbox.js'
import { toExternalPermissionMode } from '../../utils/permissions/PermissionMode.js'
import {
  toTeammateMessageContract,
  type TeammateStructuredPayload,
} from '../../utils/teammateMessage.js'
import { parseLocalRecipient, recipientNameKey } from '../../utils/recipientIdentity.js'
import {
  formatContextSizeHint,
  resolveAgentTarget,
} from '../AgentTool/resolveAgentTarget.js'
import { SEND_MESSAGE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const StructuredMessage = lazySchema(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('shutdown_request'),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal('shutdown_response'),
      request_id: z.string(),
      approve: semanticBoolean(),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal('plan_approval_response'),
      request_id: z.string(),
      approve: semanticBoolean(),
      feedback: z.string().optional(),
    }),
  ]),
)

const inputSchema = lazySchema(() =>
  z.object({
    to: z
      .string()
      .describe(
        feature('UDS_INBOX')
          ? 'Recipient (must be currently running): a running subagent by its friendly name/alias, worker handle, or raw agent ID; a teammate name or "*" when Agent Teams is enabled; "uds:<socket-path>" for a local peer; or "bridge:<session-id>" for a Remote Control peer (use ListPeers to discover). If the subagent has stopped, use ResumeAgent instead.'
          : 'Recipient (must be currently running): a running subagent by its friendly name/alias, worker handle, or raw agent ID; or a teammate name/"*" when Agent Teams is enabled. If the subagent has stopped, use ResumeAgent instead.',
      ),
    summary: z
      .string()
      .optional()
      .describe(
        'A 5-10 word summary shown as a preview in the UI (required when message is a string)',
      ),
    message: isAgentTeamsOptedIn()
      ? z.union([
          z.string().describe('Plain text message content'),
          StructuredMessage(),
        ])
      : z.string().describe('Plain text message content'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export type Input = z.infer<InputSchema>

export type MessageRouting = {
  sender: string
  senderColor?: string
  target: string
  targetColor?: string
  summary?: string
  content?: string
}

export type MessageOutput = {
  success: boolean
  message: string
  routing?: MessageRouting
}

export type FailedRecipient = { name: string; error: string }

export type BroadcastOutput = {
  success: boolean
  message: string
  recipients: string[]
  failed_recipients?: FailedRecipient[]
  routing?: MessageRouting
}

export type RequestOutput = {
  success: boolean
  message: string
  request_id: string
  target: string
}

export type ResponseOutput = {
  success: boolean
  message: string
  request_id?: string
}

export type SendMessageToolOutput =
  | MessageOutput
  | BroadcastOutput
  | RequestOutput
  | ResponseOutput

function findTeammateColor(
  appState: {
    teamContext?: { teammates: { [id: string]: { color?: string } } }
  },
  name: string,
): string | undefined {
  const teammates = appState.teamContext?.teammates
  if (!teammates) return undefined
  for (const teammate of Object.values(teammates)) {
    if ('name' in teammate && (teammate as { name: string }).name === name) {
      return teammate.color
    }
  }
  return undefined
}

type RosterResolution =
  | { kind: 'none' }
  | { kind: 'member'; member: TeamPrincipal }
  | { kind: 'ambiguous' }

/**
 * Resolves a bare (non-`@`) name against a fresh version-2 team snapshot.
 * Only `active` teammate recipient records are routable — `reserved`,
 * `starting`, `stopped`, and `terminated` fail closed to `none` so the
 * caller falls through to local-worker resolution instead of guessing.
 *
 * Ambiguity is detected on either the routing key (`recipientNameKey`) or the
 * sanitized mailbox-file path (`sanitizePathComponent`): two legacy names
 * like "legacy.name" and "legacy-name" key differently but collide on disk
 * (`sanitizePathComponent` maps both to `legacy-name`), so delivery would be
 * indistinguishable between them. Per the plan's design decision, that fails
 * closed as ambiguous rather than silently picking one.
 */
async function resolveFreshRosterMember(
  teamName: string,
  targetName: string,
): Promise<RosterResolution> {
  let snapshot: Readonly<TeamFile>
  try {
    snapshot = await readTeamSnapshot(teamName)
  } catch {
    return { kind: 'none' }
  }

  const targetKey = recipientNameKey(targetName)
  const targetPath = sanitizePathComponent(targetName)
  const candidates = (snapshot.recipientRecords ?? []).filter(
    record =>
      record.kind === 'teammate' &&
      record.status === 'active' &&
      (recipientNameKey(record.name) === targetKey ||
        sanitizePathComponent(record.name) === targetPath),
  )

  if (candidates.length === 0) return { kind: 'none' }
  const distinctAllocationIds = new Set(candidates.map(c => c.allocationId))
  if (distinctAllocationIds.size > 1) return { kind: 'ambiguous' }

  const record = candidates[0]!
  return {
    kind: 'member',
    member: {
      kind: 'teammate',
      agentId: record.agentId,
      name: record.name,
      allocationId: record.allocationId,
    },
  }
}

/**
 * Routes a plain-text message to a roster-resolved teammate. The recipient
 * has already been confirmed `active` by `resolveFreshRosterMember` — this
 * only performs the mailbox write and reports its truthful outcome. A
 * successful result means "written to the addressed incarnation's mailbox,"
 * not "processed by the recipient."
 */
async function routeToTeammate(
  member: TeamPrincipal,
  teammateMessage: {
    from: string
    text: string
    color?: string
    summary?: string
    structured?: TeammateStructuredPayload
  },
  teamName: string,
  context: ToolUseContext,
): Promise<{ data: MessageOutput }> {
  try {
    await writeToMailbox({
      recipient: member,
      message: {
        text: teammateMessage.text,
        summary: teammateMessage.summary,
        color: teammateMessage.color,
        structured: teammateMessage.structured,
      },
      teamName,
    })
  } catch (error) {
    return {
      data: {
        success: false,
        message: `Failed to send to ${member.name}: ${errorMessage(error)}`,
      },
    }
  }

  const appState = context.getAppState()
  const recipientColor = findTeammateColor(appState, member.name)

  return {
    data: {
      success: true,
      message: `Message sent to ${member.name}'s inbox`,
      routing: {
        sender: teammateMessage.from,
        senderColor: teammateMessage.color,
        target: `@${member.name}`,
        targetColor: recipientColor,
        summary: teammateMessage.summary,
        content: teammateMessage.text,
      },
    },
  }
}

/**
 * Resolves a target against running/resumable local subagents (registered
 * alias, durable worker handle, or raw agent ID) — used both for explicit
 * `@name` targets (which never consult the team roster) and as the fallback
 * for a bare name with no active-teammate match. Returns `null` when there is
 * no local match at all, letting the caller decide the final failure.
 */
async function routeToLocalWorker(
  target: string,
  displayInput: string,
  message: string,
  context: ToolUseContext,
): Promise<{ data: MessageOutput } | null> {
  const appState = context.getAppState()
  const resolved = await resolveAgentTarget({
    input: target,
    appState,
    sessionId: getSessionId(),
  })
  if (!resolved) return null

  const { agentId } = resolved
  // Re-read state after resolution: resolveAgentTarget may have awaited
  // I/O, during which another SendMessage/ResumeAgent call could have
  // changed this task's status. Route the running/stopped decision off
  // fresh state, not the snapshot captured before resolution.
  const freshAppState = context.getAppState()
  const task = freshAppState.tasks[agentId]
  if (isLocalAgentTask(task) && !isMainSessionTask(task)) {
    const queued = queuePendingMessageIfRunning(
      agentId,
      message,
      context.setAppStateForTasks ?? context.setAppState,
    )
    if (queued) {
      return {
        data: {
          success: true,
          message: `Message queued for delivery to ${displayInput} at its next tool round.`,
        },
      }
    }
  }
  const resumeTarget = resolved.displayName.startsWith('@')
    ? resolved.displayName
    : displayInput.trim()
  return {
    data: {
      success: false,
      message: `Agent "${resolved.displayName}" is stopped. Use ResumeAgent({ agentId: "${resumeTarget}", prompt }) to restart it.${formatContextSizeHint(resolved.contextTokens, resolved.contextWindowTokens)}`,
    },
  }
}

async function handleBroadcast(
  content: string,
  summary: string | undefined,
  context: ToolUseContext,
): Promise<{ data: BroadcastOutput }> {
  const appState = context.getAppState()
  const teamName = getTeamName(appState.teamContext)

  if (!teamName) {
    throw new Error(
      'Not in a team context. Create a team with Teammate spawnTeam first, or set CLAUDE_CODE_TEAM_NAME.',
    )
  }

  const snapshot = await readTeamSnapshot(teamName)

  const senderName =
    getAgentName() || (isTeammate() ? 'teammate' : TEAM_LEAD_NAME)
  if (!senderName) {
    throw new Error(
      'Cannot broadcast: sender name is required. Set CLAUDE_CODE_AGENT_NAME.',
    )
  }

  const senderColor = getTeammateColor()

  const targets: TeamPrincipal[] = (snapshot.recipientRecords ?? [])
    .filter(
      record =>
        record.kind === 'teammate' &&
        record.status === 'active' &&
        record.name.toLowerCase() !== senderName.toLowerCase(),
    )
    .map(record => ({
      kind: 'teammate' as const,
      agentId: record.agentId,
      name: record.name,
      allocationId: record.allocationId,
    }))

  if (targets.length === 0) {
    return {
      data: {
        success: true,
        message: 'No teammates to broadcast to (you are the only team member)',
        recipients: [],
      },
    }
  }

  const settled = await Promise.allSettled(
    targets.map(target =>
      writeToMailbox({
        recipient: target,
        message: { text: content, summary, color: senderColor },
        teamName,
      }),
    ),
  )

  const recipients: string[] = []
  const failedRecipients: FailedRecipient[] = []
  settled.forEach((outcome, index) => {
    const target = targets[index]!
    if (outcome.status === 'fulfilled') {
      recipients.push(target.name)
    } else {
      failedRecipients.push({ name: target.name, error: errorMessage(outcome.reason) })
    }
  })

  const success = failedRecipients.length === 0
  const message = success
    ? `Message broadcast to ${recipients.length} teammate(s): ${recipients.join(', ')}`
    : `Message broadcast to ${recipients.length} of ${targets.length} teammate(s); failed: ${failedRecipients.map(f => f.name).join(', ')}`

  return {
    data: {
      success,
      message,
      recipients,
      ...(failedRecipients.length > 0 ? { failed_recipients: failedRecipients } : {}),
      routing: {
        sender: senderName,
        senderColor,
        target: '@team',
        summary,
        content,
      },
    },
  }
}

/**
 * Reads the call-time team snapshot, resolves the calling principal, and checks
 * its role. The call-time snapshot is authoritative — validation may have
 * preceded a permission wait, so re-checking here is what actually matters.
 *
 * Returns the refusal reason rather than throwing, because each caller wraps it
 * in its own output shape (RequestOutput carries a target, ResponseOutput does
 * not).
 */
async function resolveAuthorizedSender(
  teamName: string,
  requiredKind: TeamPrincipal['kind'],
  unauthorizedMessage: string,
): Promise<
  { snapshot: Readonly<TeamFile>; sender: TeamPrincipal } | { error: string }
> {
  let snapshot: Readonly<TeamFile>
  let sender: TeamPrincipal
  try {
    snapshot = await readTeamSnapshot(teamName)
    sender = await resolveCurrentTeamPrincipal(teamName, snapshot)
  } catch (error) {
    return { error: `Cannot verify team roster: ${errorMessage(error)}` }
  }
  if (sender.kind !== requiredKind) {
    return { error: unauthorizedMessage }
  }
  return { snapshot, sender }
}

/**
 * Resolves the leader principal and confirms one outstanding shutdown request
 * matching the exact request id and the leader/sender agent+allocation ID
 * tuple — the same correlation `classifyMailboxMessage`/`claimPendingControl`
 * use, but as a read-only existence check for a teammate about to send the
 * RESPONSE side (shutdown approval/rejection). A `consumed` record never
 * matches (replay/duplicate); the actual claim-to-`processing` happens on
 * the leader's consumption side (useInboxPoller/attachments.ts).
 *
 * Returns the leader rather than the matched record: neither caller reads the
 * record, only the leader it correlates against.
 */
function requireOutstandingShutdown(
  snapshot: Readonly<TeamFile>,
  requestId: string,
  sender: TeamPrincipal,
): { leader: TeamPrincipal } | { error: string } {
  const leader = resolveLeaderPrincipal(snapshot)
  const pending = (snapshot.pendingControls ?? []).find(
    (p: PendingControlRecord) =>
      p.requestId === requestId &&
      p.requestType === 'shutdown' &&
      p.state !== 'consumed' &&
      p.senderAgentId === leader.agentId &&
      p.senderAllocationId === leader.allocationId &&
      p.recipientAgentId === sender.agentId &&
      p.recipientAllocationId === sender.allocationId,
  )
  if (!pending) {
    return {
      error: `No outstanding shutdown request "${requestId}" found for you. It may already be resolved or was never sent to you.`,
    }
  }
  return { leader }
}

async function handleShutdownRequest(
  targetName: string,
  reason: string | undefined,
  context: ToolUseContext,
): Promise<{ data: RequestOutput }> {
  const appState = context.getAppState()
  const teamName = getTeamName(appState.teamContext)
  if (!teamName) {
    return {
      data: {
        success: false,
        message: 'Not in a team context.',
        request_id: '',
        target: targetName,
      },
    }
  }

  // Authority: only the team lead may issue a shutdown_request.
  const authorized = await resolveAuthorizedSender(
    teamName,
    'leader',
    'Only the team lead can request teammate shutdown.',
  )
  if ('error' in authorized) {
    return {
      data: {
        success: false,
        message: authorized.error,
        request_id: '',
        target: targetName,
      },
    }
  }
  const sender = authorized.sender

  const roster = await resolveFreshRosterMember(teamName, targetName)
  if (roster.kind !== 'member') {
    return {
      data: {
        success: false,
        message:
          roster.kind === 'ambiguous'
            ? `"${targetName}" is an ambiguous legacy teammate name: multiple teammates share the same routing key or mailbox path.`
            : `No active teammate named "${targetName}" to shut down.`,
        request_id: '',
        target: targetName,
      },
    }
  }

  const requestId = generateRequestId('shutdown', targetName)
  const shutdownMessage = createShutdownRequestMessage({
    requestId,
    from: sender.name,
    reason,
  })

  try {
    // The team lock is released before this write; the envelope binds the
    // exact recipient allocation so a concurrent removal/replacement can't
    // retarget it.
    await writeControlRequestToMailbox({
      teamName,
      requestId,
      requestType: 'shutdown',
      recipient: roster.member,
      control: shutdownMessage,
      color: getTeammateColor(),
    })
  } catch (error) {
    return {
      data: {
        success: false,
        message: `Failed to send shutdown request to ${targetName}: ${errorMessage(error)}`,
        request_id: requestId,
        target: targetName,
      },
    }
  }

  return {
    data: {
      success: true,
      message: `Shutdown request sent to ${targetName}. Request ID: ${requestId}`,
      request_id: requestId,
      target: targetName,
    },
  }
}

async function handleShutdownApproval(
  requestId: string,
  context: ToolUseContext,
): Promise<{ data: ResponseOutput }> {
  const teamName = getTeamName()
  if (!teamName) {
    return {
      data: { success: false, message: 'Not in a team context.', request_id: requestId },
    }
  }

  const authorized = await resolveAuthorizedSender(
    teamName,
    'teammate',
    'Only a teammate can approve its own shutdown.',
  )
  if ('error' in authorized) {
    return {
      data: { success: false, message: authorized.error, request_id: requestId },
    }
  }
  const sender = authorized.sender

  const outstanding = requireOutstandingShutdown(
    authorized.snapshot,
    requestId,
    sender,
  )
  if ('error' in outstanding) {
    return {
      data: { success: false, message: outstanding.error, request_id: requestId },
    }
  }
  const leader = outstanding.leader

  logForDebugging(
    `[SendMessageTool] handleShutdownApproval: teamName=${teamName}, agentId=${sender.agentId}, agentName=${sender.name}`,
  )

  let ownPaneId: string | undefined
  let ownBackendType: BackendType | undefined
  const teamFile = await readTeamFileAsync(teamName)
  if (teamFile) {
    const selfMember = teamFile.members.find(m => m.agentId === sender.agentId)
    if (selfMember) {
      ownPaneId = selfMember.tmuxPaneId
      ownBackendType = selfMember.backendType
    }
  }

  const approvedMessage = createShutdownApprovedMessage({
    requestId,
    from: sender.name,
    paneId: ownPaneId,
    backendType: ownBackendType,
  })

  // Acknowledgement success is a prerequisite for shutdown (Task 3 Step 10):
  // abort the in-process controller / schedule process exit only AFTER the
  // response has actually been written. On failure, the teammate stays
  // alive and the request remains outstanding for retry.
  let writeResult: Awaited<ReturnType<typeof writeControlToMailbox>>
  try {
    writeResult = await writeControlToMailbox({
      recipient: leader,
      control: approvedMessage,
      teamName,
      color: getTeammateColor(),
    })
  } catch (error) {
    return {
      data: {
        success: false,
        message: `Failed to send shutdown approval: ${errorMessage(error)}`,
        request_id: requestId,
      },
    }
  }
  if (writeResult.warning) {
    // { written: true, warning } means the response exists in the mailbox —
    // log/surface the warning but do not retry or block shutdown.
    logForDebugging(`[SendMessageTool] ${writeResult.warning}`)
  }

  const agentId = sender.agentId
  const agentName = sender.name

  if (ownBackendType === 'in-process') {
    logForDebugging(
      `[SendMessageTool] In-process teammate ${agentName} approving shutdown - signaling abort`,
    )

    const appState = context.getAppState()
    const task = findTeammateTaskByAgentId(agentId, appState.tasks)
    if (task?.abortController) {
      task.abortController.abort()
      logForDebugging(
        `[SendMessageTool] Aborted controller for in-process teammate ${agentName}`,
      )
    } else {
      logForDebugging(
        `[SendMessageTool] Warning: Could not find task/abortController for ${agentName}`,
      )
    }
  } else {
    const appState = context.getAppState()
    const task = findTeammateTaskByAgentId(agentId, appState.tasks)
    if (task?.abortController) {
      logForDebugging(
        `[SendMessageTool] Fallback: Found in-process task for ${agentName} via AppState, aborting`,
      )
      task.abortController.abort()

      return {
        data: {
          success: true,
          message: `Shutdown approved (fallback path). Agent ${agentName} is now exiting.`,
          request_id: requestId,
        },
      }
    }

    setImmediate(async () => {
      await gracefulShutdown(0, 'other')
    })
  }

  return {
    data: {
      success: true,
      message: `Shutdown approved. Sent confirmation to team-lead. Agent ${agentName} is now exiting.`,
      request_id: requestId,
    },
  }
}

async function handleShutdownRejection(
  requestId: string,
  reason: string,
): Promise<{ data: ResponseOutput }> {
  const teamName = getTeamName()
  if (!teamName) {
    return {
      data: { success: false, message: 'Not in a team context.', request_id: requestId },
    }
  }

  const authorized = await resolveAuthorizedSender(
    teamName,
    'teammate',
    'Only a teammate can reject its own shutdown request.',
  )
  if ('error' in authorized) {
    return {
      data: { success: false, message: authorized.error, request_id: requestId },
    }
  }
  const sender = authorized.sender

  const outstanding = requireOutstandingShutdown(
    authorized.snapshot,
    requestId,
    sender,
  )
  if ('error' in outstanding) {
    return {
      data: { success: false, message: outstanding.error, request_id: requestId },
    }
  }
  const leader = outstanding.leader

  const rejectedMessage = createShutdownRejectedMessage({
    requestId,
    from: sender.name,
    reason,
  })

  try {
    await writeControlToMailbox({
      recipient: leader,
      control: rejectedMessage,
      teamName,
      color: getTeammateColor(),
    })
  } catch (error) {
    return {
      data: {
        success: false,
        message: `Failed to send shutdown rejection: ${errorMessage(error)}`,
        request_id: requestId,
      },
    }
  }

  return {
    data: {
      success: true,
      message: `Shutdown rejected. Reason: "${reason}". Continuing to work.`,
      request_id: requestId,
    },
  }
}

async function handlePlanDecision(
  recipientName: string,
  requestId: string,
  decision: { outcome: 'approved' } | { outcome: 'rejected'; feedback: string },
  context: ToolUseContext,
): Promise<{ data: ResponseOutput }> {
  const appState = context.getAppState()
  const teamName = appState.teamContext?.teamName
  const approved = decision.outcome === 'approved'
  const verb = approved ? 'approve' : 'reject'

  if (!isTeamLead(appState.teamContext) || !teamName) {
    throw new Error(
      `Only the team lead can ${verb} plans. Teammates cannot ${verb} their own or other plans.`,
    )
  }

  const authorized = await resolveAuthorizedSender(
    teamName,
    'leader',
    `Only the team lead can ${verb} plans.`,
  )
  if ('error' in authorized) {
    return {
      data: { success: false, message: authorized.error, request_id: requestId },
    }
  }

  const recipient = resolveTeamPrincipalByName(authorized.snapshot, recipientName)
  if (!recipient) {
    return {
      data: {
        success: false,
        message: `No teammate named "${recipientName}" found in the current roster.`,
        request_id: requestId,
      },
    }
  }

  let response: ReturnType<typeof createPlanApprovalResponseMessage>
  if (decision.outcome === 'approved') {
    const leaderExternalMode = toExternalPermissionMode(
      appState.toolPermissionContext.mode,
    )
    response = createPlanApprovalResponseMessage({
      requestId,
      approved: true,
      permissionMode:
        leaderExternalMode === 'plan' ? 'default' : leaderExternalMode,
    })
  } else {
    response = createPlanApprovalResponseMessage({
      requestId,
      approved: false,
      feedback: decision.feedback,
    })
  }

  try {
    await writeControlToMailbox({
      recipient,
      control: response,
      teamName,
    })
  } catch (error) {
    return {
      data: {
        success: false,
        message: `Failed to send plan ${approved ? 'approval' : 'rejection'} to ${recipientName}: ${errorMessage(error)}`,
        request_id: requestId,
      },
    }
  }

  return {
    data: {
      success: true,
      message:
        decision.outcome === 'approved'
          ? `Plan approved for ${recipientName}. They will receive the approval and can proceed with implementation.`
          : `Plan rejected for ${recipientName} with feedback: "${decision.feedback}"`,
      request_id: requestId,
    },
  }
}

export const SendMessageTool: Tool<InputSchema, SendMessageToolOutput> =
  buildTool({
    name: SEND_MESSAGE_TOOL_NAME,
    searchHint: 'send messages to subagents, Agent Mode workers, or agent teammates',
    maxResultSizeChars: 100_000,

    userFacingName() {
      return 'SendMessage'
    },

    get inputSchema(): InputSchema {
      return inputSchema()
    },
    shouldDefer: true,
    alwaysLoad: true,

    isEnabled() {
      return true
    },

    isReadOnly(input) {
      return typeof input.message === 'string'
    },

    backfillObservableInput(input) {
      if ('type' in input) return
      if (typeof input.to !== 'string') return

      if (input.to === '*') {
        input.type = 'broadcast'
        if (typeof input.message === 'string') input.content = input.message
      } else if (typeof input.message === 'string') {
        input.type = 'message'
        input.recipient = input.to
        input.content = input.message
      } else if (typeof input.message === 'object' && input.message !== null) {
        const msg = input.message as {
          type?: string
          request_id?: string
          approve?: boolean
          reason?: string
          feedback?: string
        }
        input.type = msg.type
        input.recipient = input.to
        if (msg.request_id !== undefined) input.request_id = msg.request_id
        if (msg.approve !== undefined) input.approve = msg.approve
        const content = msg.reason ?? msg.feedback
        if (content !== undefined) input.content = content
      }
    },

    toAutoClassifierInput(input) {
      if (typeof input.message === 'string') {
        return `to ${input.to}: ${input.message}`
      }
      switch (input.message.type) {
        case 'shutdown_request':
          return `shutdown_request to ${input.to}`
        case 'shutdown_response':
          return `shutdown_response ${input.message.approve ? 'approve' : 'reject'} ${input.message.request_id}`
        case 'plan_approval_response':
          return `plan_approval ${input.message.approve ? 'approve' : 'reject'} to ${input.to}`
      }
    },

    async checkPermissions(input, _context) {
      if (feature('UDS_INBOX') && parseAddress(input.to).scheme === 'bridge') {
        return {
          behavior: 'ask' as const,
          message: `Send a message to Remote Control session ${input.to}? It arrives as a user prompt on the receiving Claude (possibly another machine) via Anthropic's servers.`,
          // safetyCheck (not mode) — permissions.ts guards this before both
          // bypassPermissions (step 1g) and auto-mode's allowlist/classifier.
          // Cross-machine prompt injection must stay bypass-immune.
          decisionReason: {
            type: 'safetyCheck',
            reason:
              'Cross-machine bridge message requires explicit user consent',
            classifierApprovable: false,
          },
        }
      }
      return { behavior: 'allow' as const, updatedInput: input }
    },

    async validateInput(input, context) {
      if (input.to.trim().length === 0) {
        return {
          result: false,
          message: 'to must not be empty',
          errorCode: 9,
        }
      }
      const addr = parseAddress(input.to)
      if (
        (addr.scheme === 'bridge' || addr.scheme === 'uds') &&
        addr.target.trim().length === 0
      ) {
        return {
          result: false,
          message: 'address target must not be empty',
          errorCode: 9,
        }
      }
      if (!isAgentSwarmsEnabled() && typeof input.message !== 'string') {
        return {
          result: false,
          message: 'structured messages require Agent Teams',
          errorCode: 9,
        }
      }
      if (input.to.includes('@')) {
        const isSingleLeadingAt =
          input.to.startsWith('@') && !input.to.slice(1).includes('@')
        let isLocalAgentTarget = false
        if (isSingleLeadingAt && typeof input.message === 'string') {
          isLocalAgentTarget =
            (await resolveAgentTarget({
              input: input.to,
              appState: context.getAppState(),
              sessionId: getSessionId(),
            })) !== null
        }
        if (!isLocalAgentTarget) {
          return {
            result: false,
            message:
              'to must be a bare teammate name or "*" — there is only one team per session',
            errorCode: 9,
          }
        }
      }
      if (!isAgentSwarmsEnabled()) {
        if (input.to === '*') {
          return {
            result: false,
            message: 'broadcast messaging requires Agent Teams',
            errorCode: 9,
          }
        }
        if (parseAddress(input.to).scheme !== 'other') {
          return {
            result: false,
            message: 'cross-session messaging requires Agent Teams',
            errorCode: 9,
          }
        }
        if (!input.summary || input.summary.trim().length === 0) {
          return {
            result: false,
            message: 'summary is required when message is a string',
            errorCode: 9,
          }
        }
        return { result: true }
      }
      if (feature('UDS_INBOX') && parseAddress(input.to).scheme === 'bridge') {
        // Structured-message rejection first — it's the permanent constraint.
        // Showing "not connected" first would make the user reconnect only to
        // hit this error on retry.
        if (typeof input.message !== 'string') {
          return {
            result: false,
            message:
              'structured messages cannot be sent cross-session — only plain text',
            errorCode: 9,
          }
        }
        // postInterClaudeMessage derives from= via getReplBridgeHandle() —
        // check handle directly for the init-timing window. Also check
        // isReplBridgeActive() to reject outbound-only (CCR mirror) mode
        // where the bridge is write-only and peer messaging is unsupported.
        if (!getReplBridgeHandle() || !isReplBridgeActive()) {
          return {
            result: false,
            message:
              'Remote Control is not connected — cannot send to a bridge: target. Reconnect with /remote-control first.',
            errorCode: 9,
          }
        }
        return { result: true }
      }
      if (
        feature('UDS_INBOX') &&
        parseAddress(input.to).scheme === 'uds' &&
        typeof input.message === 'string'
      ) {
        // UDS cross-session send: summary isn't rendered (UI.tsx returns null
        // for string messages), so don't require it. Structured messages fall
        // through to the rejection below.
        return { result: true }
      }
      if (typeof input.message === 'string') {
        if (!input.summary || input.summary.trim().length === 0) {
          return {
            result: false,
            message: 'summary is required when message is a string',
            errorCode: 9,
          }
        }
        return { result: true }
      }

      if (input.to === '*') {
        return {
          result: false,
          message: 'structured messages cannot be broadcast (to: "*")',
          errorCode: 9,
        }
      }
      if (feature('UDS_INBOX') && parseAddress(input.to).scheme !== 'other') {
        return {
          result: false,
          message:
            'structured messages cannot be sent cross-session — only plain text',
          errorCode: 9,
        }
      }

      if (
        input.message.type === 'shutdown_response' &&
        input.to !== TEAM_LEAD_NAME
      ) {
        return {
          result: false,
          message: `shutdown_response must be sent to "${TEAM_LEAD_NAME}"`,
          errorCode: 9,
        }
      }

      if (
        input.message.type === 'shutdown_response' &&
        !input.message.approve &&
        (!input.message.reason || input.message.reason.trim().length === 0)
      ) {
        return {
          result: false,
          message: 'reason is required when rejecting a shutdown request',
          errorCode: 9,
        }
      }

      // Early authority pre-checks (fast-fail before the permission wait).
      // The call-time versioned snapshot inside the handlers below is the
      // AUTHORITATIVE check — validation may precede a permission prompt the
      // user takes minutes to answer, during which roster membership can
      // change — these are a UX nicety, not the security boundary.
      if (
        input.message.type === 'shutdown_request' &&
        !isTeamLead(context.getAppState().teamContext)
      ) {
        return {
          result: false,
          message: 'Only the team lead can request teammate shutdown.',
          errorCode: 9,
        }
      }
      if (input.message.type === 'shutdown_response' && !isTeammate()) {
        return {
          result: false,
          message: 'Only a teammate can respond to its own shutdown request.',
          errorCode: 9,
        }
      }
      if (
        input.message.type === 'plan_approval_response' &&
        !isTeamLead(context.getAppState().teamContext)
      ) {
        return {
          result: false,
          message: 'Only the team lead can approve or reject plans.',
          errorCode: 9,
        }
      }

      return { result: true }
    },

    async description() {
      return DESCRIPTION
    },

    async prompt() {
      return getPrompt()
    },

    mapToolResultToToolResultBlockParam(data, toolUseID) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: [
          {
            type: 'text' as const,
            text: jsonStringify(data),
          },
        ],
      }
    },

    async call(input, context, _canUseTool, _assistantMessage) {
      if (feature('UDS_INBOX') && typeof input.message === 'string') {
        const addr = parseAddress(input.to)
        if (addr.scheme === 'bridge') {
          // Re-check handle — checkPermissions blocks on user approval (can be
          // minutes). validateInput's check is stale if the bridge dropped
          // during the prompt wait; without this, from="unknown" ships.
          // Also re-check isReplBridgeActive for outbound-only mode.
          if (!getReplBridgeHandle() || !isReplBridgeActive()) {
            return {
              data: {
                success: false,
                message: `Remote Control disconnected before send — cannot deliver to ${input.to}`,
              },
            }
          }
          /* eslint-disable @typescript-eslint/no-require-imports */
          const { postInterClaudeMessage } =
            require('../../bridge/peerSessions.js') as typeof import('../../bridge/peerSessions.js')
          /* eslint-enable @typescript-eslint/no-require-imports */
          const result = await postInterClaudeMessage(
            addr.target,
            input.message,
          )
          const preview = input.summary || truncate(input.message, 50)
          return {
            data: {
              success: result.ok,
              message: result.ok
                ? `“${preview}” → ${input.to}`
                : `Failed to send to ${input.to}: ${result.error ?? 'unknown'}`,
            },
          }
        }
        if (addr.scheme === 'uds') {
          /* eslint-disable @typescript-eslint/no-require-imports */
          const { sendToUdsSocket } =
            require('../../utils/udsClient.js') as typeof import('../../utils/udsClient.js')
          /* eslint-enable @typescript-eslint/no-require-imports */
          try {
            await sendToUdsSocket(addr.target, input.message)
            const preview = input.summary || truncate(input.message, 50)
            return {
              data: {
                success: true,
                message: `“${preview}” → ${input.to}`,
              },
            }
          } catch (e) {
            return {
              data: {
                success: false,
                message: `Failed to send to ${input.to}: ${errorMessage(e)}`,
              },
            }
          }
        }
      }

      // Deterministic routing order for a plain-text message to a named
      // recipient (Task 2): explicit `@name` always means "local worker" and
      // never consults the team roster. A bare name prefers a currently
      // active teammate; only when there's no roster match does it fall
      // back to local-worker resolution (registered alias, durable handle,
      // or raw agent ID). Stopped subagents are NOT auto-resumed — use
      // ResumeAgent for those.
      if (typeof input.message === 'string' && input.to !== '*') {
        let parsed: ReturnType<typeof parseLocalRecipient>
        try {
          parsed = parseLocalRecipient(input.to)
        } catch (error) {
          return { data: { success: false, message: errorMessage(error) } }
        }

        if (!parsed.explicit && isAgentSwarmsEnabled()) {
          const appState = context.getAppState()
          const teamName = getTeamName(appState.teamContext)
          if (teamName) {
            const roster = await resolveFreshRosterMember(teamName, parsed.target)
            if (roster.kind === 'ambiguous') {
              return {
                data: {
                  success: false,
                  message: `"${parsed.target}" is an ambiguous legacy teammate name: multiple teammates share the same routing key or mailbox path. Use an explicit @name to target a local worker, or resolve the collision in the team roster.`,
                },
              }
            }
            if (roster.kind === 'member') {
              const teammateMessage = toTeammateMessageContract({
                from: getAgentName() || (isTeammate() ? 'teammate' : TEAM_LEAD_NAME),
                text: input.message,
                color: getTeammateColor(),
                summary: input.summary,
              })
              return routeToTeammate(roster.member, teammateMessage, teamName, context)
            }
          }
        }

        const localResult = await routeToLocalWorker(
          parsed.target,
          input.to,
          input.message,
          context,
        )
        if (localResult) return localResult
      }

      if (!isAgentSwarmsEnabled()) {
        return {
          data: {
            success: false,
            message: `No running subagent or Agent Mode worker found for ${input.to}. Without Agent Teams, SendMessage can only target running worker handles or agent IDs.`,
          },
        }
      }

      if (typeof input.message === 'string') {
        if (input.to === '*') {
          return handleBroadcast(input.message, input.summary, context)
        }
        return {
          data: {
            success: false,
            message: `No running subagent, Agent Mode worker, or active teammate found for "${input.to}".`,
          },
        }
      }

      if (input.to === '*') {
        throw new Error('structured messages cannot be broadcast')
      }

      switch (input.message.type) {
        case 'shutdown_request':
          return handleShutdownRequest(input.to, input.message.reason, context)
        case 'shutdown_response':
          if (input.message.approve) {
            return handleShutdownApproval(input.message.request_id, context)
          }
          return handleShutdownRejection(
            input.message.request_id,
            input.message.reason!,
          )
        case 'plan_approval_response':
          return handlePlanDecision(
            input.to,
            input.message.request_id,
            input.message.approve
              ? { outcome: 'approved' }
              : {
                  outcome: 'rejected',
                  feedback: input.message.feedback ?? 'Plan needs revision',
                },
            context,
          )
      }
    },

    renderToolUseMessage,
    renderToolResultMessage,
  } satisfies ToolDef<InputSchema, SendMessageToolOutput>)
