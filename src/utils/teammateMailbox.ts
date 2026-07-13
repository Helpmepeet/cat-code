/**
 * Teammate Mailbox - File-based messaging system for agent swarms
 *
 * Each teammate has an inbox file at .cat-code/teams/{team_name}/inboxes/{agent_name}.json
 * Other teammates can write messages to it, and the recipient sees them as attachments.
 *
 * Note: Inboxes are keyed by agent name within a team.
 */

import { randomUUID } from 'crypto'
import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod/v4'
import {
  StructuredTeammateHandoffRequestMessageSchema,
  StructuredTeammateHandoffResultMessageSchema,
} from '../contracts/orchestration.js'
import {
  formatTeammateMessagesForModel,
  type TeammateStructuredPayload,
} from './teammateMessage.js'
import { PermissionModeSchema } from '../entrypoints/sdk/coreSchemas.js'
import { SEND_MESSAGE_TOOL_NAME } from '../tools/SendMessageTool/constants.js'
import type { Message } from '../types/message.js'
import { generateRequestId } from './agentId.js'
import { count } from './array.js'
import { logForDebugging } from './debug.js'
import { getTeamsDir } from './envUtils.js'
import { errorMessage, getErrnoCode } from './errors.js'
import { lazySchema } from './lazySchema.js'
import * as lockfile from './lockfile.js'
import { logError } from './log.js'
import { jsonParse, jsonStringify } from './slowOperations.js'
import type { BackendType } from './swarm/backends/types.js'
import { TEAM_LEAD_NAME } from './swarm/constants.js'
import type { PendingControlRecord, TeamFile } from './swarm/teamHelpers.js'
import { readTeamSnapshot, transactTeamFile } from './swarm/teamHelpers.js'
import { sanitizePathComponent } from './tasks.js'
import { getAgentId, getAgentName, getTeammateColor, getTeamName } from './teammate.js'

// Lock options: retry with backoff so concurrent callers (multiple Claudes
// in a swarm) wait for the lock instead of failing immediately. The sync
// lockSync API blocked the event loop; the async API needs explicit retries
// to achieve the same serialization semantics.
const LOCK_OPTIONS = {
  retries: {
    retries: 10,
    minTimeout: 5,
    maxTimeout: 100,
  },
}

const TeammateStructuredPayloadSchema = z.union([
  StructuredTeammateHandoffRequestMessageSchema,
  StructuredTeammateHandoffResultMessageSchema,
])

/**
 * Re-exported from teamHelpers.ts (which owns `TeamFile.pendingControls`) so
 * control-plane call sites only need to import from this module.
 */
export type { PendingControlRecord }

export type TeammateMessage = {
  from: string
  text: string
  timestamp: string
  read: boolean
  color?: string // Sender's assigned color (e.g., 'red', 'blue', 'green')
  summary?: string // 5-10 word summary shown as preview in the UI
  structured?: TeammateStructuredPayload
  // Version-2 envelope fields. Absent on messages written by the legacy
  // positional writeToMailbox() path (still used by call sites that predate
  // this identity model) — always optional so both shapes round-trip through
  // the same schema.
  messageId?: string
  protocolVersion?: 2
  senderAgentId?: string
  senderAllocationId?: string
  recipientAgentId?: string
  recipientAllocationId?: string
  payloadClass?: 'chat' | 'notification' | 'control'
  // Mutually exclusive with each other and with plain chat `text` (Task 3
  // Step 1). Populated only by `writeControlToMailbox`/the notification
  // producers; classifyMailboxMessage is the sole strict validator — kept
  // `unknown` at the file-parse boundary (see TeammateMailboxMessageSchema)
  // so one malformed/forged envelope can't fail the whole mailbox read.
  notification?: MailboxNotificationPayload
  control?: MailboxControlPayload
}

// Kept lazy + lenient: legacy call sites (see MailboxChatInput doc comment on
// principalWriteToMailbox) still write messages with no envelope fields at
// all, and a single malformed/forged `control`/`notification` payload must
// not fail the parse of the WHOLE mailbox array (which would silently drop
// every other, unrelated message in the same file). `classifyMailboxMessage`
// is the sole place that strictly validates an individual message's control/
// notification payload against the closed unions below.
const TeammateMailboxMessageSchema = lazySchema(() =>
  z.object({
    from: z.string(),
    text: z.string(),
    timestamp: z.string(),
    read: z.boolean(),
    color: z.string().optional(),
    summary: z.string().optional(),
    structured: TeammateStructuredPayloadSchema.optional(),
    messageId: z.string().optional(),
    protocolVersion: z.literal(2).optional(),
    senderAgentId: z.string().optional(),
    senderAllocationId: z.string().optional(),
    recipientAgentId: z.string().optional(),
    recipientAllocationId: z.string().optional(),
    payloadClass: z.enum(['chat', 'notification', 'control']).optional(),
    notification: z.unknown().optional(),
    control: z.unknown().optional(),
  }),
)

const TeammateMailboxFileSchema = lazySchema(() =>
  z.array(TeammateMailboxMessageSchema()),
)

export type MailboxSignature = string | null

/**
 * Get the path to a teammate's inbox file
 * Structure: ~/.cat-code/teams/{team_name}/inboxes/{agent_name}.json
 */
export function getInboxPath(agentName: string, teamName?: string): string {
  const team = teamName || getTeamName() || 'default'
  const safeTeam = sanitizePathComponent(team)
  const safeAgentName = sanitizePathComponent(agentName)
  const inboxDir = join(getTeamsDir(), safeTeam, 'inboxes')
  const fullPath = join(inboxDir, `${safeAgentName}.json`)
  logForDebugging(
    `[TeammateMailbox] getInboxPath: agent=${agentName}, team=${team}, fullPath=${fullPath}`,
  )
  return fullPath
}

/**
 * Ensure the inbox directory exists for a team
 */
async function ensureInboxDir(teamName?: string): Promise<void> {
  const team = teamName || getTeamName() || 'default'
  const safeTeam = sanitizePathComponent(team)
  const inboxDir = join(getTeamsDir(), safeTeam, 'inboxes')
  await mkdir(inboxDir, { recursive: true })
  logForDebugging(`[TeammateMailbox] Ensured inbox directory: ${inboxDir}`)
}

/**
 * Read all messages from a teammate's inbox
 * @param agentName - The agent name (not UUID) to read inbox for
 * @param teamName - Optional team name (defaults to CLAUDE_CODE_TEAM_NAME env var or 'default')
 */
export async function readMailbox(
  agentName: string,
  teamName?: string,
): Promise<TeammateMessage[]> {
  const inboxPath = getInboxPath(agentName, teamName)
  logForDebugging(`[TeammateMailbox] readMailbox: path=${inboxPath}`)

  try {
    const content = await readFile(inboxPath, 'utf-8')
    const parsed = TeammateMailboxFileSchema().safeParse(jsonParse(content))
    if (!parsed.success) {
      logForDebugging(
        `[TeammateMailbox] readMailbox: invalid mailbox payload for ${agentName}: ${parsed.error.message}`,
        { level: 'warn' },
      )
      return []
    }
    // `control`/`notification` are `unknown` at this lenient boundary (see
    // TeammateMailboxMessageSchema doc comment) — classifyMailboxMessage does
    // the real per-message validation against the closed unions.
    const messages = parsed.data as unknown as TeammateMessage[]
    logForDebugging(
      `[TeammateMailbox] readMailbox: read ${messages.length} message(s)`,
    )
    return messages
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT') {
      logForDebugging(`[TeammateMailbox] readMailbox: file does not exist`)
      return []
    }
    logForDebugging(`Failed to read inbox for ${agentName}: ${error}`)
    logError(error)
    return []
  }
}

async function getMailboxSignature(
  agentName: string,
  teamName?: string,
): Promise<MailboxSignature> {
  const inboxPath = getInboxPath(agentName, teamName)
  try {
    const stats = await stat(inboxPath)
    if (!stats.isFile()) return null
    return `${stats.mtimeMs}:${stats.size}`
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT') return null
    logForDebugging(`Failed to stat inbox for ${agentName}: ${error}`)
    logError(error)
    return null
  }
}

export async function readMailboxIfChanged(
  agentName: string,
  teamName?: string,
  previousSignature?: MailboxSignature,
): Promise<{
  changed: boolean
  signature: MailboxSignature | undefined
  messages: TeammateMessage[]
}> {
  const signature = await getMailboxSignature(agentName, teamName)
  if (previousSignature !== undefined && signature === previousSignature) {
    return { changed: false, signature, messages: [] }
  }
  const messages = await readMailbox(agentName, teamName)
  return {
    changed: true,
    signature: messages.some(m => !m.read) ? undefined : signature,
    messages,
  }
}

/**
 * Read only unread messages from a teammate's inbox
 * @param agentName - The agent name (not UUID) to read inbox for
 * @param teamName - Optional team name
 */
export async function readUnreadMessages(
  agentName: string,
  teamName?: string,
): Promise<TeammateMessage[]> {
  const messages = await readMailbox(agentName, teamName)
  const unread = messages.filter(m => !m.read)
  logForDebugging(
    `[TeammateMailbox] readUnreadMessages: ${unread.length} unread of ${messages.length} total`,
  )
  return unread
}

