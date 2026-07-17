import { randomUUID } from 'crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod/v4'
import { getSessionCreatedTeams } from '../../bootstrap/state.js'
import { formatAgentId } from '../agentId.js'
import { logForDebugging } from '../debug.js'
import { getTeamsDir } from '../envUtils.js'
import { errorMessage, getErrnoCode } from '../errors.js'
import { execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import { gitExe } from '../git.js'
import { lazySchema } from '../lazySchema.js'
import { lock } from '../lockfile.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import {
  canonicalizeNewTeammateName,
  MAX_TEAMMATE_NAME_BYTES,
  recipientNameKey,
} from '../recipientIdentity.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import { getTasksDir, notifyTasksUpdated } from '../tasks.js'
import { getAgentName, getTeamName, isTeammate } from '../teammate.js'
import { type BackendType, isPaneBackend } from './backends/types.js'
import { TEAM_LEAD_NAME } from './constants.js'

export const inputSchema = lazySchema(() =>
  z.strictObject({
    operation: z
      .enum(['spawnTeam', 'cleanup'])
      .describe(
        'Operation: spawnTeam to create a team, cleanup to remove team and task directories.',
      ),
    agent_type: z
      .string()
      .optional()
      .describe(
        'Type/role of the team lead (e.g., "researcher", "test-runner"). ' +
          'Used for team file and inter-agent coordination.',
      ),
    team_name: z
      .string()
      .optional()
      .describe('Name for the new team to create (required for spawnTeam).'),
    description: z
      .string()
      .optional()
      .describe('Team description/purpose (only used with spawnTeam).'),
  }),
)

// Output types for different operations
export type SpawnTeamOutput = {
  team_name: string
  team_file_path: string
  lead_agent_id: string
}

export type CleanupOutput = {
  success: boolean
  message: string
  team_name?: string
}

export type TeamAllowedPath = {
  path: string // Directory path (absolute)
  toolName: string // The tool this applies to (e.g., "Edit", "Write")
  addedBy: string // Agent name who added this rule
  addedAt: number // Timestamp when added
}

/**
 * A single named allocation within a team's shared recipient namespace.
 * Local subagent aliases and teammate names share one collection so a new
 * allocation of either kind can never collide with the other. Records are
 * never deleted — `terminated` records remain as tombstones until explicit
 * team cleanup, so a key/allocationId can never be silently reused.
 */
export type TeamRecipientRecord = {
  allocationId: string
  key: string
  name: string
  kind: 'leader' | 'local' | 'teammate'
  agentId: string
  sessionId: string
  status: 'reserved' | 'starting' | 'active' | 'stopped' | 'terminated'
  launcherPid: number
  launcherInstanceId: string
  backendType?: BackendType
  createdAt: number
  updatedAt: number
}

/**
 * One outstanding privileged-control request/response correlation record.
 * Created (state `sending` -> `written`) by the requester when it emits a
 * request-shaped control (shutdown request, permission/sandbox/plan
 * request); claimed (`written` -> `processing`) by the recipient when it
 * processes the matching response so a duplicate/racing delivery can't be
 * handled twice; finalized to `consumed` on success or returned to
 * `written` on handler failure so the response can be retried. See
 * `docs/superpowers/plans/2026-07-12-agent-control-routing-hardening-plan.md`
 * Task 3.
 */
export type PendingControlRecord = {
  requestId: string
  requestType: 'permission' | 'sandbox' | 'shutdown' | 'plan'
  senderAgentId: string
  senderAllocationId: string
  recipientAgentId: string
  recipientAllocationId: string
  state: 'sending' | 'written' | 'processing' | 'consumed'
}

export type TeamFile = {
  name: string
  description?: string
  createdAt: number
  leadAgentId: string
  leadSessionId?: string // Actual session UUID of the leader (for discovery)
  hiddenPaneIds?: string[] // Pane IDs that are currently hidden from the UI
  teamAllowedPaths?: TeamAllowedPath[] // Paths all teammates can edit without asking
  // Absent/non-2 means a legacy team file: version-2 controls (recipient
  // records, pending controls, typed mailbox envelopes) must not be applied
  // to it. Legacy teams must be restarted or cleaned up, never silently
  // upgraded in place.
  teamProtocolVersion?: 2
  recipientRecords?: TeamRecipientRecord[]
  // Absent is treated identically to `[]` everywhere this is read (teams
  // created before this field shipped, or a caller that doesn't bother
  // seeding it) — never a distinct "unknown" state.
  pendingControls?: PendingControlRecord[]
  members: Array<{
    agentId: string
    name: string
    agentType?: string
    model?: string
    prompt?: string
    color?: string
    planModeRequired?: boolean
    joinedAt: number
    tmuxPaneId: string
    cwd: string
    worktreePath?: string
    sessionId?: string
    subscriptions: string[]
    backendType?: BackendType
    isActive?: boolean // false when idle, undefined/true when active
    mode?: PermissionMode // Current permission mode for this teammate
    allocationId?: string // TeamRecipientRecord.allocationId for version-2 teams
  }>
}

