import { feature } from 'bun:bundle'
import type { UUID } from 'crypto'
import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative } from 'path'
import {
  getMainLoopModelOverride,
  getSessionId,
  setMainLoopModelOverride,
  setMainThreadAgentType,
  setOriginalCwd,
  setProviderSwitchLocked,
  switchSession,
} from '../bootstrap/state.js'
import { clearSystemPromptSections } from '../constants/systemPromptSections.js'
import { restoreCostStateForSession } from '../cost-tracker.js'
import {
  acquireDeferredContinuationLocks,
  readPendingDeferredContinuation,
  type DeferredContinuationJobV1,
  type DeferredContinuationLockGuard,
} from '../services/deferredContinuation.js'
import type { AppState } from '../state/AppState.js'
import type { AgentColorName } from '../tools/AgentTool/agentColorManager.js'
import {
  type AgentDefinition,
  type AgentDefinitionsResult,
  getActiveAgentsFromList,
  getAgentDefinitionsWithOverrides,
} from '../tools/AgentTool/loadAgentsDir.js'
import { TODO_WRITE_TOOL_NAME } from '../tools/TodoWriteTool/constants.js'
import { asSessionId } from '../types/ids.js'
import type {
  AttributionSnapshotMessage,
  ContextCollapseCommitEntry,
  ContextCollapseSnapshotEntry,
  PersistedWorktreeSession,
  SubagentSpawnedMessage,
  SubagentTerminalMessage,
} from '../types/logs.js'
import type { Message } from '../types/message.js'
import { renameRecordingForSession } from './asciicast.js'
import { clearMemoryFileCaches } from './claudemd.js'
import {
  type AttributionState,
  attributionRestoreStateFromLog,
  restoreAttributionStateFromSnapshots,
} from './commitAttribution.js'
import { updateSessionName } from './concurrentSessions.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import type { FileHistorySnapshot } from './fileHistory.js'
import { fileHistoryRestoreStateFromLog } from './fileHistory.js'
import { createSystemMessage } from './messages.js'
import { parseUserSpecifiedModel } from './model/model.js'
import { hasProviderBoundHistory } from './model/providers.js'
import { getPlansDirectory } from './plans.js'
import { setCwd } from './Shell.js'
import {
  adoptResumedSessionFile,
  getTranscriptPath,
  getTranscriptPathForSession,
  recordContentReplacement,
  resetSessionFilePointer,
  restoreSessionMetadata,
  saveMode,
  saveWorktreeState,
} from './sessionStorage.js'
import { isTodoV2Enabled } from './tasks.js'
import type { TodoList } from './todo/types.js'
import { TodoListSchema } from './todo/types.js'
import type { ContentReplacementRecord } from './toolResultStorage.js'
import type { ThreadGoal } from './threadGoal.js'
import { activateTranscriptLease } from './transcriptLease.js'
import {
  getCurrentWorktreeSession,
  restoreWorktreeSession,
} from './worktree.js'

type ResumeResult = {
  messages?: Message[]
  fileHistorySnapshots?: FileHistorySnapshot[]
  attributionSnapshots?: AttributionSnapshotMessage[]
  contextCollapseCommits?: ContextCollapseCommitEntry[]
  contextCollapseSnapshot?: ContextCollapseSnapshotEntry
  threadGoal?: ThreadGoal | null
  worktreeSession?: PersistedWorktreeSession | null
  customTitle?: string
  tag?: string
  agentName?: string
  agentColor?: string
  agentSetting?: string
  mode?: 'agent' | 'coordinator' | 'normal'
  prNumber?: number
  prUrl?: string
  prRepository?: string
}

/**
 * Forks retain conversation history but do not adopt metadata whose identity
 * belongs to the source session.
 */
export function prepareSessionRestoreResult(
  result: ResumeResult,
  forkSession: boolean,
): ResumeResult {
  return forkSession
    ? { ...result, threadGoal: null, worktreeSession: undefined }
    : result
}