/**
 * Legacy positional write path. Preserved byte-for-byte for the many call
 * sites (spawnMultiAgent.ts, permissionSync.ts, useInboxPoller.ts, etc.) that
 * predate the versioned envelope/principal model and construct their own
 * `from` field. Silently logs and returns on failure — never throws. New
 * call sites that have a resolved `TeamPrincipal` recipient should use the
 * object-form overload of `writeToMailbox` instead, which throws
 * `MailboxWriteError` so callers can report truthful delivery failure.
 */
async function legacyWriteToMailbox(
  recipientName: string,
  message: Omit<TeammateMessage, 'read'>,
  teamName?: string,
): Promise<void> {
  await ensureInboxDir(teamName)

  const inboxPath = getInboxPath(recipientName, teamName)
  const lockFilePath = `${inboxPath}.lock`

  logForDebugging(
    `[TeammateMailbox] writeToMailbox: recipient=${recipientName}, from=${message.from}, path=${inboxPath}`,
  )

  // Ensure the inbox file exists before locking (proper-lockfile requires the file to exist)
  try {
    await writeFile(inboxPath, '[]', { encoding: 'utf-8', flag: 'wx' })
    logForDebugging(`[TeammateMailbox] writeToMailbox: created new inbox file`)
  } catch (error) {
    const code = getErrnoCode(error)
    if (code !== 'EEXIST') {
      logForDebugging(
        `[TeammateMailbox] writeToMailbox: failed to create inbox file: ${error}`,
      )
      logError(error)
      return
    }
  }

  let release: (() => Promise<void>) | undefined
  try {
    release = await lockfile.lock(inboxPath, {
      lockfilePath: lockFilePath,
      ...LOCK_OPTIONS,
    })

    // Re-read messages after acquiring lock to get the latest state
    const messages = await readMailbox(recipientName, teamName)

    const newMessage: TeammateMessage = {
      ...message,
      read: false,
    }

    messages.push(newMessage)

    await writeFile(inboxPath, jsonStringify(messages, null, 2), 'utf-8')
    logForDebugging(
      `[TeammateMailbox] Wrote message to ${recipientName}'s inbox from ${message.from}`,
    )
  } catch (error) {
    logForDebugging(`Failed to write to inbox for ${recipientName}: ${error}`)
    logError(error)
  } finally {
    if (release) {
      await release()
    }
  }
}

/**
 * Raised by the principal-based `writeToMailbox` overload for any pre-write
 * or write failure. Wraps the failing operation and recipient so a caller
 * (e.g. SendMessageTool) can report a truthful per-recipient failure instead
 * of silently swallowing it — see docs/superpowers/plans/2026-07-12-agent-
 * control-routing-hardening-plan.md Task 2.
 */
export class MailboxWriteError extends Error {
  readonly recipientName: string
  readonly operation: 'mkdir' | 'create' | 'lock' | 'read' | 'write'
  constructor(
    recipientName: string,
    operation: MailboxWriteError['operation'],
    cause: unknown,
  ) {
    super(
      `Failed to write to ${recipientName}'s mailbox (${operation}): ${errorMessage(cause)}`,
    )
    this.name = 'MailboxWriteError'
    this.recipientName = recipientName
    this.operation = operation
  }
}

/** A resolved identity for mailbox envelope sender/recipient fields. */
export type TeamPrincipal = {
  kind: 'leader' | 'teammate'
  agentId: string
  name: string
  allocationId: string
}

export type MailboxWrittenResult = {
  written: true
  messageId: string
  warning?: string
}

/**
 * Plain-chat mailbox input. Statically excludes `control`/`notification` so
 * a caller can never smuggle a privileged control payload through the chat
 * path — those go through Task 3's `writeControlToMailbox` instead.
 * `structured` is preserved from the pre-existing worker-handoff contract
 * (`toTeammateMessageContract`) — attachments.ts/useInboxPoller.ts already
 * read `TeammateMessage.structured` downstream, so it must keep flowing
 * through the principal write path too.
 */
export type MailboxChatInput = {
  text: string
  summary?: string
  color?: string
  structured?: TeammateStructuredPayload
  control?: never
  notification?: never
}

function recipientRecordToPrincipal(
  record: NonNullable<TeamFile['recipientRecords']>[number],
): TeamPrincipal {
  return {
    kind: record.kind === 'leader' ? 'leader' : 'teammate',
    agentId: record.agentId,
    name: record.name,
    allocationId: record.allocationId,
  }
}

/**
 * Resolves "the team lead" from a snapshot: its `leader` recipient record,
 * or (absent one — a legacy/minimal snapshot) `TEAM_LEAD_NAME`/`leadAgentId`
 * as a synthetic fallback principal.
 */
export function resolveLeaderPrincipal(snapshot: Readonly<TeamFile>): TeamPrincipal {
  const leaderRecord = (snapshot.recipientRecords ?? []).find(
    r => r.kind === 'leader',
  )
  if (leaderRecord) return recipientRecordToPrincipal(leaderRecord)
  const fallbackId = snapshot.leadAgentId || TEAM_LEAD_NAME
  return {
    kind: 'leader',
    agentId: fallbackId,
    name: TEAM_LEAD_NAME,
    allocationId: fallbackId,
  }
}

/**
 * Resolves a specific recipient by display name (case-sensitive — routing
 * callers that need case-insensitive matching should compare via
 * `recipientNameKey` themselves). Excludes `terminated` records — a
 * tombstoned name never resolves to a live principal — except that
 * `TEAM_LEAD_NAME` always falls back to `resolveLeaderPrincipal` since the
 * leader record predates the terminated-tombstone convention on some legacy
 * snapshots. Returns `null` when there is no live match.
 */
export function resolveTeamPrincipalByName(
  snapshot: Readonly<TeamFile>,
  name: string,
): TeamPrincipal | null {
  const record = (snapshot.recipientRecords ?? []).find(
    r => r.name === name && r.status !== 'terminated',
  )
  if (record) return recipientRecordToPrincipal(record)
  if (name === TEAM_LEAD_NAME) return resolveLeaderPrincipal(snapshot)
  return null
}

/**
 * Resolves the current runtime identity to a `TeamPrincipal` against a
 * versioned team snapshot: matches the running agent ID against the
 * snapshot's `recipientRecords`, falling back to `resolveLeaderPrincipal`
 * when no agent ID is set — the original session that created the team
 * never had one.
 */
export async function resolveCurrentTeamPrincipal(
  teamName: string,
  snapshot: Readonly<TeamFile>,
): Promise<TeamPrincipal> {
  const records = snapshot.recipientRecords ?? []
  const agentId = getAgentId()
  if (agentId) {
    const record = records.find(r => r.agentId === agentId)
    if (record) return recipientRecordToPrincipal(record)
  }
  return resolveLeaderPrincipal(snapshot)
}

/**
 * Best-effort sender resolution for the principal write path: uses the real
 * team snapshot when one is available, but never turns "no team file yet" or
 * "not in a team" into a write failure — the recipient side of the envelope
 * (a caller-supplied `TeamPrincipal`) is what routing correctness depends on.
 */
async function resolveSenderPrincipalBestEffort(
  teamName: string,
): Promise<TeamPrincipal> {
  try {
    const snapshot = await readTeamSnapshot(teamName)
    return await resolveCurrentTeamPrincipal(teamName, snapshot)
  } catch {
    const agentId = getAgentId()
    const agentName = getAgentName()
    if (agentId && agentName) {
      return { kind: 'teammate', agentId, name: agentName, allocationId: agentId }
    }
    return {
      kind: 'leader',
      agentId: TEAM_LEAD_NAME,
      name: TEAM_LEAD_NAME,
      allocationId: TEAM_LEAD_NAME,
    }
  }
}

/**
 * Re-reads and validates a mailbox file for the principal write path.
 * Unlike `readMailbox`, malformed JSON is a hard failure (`MailboxWriteError`
 * with operation 'read') rather than a silent `[]` — a write must never
 * truncate a mailbox it couldn't actually parse.
 */
async function readMailboxStrict(
  recipientName: string,
  inboxPath: string,
): Promise<TeammateMessage[]> {
  let content: string
  try {
    content = await readFile(inboxPath, 'utf-8')
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') return []
    throw new MailboxWriteError(recipientName, 'read', error)
  }
  let parsedJson: unknown
  try {
    parsedJson = jsonParse(content)
  } catch (error) {
    throw new MailboxWriteError(recipientName, 'read', error)
  }
  const parsed = TeammateMailboxFileSchema().safeParse(parsedJson)
  if (!parsed.success) {
    throw new MailboxWriteError(recipientName, 'read', parsed.error)
  }
  return parsed.data as unknown as TeammateMessage[]
}

/**
 * Shared low-level envelope writer used by both the chat path
 * (`principalWriteToMailbox`) and the control path (`writeControlToMailbox`):
 * stamps a UUID `messageId`, `protocolVersion: 2`, and sender/recipient
 * agent+allocation IDs onto every envelope, and throws `MailboxWriteError`
 * (never silently swallows) on any pre-write or write failure so callers can
 * report truthful per-recipient delivery results. A lock-release failure
 * AFTER a successful write returns a `warning` instead of throwing — the
 * message exists from this process's perspective, and throwing here would
 * invite a duplicate-retry.
 */