export type Input = z.infer<ReturnType<typeof inputSchema>>
// Export SpawnTeamOutput as Output for backward compatibility
export type Output = SpawnTeamOutput

/**
 * Sanitizes a name for use in tmux window names, worktree paths, and file paths.
 * Replaces all non-alphanumeric characters with hyphens and lowercases.
 */
export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()
}

/**
 * Sanitizes an agent name for use in deterministic agent IDs.
 * Replaces @ with - to prevent ambiguity in the agentName@teamName format.
 * @deprecated New teammate/local recipient names are canonicalized once via
 * `canonicalizeNewTeammateName`/`recipientNameKey` at allocation time and
 * never need re-sanitizing downstream. Retained only for any remaining
 * legacy call sites operating on pre-existing names.
 */
export function sanitizeAgentName(name: string): string {
  return name.replace(/@/g, '-')
}

/**
 * Gets the path to a team's directory
 */
export function getTeamDir(teamName: string): string {
  return join(getTeamsDir(), sanitizeName(teamName))
}

/**
 * Gets the path to a team's config.json file
 */
export function getTeamFilePath(teamName: string): string {
  return join(getTeamDir(teamName), 'config.json')
}

/**
 * Reads a team file by name (sync — for sync contexts like React render paths)
 * @internal Exported for team discovery UI
 */
// sync IO: called from sync context
export function readTeamFile(teamName: string): TeamFile | null {
  try {
    const content = readFileSync(getTeamFilePath(teamName), 'utf-8')
    return jsonParse(content) as TeamFile
  } catch (e) {
    if (getErrnoCode(e) === 'ENOENT') return null
    logForDebugging(
      `[TeammateTool] Failed to read team file for ${teamName}: ${errorMessage(e)}`,
    )
    return null
  }
}

/**
 * Reads a team file by name (async — for tool handlers and other async contexts)
 */
export async function readTeamFileAsync(
  teamName: string,
): Promise<TeamFile | null> {
  try {
    const content = await readFile(getTeamFilePath(teamName), 'utf-8')
    return jsonParse(content) as TeamFile
  } catch (e) {
    if (getErrnoCode(e) === 'ENOENT') return null
    logForDebugging(
      `[TeammateTool] Failed to read team file for ${teamName}: ${errorMessage(e)}`,
    )
    return null
  }
}

/**
 * Writes a team file (sync — for sync contexts)
 */
// sync IO: called from sync context
function writeTeamFile(teamName: string, teamFile: TeamFile): void {
  const teamDir = getTeamDir(teamName)
  mkdirSync(teamDir, { recursive: true })
  writeFileSync(getTeamFilePath(teamName), jsonStringify(teamFile, null, 2))
}

/**
 * Writes a team file (async — for tool handlers)
 */
export async function writeTeamFileAsync(
  teamName: string,
  teamFile: TeamFile,
): Promise<void> {
  const teamDir = getTeamDir(teamName)
  await mkdir(teamDir, { recursive: true })
  await writeFile(getTeamFilePath(teamName), jsonStringify(teamFile, null, 2))
}

// ============================================================================
// Versioned team transactions
//
// All version-2 team-file mutations go through `transactTeamFile`: lock,
// fresh-read, validate, apply one transaction, write once, unlock. Mailbox
// I/O must never happen while the team lock is held — callers take a
// snapshot via `readTeamSnapshot`/`transactTeamFile`, release the lock, then
// do mailbox I/O separately.
// ============================================================================

export class TeamFileLockError extends Error {
  constructor(teamName: string, cause: unknown) {
    super(`Failed to lock team file for "${teamName}": ${errorMessage(cause)}`)
    this.name = 'TeamFileLockError'
  }
}

export class TeamProtocolVersionError extends Error {
  constructor(teamName: string, found: number | undefined) {
    super(
      `Team "${teamName}" is on protocol version ${found ?? 'legacy'}, not 2. ` +
        'Restart or clean up this team before using version-2 routing/controls.',
    )
    this.name = 'TeamProtocolVersionError'
  }
}

export class RecipientConflictError extends Error {
  constructor(key: string) {
    super(`Recipient key "${key}" is already allocated in this team`)
    this.name = 'RecipientConflictError'
  }
}

export class RecipientTransitionError extends Error {
  constructor(allocationId: string, from: string, to: string, reason: string) {
    super(
      `Cannot transition recipient ${allocationId} from "${from}" to "${to}": ${reason}`,
    )
    this.name = 'RecipientTransitionError'
  }
}

const TEAM_LOCK_RETRY_OPTIONS = {
  retries: 8,
  factor: 1.5,
  minTimeout: 10,
  maxTimeout: 100,
} as const

function teamLockOptions(teamName: string) {
  const filePath = getTeamFilePath(teamName)
  return {
    lockfilePath: `${filePath}.lock`,
    realpath: false,
    stale: 60_000,
    retries: TEAM_LOCK_RETRY_OPTIONS,
  } as const
}