/**
 * Scan the transcript for the last TodoWrite tool_use block and return its todos.
 * Used to hydrate AppState.todos on SDK --resume so the model's todo list
 * survives session restarts without file persistence.
 */
function extractTodosFromTranscript(messages: Message[]): TodoList {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.type !== 'assistant') continue
    const toolUse = msg.message.content.find(
      block => block.type === 'tool_use' && block.name === TODO_WRITE_TOOL_NAME,
    )
    if (!toolUse || toolUse.type !== 'tool_use') continue
    const input = toolUse.input
    if (input === null || typeof input !== 'object') return []
    const parsed = TodoListSchema().safeParse(
      (input as Record<string, unknown>).todos,
    )
    return parsed.success ? parsed.data : []
  }
  return []
}

/**
 * Restore session state (file history, attribution, todos) from log on resume.
 * Used by both SDK (print.ts) and interactive (REPL.tsx, main.tsx) resume paths.
 */
export function restoreSessionStateFromLog(
  result: ResumeResult,
  setAppState: (f: (prev: AppState) => AppState) => void,
): void {
  setAppState(prev => ({ ...prev, threadGoal: result.threadGoal ?? null }))

  // Restore file history state
  if (result.fileHistorySnapshots && result.fileHistorySnapshots.length > 0) {
    fileHistoryRestoreStateFromLog(result.fileHistorySnapshots, newState => {
      setAppState(prev => ({ ...prev, fileHistory: newState }))
    })
  }

  // Restore attribution state (ant-only feature)
  if (
    feature('COMMIT_ATTRIBUTION') &&
    result.attributionSnapshots &&
    result.attributionSnapshots.length > 0
  ) {
    attributionRestoreStateFromLog(result.attributionSnapshots, newState => {
      setAppState(prev => ({ ...prev, attribution: newState }))
    })
  }

  // Restore TodoWrite state from transcript (SDK/non-interactive only).
  // Interactive mode uses file-backed v2 tasks, so AppState.todos is unused there.
  if (!isTodoV2Enabled() && result.messages && result.messages.length > 0) {
    const todos = extractTodosFromTranscript(result.messages)
    if (todos.length > 0) {
      const agentId = getSessionId()
      setAppState(prev => ({
        ...prev,
        todos: { ...prev.todos, [agentId]: todos },
      }))
    }
  }
}

/**
 * Compute restored attribution state from log snapshots.
 * Used for computing initial state before render (e.g., main.tsx --continue).
 * Returns undefined if attribution feature is disabled or no snapshots exist.
 */
export function computeRestoredAttributionState(
  result: ResumeResult,
): AttributionState | undefined {
  if (
    feature('COMMIT_ATTRIBUTION') &&
    result.attributionSnapshots &&
    result.attributionSnapshots.length > 0
  ) {
    return restoreAttributionStateFromSnapshots(result.attributionSnapshots)
  }
  return undefined
}

/**
 * Compute standalone agent context (name/color) for session resume.
 * Used for computing initial state before render (per CLAUDE.md guidelines).
 * Returns undefined if no name/color is set on the session.
 */
export function computeStandaloneAgentContext(
  agentName: string | undefined,
  agentColor: string | undefined,
): AppState['standaloneAgentContext'] | undefined {
  if (!agentName && !agentColor) {
    return undefined
  }
  return {
    name: agentName ?? '',
    color: (agentColor === 'default' ? undefined : agentColor) as
      | AgentColorName
      | undefined,
  }
}

/**
 * Restore agent setting from a resumed session.
 *
 * When resuming a conversation that used a custom agent, this re-applies the
 * agent type and model override (unless the user specified --agent on the CLI).
 * Mutates bootstrap state via setMainThreadAgentType / setMainLoopModelOverride.
 *
 * Returns the restored agent definition and its agentType string, or undefined
 * if no agent was restored.
 */