async function writeResolvedEnvelopeToMailbox(args: {
  sender: TeamPrincipal
  recipient: TeamPrincipal
  teamName: string
  payloadClass: 'chat' | 'notification' | 'control'
  text: string
  color?: string
  summary?: string
  structured?: TeammateStructuredPayload
  notification?: MailboxNotificationPayload
  control?: MailboxControlPayload
}): Promise<MailboxWrittenResult> {
  const { sender, recipient, teamName } = args

  try {
    await ensureInboxDir(teamName)
  } catch (error) {
    throw new MailboxWriteError(recipient.name, 'mkdir', error)
  }

  const inboxPath = getInboxPath(recipient.name, teamName)
  const lockFilePath = `${inboxPath}.lock`

  try {
    await writeFile(inboxPath, '[]', { encoding: 'utf-8', flag: 'wx' })
  } catch (error) {
    if (getErrnoCode(error) !== 'EEXIST') {
      throw new MailboxWriteError(recipient.name, 'create', error)
    }
  }

  let release: () => Promise<void>
  try {
    release = await lockfile.lock(inboxPath, {
      lockfilePath: lockFilePath,
      ...LOCK_OPTIONS,
    })
  } catch (error) {
    throw new MailboxWriteError(recipient.name, 'lock', error)
  }

  let existing: TeammateMessage[]
  try {
    existing = await readMailboxStrict(recipient.name, inboxPath)
  } catch (error) {
    await release().catch(() => {})
    throw error
  }

  const messageId = randomUUID()
  const envelope: TeammateMessage = {
    from: sender.name,
    text: args.text,
    timestamp: new Date().toISOString(),
    read: false,
    color: args.color,
    summary: args.summary,
    structured: args.structured,
    messageId,
    protocolVersion: 2,
    senderAgentId: sender.agentId,
    senderAllocationId: sender.allocationId,
    recipientAgentId: recipient.agentId,
    recipientAllocationId: recipient.allocationId,
    payloadClass: args.payloadClass,
    notification: args.notification,
    control: args.control,
  }

  try {
    await writeFile(
      inboxPath,
      jsonStringify([...existing, envelope], null, 2),
      'utf-8',
    )
  } catch (error) {
    await release().catch(() => {})
    throw new MailboxWriteError(recipient.name, 'write', error)
  }

  try {
    await release()
    return { written: true, messageId }
  } catch (error) {
    const warning = `Mailbox write to "${recipient.name}" committed, but lock release failed: ${errorMessage(error)}`
    logForDebugging(`[TeammateMailbox] ${warning}`)
    return { written: true, messageId, warning }
  }
}

/**
 * Principal-based chat write path — resolves the sender best-effort (never
 * fails just because "not in a team yet") and delegates to the shared
 * envelope writer with `payloadClass: 'chat'`.
 */
async function principalWriteToMailbox(args: {
  recipient: TeamPrincipal
  message: MailboxChatInput
  teamName: string
}): Promise<MailboxWrittenResult> {
  const { recipient, message, teamName } = args
  const sender = await resolveSenderPrincipalBestEffort(teamName)
  return writeResolvedEnvelopeToMailbox({
    sender,
    recipient,
    teamName,
    payloadClass: 'chat',
    text: message.text,
    color: message.color,
    summary: message.summary,
    structured: message.structured,
  })
}

/**
 * Raised by `writeControlToMailbox` when the resolved sender/recipient
 * principals don't satisfy the direction-authority matrix (Design Decisions
 * "Mailbox control boundary") or the control payload's own identity field
 * (`from`/`agent_id`/`workerId`+`workerName`) contradicts the resolved
 * sender. Never thrown for a plain-chat write.
 */
export class MailboxControlAuthorityError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'MailboxControlAuthorityError'
  }
}

type ControlDirection = 'lead_to_teammate' | 'teammate_to_lead'

function controlDirection(
  sender: TeamPrincipal,
  receiver: TeamPrincipal,
): ControlDirection | null {
  if (sender.kind === 'leader' && receiver.kind === 'teammate') {
    return 'lead_to_teammate'
  }
  if (sender.kind === 'teammate' && receiver.kind === 'leader') {
    return 'teammate_to_lead'
  }
  return null
}

// Direction-authority matrix from the plan's Design Decisions section —
// "Mailbox control boundary". A control type absent from BOTH sets is
// rejected regardless of direction (there is currently none; every closed
// union member is listed exactly once).
const LEAD_TO_TEAMMATE_CONTROL_TYPES = new Set<MailboxControlPayload['type']>([
  'permission_response',
  'sandbox_permission_response',
  'shutdown_request',
  'plan_approval_response',
  'team_permission_update',
  'mode_set_request',
])
const TEAMMATE_TO_LEAD_CONTROL_TYPES = new Set<MailboxControlPayload['type']>([
  'permission_request',
  'sandbox_permission_request',
  'shutdown_approved',
  'shutdown_rejected',
  'plan_approval_request',
])

function isControlAllowedForDirection(
  type: MailboxControlPayload['type'],
  direction: ControlDirection,
): boolean {
  return direction === 'lead_to_teammate'
    ? LEAD_TO_TEAMMATE_CONTROL_TYPES.has(type)
    : TEAMMATE_TO_LEAD_CONTROL_TYPES.has(type)
}

/**
 * Binds friendly-name control fields (`from`) to `principal.name` and
 * durable-ID fields (`agent_id`, `workerId`/`workerName`) to
 * `principal.agentId`/`name`. Control types with no sender-identity field of
 * their own (the envelope's senderAgentId/senderAllocationId already carry
 * it) have nothing to check here.
 */
function controlFieldsMatchSender(
  control: MailboxControlPayload,
  sender: TeamPrincipal,
): boolean {
  switch (control.type) {
    case 'permission_request':
      // Despite the field name, `agent_id` carries the worker's NAME in
      // this protocol's actual usage (useInboxPoller.ts displays it as the
      // badge name and uses it as the recipient name when routing the
      // leader's response back) — bind it to `sender.name`, not
      // `sender.agentId`.
      return control.agent_id === sender.name
    case 'sandbox_permission_request':
      return (
        control.workerId === sender.agentId && control.workerName === sender.name
      )
    case 'shutdown_request':
    case 'shutdown_approved':
    case 'shutdown_rejected':
    case 'plan_approval_request':
    case 'mode_set_request':
      return control.from === sender.name
    case 'permission_response':
    case 'sandbox_permission_response':
    case 'plan_approval_response':
    case 'team_permission_update':
      return true
  }
}

function getControlRequestId(control: MailboxControlPayload): string | null {
  switch (control.type) {
    case 'permission_request':
    case 'permission_response':
      return control.request_id
    case 'sandbox_permission_request':
    case 'sandbox_permission_response':
    case 'shutdown_request':
    case 'shutdown_approved':
    case 'shutdown_rejected':
    case 'plan_approval_request':
    case 'plan_approval_response':
      return control.requestId
    case 'team_permission_update':
    case 'mode_set_request':
      return null
  }
}

function requestTypeForControl(
  type: MailboxControlPayload['type'],
): PendingControlRecord['requestType'] | null {
  switch (type) {
    case 'permission_request':
    case 'permission_response':
      return 'permission'
    case 'sandbox_permission_request':
    case 'sandbox_permission_response':
      return 'sandbox'
    case 'shutdown_request':
    case 'shutdown_approved':
    case 'shutdown_rejected':
      return 'shutdown'
    case 'plan_approval_request':
    case 'plan_approval_response':
      return 'plan'
    case 'team_permission_update':
    case 'mode_set_request':
      return null
  }
}

const RESPONSE_CONTROL_TYPES = new Set<MailboxControlPayload['type']>([
  'permission_response',
  'sandbox_permission_response',
  'shutdown_approved',
  'shutdown_rejected',
  'plan_approval_response',
])

function isResponseControlType(type: MailboxControlPayload['type']): boolean {
  return RESPONSE_CONTROL_TYPES.has(type)
}

/**
 * Finds the one outstanding request record a response control resolves,
 * scoped by request ID, request type, and the exact sender/recipient
 * agent+allocation ID tuple (reversed: the record's `recipientAgentId` is
 * the one now responding, and its `senderAgentId` is the one now
 * receiving). A `consumed` record never matches — that's a replay/duplicate.
 */
function findMatchingPendingControl(
  pendingControls: readonly PendingControlRecord[],
  control: MailboxControlPayload,
  sender: TeamPrincipal,
  receiver: TeamPrincipal,
): PendingControlRecord | null {
  const requestId = getControlRequestId(control)
  const requestType = requestTypeForControl(control.type)
  if (!requestId || !requestType) return null
  return (
    pendingControls.find(
      p =>
        p.requestId === requestId &&
        p.requestType === requestType &&
        p.state !== 'consumed' &&
        p.senderAgentId === receiver.agentId &&
        p.senderAllocationId === receiver.allocationId &&
        p.recipientAgentId === sender.agentId &&
        p.recipientAllocationId === sender.allocationId,
    ) ?? null
  )
}