function assertVersion2(
  teamName: string,
  teamFile: TeamFile,
): asserts teamFile is TeamFile & {
  teamProtocolVersion: 2
  recipientRecords: TeamRecipientRecord[]
} {
  if (teamFile.teamProtocolVersion !== 2 || !teamFile.recipientRecords) {
    throw new TeamProtocolVersionError(teamName, teamFile.teamProtocolVersion)
  }
}

/**
 * Briefly locks the team file to fresh-read and validate it, then returns a
 * detached, immutable snapshot. Safe to hold onto after the lock releases —
 * it will not reflect subsequent writes. Throws `TeamProtocolVersionError`
 * for a legacy (pre-version-2) team file.
 */
export async function readTeamSnapshot(
  teamName: string,
): Promise<Readonly<TeamFile>> {
  const filePath = getTeamFilePath(teamName)
  let release: () => Promise<void>
  try {
    release = await lock(filePath, teamLockOptions(teamName))
  } catch (e) {
    throw new TeamFileLockError(teamName, e)
  }
  try {
    const teamFile = await readTeamFileAsync(teamName)
    if (!teamFile) {
      throw new Error(`Team "${teamName}" does not exist`)
    }
    assertVersion2(teamName, teamFile)
    return Object.freeze(structuredClone(teamFile))
  } finally {
    await release().catch(() => {})
  }
}

/**
 * The one write path for version-2 team-file mutations: locks, fresh-reads,
 * validates, applies `transaction` once, writes once, unlocks. Neither the
 * lock nor the transaction callback may perform mailbox I/O.
 *
 * A lock-release failure AFTER a successful write returns the committed
 * result plus a `warning` instead of throwing — the write already happened,
 * so throwing here would invite a caller to retry and double-apply it.
 */
export async function transactTeamFile<T>(
  teamName: string,
  transaction: (
    teamFile: TeamFile,
  ) => { teamFile: TeamFile; result: T } | Promise<{ teamFile: TeamFile; result: T }>,
): Promise<{ result: T; warning?: string }> {
  const filePath = getTeamFilePath(teamName)
  let release: () => Promise<void>
  try {
    release = await lock(filePath, teamLockOptions(teamName))
  } catch (e) {
    throw new TeamFileLockError(teamName, e)
  }

  let committed: { result: T }
  try {
    const current = await readTeamFileAsync(teamName)
    if (!current) {
      throw new Error(`Team "${teamName}" does not exist`)
    }
    assertVersion2(teamName, current)
    const { teamFile: next, result } = await transaction(current)
    await writeTeamFileAsync(teamName, next)
    committed = { result }
  } catch (e) {
    await release().catch(() => {})
    throw e
  }

  try {
    await release()
    return committed
  } catch (e) {
    const warning = `Team file write for "${teamName}" committed, but lock release failed: ${errorMessage(e)}`
    logForDebugging(`[teamHelpers] ${warning}`)
    return { ...committed, warning }
  }
}

// One UUID per running process — distinguishes "this exact process instance"
// from a PID, which can be reused by the OS after the process that launched
// a `starting` allocation has died.
const PROCESS_INSTANCE_ID = randomUUID()

function isKeyOccupied(
  key: string,
  recipientRecords: readonly TeamRecipientRecord[],
  forbiddenKeys: ReadonlySet<string>,
): boolean {
  if (forbiddenKeys.has(key)) return true
  return recipientRecords.some(record => record.key === key)
}

/**
 * Reserves a new recipient key (local subagent alias or teammate name) under
 * one team transaction. `terminated` records still occupy their key — a
 * name is never reused within a team, even after the recipient it named is
 * gone. `forbiddenKeys` lets a caller fold in process-local reservations
 * (e.g. an in-flight worker-name claim) that this team file doesn't know
 * about yet.
 */
export async function allocateTeamRecipient(args: {
  teamName: string
  requestedName: string
  kind: 'local' | 'teammate'
  conflict: 'error' | 'suffix'
  forbiddenKeys: ReadonlySet<string>
  sessionId: string
  backendType?: BackendType
}): Promise<TeamRecipientRecord> {
  const { result } = await transactTeamFile(args.teamName, teamFile => {
    const recipientRecords = teamFile.recipientRecords ?? []

    const buildCandidate = (name: string): { name: string; key: string } =>
      args.kind === 'teammate'
        ? {
            name: canonicalizeNewTeammateName(name),
            key: canonicalizeNewTeammateName(name),
          }
        : { name, key: recipientNameKey(name) }

    let candidate = buildCandidate(args.requestedName)
    if (isKeyOccupied(candidate.key, recipientRecords, args.forbiddenKeys)) {
      if (args.conflict === 'error') {
        throw new RecipientConflictError(candidate.key)
      }
      const baseName = args.requestedName.trim()
      let suffix = 2
      for (;;) {
        const suffixStr = `-${suffix}`
        // canonicalizeNewTeammateName's charset is ASCII-only (byte length
        // == character length here), so a plain slice is safe. Truncate the
        // base so a long-but-otherwise-valid name doesn't throw when a
        // suffix pushes it over the byte cap — degrade to a shorter unique
        // candidate instead of surfacing an internal validation error for
        // what's really just "try another candidate."
        const maxBaseLength = Math.max(
          1,
          MAX_TEAMMATE_NAME_BYTES - suffixStr.length,
        )
        const next = buildCandidate(
          `${baseName.slice(0, maxBaseLength)}${suffixStr}`,
        )
        if (!isKeyOccupied(next.key, recipientRecords, args.forbiddenKeys)) {
          candidate = next
          break
        }
        suffix += 1
      }
    }

    const now = Date.now()
    const record: TeamRecipientRecord = {
      allocationId: randomUUID(),
      key: candidate.key,
      name: candidate.name,
      kind: args.kind,
      agentId: formatAgentId(candidate.name, args.teamName),
      sessionId: args.sessionId,
      status: 'reserved',
      launcherPid: process.pid,
      launcherInstanceId: PROCESS_INSTANCE_ID,
      backendType: args.backendType,
      createdAt: now,
      updatedAt: now,
    }

    return {
      teamFile: { ...teamFile, recipientRecords: [...recipientRecords, record] },
      result: record,
    }
  })
  return result
}

