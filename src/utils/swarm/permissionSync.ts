/**
 * Permission helpers for agent swarms.
 *
 * Active requests use teammate mailboxes. Resolved-file polling remains for
 * outstanding requests created by older workers.
 */

import { readFile, unlink } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod/v4'
import type {
  TrustedSedEditApprovalPayload,
  TrustedSedEditPreviewChallenge,
} from '../../tools/BashTool/sedEditCapability.js'
import { logForDebugging } from '../debug.js'
import { getErrnoCode } from '../errors.js'
import { lazySchema } from '../lazySchema.js'
import { logError } from '../log.js'
import type { PermissionUpdate } from '../permissions/PermissionUpdateSchema.js'
import { jsonParse } from '../slowOperations.js'
import {
  getAgentId,
  getAgentName,
  getTeammateColor,
  getTeamName,
} from '../teammate.js'
import {
  createPermissionRequestMessage,
  createPermissionResponseMessage,
  createSandboxPermissionRequestMessage,
  createSandboxPermissionResponseMessage,
  resolveLeaderPrincipal,
  resolveTeamPrincipalByName,
  writeControlRequestToMailbox,
  writeControlToMailbox,
} from '../teammateMailbox.js'
import { getTeamDir, readTeamSnapshot } from './teamHelpers.js'

/**
 * Full request schema for a permission request from a worker to the leader
 */
export const SwarmPermissionRequestSchema = lazySchema(() =>
  z.object({
    /** Unique identifier for this request */
    id: z.string(),
    /** Worker's CLAUDE_CODE_AGENT_ID */
    workerId: z.string(),
    /** Worker's CLAUDE_CODE_AGENT_NAME */
    workerName: z.string(),
    /** Worker's CLAUDE_CODE_AGENT_COLOR */
    workerColor: z.string().optional(),
    /** Team name for routing */
    teamName: z.string(),
    /** Tool name requiring permission (e.g., "Bash", "Edit") */
    toolName: z.string(),
    /** Original toolUseID from worker's context */
    toolUseId: z.string(),
    /** Human-readable description of the tool use */
    description: z.string(),
    /** Serialized tool input */
    input: z.record(z.string(), z.unknown()),
    /** Suggested permission rules from the permission result */
    permissionSuggestions: z.array(z.unknown()),
    trustedSedEditPreview: z
      .object({
        toolUseID: z.string(),
        command: z.string(),
        filePath: z.string(),
        previewId: z.string(),
        identity: z
          .object({
            canonicalPath: z.string(),
            device: z.number(),
            inode: z.number(),
            size: z.number(),
            modifiedAtMs: z.number(),
            changedAtMs: z.number(),
            nativeFileId: z.string().optional(),
          })
          .strict(),
      })
      .strict()
      .optional(),
    /** Status of the request */
    status: z.enum(['pending', 'approved', 'rejected']),
    /** Who resolved the request */
    resolvedBy: z.enum(['worker', 'leader']).optional(),
    /** Timestamp when resolved */
    resolvedAt: z.number().optional(),
    /** Rejection feedback message */
    feedback: z.string().optional(),
    /** Modified input if changed by resolver */
    updatedInput: z.record(z.string(), z.unknown()).optional(),
    /** "Always allow" rules applied during resolution */
    permissionUpdates: z.array(z.unknown()).optional(),
    /** Timestamp when request was created */
    createdAt: z.number(),
  }),
)

export type SwarmPermissionRequest = z.infer<
  ReturnType<typeof SwarmPermissionRequestSchema>
>

/**
 * Resolution data returned when leader/worker resolves a request
 */
export type PermissionResolution = {
  /** Decision: approved or rejected */
  decision: 'approved' | 'rejected'
  /** Who resolved it */
  resolvedBy: 'worker' | 'leader'
  /** Optional feedback message if rejected */
  feedback?: string
  /** Optional updated input if the resolver modified it */
  updatedInput?: Record<string, unknown>
  /** Permission updates to apply (e.g., "always allow" rules) */
  permissionUpdates?: PermissionUpdate[]
  /** Separate user-approved SedEdit capability, correlated to this request. */
  trustedSedEditApproval?: TrustedSedEditApprovalPayload
  /** Explicit UI approval of the special preview, distinct from Bash allow. */
  sedEditPreviewApproved?: boolean
}

/**
 * Get the base directory for a team's permission requests
 * Path: ~/.claude/teams/{teamName}/permissions/
 */