/**
 * The sole producer of privileged control envelopes (Design Decisions
 * "Mailbox control boundary"). No caller-authored sender argument — the
 * sender principal is always resolved from the current process's own
 * identity against a fresh version-2 team snapshot, so a teammate can never
 * claim to be the team lead (or vice versa) by passing a `from`/`agentId`
 * field. Throws `TeamProtocolVersionError` for a legacy/absent team (Design
 * Decisions: "version-2 controls" are never accepted against those),
 * `MailboxControlAuthorityError` for a direction/field-identity violation,
 * and `MailboxWriteError` for any I/O failure.
 */
export async function writeControlToMailbox(args: {
  recipient: TeamPrincipal
  control: MailboxControlPayload
  teamName: string
  color?: string
}): Promise<MailboxWrittenResult> {
  const { recipient, control, teamName } = args
  const snapshot = await readTeamSnapshot(teamName)
  const sender = await resolveCurrentTeamPrincipal(teamName, snapshot)

  const direction = controlDirection(sender, recipient)
  if (!direction || !isControlAllowedForDirection(control.type, direction)) {
    throw new MailboxControlAuthorityError(
      `"${control.type}" is not permitted from ${sender.kind} "${sender.name}" to ${recipient.kind} "${recipient.name}"`,
    )
  }
  if (!controlFieldsMatchSender(control, sender)) {
    throw new MailboxControlAuthorityError(
      `"${control.type}" payload identity field does not match the resolved sender ("${sender.name}"/"${sender.agentId}")`,
    )
  }

  return writeResolvedEnvelopeToMailbox({
    sender,
    recipient,
    teamName,
    payloadClass: 'control',
    text: jsonStringify(control),
    color: args.color,
    control,
  })
}

/**
 * Composes `writeControlToMailbox` with request/response correlation
 * (Design Decisions "Mailbox control boundary" + Task 3 Step 6): creates a
 * `PendingControlRecord` in state `sending` before the write, transitions it
 * to `written` after a successful write, and removes it entirely if the
 * write fails (a crash between those two steps leaves a correlatable
 * `sending` record instead of silently losing the outstanding request).
 * Use for every control that ESTABLISHES a new outstanding request
 * (shutdown/permission/sandbox/plan requests) — response controls
 * (approvals/rejections) fulfill an existing record instead; see
 * `claimPendingControl`/`finishPendingControl`.
 */
export async function writeControlRequestToMailbox(args: {
  teamName: string
  requestId: string
  requestType: PendingControlRecord['requestType']
  recipient: TeamPrincipal
  control: MailboxControlPayload
  color?: string
}): Promise<MailboxWrittenResult> {
  const { teamName, requestId, requestType, recipient, control } = args
  const snapshot = await readTeamSnapshot(teamName)
  const sender = await resolveCurrentTeamPrincipal(teamName, snapshot)

  await beginPendingControl({ teamName, requestId, requestType, sender, recipient })
  try {
    const result = await writeControlToMailbox({
      recipient,
      control,
      teamName,
      color: args.color,
    })
    await markPendingControlWritten(teamName, requestId).catch(() => {})
    return result
  } catch (error) {
    await removePendingControl(teamName, requestId).catch(() => {})
    throw error
  }
}

async function beginPendingControl(args: {
  teamName: string
  requestId: string
  requestType: PendingControlRecord['requestType']
  sender: TeamPrincipal
  recipient: TeamPrincipal
}): Promise<void> {
  await transactTeamFile(args.teamName, teamFile => {
    const pendingControls = teamFile.pendingControls ?? []
    const record: PendingControlRecord = {
      requestId: args.requestId,
      requestType: args.requestType,
      senderAgentId: args.sender.agentId,
      senderAllocationId: args.sender.allocationId,
      recipientAgentId: args.recipient.agentId,
      recipientAllocationId: args.recipient.allocationId,
      state: 'sending',
    }
    return {
      teamFile: { ...teamFile, pendingControls: [...pendingControls, record] },
      result: undefined,
    }
  })
}

async function markPendingControlWritten(
  teamName: string,
  requestId: string,
): Promise<void> {
  await transactTeamFile(teamName, teamFile => {
    const pendingControls = teamFile.pendingControls ?? []
    const index = pendingControls.findIndex(
      p => p.requestId === requestId && p.state === 'sending',
    )
    if (index === -1) return { teamFile, result: undefined }
    const updated = pendingControls.map((p, i) =>
      i === index ? { ...p, state: 'written' as const } : p,
    )
    return { teamFile: { ...teamFile, pendingControls: updated }, result: undefined }
  })
}

async function removePendingControl(
  teamName: string,
  requestId: string,
): Promise<void> {
  await transactTeamFile(teamName, teamFile => {
    const pendingControls = (teamFile.pendingControls ?? []).filter(
      p => p.requestId !== requestId,
    )
    return { teamFile: { ...teamFile, pendingControls }, result: undefined }
  })
}

/**
 * Compare-and-swaps the outstanding request record a RESPONSE control
 * resolves from `sending | written` to `processing`, so that when the same
 * response is observed by more than one concurrent consumer (e.g. both
 * `useInboxPoller` and the headless attachments path), only the claim winner
 * runs the handler. A response already present in the mailbox proves the
 * original request write crossed the process boundary even if the sender
 * crashed before marking its record `written` — hence matching `sending`
 * too. Returns `null` when there is no matching unconsumed record (already
 * consumed, wrong incarnation, or never sent) — the caller must treat that
 * as unsolicited/stale, never process it.
 */
export async function claimPendingControl(args: {
  teamName: string
  response: TeammateMessage
  control: MailboxControlPayload
}): Promise<PendingControlRecord | null> {
  const requestId = getControlRequestId(args.control)
  const requestType = requestTypeForControl(args.control.type)
  if (!requestId || !requestType) return null
  const { senderAgentId, senderAllocationId, recipientAgentId, recipientAllocationId } =
    args.response
  if (!senderAgentId || !senderAllocationId || !recipientAgentId || !recipientAllocationId) {
    return null
  }

  const { result } = await transactTeamFile(args.teamName, teamFile => {
    const pendingControls = teamFile.pendingControls ?? []
    const index = pendingControls.findIndex(
      p =>
        p.requestId === requestId &&
        p.requestType === requestType &&
        (p.state === 'sending' || p.state === 'written') &&
        p.senderAgentId === recipientAgentId &&
        p.senderAllocationId === recipientAllocationId &&
        p.recipientAgentId === senderAgentId &&
        p.recipientAllocationId === senderAllocationId,
    )
    if (index === -1) return { teamFile, result: null }
    const claimed: PendingControlRecord = {
      ...pendingControls[index]!,
      state: 'processing',
    }
    const updated = pendingControls.map((p, i) => (i === index ? claimed : p))
    return {
      teamFile: { ...teamFile, pendingControls: updated },
      result: claimed,
    }
  })
  return result
}

/**
 * Finalizes a claimed request record: `consumed` on successful handling, or
 * back to `written` on handler failure so the same response can be retried
 * (`claimPendingControl` will match it again on the next poll — the mailbox
 * message itself must also stay unread in that case; see call sites).
 */
export async function finishPendingControl(args: {
  teamName: string
  requestId: string
  outcome: 'consumed' | 'retry'
}): Promise<void> {
  await transactTeamFile(args.teamName, teamFile => {
    const pendingControls = teamFile.pendingControls ?? []
    const index = pendingControls.findIndex(p => p.requestId === args.requestId)
    if (index === -1) return { teamFile, result: undefined }
    const nextState = args.outcome === 'consumed' ? 'consumed' as const : 'written' as const
    const updated = pendingControls.map((p, i) =>
      i === index ? { ...p, state: nextState } : p,
    )
    return { teamFile: { ...teamFile, pendingControls: updated }, result: undefined }
  })
}

/**
 * Writes a message to a teammate's inbox. Two call shapes:
 *
 * - Legacy positional (`recipientName, message, teamName?`): preserved
 *   behavior for existing call sites — logs and swallows failures, returns
 *   void. Not versioned.
 * - Principal object (`{ recipient, message, teamName }`): the version-2
 *   path used by SendMessageTool's roster-resolved teammate routing. Throws
 *   `MailboxWriteError` on any failure and returns a `MailboxWrittenResult`
 *   (with a UUID `messageId`) on success.
 *
 * Uses file locking to prevent race conditions when multiple agents write
 * concurrently.
 */
export function writeToMailbox(
  recipientName: string,
  message: Omit<TeammateMessage, 'read'>,
  teamName?: string,
): Promise<void>
export function writeToMailbox(args: {
  recipient: TeamPrincipal
  message: MailboxChatInput
  teamName: string
}): Promise<MailboxWrittenResult>
export function writeToMailbox(
  recipientNameOrArgs:
    | string
    | { recipient: TeamPrincipal; message: MailboxChatInput; teamName: string },
  message?: Omit<TeammateMessage, 'read'>,
  teamName?: string,
): Promise<void> | Promise<MailboxWrittenResult> {
  if (typeof recipientNameOrArgs === 'string') {
    return legacyWriteToMailbox(recipientNameOrArgs, message!, teamName)
  }
  return principalWriteToMailbox(recipientNameOrArgs)
}

/**
 * Marks only the supplied message IDs as read, leaving all others (including
 * unknown IDs, which are harmless no-ops) untouched. This is the exact-ID
 * counterpart to `markMessagesAsRead`/`markMessagesAsReadByPredicate` for
 * callers that have a `TeamPrincipal` and know precisely which envelopes they
 * finished processing.
 */