/**
 * Moves one recipient record through its lifecycle. Compares both the
 * allocation ID and the expected `from` state — an invalid or duplicate
 * transition fails closed rather than clobbering a state it didn't expect.
 * Pass `member` to atomically upsert the corresponding `TeamFile.members`
 * entry (e.g. when a teammate allocation goes `starting` -> `active`).
 */
export async function transitionTeamRecipient(args: {
  teamName: string
  allocationId: string
  from: TeamRecipientRecord['status']
  to: TeamRecipientRecord['status']
  member?: TeamFile['members'][number]
}): Promise<void> {
  await transactTeamFile(args.teamName, teamFile => {
    const recipientRecords = teamFile.recipientRecords ?? []
    const index = recipientRecords.findIndex(
      r => r.allocationId === args.allocationId,
    )
    if (index === -1) {
      throw new RecipientTransitionError(
        args.allocationId,
        args.from,
        args.to,
        'allocation not found',
      )
    }
    const record = recipientRecords[index]!
    if (record.status !== args.from) {
      throw new RecipientTransitionError(
        args.allocationId,
        args.from,
        args.to,
        `current status is "${record.status}"`,
      )
    }

    const canonicalAgentId = formatAgentId(record.name, args.teamName)
    const updatedRecords = recipientRecords.map((r, i) =>
      i === index
        ? {
            ...r,
            agentId: canonicalAgentId,
            status: args.to,
            updatedAt: Date.now(),
          }
        : r,
    )

    let members = teamFile.members
    if (args.member) {
      const member = {
        ...args.member,
        agentId: canonicalAgentId,
        allocationId: record.allocationId,
        name: record.name,
      }
      const memberIndex = members.findIndex(
        m =>
          m.allocationId === record.allocationId ||
          m.agentId === canonicalAgentId,
      )
      members =
        memberIndex === -1
          ? [...members, member]
          : members.map((m, i) => (i === memberIndex ? member : m))
    }

    return {
      teamFile: { ...teamFile, recipientRecords: updatedRecords, members },
      result: undefined,
    }
  })
}

/**
 * Best-effort recovery for a `starting` allocation whose launcher may have
 * crashed mid-launch. PID death alone can only prove the launcher is gone —
 * it can't positively confirm the backend/task it was starting is gone too —
 * so a live launcher PID is reported as `manual_cleanup_required` rather
 * than guessed either way. A confirmed-dead launcher's `starting` record is
 * tombstoned as `terminated`: it is never promoted to `active` by recovery,
 * and it never becomes reusable.
 */