export function restoreAgentFromSession(
  agentSetting: string | undefined,
  currentAgentDefinition: AgentDefinition | undefined,
  agentDefinitions: AgentDefinitionsResult,
): {
  agentDefinition: AgentDefinition | undefined
  agentType: string | undefined
} {
  // If user already specified --agent on CLI, keep that definition
  if (currentAgentDefinition) {
    return { agentDefinition: currentAgentDefinition, agentType: undefined }
  }

  // If session had no agent, clear any stale bootstrap state
  if (!agentSetting) {
    setMainThreadAgentType(undefined)
    return { agentDefinition: undefined, agentType: undefined }
  }

  const resumedAgent = agentDefinitions.activeAgents.find(
    agent => agent.agentType === agentSetting,
  )
  if (!resumedAgent) {
    logForDebugging(
      `Resumed session had agent "${agentSetting}" but it is no longer available. Using default behavior.`,
    )
    setMainThreadAgentType(undefined)
    return { agentDefinition: undefined, agentType: undefined }
  }

  setMainThreadAgentType(resumedAgent.agentType)

  // Apply agent's model if user didn't specify one
  if (
    !getMainLoopModelOverride() &&
    resumedAgent.model &&
    resumedAgent.model !== 'inherit'
  ) {
    setMainLoopModelOverride(parseUserSpecifiedModel(resumedAgent.model))
  }

  return { agentDefinition: resumedAgent, agentType: resumedAgent.agentType }
}

/**
 * Refresh agent definitions after a coordinator/normal mode switch.
 *
 * When resuming a session that was in a different mode (coordinator vs normal),
 * the built-in agents need to be re-derived to match the new mode. CLI-provided
 * agents (from --agents flag) are merged back in.
 */
export async function refreshAgentDefinitionsForModeSwitch(
  modeWasSwitched: boolean,
  currentCwd: string,
  cliAgents: AgentDefinition[],
  currentAgentDefinitions: AgentDefinitionsResult,
): Promise<AgentDefinitionsResult> {
  if (!feature('COORDINATOR_MODE') || !modeWasSwitched) {
    return currentAgentDefinitions
  }

  // Re-derive agent definitions after mode switch so built-in agents
  // reflect the new coordinator/normal mode
  getAgentDefinitionsWithOverrides.cache.clear?.()
  const freshAgentDefs = await getAgentDefinitionsWithOverrides(currentCwd)
  const freshAllAgents = [...freshAgentDefs.allAgents, ...cliAgents]
  return {
    ...freshAgentDefs,
    allAgents: freshAllAgents,
    activeAgents: getActiveAgentsFromList(freshAllAgents),
  }
}

/**
 * Result of processing a resumed/continued conversation for rendering.
 */
export type ProcessedResume = {
  messages: Message[]
  fileHistorySnapshots?: FileHistorySnapshot[]
  contentReplacements?: ContentReplacementRecord[]
  agentName: string | undefined
  agentColor: AgentColorName | undefined
  restoredAgentDef: AgentDefinition | undefined
  initialState: AppState
}

/**
 * Subset of the session mode API needed for session resume.
 */
type SessionModeApi = {
  matchSessionMode(mode?: 'agent' | 'coordinator' | 'normal'): string | undefined
  getCurrentSessionMode(): 'agent' | 'coordinator' | 'normal'
}

/**
 * The loaded conversation data (return type of loadConversationForResume).
 */
type ResumeLoadResult = {
  messages: Message[]
  fileHistorySnapshots?: FileHistorySnapshot[]
  attributionSnapshots?: AttributionSnapshotMessage[]
  contentReplacements?: ContentReplacementRecord[]
  contextCollapseCommits?: ContextCollapseCommitEntry[]
  contextCollapseSnapshot?: ContextCollapseSnapshotEntry
  threadGoal?: ThreadGoal | null
  sessionId: UUID | undefined
  agentName?: string
  agentColor?: string
  agentSetting?: string
  customTitle?: string
  tag?: string
  mode?: 'agent' | 'coordinator' | 'normal'
  worktreeSession?: PersistedWorktreeSession | null
  prNumber?: number
  prUrl?: string
  prRepository?: string
}