export async function acknowledgeMailboxMessages(args: {
  recipient: TeamPrincipal
  teamName: string
  messageIds: readonly string[]
}): Promise<void> {
  const { recipient, teamName, messageIds } = args
  if (messageIds.length === 0) return
  const idSet = new Set(messageIds)
  const inboxPath = getInboxPath(recipient.name, teamName)
  const lockFilePath = `${inboxPath}.lock`

  let release: (() => Promise<void>) | undefined
  try {
    release = await lockfile.lock(inboxPath, {
      lockfilePath: lockFilePath,
      ...LOCK_OPTIONS,
    })

    // Strict read: a transiently-malformed mailbox must bail (caught below),
    // never be silently truncated to `[]` and rewritten — the same data-loss
    // guard the write path uses (see readMailboxStrict's doc comment).
    const messages = await readMailboxStrict(recipient.name, inboxPath)
    const updated = messages.map(m =>
      m.messageId && idSet.has(m.messageId) ? { ...m, read: true } : m,
    )

    await writeFile(inboxPath, jsonStringify(updated, null, 2), 'utf-8')
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT') return
    logError(error)
  } finally {
    if (release) {
      try {
        await release()
      } catch {
        // Lock may have already been released
      }
    }
  }
}

/**
 * Mark a specific message in a teammate's inbox as read by index
 * Uses file locking to prevent race conditions
 * @param agentName - The agent name to mark message as read for
 * @param teamName - Optional team name
 * @param messageIndex - Index of the message to mark as read
 */
export async function markMessageAsReadByIndex(
  agentName: string,
  teamName: string | undefined,
  messageIndex: number,
): Promise<void> {
  const inboxPath = getInboxPath(agentName, teamName)
  logForDebugging(
    `[TeammateMailbox] markMessageAsReadByIndex called: agentName=${agentName}, teamName=${teamName}, index=${messageIndex}, path=${inboxPath}`,
  )

  const lockFilePath = `${inboxPath}.lock`

  let release: (() => Promise<void>) | undefined
  try {
    logForDebugging(
      `[TeammateMailbox] markMessageAsReadByIndex: acquiring lock...`,
    )
    release = await lockfile.lock(inboxPath, {
      lockfilePath: lockFilePath,
      ...LOCK_OPTIONS,
    })
    logForDebugging(`[TeammateMailbox] markMessageAsReadByIndex: lock acquired`)

    // Re-read messages after acquiring lock to get the latest state
    const messages = await readMailbox(agentName, teamName)
    logForDebugging(
      `[TeammateMailbox] markMessageAsReadByIndex: read ${messages.length} messages after lock`,
    )

    if (messageIndex < 0 || messageIndex >= messages.length) {
      logForDebugging(
        `[TeammateMailbox] markMessageAsReadByIndex: index ${messageIndex} out of bounds (${messages.length} messages)`,
      )
      return
    }

    const message = messages[messageIndex]
    if (!message || message.read) {
      logForDebugging(
        `[TeammateMailbox] markMessageAsReadByIndex: message already read or missing`,
      )
      return
    }

    messages[messageIndex] = { ...message, read: true }

    await writeFile(inboxPath, jsonStringify(messages, null, 2), 'utf-8')
    logForDebugging(
      `[TeammateMailbox] markMessageAsReadByIndex: marked message at index ${messageIndex} as read`,
    )
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT') {
      logForDebugging(
        `[TeammateMailbox] markMessageAsReadByIndex: file does not exist at ${inboxPath}`,
      )
      return
    }
    logForDebugging(
      `[TeammateMailbox] markMessageAsReadByIndex FAILED for ${agentName}: ${error}`,
    )
    logError(error)
  } finally {
    if (release) {
      await release()
      logForDebugging(
        `[TeammateMailbox] markMessageAsReadByIndex: lock released`,
      )
    }
  }
}

/**
 * Mark all messages in a teammate's inbox as read
 * Uses file locking to prevent race conditions
 * @param agentName - The agent name to mark messages as read for
 * @param teamName - Optional team name
 */
export async function markMessagesAsRead(
  agentName: string,
  teamName?: string,
): Promise<void> {
  const inboxPath = getInboxPath(agentName, teamName)
  logForDebugging(
    `[TeammateMailbox] markMessagesAsRead called: agentName=${agentName}, teamName=${teamName}, path=${inboxPath}`,
  )

  const lockFilePath = `${inboxPath}.lock`

  let release: (() => Promise<void>) | undefined
  try {
    logForDebugging(`[TeammateMailbox] markMessagesAsRead: acquiring lock...`)
    release = await lockfile.lock(inboxPath, {
      lockfilePath: lockFilePath,
      ...LOCK_OPTIONS,
    })
    logForDebugging(`[TeammateMailbox] markMessagesAsRead: lock acquired`)

    // Re-read messages after acquiring lock to get the latest state
    const messages = await readMailbox(agentName, teamName)
    logForDebugging(
      `[TeammateMailbox] markMessagesAsRead: read ${messages.length} messages after lock`,
    )

    if (messages.length === 0) {
      logForDebugging(
        `[TeammateMailbox] markMessagesAsRead: no messages to mark`,
      )
      return
    }

    const unreadCount = count(messages, m => !m.read)
    logForDebugging(
      `[TeammateMailbox] markMessagesAsRead: ${unreadCount} unread of ${messages.length} total`,
    )

    // messages comes from jsonParse — fresh, unshared objects safe to mutate
    for (const m of messages) m.read = true

    await writeFile(inboxPath, jsonStringify(messages, null, 2), 'utf-8')
    logForDebugging(
      `[TeammateMailbox] markMessagesAsRead: WROTE ${unreadCount} message(s) as read to ${inboxPath}`,
    )
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT') {
      logForDebugging(
        `[TeammateMailbox] markMessagesAsRead: file does not exist at ${inboxPath}`,
      )
      return
    }
    logForDebugging(
      `[TeammateMailbox] markMessagesAsRead FAILED for ${agentName}: ${error}`,
    )
    logError(error)
  } finally {
    if (release) {
      await release()
      logForDebugging(`[TeammateMailbox] markMessagesAsRead: lock released`)
    }
  }
}

/**
 * Clear a teammate's inbox (delete all messages)
 * @param agentName - The agent name to clear inbox for
 * @param teamName - Optional team name
 */
export async function clearMailbox(
  agentName: string,
  teamName?: string,
): Promise<void> {
  const inboxPath = getInboxPath(agentName, teamName)

  try {
    // flag 'r+' throws ENOENT if the file doesn't exist, so we don't
    // accidentally create an inbox file that wasn't there.
    await writeFile(inboxPath, '[]', { encoding: 'utf-8', flag: 'r+' })
    logForDebugging(`[TeammateMailbox] Cleared inbox for ${agentName}`)
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT') {
      return
    }
    logForDebugging(`Failed to clear inbox for ${agentName}: ${error}`)
    logError(error)
  }
}

/**
 * Format teammate messages as XML for attachment display
 */
export function formatTeammateMessages(
  messages: Array<{
    from: string
    text: string
    timestamp: string
    color?: string
    summary?: string
    structured?: TeammateStructuredPayload
  }>,
): string {
  return formatTeammateMessagesForModel(
    messages.map(m => ({
      kind: 'teammate',
      from: m.from,
      text: m.text,
      color: m.color,
      summary: m.summary,
      structured: m.structured,
    })),
  )
}

/**
 * Structured message sent when a teammate becomes idle (via Stop hook)
 */
export const IdleNotificationMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('idle_notification'),
    from: z.string(),
    timestamp: z.string(),
    idleReason: z.enum(['available', 'interrupted', 'failed']).optional(),
    summary: z.string().optional(),
    completedTaskId: z.string().optional(),
    completedStatus: z.enum(['resolved', 'blocked', 'failed']).optional(),
    failureReason: z.string().optional(),
  }),
)

export type IdleNotificationMessage = z.infer<
  ReturnType<typeof IdleNotificationMessageSchema>
>

/**
 * Creates an idle notification message to send to the team leader
 */
export function createIdleNotification(
  agentId: string,
  options?: {
    idleReason?: IdleNotificationMessage['idleReason']
    summary?: string
    completedTaskId?: string
    completedStatus?: 'resolved' | 'blocked' | 'failed'
    failureReason?: string
  },
): IdleNotificationMessage {
  return {
    type: 'idle_notification',
    from: agentId,
    timestamp: new Date().toISOString(),
    idleReason: options?.idleReason,
    summary: options?.summary,
    completedTaskId: options?.completedTaskId,
    completedStatus: options?.completedStatus,
    failureReason: options?.failureReason,
  }
}

/**
 * Checks if a message text contains an idle notification
 */
export function isIdleNotification(
  messageText: string,
): IdleNotificationMessage | null {
  try {
    const parsed = jsonParse(messageText)
    if (parsed && parsed.type === 'idle_notification') {
      return parsed as IdleNotificationMessage
    }
  } catch {
    // Not JSON or not a valid idle notification
  }
  return null
}

/**
 * Permission request message sent from worker to leader via mailbox.
 * Field names align with SDK `can_use_tool` (snake_case).
 */
export const PermissionRequestMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('permission_request'),
    request_id: z.string(),
    agent_id: z.string(),
    tool_name: z.string(),
    tool_use_id: z.string(),
    description: z.string(),
    input: z.record(z.string(), z.unknown()),
    permission_suggestions: z.array(z.unknown()),
  }),
)