export async function recoverStartingRecipient(args: {
  teamName: string
  allocationId: string
}): Promise<'active' | 'terminated' | 'manual_cleanup_required'> {
  function launcherIsAlive(pid: number): boolean {
    if (pid === process.pid) return true
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  const { result } = await transactTeamFile(args.teamName, teamFile => {
    const recipientRecords = teamFile.recipientRecords ?? []
    const index = recipientRecords.findIndex(
      r => r.allocationId === args.allocationId,
    )
    if (index === -1) {
      return { teamFile, result: 'terminated' as const }
    }
    const record = recipientRecords[index]!
    if (record.status !== 'starting') {
      return {
        teamFile,
        result: (record.status === 'active' ? 'active' : 'terminated') as
          | 'active'
          | 'terminated',
      }
    }
    if (launcherIsAlive(record.launcherPid)) {
      return { teamFile, result: 'manual_cleanup_required' as const }
    }
    const updatedRecords = recipientRecords.map((r, i) =>
      i === index ? { ...r, status: 'terminated' as const, updatedAt: Date.now() } : r,
    )
    return {
      teamFile: { ...teamFile, recipientRecords: updatedRecords },
      result: 'terminated' as const,
    }
  })
  return result
}

/**
 * Best-effort tombstone for a failed spawn, regardless of which pre-terminal
 * state (`reserved` or `starting`) the allocation is currently in. Compensating
 * catch blocks around a spawn often don't know exactly how far setup
 * progressed before failing — e.g. a caller-side allocate-then-spawn wrapper
 * can fail before the spawned handler ever reaches its own `reserved ->
 * starting` transition. Checking the current status inside one transaction
 * (rather than requiring an exact `from` match) makes this safe to call from
 * any failure point without knowing the precise state. A transition failure
 * (already terminal/active, lock error) is logged, not thrown — the caller
 * is already propagating the original failure.
 */
export async function tombstoneFailedRecipient(
  teamName: string,
  allocationId: string,
): Promise<void> {
  try {
    const { result } = await transactTeamFile(teamName, teamFile => {
      const recipientRecords = teamFile.recipientRecords ?? []
      const index = recipientRecords.findIndex(r => r.allocationId === allocationId)
      if (index === -1) return { teamFile, result: false }
      const record = recipientRecords[index]!
      if (record.status !== 'reserved' && record.status !== 'starting') {
        return { teamFile, result: false }
      }
      const updatedRecords = recipientRecords.map((r, i) =>
        i === index ? { ...r, status: 'terminated' as const, updatedAt: Date.now() } : r,
      )
      return {
        teamFile: { ...teamFile, recipientRecords: updatedRecords },
        result: true,
      }
    })
    if (!result) {
      logForDebugging(
        `[teamHelpers] tombstoneFailedRecipient: allocation ${allocationId} in team "${teamName}" was not in a pre-terminal state; left untouched`,
      )
    }
  } catch (e) {
    logForDebugging(
      `[teamHelpers] tombstoneFailedRecipient failed for ${allocationId} in "${teamName}": ${errorMessage(e)}`,
    )
  }
}

/**
 * Removes a teammate from the team file by agent ID or name, and tombstones
 * its recipient record (if any) so the name is never reused within the team.
 * Used by the leader when processing shutdown approvals.
 */
export async function removeTeammateFromTeamFile(
  teamName: string,
  identifier: { agentId?: string; name?: string },
): Promise<boolean> {
  const identifierStr = identifier.agentId || identifier.name
  if (!identifierStr) {
    logForDebugging(
      '[TeammateTool] removeTeammateFromTeamFile called with no identifier',
    )
    return false
  }

  try {
    const { result } = await transactTeamFile(teamName, teamFile => {
      const originalLength = teamFile.members.length
      const members = teamFile.members.filter(m => {
        if (identifier.agentId && m.agentId === identifier.agentId) return false
        if (identifier.name && m.name === identifier.name) return false
        return true
      })
      const removed = members.length !== originalLength

      const recipientRecords = (teamFile.recipientRecords ?? []).map(r => {
        const matches =
          (identifier.agentId !== undefined && r.agentId === identifier.agentId) ||
          (identifier.name !== undefined && r.name === identifier.name)
        return matches && r.status !== 'terminated'
          ? { ...r, status: 'terminated' as const, updatedAt: Date.now() }
          : r
      })

      return { teamFile: { ...teamFile, members, recipientRecords }, result: removed }
    })

    if (result) {
      logForDebugging(
        `[TeammateTool] Removed teammate from team file: ${identifierStr}`,
      )
    } else {
      logForDebugging(
        `[TeammateTool] Teammate ${identifierStr} not found in team file for "${teamName}"`,
      )
    }
    return result
  } catch (e) {
    logForDebugging(
      `[TeammateTool] Cannot remove teammate ${identifierStr} from "${teamName}": ${errorMessage(e)}`,
    )
    return false
  }
}

/**
 * Adds a pane ID to the hidden panes list in the team file.
 * @param teamName - The name of the team
 * @param paneId - The pane ID to hide
 * @returns true if the pane was added to hidden list, false if team doesn't exist
 */
export async function addHiddenPaneId(
  teamName: string,
  paneId: string,
): Promise<boolean> {
  try {
    await transactTeamFile(teamName, teamFile => {
      const hiddenPaneIds = teamFile.hiddenPaneIds ?? []
      if (hiddenPaneIds.includes(paneId)) {
        return { teamFile, result: undefined }
      }
      return {
        teamFile: { ...teamFile, hiddenPaneIds: [...hiddenPaneIds, paneId] },
        result: undefined,
      }
    })
    logForDebugging(
      `[TeammateTool] Added ${paneId} to hidden panes for team ${teamName}`,
    )
    return true
  } catch (e) {
    logForDebugging(
      `[TeammateTool] Cannot add hidden pane ${paneId} for "${teamName}": ${errorMessage(e)}`,
    )
    return false
  }
}

/**
 * Removes a pane ID from the hidden panes list in the team file.
 * @param teamName - The name of the team
 * @param paneId - The pane ID to show (remove from hidden list)
 * @returns true if the pane was removed from hidden list, false if team doesn't exist
 */
export async function removeHiddenPaneId(
  teamName: string,
  paneId: string,
): Promise<boolean> {
  try {
    await transactTeamFile(teamName, teamFile => {
      const hiddenPaneIds = teamFile.hiddenPaneIds ?? []
      if (!hiddenPaneIds.includes(paneId)) {
        return { teamFile, result: undefined }
      }
      return {
        teamFile: {
          ...teamFile,
          hiddenPaneIds: hiddenPaneIds.filter(id => id !== paneId),
        },
        result: undefined,
      }
    })
    logForDebugging(
      `[TeammateTool] Removed ${paneId} from hidden panes for team ${teamName}`,
    )
    return true
  } catch (e) {
    logForDebugging(
      `[TeammateTool] Cannot remove hidden pane ${paneId} for "${teamName}": ${errorMessage(e)}`,
    )
    return false
  }
}

/**
 * Removes a teammate from the team config file by pane ID, tombstoning its
 * recipient record. Also removes from hiddenPaneIds if present.
 * @param teamName - The name of the team
 * @param tmuxPaneId - The pane ID of the teammate to remove
 * @returns true if the member was removed, false if team or member doesn't exist
 */
export async function removeMemberFromTeam(
  teamName: string,
  tmuxPaneId: string,
): Promise<boolean> {
  try {
    const { result } = await transactTeamFile(teamName, teamFile => {
      const memberIndex = teamFile.members.findIndex(
        m => m.tmuxPaneId === tmuxPaneId,
      )
      if (memberIndex === -1) {
        return { teamFile, result: false }
      }
      const removedMember = teamFile.members[memberIndex]!
      const members = teamFile.members.filter((_, i) => i !== memberIndex)
      const hiddenPaneIds = teamFile.hiddenPaneIds?.filter(
        id => id !== tmuxPaneId,
      )
      const recipientRecords = (teamFile.recipientRecords ?? []).map(r =>
        r.agentId === removedMember.agentId && r.status !== 'terminated'
          ? { ...r, status: 'terminated' as const, updatedAt: Date.now() }
          : r,
      )
      return {
        teamFile: { ...teamFile, members, hiddenPaneIds, recipientRecords },
        result: true,
      }
    })
    if (result) {
      logForDebugging(
        `[TeammateTool] Removed member with pane ${tmuxPaneId} from team ${teamName}`,
      )
    }
    return result
  } catch (e) {
    logForDebugging(
      `[TeammateTool] Cannot remove member with pane ${tmuxPaneId} from "${teamName}": ${errorMessage(e)}`,
    )
    return false
  }
}

/**
 * Removes a teammate from a team's member list by agent ID, tombstoning its
 * recipient record. Use this for in-process teammates which all share the
 * same tmuxPaneId.
 * @param teamName - The name of the team
 * @param agentId - The agent ID of the teammate to remove (e.g., "researcher@my-team")
 * @returns true if the member was removed, false if team or member doesn't exist
 */
export async function removeMemberByAgentId(
  teamName: string,
  agentId: string,
): Promise<boolean> {
  try {
    const { result } = await transactTeamFile(teamName, teamFile => {
      const memberIndex = teamFile.members.findIndex(m => m.agentId === agentId)
      if (memberIndex === -1) {
        return { teamFile, result: false }
      }
      const members = teamFile.members.filter((_, i) => i !== memberIndex)
      const recipientRecords = (teamFile.recipientRecords ?? []).map(r =>
        r.agentId === agentId && r.status !== 'terminated'
          ? { ...r, status: 'terminated' as const, updatedAt: Date.now() }
          : r,
      )
      return { teamFile: { ...teamFile, members, recipientRecords }, result: true }
    })
    if (result) {
      logForDebugging(
        `[TeammateTool] Removed member ${agentId} from team ${teamName}`,
      )
    }
    return result
  } catch (e) {
    logForDebugging(
      `[TeammateTool] Cannot remove member ${agentId} from "${teamName}": ${errorMessage(e)}`,
    )
    return false
  }
}

/**
 * Sets a team member's permission mode.
 * Called when the team leader changes a teammate's mode via the TeamsDialog.
 * @param teamName - The name of the team
 * @param memberName - The name of the member to update
 * @param mode - The new permission mode
 */
export async function setMemberMode(
  teamName: string,
  memberName: string,
  mode: PermissionMode,
): Promise<boolean> {
  try {
    const { result } = await transactTeamFile(teamName, teamFile => {
      const member = teamFile.members.find(m => m.name === memberName)
      if (!member) {
        return { teamFile, result: false }
      }
      if (member.mode === mode) {
        return { teamFile, result: true }
      }
      const members = teamFile.members.map(m =>
        m.name === memberName ? { ...m, mode } : m,
      )
      return { teamFile: { ...teamFile, members }, result: true }
    })
    if (result) {
      logForDebugging(
        `[TeammateTool] Set member ${memberName} in team ${teamName} to mode: ${mode}`,
      )
    } else {
      logForDebugging(
        `[TeammateTool] Cannot set member mode: member ${memberName} not found in team ${teamName}`,
      )
    }
    return result
  } catch (e) {
    logForDebugging(
      `[TeammateTool] Cannot set member mode for ${memberName} in "${teamName}": ${errorMessage(e)}`,
    )
    return false
  }
}

/**
 * Sync the current teammate's mode to config.json so team lead sees it.
 * No-op if not running as a teammate.
 * @param mode - The permission mode to sync
 * @param teamNameOverride - Optional team name override (uses env var if not provided)
 */
export async function syncTeammateMode(
  mode: PermissionMode,
  teamNameOverride?: string,
): Promise<void> {
  if (!isTeammate()) return
  const teamName = teamNameOverride ?? getTeamName()
  const agentName = getAgentName()
  if (teamName && agentName) {
    await setMemberMode(teamName, agentName, mode)
  }
}

/**
 * Sets multiple team members' permission modes in a single atomic operation.
 * Avoids race conditions when updating multiple teammates at once.
 * @param teamName - The name of the team
 * @param modeUpdates - Array of {memberName, mode} to update
 */
export async function setMultipleMemberModes(
  teamName: string,
  modeUpdates: Array<{ memberName: string; mode: PermissionMode }>,
): Promise<boolean> {
  try {
    const { result } = await transactTeamFile(teamName, teamFile => {
      const updateMap = new Map(modeUpdates.map(u => [u.memberName, u.mode]))
      let anyChanged = false
      const members = teamFile.members.map(member => {
        const newMode = updateMap.get(member.name)
        if (newMode !== undefined && member.mode !== newMode) {
          anyChanged = true
          return { ...member, mode: newMode }
        }
        return member
      })
      return {
        teamFile: anyChanged ? { ...teamFile, members } : teamFile,
        result: anyChanged,
      }
    })
    if (result) {
      logForDebugging(
        `[TeammateTool] Set ${modeUpdates.length} member modes in team ${teamName}`,
      )
    }
    return true
  } catch (e) {
    logForDebugging(
      `[TeammateTool] Cannot set member modes in "${teamName}": ${errorMessage(e)}`,
    )
    return false
  }
}

/**
 * Sets a team member's active status.
 * Called when a teammate becomes idle (isActive=false) or starts a new turn (isActive=true).
 * @param teamName - The name of the team
 * @param memberName - The name of the member to update
 * @param isActive - Whether the member is active (true) or idle (false)
 */
export async function setMemberActive(
  teamName: string,
  memberName: string,
  isActive: boolean,
): Promise<void> {
  try {
    await transactTeamFile(teamName, teamFile => {
      const member = teamFile.members.find(m => m.name === memberName)
      if (!member || member.isActive === isActive) {
        return { teamFile, result: undefined }
      }
      const members = teamFile.members.map(m =>
        m.name === memberName ? { ...m, isActive } : m,
      )
      return { teamFile: { ...teamFile, members }, result: undefined }
    })
    logForDebugging(
      `[TeammateTool] Set member ${memberName} in team ${teamName} to ${isActive ? 'active' : 'idle'}`,
    )
  } catch (e) {
    logForDebugging(
      `[TeammateTool] Cannot set member active for ${memberName} in "${teamName}": ${errorMessage(e)}`,
    )
  }
}

/**
 * Destroys a git worktree at the given path.
 * First attempts to use `git worktree remove`, then falls back to rm -rf.
 * Safe to call on non-existent paths.
 */
async function destroyWorktree(worktreePath: string): Promise<void> {
  // Read the .git file in the worktree to find the main repo
  const gitFilePath = join(worktreePath, '.git')
  let mainRepoPath: string | null = null

  try {
    const gitFileContent = (await readFile(gitFilePath, 'utf-8')).trim()
    // The .git file contains something like: gitdir: /path/to/repo/.git/worktrees/worktree-name
    const match = gitFileContent.match(/^gitdir:\s*(.+)$/)
    if (match && match[1]) {
      // Extract the main repo .git directory (go up from .git/worktrees/name to .git)
      const worktreeGitDir = match[1]
      // Go up 2 levels from .git/worktrees/name to get to .git, then get parent for repo root
      const mainGitDir = join(worktreeGitDir, '..', '..')
      mainRepoPath = join(mainGitDir, '..')
    }
  } catch {
    // Ignore errors reading .git file (path doesn't exist, not a file, etc.)
  }

  // Try to remove using git worktree remove command
  if (mainRepoPath) {
    const result = await execFileNoThrowWithCwd(
      gitExe(),
      ['worktree', 'remove', '--force', worktreePath],
      { cwd: mainRepoPath },
    )

    if (result.code === 0) {
      logForDebugging(
        `[TeammateTool] Removed worktree via git: ${worktreePath}`,
      )
      return
    }

    // Check if the error is "not a working tree" (already removed)
    if (result.stderr?.includes('not a working tree')) {
      logForDebugging(
        `[TeammateTool] Worktree already removed: ${worktreePath}`,
      )
      return
    }

    logForDebugging(
      `[TeammateTool] git worktree remove failed, falling back to rm: ${result.stderr}`,
    )
  }

  // Fallback: manually remove the directory
  try {
    await rm(worktreePath, { recursive: true, force: true })
    logForDebugging(
      `[TeammateTool] Removed worktree directory manually: ${worktreePath}`,
    )
  } catch (error) {
    logForDebugging(
      `[TeammateTool] Failed to remove worktree ${worktreePath}: ${errorMessage(error)}`,
    )
  }
}

/**
 * Mark a team as created this session so it gets cleaned up on exit.
 * Call this right after the initial writeTeamFile. TeamDelete should
 * call unregisterTeamForSessionCleanup to prevent double-cleanup.
 * Backing Set lives in bootstrap/state.ts so resetStateForTests()
 * clears it between tests (avoids the PR #17615 cross-shard leak class).
 */
export function registerTeamForSessionCleanup(teamName: string): void {
  getSessionCreatedTeams().add(teamName)
}

/**
 * Remove a team from session cleanup tracking (e.g., after explicit
 * TeamDelete — already cleaned, don't try again on shutdown).
 */
export function unregisterTeamForSessionCleanup(teamName: string): void {
  getSessionCreatedTeams().delete(teamName)
}

/**
 * Clean up all teams created this session that weren't explicitly deleted.
 * Registered with gracefulShutdown from init.ts.
 */
export async function cleanupSessionTeams(): Promise<void> {
  const sessionCreatedTeams = getSessionCreatedTeams()
  if (sessionCreatedTeams.size === 0) return
  const teams = Array.from(sessionCreatedTeams)
  logForDebugging(
    `cleanupSessionTeams: removing ${teams.length} orphan team dir(s): ${teams.join(', ')}`,
  )
  // Kill panes first — on SIGINT the teammate processes are still running;
  // deleting directories alone would orphan them in open tmux/iTerm2 panes.
  // (TeamDeleteTool's path doesn't need this — by then teammates have
  // gracefully exited and useInboxPoller has already closed their panes.)
  await Promise.allSettled(teams.map(name => killOrphanedTeammatePanes(name)))
  await Promise.allSettled(teams.map(name => cleanupTeamDirectories(name)))
  sessionCreatedTeams.clear()
}

/**
 * Best-effort kill of all pane-backed teammate panes for a team.
 * Called from cleanupSessionTeams on ungraceful leader exit (SIGINT/SIGTERM).
 * Dynamic imports avoid adding registry/detection to this module's static
 * dep graph — this only runs at shutdown, so the import cost is irrelevant.
 */
async function killOrphanedTeammatePanes(teamName: string): Promise<void> {
  const teamFile = readTeamFile(teamName)
  if (!teamFile) return

  const paneMembers = teamFile.members.filter(
    m =>
      m.name !== TEAM_LEAD_NAME &&
      m.tmuxPaneId &&
      m.backendType &&
      isPaneBackend(m.backendType),
  )
  if (paneMembers.length === 0) return

  const [{ ensureBackendsRegistered, getBackendByType }, { isInsideTmux }] =
    await Promise.all([
      import('./backends/registry.js'),
      import('./backends/detection.js'),
    ])
  await ensureBackendsRegistered()
  const useExternalSession = !(await isInsideTmux())

  await Promise.allSettled(
    paneMembers.map(async m => {
      // filter above guarantees these; narrow for the type system
      if (!m.tmuxPaneId || !m.backendType || !isPaneBackend(m.backendType)) {
        return
      }
      const ok = await getBackendByType(m.backendType).killPane(
        m.tmuxPaneId,
        useExternalSession,
      )
      logForDebugging(
        `cleanupSessionTeams: killPane ${m.name} (${m.backendType} ${m.tmuxPaneId}) → ${ok}`,
      )
    }),
  )
}

/**
 * Cleans up team and task directories for a given team name.
 * Also cleans up git worktrees created for teammates.
 * Called when a swarm session is terminated.
 */
export async function cleanupTeamDirectories(teamName: string): Promise<void> {
  const sanitizedName = sanitizeName(teamName)

  // Read team file to get worktree paths BEFORE deleting the team directory
  const teamFile = readTeamFile(teamName)
  const worktreePaths: string[] = []
  if (teamFile) {
    for (const member of teamFile.members) {
      if (member.worktreePath) {
        worktreePaths.push(member.worktreePath)
      }
    }
  }

  // Clean up worktrees first
  for (const worktreePath of worktreePaths) {
    await destroyWorktree(worktreePath)
  }

  // Clean up team directory (~/.claude/teams/{team-name}/)
  const teamDir = getTeamDir(teamName)
  try {
    await rm(teamDir, { recursive: true, force: true })
    logForDebugging(`[TeammateTool] Cleaned up team directory: ${teamDir}`)
  } catch (error) {
    logForDebugging(
      `[TeammateTool] Failed to clean up team directory ${teamDir}: ${errorMessage(error)}`,
    )
  }

  // Clean up tasks directory (~/.claude/tasks/{taskListId}/)
  // The leader and teammates all store tasks under the sanitized team name.
  const tasksDir = getTasksDir(sanitizedName)
  try {
    await rm(tasksDir, { recursive: true, force: true })
    logForDebugging(`[TeammateTool] Cleaned up tasks directory: ${tasksDir}`)
    notifyTasksUpdated()
  } catch (error) {
    logForDebugging(
      `[TeammateTool] Failed to clean up tasks directory ${tasksDir}: ${errorMessage(error)}`,
    )
  }
}