/**
 * Restore the worktree working directory on resume. The transcript records
 * the last worktree enter/exit; if the session crashed while inside a
 * worktree (last entry = session object, not null), cd back into it.
 *
 * process.chdir is the TOCTOU-safe existence check — it throws ENOENT if
 * the /exit dialog removed the directory, or if the user deleted it
 * manually between sessions.
 *
 * When --worktree already created a fresh worktree, that takes precedence
 * over the resumed session's state. restoreSessionMetadata just overwrote
 * project.currentSessionWorktree with the stale transcript value, so
 * re-assert the fresh worktree here before adoptResumedSessionFile writes
 * it back to disk.
 */
export function restoreWorktreeForResume(
  worktreeSession: PersistedWorktreeSession | null | undefined,
): void {
  const fresh = getCurrentWorktreeSession()
  if (fresh) {
    saveWorktreeState(fresh)
    return
  }
  if (!worktreeSession) return

  try {
    process.chdir(worktreeSession.worktreePath)
  } catch {
    // Directory is gone. Override the stale cache so the next
    // reAppendSessionMetadata records "exited" instead of re-persisting
    // a path that no longer exists.
    saveWorktreeState(null)
    return
  }

  setCwd(worktreeSession.worktreePath)
  setOriginalCwd(getCwd())
  // projectRoot is intentionally NOT set here. The transcript doesn't record
  // whether the worktree was entered via --worktree (which sets projectRoot)
  // or EnterWorktreeTool (which doesn't). Leaving projectRoot stable matches
  // EnterWorktreeTool's behavior — skills/history stay anchored to the
  // original project.
  restoreWorktreeSession(worktreeSession)
  // The /resume slash command calls this mid-session after caches have been
  // populated against the old cwd. Cheap no-ops for the CLI-flag path
  // (caches aren't populated yet there).
  clearMemoryFileCaches()
  clearSystemPromptSections()
  getPlansDirectory.cache.clear?.()
}

export async function restoreTrustedDeferredContinuationContext(
  context: { cwd: string; worktreeRoot?: string },
  transcript: {
    projectPath?: string
    worktreeSession?: PersistedWorktreeSession | null
  },
): Promise<void> {
  if (!isAbsolute(context.cwd)) {
    throw new Error('Deferred continuation cwd must be absolute')
  }
  const canonicalCwd = await realpath(context.cwd)
  const canonicalProject = transcript.projectPath
    ? await realpath(transcript.projectPath)
    : null
  const canonicalWorktree = context.worktreeRoot
    ? await realpath(context.worktreeRoot)
    : null
  const transcriptWorktree = transcript.worktreeSession?.worktreePath
    ? await realpath(transcript.worktreeSession.worktreePath)
    : null

  if (canonicalWorktree !== transcriptWorktree) {
    throw new Error('Deferred continuation worktree identity mismatch')
  }
  const trustedRoot = canonicalWorktree ?? canonicalProject
  if (!trustedRoot) {
    throw new Error('Deferred continuation transcript lacks trusted project context')
  }
  const rel = relative(trustedRoot, canonicalCwd)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Deferred continuation cwd is outside trusted project context')
  }

  process.chdir(canonicalCwd)
  setCwd(canonicalCwd)
  setOriginalCwd(canonicalProject ?? canonicalCwd)
  if (transcript.worktreeSession) {
    restoreWorktreeSession(transcript.worktreeSession)
  }
  clearMemoryFileCaches()
  clearSystemPromptSections()
  getPlansDirectory.cache.clear?.()
}

export const DEFERRED_RESUME_BUSY_NOTICE =
  'A scheduled continuation is already in progress. Wait for it to finish, then resume this conversation again.'

export type DeferredResumeDecision =
  | { action: 'allow' }
  | { action: 'block'; notice: string }

/**
 * Thrown when a resume is refused because a background continuation owns the
 * session. Typed so the CLI resume entries can show the reason instead of their
 * generic "failed to resume" text — a session that is merely busy for one turn
 * must not look like a corrupt transcript.
 */