export type PermissionRequestMessage = z.infer<
  ReturnType<typeof PermissionRequestMessageSchema>
>

/**
 * Permission response message sent from leader to worker via mailbox.
 * Shape mirrors SDK ControlResponseSchema / ControlErrorResponseSchema.
 */
export const PermissionResponseMessageSchema = lazySchema(() =>
  z.discriminatedUnion('subtype', [
    z.object({
      type: z.literal('permission_response'),
      request_id: z.string(),
      subtype: z.literal('success'),
      response: z
        .object({
          updated_input: z.record(z.string(), z.unknown()).optional(),
          permission_updates: z.array(z.unknown()).optional(),
        })
        .optional(),
    }),
    z.object({
      type: z.literal('permission_response'),
      request_id: z.string(),
      subtype: z.literal('error'),
      error: z.string(),
    }),
  ]),
)

export type PermissionResponseMessage = z.infer<
  ReturnType<typeof PermissionResponseMessageSchema>
>

/**
 * Creates a permission request message to send to the team leader
 */
export function createPermissionRequestMessage(params: {
  request_id: string
  agent_id: string
  tool_name: string
  tool_use_id: string
  description: string
  input: Record<string, unknown>
  permission_suggestions?: unknown[]
}): PermissionRequestMessage {
  return {
    type: 'permission_request',
    request_id: params.request_id,
    agent_id: params.agent_id,
    tool_name: params.tool_name,
    tool_use_id: params.tool_use_id,
    description: params.description,
    input: params.input,
    permission_suggestions: params.permission_suggestions || [],
  }
}

/**
 * Creates a permission response message to send back to a worker
 */
export function createPermissionResponseMessage(params: {
  request_id: string
  subtype: 'success' | 'error'
  error?: string
  updated_input?: Record<string, unknown>
  permission_updates?: unknown[]
}): PermissionResponseMessage {
  if (params.subtype === 'error') {
    return {
      type: 'permission_response',
      request_id: params.request_id,
      subtype: 'error',
      error: params.error || 'Permission denied',
    }
  }
  return {
    type: 'permission_response',
    request_id: params.request_id,
    subtype: 'success',
    response: {
      updated_input: params.updated_input,
      permission_updates: params.permission_updates,
    },
  }
}

/**
 * Checks if a message text contains a permission request
 */
export function isPermissionRequest(
  messageText: string,
): PermissionRequestMessage | null {
  try {
    const parsed = jsonParse(messageText)
    if (parsed && parsed.type === 'permission_request') {
      return parsed as PermissionRequestMessage
    }
  } catch {
    // Not JSON or not a valid permission request
  }
  return null
}

/**
 * Checks if a message text contains a permission response
 */
export function isPermissionResponse(
  messageText: string,
): PermissionResponseMessage | null {
  try {
    const parsed = jsonParse(messageText)
    if (parsed && parsed.type === 'permission_response') {
      return parsed as PermissionResponseMessage
    }
  } catch {
    // Not JSON or not a valid permission response
  }
  return null
}

/**
 * Sandbox permission request message sent from worker to leader via mailbox
 * This is triggered when sandbox runtime detects a network access to a non-allowed host
 */
export const SandboxPermissionRequestMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('sandbox_permission_request'),
    requestId: z.string(),
    workerId: z.string(),
    workerName: z.string(),
    workerColor: z.string().optional(),
    hostPattern: z.object({ host: z.string() }),
    createdAt: z.number(),
  }),
)

export type SandboxPermissionRequestMessage = z.infer<
  ReturnType<typeof SandboxPermissionRequestMessageSchema>
>

/**
 * Sandbox permission response message sent from leader to worker via mailbox
 */
export const SandboxPermissionResponseMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('sandbox_permission_response'),
    requestId: z.string(),
    host: z.string(),
    allow: z.boolean(),
    timestamp: z.string(),
  }),
)

export type SandboxPermissionResponseMessage = z.infer<
  ReturnType<typeof SandboxPermissionResponseMessageSchema>
>

/**
 * Creates a sandbox permission request message to send to the team leader
 */
export function createSandboxPermissionRequestMessage(params: {
  requestId: string
  workerId: string
  workerName: string
  workerColor?: string
  host: string
}): SandboxPermissionRequestMessage {
  return {
    type: 'sandbox_permission_request',
    requestId: params.requestId,
    workerId: params.workerId,
    workerName: params.workerName,
    workerColor: params.workerColor,
    hostPattern: { host: params.host },
    createdAt: Date.now(),
  }
}

/**
 * Creates a sandbox permission response message to send back to a worker
 */
export function createSandboxPermissionResponseMessage(params: {
  requestId: string
  host: string
  allow: boolean
}): SandboxPermissionResponseMessage {
  return {
    type: 'sandbox_permission_response',
    requestId: params.requestId,
    host: params.host,
    allow: params.allow,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Checks if a message text contains a sandbox permission request
 */
export function isSandboxPermissionRequest(
  messageText: string,
): SandboxPermissionRequestMessage | null {
  try {
    const parsed = jsonParse(messageText)
    if (parsed && parsed.type === 'sandbox_permission_request') {
      return parsed as SandboxPermissionRequestMessage
    }
  } catch {
    // Not JSON or not a valid sandbox permission request
  }
  return null
}

/**
 * Checks if a message text contains a sandbox permission response
 */
export function isSandboxPermissionResponse(
  messageText: string,
): SandboxPermissionResponseMessage | null {
  try {
    const parsed = jsonParse(messageText)
    if (parsed && parsed.type === 'sandbox_permission_response') {
      return parsed as SandboxPermissionResponseMessage
    }
  } catch {
    // Not JSON or not a valid sandbox permission response
  }
  return null
}

/**
 * Message sent when a teammate requests plan approval from the team leader
 */
export const PlanApprovalRequestMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('plan_approval_request'),
    from: z.string(),
    timestamp: z.string(),
    planFilePath: z.string(),
    planContent: z.string(),
    requestId: z.string(),
  }),
)

export type PlanApprovalRequestMessage = z.infer<
  ReturnType<typeof PlanApprovalRequestMessageSchema>
>

/**
 * Creates a plan approval request message to send to the team leader.
 */
export function createPlanApprovalRequestMessage(params: {
  requestId: string
  from: string
  planFilePath: string
  planContent: string
}): PlanApprovalRequestMessage {
  return {
    type: 'plan_approval_request',
    from: params.from,
    timestamp: new Date().toISOString(),
    planFilePath: params.planFilePath,
    planContent: params.planContent,
    requestId: params.requestId,
  }
}

/**
 * Message sent by the team leader in response to a plan approval request
 */
export const PlanApprovalResponseMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('plan_approval_response'),
    requestId: z.string(),
    approved: z.boolean(),
    feedback: z.string().optional(),
    timestamp: z.string(),
    permissionMode: PermissionModeSchema().optional(),
  }),
)

export type PlanApprovalResponseMessage = z.infer<
  ReturnType<typeof PlanApprovalResponseMessageSchema>
>

/**
 * Creates a plan approval response message to send back to a teammate.
 */
export function createPlanApprovalResponseMessage(params: {
  requestId: string
  approved: boolean
  feedback?: string
  permissionMode?: PlanApprovalResponseMessage['permissionMode']
}): PlanApprovalResponseMessage {
  return {
    type: 'plan_approval_response',
    requestId: params.requestId,
    approved: params.approved,
    feedback: params.feedback,
    timestamp: new Date().toISOString(),
    permissionMode: params.permissionMode,
  }
}

/**
 * Shutdown request message sent from leader to teammate via mailbox
 */
export const ShutdownRequestMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('shutdown_request'),
    requestId: z.string(),
    from: z.string(),
    reason: z.string().optional(),
    timestamp: z.string(),
  }),
)

export type ShutdownRequestMessage = z.infer<
  ReturnType<typeof ShutdownRequestMessageSchema>
>

/**
 * Shutdown approved message sent from teammate to leader via mailbox
 */
export const ShutdownApprovedMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('shutdown_approved'),
    requestId: z.string(),
    from: z.string(),
    timestamp: z.string(),
    paneId: z.string().optional(),
    backendType: z.string().optional(),
  }),
)

export type ShutdownApprovedMessage = z.infer<
  ReturnType<typeof ShutdownApprovedMessageSchema>
>

/**
 * Shutdown rejected message sent from teammate to leader via mailbox
 */
export const ShutdownRejectedMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('shutdown_rejected'),
    requestId: z.string(),
    from: z.string(),
    reason: z.string(),
    timestamp: z.string(),
  }),
)

export type ShutdownRejectedMessage = z.infer<
  ReturnType<typeof ShutdownRejectedMessageSchema>
>

/**
 * Creates a shutdown request message to send to a teammate
 */