export function getPermissionDir(teamName: string): string {
  return join(getTeamDir(teamName), 'permissions')
}

/**
 * Get the resolved directory for a team
 */
function getResolvedDir(teamName: string): string {
  return join(getPermissionDir(teamName), 'resolved')
}

/**
 * Get the path to a resolved request file
 */
function getResolvedRequestPath(teamName: string, requestId: string): string {
  return join(getResolvedDir(teamName), `${requestId}.json`)
}

/**
 * Generate a unique request ID
 */
export function generateRequestId(): string {
  return `perm-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
}

/**
 * Create a new SwarmPermissionRequest object
 */
export function createPermissionRequest(params: {
  toolName: string
  toolUseId: string
  input: Record<string, unknown>
  description: string
  permissionSuggestions?: unknown[]
  trustedSedEditPreview?: TrustedSedEditPreviewChallenge
  teamName?: string
  workerId?: string
  workerName?: string
  workerColor?: string
}): SwarmPermissionRequest {
  const teamName = params.teamName || getTeamName()
  const workerId = params.workerId || getAgentId()
  const workerName = params.workerName || getAgentName()
  const workerColor = params.workerColor || getTeammateColor()

  if (!teamName) {
    throw new Error('Team name is required for permission requests')
  }
  if (!workerId) {
    throw new Error('Worker ID is required for permission requests')
  }
  if (!workerName) {
    throw new Error('Worker name is required for permission requests')
  }

  return {
    id: generateRequestId(),
    workerId,
    workerName,
    workerColor,
    teamName,
    toolName: params.toolName,
    toolUseId: params.toolUseId,
    description: params.description,
    input: params.input,
    permissionSuggestions: params.permissionSuggestions || [],
    ...(params.trustedSedEditPreview
      ? { trustedSedEditPreview: params.trustedSedEditPreview }
      : {}),
    status: 'pending',
    createdAt: Date.now(),
  }
}

/**
 * Read a resolved permission request by ID
 * Called by workers to check if their request has been resolved
 *
 * @returns The resolved request, or null if not yet resolved
 */
export async function readResolvedPermission(
  requestId: string,
  teamName?: string,
): Promise<SwarmPermissionRequest | null> {
  const team = teamName || getTeamName()
  if (!team) {
    return null
  }

  const resolvedPath = getResolvedRequestPath(team, requestId)

  try {
    const content = await readFile(resolvedPath, 'utf-8')
    const parsed = SwarmPermissionRequestSchema().safeParse(jsonParse(content))
    if (parsed.success) {
      return parsed.data
    }
    logForDebugging(
      `[PermissionSync] Invalid resolved request ${requestId}: ${parsed.error.message}`,
    )
    return null
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') {
      return null
    }
    logForDebugging(
      `[PermissionSync] Failed to read resolved request ${requestId}: ${e}`,
    )
    logError(e)
    return null
  }
}

/**
 * Legacy response type for worker polling
 * Used for backward compatibility with worker integration code
 */
export type PermissionResponse = {
  /** ID of the request this responds to */
  requestId: string
  /** Decision: approved or denied */
  decision: 'approved' | 'denied'
  /** Timestamp when response was created */
  timestamp: string
  /** Optional feedback message if denied */
  feedback?: string
  /** Optional updated input if the resolver modified it */
  updatedInput?: Record<string, unknown>
  /** Permission updates to apply (e.g., "always allow" rules) */
  permissionUpdates?: unknown[]
}

/**
 * Poll for a permission response (worker-side convenience function)
 * Converts the resolved request into a simpler response format
 *
 * @returns The permission response, or null if not yet resolved
 */
export async function pollForResponse(
  requestId: string,
  _agentName?: string,
  teamName?: string,
): Promise<PermissionResponse | null> {
  const resolved = await readResolvedPermission(requestId, teamName)
  if (!resolved) {
    return null
  }

  return {
    requestId: resolved.id,
    decision: resolved.status === 'approved' ? 'approved' : 'denied',
    timestamp: resolved.resolvedAt
      ? new Date(resolved.resolvedAt).toISOString()
      : new Date(resolved.createdAt).toISOString(),
    feedback: resolved.feedback,
    updatedInput: resolved.updatedInput,
    permissionUpdates: resolved.permissionUpdates,
  }
}

/**
 * Remove a worker's response after processing
 * This is an alias for deleteResolvedPermission for backward compatibility
 */
export async function removeWorkerResponse(
  requestId: string,
  _agentName?: string,
  teamName?: string,
): Promise<void> {
  await deleteResolvedPermission(requestId, teamName)
}

/**
 * Check if the current agent is a team leader
 */
export function isTeamLeader(teamName?: string): boolean {
  const team = teamName || getTeamName()
  if (!team) {
    return false
  }

  // Team leaders don't have an agent ID set, or their ID is 'team-lead'
  const agentId = getAgentId()

  return !agentId || agentId === 'team-lead'
}

/**
 * Check if the current agent is a worker in a swarm
 */
export function isSwarmWorker(): boolean {
  const teamName = getTeamName()
  const agentId = getAgentId()

  return !!teamName && !!agentId && !isTeamLeader()
}

/**
 * Delete a resolved permission file
 * Called after a worker has processed the resolution
 */
export async function deleteResolvedPermission(
  requestId: string,
  teamName?: string,
): Promise<boolean> {
  const team = teamName || getTeamName()
  if (!team) {
    return false
  }

  const resolvedPath = getResolvedRequestPath(team, requestId)

  try {
    await unlink(resolvedPath)
    logForDebugging(
      `[PermissionSync] Deleted resolved permission: ${requestId}`,
    )
    return true
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') {
      return false
    }
    logForDebugging(
      `[PermissionSync] Failed to delete resolved permission: ${e}`,
    )
    logError(e)
    return false
  }
}

// ============================================================================
// Mailbox-Based Permission System
// ============================================================================

/**
 * Send a permission request to the leader via mailbox.
 * This is the new mailbox-based approach that replaces the file-based pending directory.
 *
 * @param request - The permission request to send
 * @returns true if the message was sent successfully
 */
export async function sendPermissionRequestViaMailbox(
  request: SwarmPermissionRequest,
): Promise<boolean> {
  try {
    const snapshot = await readTeamSnapshot(request.teamName)
    const recipient = resolveLeaderPrincipal(snapshot)

    // Create the permission request message. `agent_id` here is actually the
    // worker's NAME (not workerId/agentId) — deliberate, matching existing
    // usage: useInboxPoller.ts displays it as the badge name AND uses it as
    // the recipient name when routing the leader's response back
    // (sendPermissionResponseViaMailbox(parsed.agent_id, ...)). Changing it
    // to a real agent ID would break that round-trip.
    const message = createPermissionRequestMessage({
      request_id: request.id,
      agent_id: request.workerName,
      tool_name: request.toolName,
      tool_use_id: request.toolUseId,
      description: request.description,
      input: request.input,
      permission_suggestions: request.permissionSuggestions,
      trusted_sed_edit_preview: request.trustedSedEditPreview,
    })

    // Requester creates the outstanding-request record (sending -> written)
    // so the leader's response can later be claimed exactly once.
    await writeControlRequestToMailbox({
      teamName: request.teamName,
      requestId: request.id,
      requestType: 'permission',
      recipient,
      control: message,
      color: request.workerColor,
    })

    logForDebugging(
      `[PermissionSync] Sent permission request ${request.id} to leader ${recipient.name} via mailbox`,
    )
    return true
  } catch (error) {
    logForDebugging(
      `[PermissionSync] Failed to send permission request via mailbox: ${error}`,
    )
    logError(error)
    return false
  }
}

/**
 * Send a permission response to a worker via mailbox.
 * This is the new mailbox-based approach that replaces the file-based resolved directory.
 *
 * @param workerName - The worker's name to send the response to
 * @param resolution - The permission resolution
 * @param requestId - The original request ID
 * @param teamName - The team name
 * @returns true if the message was sent successfully
 */
export async function sendPermissionResponseViaMailbox(
  workerName: string,
  resolution: PermissionResolution,
  requestId: string,
  teamName?: string,
): Promise<boolean> {
  const team = teamName || getTeamName()
  if (!team) {
    logForDebugging(
      `[PermissionSync] Cannot send permission response: team name not found`,
    )
    return false
  }

  try {
    const snapshot = await readTeamSnapshot(team)
    const recipient = resolveTeamPrincipalByName(snapshot, workerName)
    if (!recipient) {
      logForDebugging(
        `[PermissionSync] Cannot send permission response: worker "${workerName}" not found in roster`,
      )
      return false
    }

    // Create the permission response message
    const message = createPermissionResponseMessage({
      request_id: requestId,
      subtype: resolution.decision === 'approved' ? 'success' : 'error',
      error: resolution.feedback,
      updated_input: resolution.updatedInput,
      permission_updates: resolution.permissionUpdates,
      trusted_sed_edit_approval: resolution.trustedSedEditApproval,
      sed_edit_preview_approved: resolution.sedEditPreviewApproved,
    })

    // Response side: no new PendingControlRecord — fulfills the one the
    // worker created when it sent permission_request; the worker's own
    // consumer claims/finishes it.
    await writeControlToMailbox({
      recipient,
      control: message,
      teamName: team,
    })

    logForDebugging(
      `[PermissionSync] Sent permission response for ${requestId} to worker ${workerName} via mailbox`,
    )
    return true
  } catch (error) {
    logForDebugging(
      `[PermissionSync] Failed to send permission response via mailbox: ${error}`,
    )
    logError(error)
    return false
  }
}

// ============================================================================
// Sandbox Permission Mailbox System
// ============================================================================

/**
 * Generate a unique sandbox permission request ID
 */
export function generateSandboxRequestId(): string {
  return `sandbox-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
}