export class DeferredContinuationBusyError extends Error {
  constructor(notice: string) {
    super(notice)
    this.name = 'DeferredContinuationBusyError'
  }
}

/**
 * Resume/adopt must respect the per-session deferred continuation lock so it
 * cannot read and adopt a transcript while a background attempt is appending to
 * it (docs/codex/2026-07-14-continue-after-limit-implementation-plan.md, "Human
 * interaction"). Reopening a transcript is not a human message: the same plan
 * requires that it leave a merely pending job scheduled, so this probes the lock
 * and never cancels the job — that is what separates it from
 * prepareHumanPromptAgainstDeferredContinuation.
 *
 * The probe releases immediately. The session lock is per-attempt; holding it
 * for the life of a REPL would starve the runner forever. The write itself is
 * gated again when a turn is submitted, so this only has to refuse the adopt.
 *
 * Staleness is deliberately left to the store: acquire reclaims a lock left by a
 * crashed worker, so a dead attempt never bricks resume.
 */
async function acquireDeferredContinuationResumeAuthority(
  sessionId: string,
): Promise<DeferredContinuationLockGuard | null> {
  let job: DeferredContinuationJobV1 | null
  try {
    job = await readPendingDeferredContinuation(sessionId)
  } catch {
    // An unreadable record cannot be driving a live attempt — the runner parses
    // the same file — and refusing to open the transcript would contradict the
    // safety-stop notice that tells the user to review it manually.
    return null
  }
  if (!job) return null

  let guard: DeferredContinuationLockGuard
  try {
    guard = await acquireDeferredContinuationLocks(job)
  } catch {
    throw new DeferredContinuationBusyError(DEFERRED_RESUME_BUSY_NOTICE)
  }
  try {
    guard.assertHealthy()
    const current = await readPendingDeferredContinuation(sessionId)
    if (!current || current.jobId !== job.jobId) {
      await guard.release()
      return null
    }
    return guard
  } catch (error) {
    await guard.release().catch(() => {})
    throw error
  }
}

export async function withDeferredContinuationResumeAuthority<T>(
  sessionId: string,
  adopt: () => T | Promise<T>,
): Promise<T> {
  const guard = await acquireDeferredContinuationResumeAuthority(sessionId)
  try {
    guard?.assertHealthy()
    const result = await adopt()
    guard?.assertHealthy()
    return result
  } finally {
    await guard?.release()
  }
}

export async function checkDeferredContinuationResume(
  sessionId: string,
): Promise<DeferredResumeDecision> {
  try {
    const guard = await acquireDeferredContinuationResumeAuthority(sessionId)
    await guard?.release()
    return { action: 'allow' }
  } catch (error) {
    if (error instanceof DeferredContinuationBusyError) {
      return { action: 'block', notice: error.message }
    }
    throw error
  }
}

/**
 * Undo restoreWorktreeForResume before a mid-session /resume switches to
 * another session. Without this, /resume from a worktree session to a
 * non-worktree session leaves the user in the old worktree directory with
 * currentWorktreeSession still pointing at the prior session. /resume to a
 * *different* worktree fails entirely — the getCurrentWorktreeSession()
 * guard above blocks the switch.
 *
 * Not needed by CLI --resume/--continue: those run once at startup where
 * getCurrentWorktreeSession() is only truthy if --worktree was used (fresh
 * worktree that should take precedence, handled by the re-assert above).
 */
export function exitRestoredWorktree(): void {
  const current = getCurrentWorktreeSession()
  if (!current) return

  restoreWorktreeSession(null)
  // Worktree state changed, so cached prompt sections that reference it are
  // stale whether or not chdir succeeds below.
  clearMemoryFileCaches()
  clearSystemPromptSections()
  getPlansDirectory.cache.clear?.()

  try {
    process.chdir(current.originalCwd)
  } catch {
    // Original dir is gone (rare). Stay put — restoreWorktreeForResume
    // will cd into the target worktree next if there is one.
    return
  }
  setCwd(current.originalCwd)
  setOriginalCwd(getCwd())
}