export function createShutdownRequestMessage(params: {
  requestId: string
  from: string
  reason?: string
}): ShutdownRequestMessage {
  return {
    type: 'shutdown_request',
    requestId: params.requestId,
    from: params.from,
    reason: params.reason,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Creates a shutdown approved message to send to the team leader
 */
export function createShutdownApprovedMessage(params: {
  requestId: string
  from: string
  paneId?: string
  backendType?: BackendType
}): ShutdownApprovedMessage {
  return {
    type: 'shutdown_approved',
    requestId: params.requestId,
    from: params.from,
    timestamp: new Date().toISOString(),
    paneId: params.paneId,
    backendType: params.backendType,
  }
}

/**
 * Creates a shutdown rejected message to send to the team leader
 */
export function createShutdownRejectedMessage(params: {
  requestId: string
  from: string
  reason: string
}): ShutdownRejectedMessage {
  return {
    type: 'shutdown_rejected',
    requestId: params.requestId,
    from: params.from,
    reason: params.reason,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Sends a shutdown request to a teammate's mailbox.
 * This is the core logic extracted for reuse by both the tool and UI components.
 *
 * @param targetName - Name of the teammate to send shutdown request to
 * @param teamName - Optional team name (defaults to CLAUDE_CODE_TEAM_NAME env var)
 * @param reason - Optional reason for the shutdown request
 * @returns The request ID and target name
 */
export async function sendShutdownRequestToMailbox(
  targetName: string,
  teamName?: string,
  reason?: string,
): Promise<{ requestId: string; target: string }> {
  const resolvedTeamName = teamName || getTeamName()
  if (!resolvedTeamName) {
    throw new Error('sendShutdownRequestToMailbox requires a team name')
  }

  const snapshot = await readTeamSnapshot(resolvedTeamName)
  const recipient = resolveTeamPrincipalByName(snapshot, targetName)
  if (!recipient) {
    throw new Error(
      `No teammate named "${targetName}" found in team "${resolvedTeamName}"`,
    )
  }

  // Generate a deterministic request ID for this shutdown request
  const requestId = generateRequestId('shutdown', targetName)

  // Get sender name (supports in-process teammates via AsyncLocalStorage) —
  // only the team lead may issue a shutdown_request; a non-lead caller fails
  // the direction-authority check inside writeControlToMailbox.
  const senderName = getAgentName() || TEAM_LEAD_NAME

  const shutdownMessage = createShutdownRequestMessage({
    requestId,
    from: senderName,
    reason,
  })

  await writeControlRequestToMailbox({
    teamName: resolvedTeamName,
    requestId,
    requestType: 'shutdown',
    recipient,
    control: shutdownMessage,
    color: getTeammateColor(),
  })

  return { requestId, target: targetName }
}

/**
 * Checks if a message text contains a shutdown request
 */
export function isShutdownRequest(
  messageText: string,
): ShutdownRequestMessage | null {
  try {
    const result = ShutdownRequestMessageSchema().safeParse(
      jsonParse(messageText),
    )
    if (result.success) return result.data
  } catch {
    // Not JSON
  }
  return null
}

/**
 * Checks if a message text contains a plan approval request
 */
export function isPlanApprovalRequest(
  messageText: string,
): PlanApprovalRequestMessage | null {
  try {
    const result = PlanApprovalRequestMessageSchema().safeParse(
      jsonParse(messageText),
    )
    if (result.success) return result.data
  } catch {
    // Not JSON
  }
  return null
}

/**
 * Checks if a message text contains a shutdown approved message
 */
export function isShutdownApproved(
  messageText: string,
): ShutdownApprovedMessage | null {
  try {
    const result = ShutdownApprovedMessageSchema().safeParse(
      jsonParse(messageText),
    )
    if (result.success) return result.data
  } catch {
    // Not JSON
  }
  return null
}

/**
 * Checks if a message text contains a shutdown rejected message
 */
export function isShutdownRejected(
  messageText: string,
): ShutdownRejectedMessage | null {
  try {
    const result = ShutdownRejectedMessageSchema().safeParse(
      jsonParse(messageText),
    )
    if (result.success) return result.data
  } catch {
    // Not JSON
  }
  return null
}

/**
 * Checks if a message text contains a plan approval response
 */
export function isPlanApprovalResponse(
  messageText: string,
): PlanApprovalResponseMessage | null {
  try {
    const result = PlanApprovalResponseMessageSchema().safeParse(
      jsonParse(messageText),
    )
    if (result.success) return result.data
  } catch {
    // Not JSON
  }
  return null
}

/**
 * Task assignment message sent when a task is assigned to a teammate
 */
export const TaskAssignmentMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('task_assignment'),
    taskId: z.string(),
    subject: z.string(),
    description: z.string(),
    assignedBy: z.string(),
    timestamp: z.string(),
  }),
)

export type TaskAssignmentMessage = z.infer<
  ReturnType<typeof TaskAssignmentMessageSchema>
>

/**
 * Creates a task assignment notification for the task's new owner.
 */
export function createTaskAssignmentMessage(params: {
  taskId: string
  subject: string
  description: string
  assignedBy: string
}): TaskAssignmentMessage {
  return {
    type: 'task_assignment',
    taskId: params.taskId,
    subject: params.subject,
    description: params.description,
    assignedBy: params.assignedBy,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Checks if a message text contains a task assignment
 */
export function isTaskAssignment(
  messageText: string,
): TaskAssignmentMessage | null {
  try {
    const result = TaskAssignmentMessageSchema().safeParse(
      jsonParse(messageText),
    )
    if (result.success) return result.data
  } catch {
    // Not JSON
  }
  return null
}

/**
 * Team permission update message sent from leader to teammates via mailbox
 * Broadcasts a permission update that applies to all teammates
 */
export const TeamPermissionUpdateMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('team_permission_update'),
    /** The permission update to apply */
    permissionUpdate: z.object({
      type: z.literal('addRules'),
      rules: z.array(
        z.object({ toolName: z.string(), ruleContent: z.string().optional() }),
      ),
      behavior: z.enum(['allow', 'deny', 'ask']),
      destination: z.literal('session'),
    }),
    /** The directory path that was allowed */
    directoryPath: z.string(),
    /** The tool name this applies to */
    toolName: z.string(),
  }),
)

export type TeamPermissionUpdateMessage = z.infer<
  ReturnType<typeof TeamPermissionUpdateMessageSchema>
>

/**
 * Checks if a message text contains a team permission update
 */
export function isTeamPermissionUpdate(
  messageText: string,
): TeamPermissionUpdateMessage | null {
  try {
    const result = TeamPermissionUpdateMessageSchema().safeParse(
      jsonParse(messageText),
    )
    if (result.success) return result.data
  } catch {
    // Not JSON
  }
  return null
}

/**
 * Mode set request message sent from leader to teammate via mailbox
 * Uses SDK PermissionModeSchema for validated mode values
 */
export const ModeSetRequestMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('mode_set_request'),
    mode: PermissionModeSchema(),
    from: z.string(),
  }),
)

export type ModeSetRequestMessage = z.infer<
  ReturnType<typeof ModeSetRequestMessageSchema>
>

/**
 * Creates a mode set request message to send to a teammate
 */
export function createModeSetRequestMessage(params: {
  mode: string
  from: string
}): ModeSetRequestMessage {
  return {
    type: 'mode_set_request',
    mode: params.mode as ModeSetRequestMessage['mode'],
    from: params.from,
  }
}

/**
 * Checks if a message text contains a mode set request
 */
export function isModeSetRequest(
  messageText: string,
): ModeSetRequestMessage | null {
  try {
    const parsed = ModeSetRequestMessageSchema().safeParse(
      jsonParse(messageText),
    )
    if (parsed.success) {
      return parsed.data
    }
  } catch {
    // Not JSON or not a valid mode set request
  }
  return null
}

/**
 * Closed union of every privileged control payload. Only `writeControlToMailbox`
 * may produce one of these — plain chat (`MailboxChatInput`) statically
 * excludes `control`. An unknown/unlisted `type` is not a control; a message
 * carrying one is either a notification (below) or plain chat.
 */
export const MailboxControlPayloadSchema = lazySchema(() =>
  z.union([
    PermissionRequestMessageSchema(),
    PermissionResponseMessageSchema(),
    SandboxPermissionRequestMessageSchema(),
    SandboxPermissionResponseMessageSchema(),
    ShutdownRequestMessageSchema(),
    ShutdownApprovedMessageSchema(),
    ShutdownRejectedMessageSchema(),
    PlanApprovalRequestMessageSchema(),
    PlanApprovalResponseMessageSchema(),
    TeamPermissionUpdateMessageSchema(),
    ModeSetRequestMessageSchema(),
  ]),
)

export type MailboxControlPayload = z.infer<
  ReturnType<typeof MailboxControlPayloadSchema>
>

/**
 * Closed union of non-privileged mailbox notifications. These "remain
 * notifications with their existing behavior" (Design Decisions) — unlike
 * controls, they carry no authority and classify by shape alone regardless
 * of envelope version (see `classifyMailboxMessage`).
 */
export const MailboxNotificationPayloadSchema = lazySchema(() =>
  z.union([IdleNotificationMessageSchema(), TaskAssignmentMessageSchema()]),
)

export type MailboxNotificationPayload = z.infer<
  ReturnType<typeof MailboxNotificationPayloadSchema>
>

/**
 * Checks if a message text is a structured protocol message that should be
 * routed by useInboxPoller rather than consumed as raw LLM context.
 *
 * These message types have specific handlers in useInboxPoller that route them
 * to the correct queues (workerPermissions, workerSandboxPermissions, etc.).
 * If getTeammateMailboxAttachments consumes them first, they get bundled as
 * raw text in attachments and never reach their intended handlers.
 */