/**
 * Send a sandbox permission request to the leader via mailbox.
 * Called by workers when sandbox runtime needs network access approval.
 *
 * @param host - The host requesting network access
 * @param requestId - Unique ID for this request
 * @param teamName - Optional team name
 * @returns true if the message was sent successfully
 */
export async function sendSandboxPermissionRequestViaMailbox(
  host: string,
  requestId: string,
  teamName?: string,
): Promise<boolean> {
  const team = teamName || getTeamName()
  if (!team) {
    logForDebugging(
      `[PermissionSync] Cannot send sandbox permission request: team name not found`,
    )
    return false
  }

  const workerId = getAgentId()
  const workerName = getAgentName()
  const workerColor = getTeammateColor()

  if (!workerId || !workerName) {
    logForDebugging(
      `[PermissionSync] Cannot send sandbox permission request: worker ID or name not found`,
    )
    return false
  }

  try {
    const snapshot = await readTeamSnapshot(team)
    const recipient = resolveLeaderPrincipal(snapshot)

    const message = createSandboxPermissionRequestMessage({
      requestId,
      workerId,
      workerName,
      workerColor,
      host,
    })

    // Requester creates the outstanding-request record (sending -> written)
    // so the leader's response can later be claimed exactly once.
    await writeControlRequestToMailbox({
      teamName: team,
      requestId,
      requestType: 'sandbox',
      recipient,
      control: message,
      color: workerColor,
    })

    logForDebugging(
      `[PermissionSync] Sent sandbox permission request ${requestId} for host ${host} to leader ${recipient.name} via mailbox`,
    )
    return true
  } catch (error) {
    logForDebugging(
      `[PermissionSync] Failed to send sandbox permission request via mailbox: ${error}`,
    )
    logError(error)
    return false
  }
}