/**
 * Read the parent transcript and compute stalled subagent entries (spawned but
 * no corresponding terminal entry). Returns in-memory system-reminder messages
 * that are prepended to the resumed conversation.
 *
 * Never throws — a read failure just returns an empty array.
 */
export async function buildStallReminders(
  transcriptPath: string,
): Promise<Message[]> {
  let raw: string
  try {
    const { readFile } = await import('fs/promises')
    raw = await readFile(transcriptPath, 'utf-8')
  } catch {
    return []
  }

  const spawned = new Map<string, SubagentSpawnedMessage>()
  const terminal = new Map<string, SubagentTerminalMessage>() // keyed by toolUseId
  // The gate is the tool_result, NOT the terminal record. A terminal record
  // says the subagent stopped; only a tool_result says the conversation ever
  // learned what it did. Gating on the terminal record silenced this reminder
  // in exactly the case it exists for: the stall sweep
  // (`cleanupRegistry.flushStallDetectedEntries`) writes a terminal record for
  // a subagent killed with its parent, so the tombstone that documents the loss
  // used to suppress the warning about it, and the resumed model then told the
  // user it had never spawned the subagent (2026-08-29).
  const resolved = new Set<string>()

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (entry.type === 'subagent-spawned') {
      const msg = entry as unknown as SubagentSpawnedMessage
      spawned.set(msg.toolUseId, msg)
    } else if (entry.type === 'subagent-terminal') {
      const msg = entry as unknown as SubagentTerminalMessage
      terminal.set(msg.toolUseId, msg)
    } else if (entry.type === 'user') {
      const content = (entry.message as { content?: unknown } | undefined)
        ?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        const { type, tool_use_id: id } = block as {
          type?: unknown
          tool_use_id?: unknown
        }
        if (type === 'tool_result' && typeof id === 'string') resolved.add(id)
      }
    }
  }

  const reminders: Message[] = []
  const now = Date.now()

  for (const [toolUseId, info] of spawned) {
    if (resolved.has(toolUseId)) continue

    const ended = terminal.get(toolUseId)
    const spawnedMs = new Date(info.spawnedAt).getTime()
    const ageHours = (now - spawnedMs) / (1000 * 60 * 60)
    const isRecent = ageHours < 24

    const text =
      ended && isRecent
        ? `<system-reminder>
A subagent spawned earlier in this session ended without delivering its result, so the conversation above carries no trace of it: the unresolved tool call was dropped when this session was rebuilt.

  agentId: ${ended.agentId}
  agentType: ${info.agentType}
  description: ${info.description}
  status: ${ended.status}${ended.reason ? ` (${ended.reason})` : ''}
  ranFor: ${Math.round(ended.durationMs / 1000)}s
  endedAt: ${ended.endedAt}
  transcript: ${info.transcriptPath}
  toolUseId: ${info.toolUseId}

It ran for real and its work may already be partly applied. Before responding to the user's next message, tell them this subagent ran and was lost, and ask which action to take: (1) Read the subagent transcript to recover what it finished, (2) re-dispatch a fresh Agent call for the remainder, or (3) abandon it. Do NOT tell the user the subagent was never spawned, and do NOT re-dispatch the same task without asking.
</system-reminder>`
        : isRecent
          ? `<system-reminder>
A subagent spawned earlier in this session has no terminal entry. It may have stalled, been killed, or is still running in the background.

  agentId: ${info.agentId}
  agentType: ${info.agentType}
  description: ${info.description}
  spawnedAt: ${info.spawnedAt}
  transcript: ${info.transcriptPath}
  toolUseId: ${info.toolUseId}

Before responding to the user's next message, surface this to them and ask which action to take: (1) re-dispatch a fresh Agent call with the same task, (2) Read the subagent transcript to recover partial results, or (3) abandon the prior subagent. Do NOT proceed with the user's current request until they choose. Do not silently ignore.
</system-reminder>`
          : `<system-reminder>
An old subagent from this session never delivered a result (spawned ${Math.round(ageHours / 24)} day(s) ago).

  agentId: ${info.agentId}
  description: ${info.description}
  transcript: ${info.transcriptPath}

Mention it to the user only if relevant to their current request. Otherwise proceed normally.
</system-reminder>`

    reminders.push(createSystemMessage(text, isRecent ? 'warning' : 'info'))
  }

  return reminders
}