export function isStructuredProtocolMessage(messageText: string): boolean {
  try {
    const parsed = jsonParse(messageText)
    if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
      return false
    }
    const type = (parsed as { type: unknown }).type
    return (
      type === 'permission_request' ||
      type === 'permission_response' ||
      type === 'sandbox_permission_request' ||
      type === 'sandbox_permission_response' ||
      type === 'shutdown_request' ||
      type === 'shutdown_approved' ||
      type === 'team_permission_update' ||
      type === 'mode_set_request' ||
      type === 'plan_approval_request' ||
      type === 'plan_approval_response'
    )
  } catch {
    return false
  }
}

// Every `MailboxControlPayload` member's `type` literal — used only to
// detect an UNMARKED legacy control-shaped payload (no protocolVersion 2
// envelope) so it can be rejected as `protocol_mismatch` instead of being
// silently treated as chat. Unlike `isStructuredProtocolMessage` above, this
// list includes `shutdown_rejected` (that function predates it and never
// gained it — left as-is since it has other, unrelated call sites).
const CONTROL_TYPE_LITERALS = new Set<MailboxControlPayload['type']>([
  'permission_request',
  'permission_response',
  'sandbox_permission_request',
  'sandbox_permission_response',
  'shutdown_request',
  'shutdown_approved',
  'shutdown_rejected',
  'plan_approval_request',
  'plan_approval_response',
  'team_permission_update',
  'mode_set_request',
])

function looksLikeControlShapedJson(text: string): boolean {
  try {
    const parsed = jsonParse(text)
    return (
      !!parsed &&
      typeof parsed === 'object' &&
      'type' in parsed &&
      CONTROL_TYPE_LITERALS.has((parsed as { type: unknown }).type as never)
    )
  } catch {
    return false
  }
}

function tryParseNotification(text: string): MailboxNotificationPayload | null {
  let parsedJson: unknown
  try {
    parsedJson = jsonParse(text)
  } catch {
    return null
  }
  const result = MailboxNotificationPayloadSchema().safeParse(parsedJson)
  return result.success ? result.data : null
}

/**
 * Classification result for one mailbox message: which of the three payload
 * classes it is, or why it's neither a valid control nor plain chat.
 * `invalid_control` and `protocol_mismatch` are terminal — callers must never
 * downgrade either to `chat` (Design Decisions "Mailbox control boundary").
 */
export type ClassifiedMailboxMessage =
  | { kind: 'chat'; message: TeammateMessage }
  | {
      kind: 'notification'
      message: TeammateMessage
      notification: MailboxNotificationPayload
    }
  | { kind: 'control'; message: TeammateMessage; control: MailboxControlPayload }
  | { kind: 'invalid_control'; message: TeammateMessage; reason: string }
  | { kind: 'protocol_mismatch'; message: TeammateMessage; reason: string }

/**
 * The sole authority-checked classifier for a mailbox message. Pure and
 * synchronous — callers resolve `sender`/`receiver` principals from a fresh
 * versioned team snapshot (and `pendingControls` from that same snapshot)
 * before calling this.
 *
 * - `idle_notification`/`task_assignment` classify as `notification` by
 *   shape alone, regardless of envelope version — they carry no authority
 *   ("remain notifications with their existing behavior").
 * - A non-version-2 envelope is `chat`, UNLESS its text is shaped like one of
 *   the closed control types, in which case it's an unmarked legacy control
 *   and must fail as `protocol_mismatch` rather than being silently consumed
 *   as chat.
 * - A version-2 envelope declaring `payloadClass !== 'control'` is `chat`
 *   (a declared-but-unparseable `notification` payloadClass is
 *   `protocol_mismatch`). Chat identity (recipientAllocationId etc.) is
 *   intentionally NOT gated here — a stale-recipient chat message is a
 *   delivery-eligibility question for the caller (e.g. attachments.ts), not
 *   a validity question for the classifier.
 * - A version-2 `control` envelope must match the resolved sender/receiver
 *   principals exactly (agent+allocation ID), parse against the closed
 *   control union, satisfy the direction-authority matrix, satisfy
 *   field-identity binding, and — for response-shaped controls — resolve
 *   exactly one unconsumed outstanding request in `pendingControls`. Any
 *   failure is `invalid_control`, never downgraded to `chat`.
 */
export function classifyMailboxMessage(args: {
  message: TeammateMessage
  receiver: TeamPrincipal
  sender: TeamPrincipal
  pendingControls: readonly PendingControlRecord[]
}): ClassifiedMailboxMessage {
  const { message, receiver, sender, pendingControls } = args

  const notification = tryParseNotification(message.text)
  if (notification) return { kind: 'notification', message, notification }

  if (message.protocolVersion !== 2) {
    if (looksLikeControlShapedJson(message.text)) {
      return {
        kind: 'protocol_mismatch',
        message,
        reason:
          'Control-shaped payload is missing the protocolVersion 2 envelope',
      }
    }
    return { kind: 'chat', message }
  }

  if (message.payloadClass !== 'control') {
    if (message.payloadClass === 'notification') {
      return {
        kind: 'protocol_mismatch',
        message,
        reason:
          'Declared notification payload did not match a known notification shape',
      }
    }
    return { kind: 'chat', message }
  }

  if (
    message.senderAgentId !== sender.agentId ||
    message.senderAllocationId !== sender.allocationId ||
    message.recipientAgentId !== receiver.agentId ||
    message.recipientAllocationId !== receiver.allocationId
  ) {
    return {
      kind: 'invalid_control',
      message,
      reason:
        'Envelope sender/recipient identity does not match the resolved principals',
    }
  }

  let rawControl: unknown
  try {
    rawControl = message.control ?? jsonParse(message.text)
  } catch {
    return {
      kind: 'invalid_control',
      message,
      reason: 'Control payload is not valid JSON',
    }
  }
  const parsed = MailboxControlPayloadSchema().safeParse(rawControl)
  if (!parsed.success) {
    return {
      kind: 'invalid_control',
      message,
      reason: `Unrecognized or malformed control payload: ${parsed.error.message}`,
    }
  }
  const control = parsed.data

  const direction = controlDirection(sender, receiver)
  if (!direction || !isControlAllowedForDirection(control.type, direction)) {
    return {
      kind: 'invalid_control',
      message,
      reason: `"${control.type}" is not permitted from ${sender.kind} to ${receiver.kind}`,
    }
  }

  if (!controlFieldsMatchSender(control, sender)) {
    return {
      kind: 'invalid_control',
      message,
      reason: 'Control payload identity field does not match the resolved sender',
    }
  }

  if (isResponseControlType(control.type)) {
    const match = findMatchingPendingControl(pendingControls, control, sender, receiver)
    if (!match) {
      return {
        kind: 'invalid_control',
        message,
        reason: `No outstanding "${control.type}" request matches this response`,
      }
    }
  }

  return { kind: 'control', message, control }
}

/**
 * Marks only messages matching a predicate as read, leaving others unread.
 * Uses the same file-locking mechanism as markMessagesAsRead.
 */
export async function markMessagesAsReadByPredicate(
  agentName: string,
  predicate: (msg: TeammateMessage) => boolean,
  teamName?: string,
): Promise<void> {
  const inboxPath = getInboxPath(agentName, teamName)

  const lockFilePath = `${inboxPath}.lock`
  let release: (() => Promise<void>) | undefined

  try {
    release = await lockfile.lock(inboxPath, {
      lockfilePath: lockFilePath,
      ...LOCK_OPTIONS,
    })

    const messages = await readMailbox(agentName, teamName)
    if (messages.length === 0) {
      return
    }

    const updatedMessages = messages.map(m =>
      !m.read && predicate(m) ? { ...m, read: true } : m,
    )

    await writeFile(inboxPath, jsonStringify(updatedMessages, null, 2), 'utf-8')
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT') {
      return
    }
    logError(error)
  } finally {
    if (release) {
      try {
        await release()
      } catch {
        // Lock may have already been released
      }
    }
  }
}

/**
 * Extracts a "[to {name}] {summary}" string from the last assistant message
 * if it ended with a SendMessage tool_use targeting a peer (not the team lead).
 * Returns undefined when the turn didn't end with a peer DM.
 */
export function getLastPeerDmSummary(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) continue

    // Stop at wake-up boundary: a user prompt (string content), not tool results (array content)
    if (msg.type === 'user' && typeof msg.message.content === 'string') {
      break
    }

    if (msg.type !== 'assistant') continue
    for (const block of msg.message.content) {
      if (
        block.type === 'tool_use' &&
        block.name === SEND_MESSAGE_TOOL_NAME &&
        typeof block.input === 'object' &&
        block.input !== null &&
        'to' in block.input &&
        typeof block.input.to === 'string' &&
        block.input.to !== '*' &&
        block.input.to.toLowerCase() !== TEAM_LEAD_NAME.toLowerCase() &&
        'message' in block.input &&
        typeof block.input.message === 'string'
      ) {
        const to = block.input.to
        const summary =
          'summary' in block.input && typeof block.input.summary === 'string'
            ? block.input.summary
            : block.input.message.slice(0, 80)
        return `[to ${to}] ${summary}`
      }
    }
  }
  return undefined
}