/**
 * Send a sandbox permission response to a worker via mailbox.
 * Called by the leader when approving/denying a sandbox network access request.
 *
 * @param workerName - The worker's name to send the response to
 * @param requestId - The original request ID
 * @param host - The host that was approved/denied
 * @param allow - Whether the connection is allowed
 * @param teamName - Optional team name
 * @returns true if the message was sent successfully
 */
export async function sendSandboxPermissionResponseViaMailbox(
  workerName: string,
  requestId: string,
  host: string,
  allow: boolean,
  teamName?: string,
): Promise<boolean> {
  const team = teamName || getTeamName()
  if (!team) {
    logForDebugging(
      `[PermissionSync] Cannot send sandbox permission response: team name not found`,
    )
    return false
  }

  try {
    const snapshot = await readTeamSnapshot(team)
    const recipient = resolveTeamPrincipalByName(snapshot, workerName)
    if (!recipient) {
      logForDebugging(
        `[PermissionSync] Cannot send sandbox permission response: worker "${workerName}" not found in roster`,
      )
      return false
    }

    const message = createSandboxPermissionResponseMessage({
      requestId,
      host,
      allow,
    })

    // Response side: no new PendingControlRecord — fulfills the one the
    // worker created when it sent sandbox_permission_request.
    await writeControlToMailbox({
      recipient,
      control: message,
      teamName: team,
    })

    logForDebugging(
      `[PermissionSync] Sent sandbox permission response for ${requestId} (host: ${host}, allow: ${allow}) to worker ${workerName} via mailbox`,
    )
    return true
  } catch (error) {
    logForDebugging(
      `[PermissionSync] Failed to send sandbox permission response via mailbox: ${error}`,
    )
    logError(error)
    return false
  }
}