/**
 * Process a loaded conversation for resume/continue.
 *
 * Handles coordinator mode matching, session ID setup, agent restoration,
 * mode persistence, and initial state computation. Called by both --continue
 * and --resume paths in main.tsx.
 */
export async function processResumedConversation(
  result: ResumeLoadResult,
  opts: {
    forkSession: boolean
    sessionIdOverride?: string
    transcriptPath?: string
    includeAttribution?: boolean
  },
  context: {
    modeApi: SessionModeApi | null
    mainThreadAgentDefinition: AgentDefinition | undefined
    agentDefinitions: AgentDefinitionsResult
    currentCwd: string
    cliAgents: AgentDefinition[]
    initialState: AppState
  },
): Promise<ProcessedResume> {
  // Refuse to adopt a transcript a background continuation is appending to.
  // Scoped to the adopt path: --fork-session writes to a fresh session file, so
  // it is not the second writer this lock exists to prevent. Runs before any
  // state is touched so a blocked resume changes nothing.
  const adoptedSessionId = opts.sessionIdOverride ?? result.sessionId
  if (!opts.forkSession && adoptedSessionId) {
    const deferred = await checkDeferredContinuationResume(adoptedSessionId)
    if (deferred.action === 'block') {
      throw new DeferredContinuationBusyError(deferred.notice)
    }
  }

  // Match coordinator/normal mode to the resumed session
  let modeWarning: string | undefined
  if (feature('COORDINATOR_MODE')) {
    modeWarning = context.modeApi?.matchSessionMode(result.mode)
    if (modeWarning) {
      result.messages.push(createSystemMessage(modeWarning, 'warning'))
    }
  }

  // Reuse the resumed session's ID unless --fork-session is specified
  if (!opts.forkSession) {
    const sid = opts.sessionIdOverride ?? result.sessionId
    if (sid) {
      await activateTranscriptLease(sid)
      // When resuming from a different project directory (git worktrees,
      // cross-project), transcriptPath points to the actual file; its dirname
      // is the project dir. Otherwise the session lives in the current project.
      switchSession(
        asSessionId(sid),
        opts.transcriptPath ? dirname(opts.transcriptPath) : null,
      )
      // Rename asciicast recording to match the resumed session ID so
      // getSessionRecordingPaths() can discover it during /share
      await renameRecordingForSession()
      await resetSessionFilePointer()
      restoreCostStateForSession(sid)
    }
  } else if (result.contentReplacements?.length) {
    // --fork-session keeps the fresh startup session ID. useLogMessages will
    // copy source messages into the new JSONL via recordTranscript, but
    // content-replacement entries are a separate entry type only written by
    // recordContentReplacement (which query.ts calls for newlyReplaced, never
    // the pre-loaded records). Without this seed, `claude -r {newSessionId}`
    // finds source tool_use_ids in messages but no matching replacement records
    // → they're classified as FROZEN → full content sent (cache miss, permanent
    // overage). insertContentReplacement stamps sessionId = getSessionId() =
    // the fresh ID, so loadTranscriptFile's keyed lookup will match.
    await recordContentReplacement(result.contentReplacements)
  }

  // Arm the provider-switch lock from the transcript the session is adopting.
  // A restored process has no accumulated cost, so `getTotalInputTokens()` is 0
  // and the model catalog would otherwise offer a cross-provider switch on a
  // conversation that already has provider-shaped state. Not scoped to the
  // adopt branch: --fork-session loads the same messages into context, so it
  // carries the same binding.
  setProviderSwitchLocked(hasProviderBoundHistory(result.messages))

  // Restore session metadata so /status shows the saved name and metadata
  // is re-appended on session exit. Fork doesn't take ownership of the
  // original session's worktree or goal: both embed source-session identity.
  const restoreResult = prepareSessionRestoreResult(result, opts.forkSession)
  restoreSessionMetadata(restoreResult)

  if (!opts.forkSession) {
    // Re-acquire immediately around adoption. The early check above prevents
    // partial state changes on an already-busy session; this second acquisition
    // closes the after-probe window where a worker could start before the
    // transcript pointer is adopted.
    const adopt = () => {
      // Cd back into the worktree the session was in when it last exited.
      // Done after restoreSessionMetadata (which caches the worktree state
      // from the transcript) so if the directory is gone we can override
      // the cache before adoptResumedSessionFile writes it.
      restoreWorktreeForResume(result.worktreeSession)

      // Point sessionFile at the resumed transcript and re-append metadata
      // now. resetSessionFilePointer above nulled it (so the old fresh-session
      // path doesn't leak), but that blocks reAppendSessionMetadata — which
      // bails on null — from running in the exit cleanup handler. For fork,
      // useLogMessages populates a *new* file via recordTranscript on REPL
      // mount; the normal lazy-materialize path is correct there.
      adoptResumedSessionFile()
    }
    if (adoptedSessionId) {
      await withDeferredContinuationResumeAuthority(adoptedSessionId, adopt)
    } else {
      adopt()
    }
  }

  // Restore agent setting from resumed session
  const { agentDefinition: restoredAgent, agentType: resumedAgentType } =
    restoreAgentFromSession(
      result.agentSetting,
      context.mainThreadAgentDefinition,
      context.agentDefinitions,
    )

  // Persist the current mode so future resumes know what mode this session was in
  if (feature('COORDINATOR_MODE')) {
    saveMode(context.modeApi?.getCurrentSessionMode() ?? 'normal')
  }

  // Compute initial state before render (per CLAUDE.md guidelines)
  const restoredAttribution = opts.includeAttribution
    ? computeRestoredAttributionState(result)
    : undefined
  const standaloneAgentContext = computeStandaloneAgentContext(
    result.agentName,
    result.agentColor,
  )
  void updateSessionName(result.agentName)
  const refreshedAgentDefs = await refreshAgentDefinitionsForModeSwitch(
    !!modeWarning,
    context.currentCwd,
    context.cliAgents,
    context.agentDefinitions,
  )

  // Detect stalled subagents and inject reminder messages. Fire-and-forget
  // on error — a missing transcript never blocks resume.
  // On --fork-session the active session ID is the NEW fork, not the source.
  // Use opts.transcriptPath if provided (cross-project resume), else derive
  // from result.sessionId (the source session). On normal resume,
  // getTranscriptPath() is correct because switchSession already ran.
  const sourceTranscriptPath = opts.forkSession
    ? (opts.transcriptPath ?? (result.sessionId ? getTranscriptPathForSession(result.sessionId) : null))
    : getTranscriptPath()
  const stallReminders = sourceTranscriptPath
    ? await buildStallReminders(sourceTranscriptPath).catch(() => [])
    : []

  return {
    messages: [...result.messages, ...stallReminders],
    fileHistorySnapshots: result.fileHistorySnapshots,
    contentReplacements: result.contentReplacements,
    agentName: result.agentName,
    agentColor: (result.agentColor === 'default'
      ? undefined
      : result.agentColor) as AgentColorName | undefined,
    restoredAgentDef: restoredAgent,
    initialState: {
      ...context.initialState,
      ...(resumedAgentType && { agent: resumedAgentType }),
      ...(restoredAttribution && { attribution: restoredAttribution }),
      ...(standaloneAgentContext && { standaloneAgentContext }),
      threadGoal: restoreResult.threadGoal ?? null,
      agentDefinitions: refreshedAgentDefs,
    },
  }
}
