import { feature } from 'bun:bundle'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { randomUUID } from 'crypto'
import type { UUID } from 'crypto'
import { constants as fsConstants, type Dirent } from 'fs'
// Sync fs primitives for readFileTailSync — separate from fs/promises
// imports above. Named (not wildcard) per CLAUDE.md style; no collisions
// with the async-suffixed names.
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'fs'
import {
  appendFile as fsAppendFile,
  open as fsOpen,
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { basename, dirname, join } from 'path'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import {
  getOriginalCwd,
  getPlanSlugCache,
  getPromptId,
  getSessionId,
  getSessionProjectDir,
  isSessionPersistenceDisabled,
  switchSession,
} from '../bootstrap/state.js'
import { builtInCommandNames } from '../commands.js'
import { COMMAND_NAME_TAG, TICK_TAG } from '../constants/xml.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import * as sessionIngress from '../services/api/sessionIngress.js'
import { REPL_TOOL_NAME } from '../tools/REPLTool/constants.js'
import {
  type AgentId,
  asAgentId,
  asSessionId,
  type SessionId,
} from '../types/ids.js'
import type { AttributionSnapshotMessage } from '../types/logs.js'
import {
  type ActiveConversationTipEntry,
  type ContentReplacementEntry,
  type ContextCollapseCommitEntry,
  type ContextCollapseSnapshotEntry,
  type DeferredContinuationResultEntryV1,
  type Entry,
  type FileHistorySnapshotMessage,
  type LegacySessionMode,
  type LogOption,
  type PersistedWorktreeSession,
  normalizeSessionMode,
  type SessionMode,
  type SerializedMessage,
  sortLogs,
  type SubagentSpawnedMessage,
  type SubagentTerminalMessage,
  type TranscriptMessage,
} from '../types/logs.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  SystemCompactBoundaryMessage,
  SystemMessage,
  UserMessage,
} from '../types/message.js'
import type { QueueOperationMessage } from '../types/messageQueueTypes.js'
import { uniq } from './array.js'
import { getActiveSubagentTranscriptPath, registerCleanup } from './cleanupRegistry.js'
import { updateSessionName } from './concurrentSessions.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { isFsInaccessible } from './errors.js'
import type { FileHistorySnapshot } from './fileHistory.js'
import { formatFileSize } from './format.js'
import { getFsImplementation } from './fsOperations.js'
import { getWorktreePaths } from './getWorktreePaths.js'
import { getBranch } from './git.js'
import { gracefulShutdownSync, isShuttingDown } from './gracefulShutdown.js'
import { parseJSONL } from './json.js'
import { logError } from './log.js'
import { extractTag, isCompactBoundaryMessage } from './messages.js'
import { sanitizePath } from './path.js'
import { writeFileSyncAndFlush_DEPRECATED } from './file.js'
import {
  activateTranscriptLease,
  assertActiveTranscriptLease,
} from './transcriptLease.js'
import {
  extractJsonStringField,
  extractLastJsonStringField,
  LITE_READ_BUF_SIZE,
  readHeadAndTail,
  readTranscriptForLoad,
  SKIP_PRECOMPACT_THRESHOLD,
} from './sessionStoragePortable.js'
import { getSettings_DEPRECATED } from './settings/settings.js'
import { jsonParse, jsonStringify } from './slowOperations.js'
import type { ContentReplacementRecord } from './toolResultStorage.js'
import { parseThreadGoal, type ThreadGoal } from './threadGoal.js'
import { validateUuid } from './uuid.js'

// Cache MACRO.VERSION at module level to work around bun --define bug in async contexts
// See: https://github.com/oven-sh/bun/issues/26168
const VERSION = typeof MACRO !== 'undefined' ? MACRO.VERSION : 'unknown'

type Transcript = (
  | UserMessage
  | AssistantMessage
  | AttachmentMessage
  | SystemMessage
)[]

function setLatestMapValue<K, V>(map: Map<K, V>, key: K, value: V): void {
  // Map.set does not move an existing key. Delete first so iteration order
  // continues to represent transcript append order across legacy ID rotations.
  map.delete(key)
  map.set(key, value)
}

function applyThreadGoalEntry(
  threadGoals: Map<UUID, ThreadGoal | null>,
  entry: Entry,
): void {
  if (entry.type === 'thread-goal-updated') {
    const goal = parseThreadGoal(entry.goal)
    if (!goal || goal.threadId !== entry.sessionId) {
      return
    }
    setLatestMapValue(threadGoals, entry.sessionId, goal)
    return
  }

  if (entry.type === 'thread-goal-cleared') {
    setLatestMapValue(threadGoals, entry.sessionId, null)
  }
}

// Use getOriginalCwd() at each call site instead of capturing at module load
// time. getCwd() at import time may run before bootstrap resolves symlinks via
// realpathSync, causing a different sanitized project directory than what
// getOriginalCwd() returns after bootstrap. This split-brain made sessions
// saved under one path invisible when loaded via the other.

/**
 * Pre-compiled regex to skip non-meaningful messages when extracting first prompt.
 * Matches anything starting with a lowercase XML-like tag (IDE context, hook
 * output, task notifications, channel messages, etc.) or a synthetic interrupt
 * marker. Kept in sync with sessionStoragePortable.ts — generic pattern avoids
 * an ever-growing allowlist that falls behind as new notification types ship.
 */
// 50MB — prevents OOM in the tombstone slow path which reads + rewrites the
// entire session file. Session files can grow to multiple GB (inc-3930).
const MAX_TOMBSTONE_REWRITE_BYTES = 50 * 1024 * 1024
const ACTIVE_CONVERSATION_TIP_TYPE = 'active-conversation-tip'

const SKIP_FIRST_PROMPT_PATTERN =
  /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/

/**
 * Type guard to check if an entry is a transcript message.
 * Transcript messages include user, assistant, attachment, and system messages.
 * IMPORTANT: This is the single source of truth for what constitutes a transcript message.
 * loadTranscriptFile() uses this to determine which messages to load into the chain.
 *
 * Progress messages are NOT transcript messages. They are ephemeral UI state
 * and must not be persisted to the JSONL or participate in the parentUuid
 * chain. Including them caused chain forks that orphaned real conversation
 * messages on resume (see #14373, #23537).
 */
export function isTranscriptMessage(entry: Entry): entry is TranscriptMessage {
  return (
    entry.type === 'user' ||
    entry.type === 'assistant' ||
    entry.type === 'attachment' ||
    entry.type === 'system'
  )
}

/**
 * Entries that participate in the parentUuid chain. Used on the write path
 * (insertMessageChain, useLogMessages) to skip progress when assigning
 * parentUuid. Old transcripts with progress already in the chain are handled
 * by the progressBridge rewrite in loadTranscriptFile.
 */
export function isChainParticipant(m: Pick<Message, 'type'>): boolean {
  return m.type !== 'progress'
}

function parseActiveConversationTipEntry(
  entry: unknown,
): ActiveConversationTipEntry | null {
  if (
    typeof entry !== 'object' ||
    entry === null ||
    !('type' in entry) ||
    entry.type !== ACTIVE_CONVERSATION_TIP_TYPE ||
    !('sessionId' in entry) ||
    !('tipUuid' in entry)
  ) {
    return null
  }
  const sessionId = validateUuid(entry.sessionId)
  const tipUuid = entry.tipUuid === null ? null : validateUuid(entry.tipUuid)
  if (!sessionId || (entry.tipUuid !== null && !tipUuid)) return null
  return {
    type: ACTIVE_CONVERSATION_TIP_TYPE,
    sessionId,
    tipUuid,
  }
}

type LegacyProgressEntry = {
  type: 'progress'
  uuid: UUID
  parentUuid: UUID | null
}

/**
 * Progress entries in transcripts written before PR #24099. They are not
 * in the Entry type union anymore but still exist on disk with uuid and
 * parentUuid fields. loadTranscriptFile bridges the chain across them.
 */
function isLegacyProgressEntry(entry: unknown): entry is LegacyProgressEntry {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    'type' in entry &&
    entry.type === 'progress' &&
    'uuid' in entry &&
    typeof entry.uuid === 'string'
  )
}

/**
 * High-frequency tool progress ticks (1/sec for Sleep, per-chunk for Bash).
 * These are UI-only: not sent to the API, not rendered after the tool
 * completes. Used by REPL.tsx to replace-in-place instead of appending, and
 * by loadTranscriptFile to skip legacy entries from old transcripts.
 */
const EPHEMERAL_PROGRESS_TYPES = new Set([
  'bash_progress',
  'powershell_progress',
  'mcp_progress',
  ...(feature('PROACTIVE') || feature('KAIROS')
    ? (['sleep_progress'] as const)
    : []),
])
export function isEphemeralToolProgress(dataType: unknown): boolean {
  return typeof dataType === 'string' && EPHEMERAL_PROGRESS_TYPES.has(dataType)
}

export function getProjectsDir(): string {
  return join(getClaudeConfigHomeDir(), 'projects')
}

// Memoized: called 12+ times per turn via hooks.ts createBaseHookInput
// (PostToolUse path, 5×/turn) + various save* functions. Input is a cwd
// string; homedir/env/regex are all session-invariant so the result is
// stable for a given input. Worktree switches just change the key — no
// cache clear needed.
export const getProjectDir = memoize((projectDir: string): string => {
  return join(getProjectsDir(), sanitizePath(projectDir))
})

export function getTranscriptPath(): string {
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  return join(projectDir, `${getSessionId()}.jsonl`)
}

/**
 * Latch the current session's transcript to the project dir it resolves to
 * right now, so a later `setOriginalCwd` can't move it.
 *
 * Callers that chdir the session mid-flight (EnterWorktreeTool) leave
 * `Project.sessionFile` pointing at the file materialized under the ORIGINAL
 * project dir while `getTranscriptPath()` — and everything derived from it:
 * `getAgentTranscriptPath`, `getAgentTranscriptPathForSession`,
 * `listAgentMetadataForSession`, the remote-agents dir, and the hook payload's
 * `transcript_path` — would start resolving under the new cwd's project dir,
 * a file nobody writes.
 *
 * This is the same fix resume/branch already has (see the comment on
 * `getTranscriptPathForSession`): pin `sessionProjectDir` rather than let the
 * path derive from a cwd that moved. `switchSession` is the only setter, by
 * design (CC-34); re-passing the current session id makes its subscribers
 * no-ops (`setCodexPromptCacheKey` skips on unchanged key, the PID file
 * rewrites the same id).
 */
export function pinSessionProjectDir(): void {
  switchSession(
    getSessionId(),
    getSessionProjectDir() ?? getProjectDir(getOriginalCwd()),
  )
}

export function getTranscriptPathForSession(sessionId: string): string {
  // When asking for the CURRENT session's transcript, honor sessionProjectDir
  // the same way getTranscriptPath() does. Without this, hooks get a
  // transcript_path computed from originalCwd while the actual file was
  // written to sessionProjectDir (set by switchActiveSession on resume/branch)
  // — different directories, so the hook sees MISSING (gh-30217). CC-34
  // made sessionId + sessionProjectDir atomic precisely to prevent this
  // kind of drift; this function just wasn't updated to read both.
  //
  // For OTHER session IDs we can only guess via originalCwd — we don't
  // track a sessionId→projectDir map. Callers wanting a specific other
  // session's path should pass fullPath explicitly (most save* functions
  // already accept this).
  if (sessionId === getSessionId()) {
    return getTranscriptPath()
  }
  const projectDir = getProjectDir(getOriginalCwd())
  return join(projectDir, `${sessionId}.jsonl`)
}

// 50 MB — session JSONL can grow to multiple GB (inc-3930). Callers that
// read the raw transcript must bail out above this threshold to avoid OOM.
export const MAX_TRANSCRIPT_READ_BYTES = 50 * 1024 * 1024

/**
 * Number of sessions to enrich on the initial load of the resume picker.
 * Each enrichment reads up to 128 KB per file (head + tail), so 50 sessions
 * means ~6.4 MB of I/O — fast on any modern filesystem while giving users
 * a much better initial view than the previous default of 10.
 */
const INITIAL_ENRICH_COUNT = 50

// In-memory map of agentId → subdirectory for grouping related subagent
// transcripts (e.g. workflow runs write to subagents/workflows/<runId>/).
// Populated before the agent runs; consulted by getAgentTranscriptPath.
const agentTranscriptSubdirs = new Map<string, string>()

/**
 * Gets message UUIDs for a specific session without loading all sessions.
 * Memoized to avoid re-reading the same session file multiple times.
 */
const getSessionMessages = memoize(
  async (sessionId: UUID): Promise<Set<UUID>> => {
    const { messages } = await loadSessionFile(sessionId)
    return new Set(messages.keys())
  },
  (sessionId: UUID) => sessionId,
)

export function setAgentTranscriptSubdir(
  agentId: string,
  subdir: string,
): void {
  agentTranscriptSubdirs.set(agentId, subdir)
}

export function clearAgentTranscriptSubdir(agentId: string): void {
  agentTranscriptSubdirs.delete(agentId)
}

export function getAgentTranscriptPath(agentId: AgentId): string {
  // Same sessionProjectDir consistency as getTranscriptPathForSession —
  // subagent transcripts live under the session dir, so if the session
  // transcript is at sessionProjectDir, subagent transcripts are too.
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  const sessionId = getSessionId()
  const subdir = agentTranscriptSubdirs.get(agentId)
  const base = subdir
    ? join(projectDir, sessionId, 'subagents', subdir)
    : join(projectDir, sessionId, 'subagents')
  return join(base, `agent-${agentId}.jsonl`)
}

export function getAgentTranscriptPathForSession(
  sessionId: string,
  agentId: AgentId,
): string {
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  return join(projectDir, sessionId, 'subagents', `agent-${agentId}.jsonl`)
}

function getAgentMetadataPath(agentId: AgentId): string {
  return getAgentTranscriptPath(agentId).replace(/\.jsonl$/, '.meta.json')
}

function getAgentMetadataPathForSession(
  sessionId: string,
  agentId: AgentId,
): string {
  return getAgentTranscriptPathForSession(sessionId, agentId).replace(
    /\.jsonl$/,
    '.meta.json',
  )
}

export type AgentMetadata = {
  agentType: string
  /** Friendly system/user-facing name for targeting this subagent. */
  agentName?: string
  /** Worktree path if the agent was spawned with isolation: "worktree" */
  worktreePath?: string
  /** Original task description from the AgentTool input. Persisted so a
   * resumed agent's notification can show the original description instead
   * of a placeholder. Optional — older metadata files lack this field. */
  description?: string
  /** Parent session that spawned this subagent. Optional — older files lack this. */
  parentSessionId?: string
  /** Agent tool_use block id in the parent transcript. Optional — older files lack this. */
  parentToolUseId?: string
  /** ISO timestamp when this subagent was spawned. Optional — older files lack this. */
  spawnedAt?: string
}

/**
 * Persist the agentType used to launch a subagent. Read by resume to
 * route correctly when subagent_type is omitted — without this, resuming
 * a fork silently degrades to general-purpose (4KB system prompt, no
 * inherited history). Sidecar file avoids JSONL schema changes.
 *
 * Also stores the worktreePath when the agent was spawned with worktree
 * isolation, enabling resume to restore the correct cwd.
 */
export async function writeAgentMetadata(
  agentId: AgentId,
  metadata: AgentMetadata,
): Promise<void> {
  const path = getAgentMetadataPath(agentId)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(metadata))
}

export async function readAgentMetadata(
  agentId: AgentId,
): Promise<AgentMetadata | null> {
  const path = getAgentMetadataPath(agentId)
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as AgentMetadata
  } catch (e) {
    if (isFsInaccessible(e)) return null
    throw e
  }
}

export async function readAgentMetadataForSession(
  sessionId: string,
  agentId: AgentId,
): Promise<AgentMetadata | null> {
  const path = getAgentMetadataPathForSession(sessionId, agentId)
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as AgentMetadata
  } catch (e) {
    if (isFsInaccessible(e)) return null
    throw e
  }
}

export async function listAgentMetadataForSession(
  sessionId: string,
): Promise<Array<{ agentId: AgentId; metadata: AgentMetadata }>> {
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  const dir = join(projectDir, sessionId, 'subagents')
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (e) {
    if (isFsInaccessible(e)) return []
    throw e
  }

  const results: Array<{ agentId: AgentId; metadata: AgentMetadata }> = []
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !entry.name.startsWith('agent-') ||
      !entry.name.endsWith('.meta.json')
    ) {
      continue
    }

    const agentId = entry.name.slice(
      'agent-'.length,
      -'.meta.json'.length,
    ) as AgentId
    try {
      const raw = await readFile(join(dir, entry.name), 'utf-8')
      results.push({ agentId, metadata: JSON.parse(raw) as AgentMetadata })
    } catch (e) {
      logForDebugging(
        `listAgentMetadataForSession: skipping ${entry.name}: ${String(e)}`,
      )
    }
  }
  return results
}

/**
 * Append a subagent-spawned entry to the parent session transcript. Synchronous.
 */
export function appendSubagentSpawned(
  parentTranscriptPath: string,
  entry: Omit<SubagentSpawnedMessage, 'type'>,
): void {
  appendEntryToFile(parentTranscriptPath, { type: 'subagent-spawned', ...entry })
}

/**
 * Append a subagent-terminal entry to the parent session transcript.
 * Sync so it can be called from process-exit cleanup handlers.
 */
export function appendSubagentTerminal(
  parentTranscriptPath: string,
  entry: Omit<SubagentTerminalMessage, 'type'>,
): void {
  appendEntryToFile(parentTranscriptPath, { type: 'subagent-terminal', ...entry })
}

/**
 * The transcript path a live session has taken ownership of, or `null` when
 * none has. `Project.sessionFile` stays null until the first user/assistant
 * message materializes the file (`materializeSessionFile`) or
 * `--continue`/`--resume` adopts an existing one (`adoptResumedSessionFile`),
 * so this is the same signal that already keeps metadata-only transcripts off
 * disk — and it inherits `shouldSkipPersistence()` (test env,
 * `--no-session-persistence`, `cleanupPeriodDays: 0`) for free.
 *
 * Diagnostic appenders MUST resolve their target through this rather than
 * `getTranscriptPath()`: that helper derives a path from the current session
 * id whether or not anything owns it, so an unowned write mints an orphan
 * transcript — 162 of 514 files on one machine, which then polluted `/resume`
 * and the desktop sidebar. Reads the singleton directly instead of via
 * `getProject()` so a diagnostic never constructs the Project (and registers
 * its cleanup handler) as a side effect.
 */
function getOwnedTranscriptPath(): string | null {
  return project?.sessionFile ?? null
}

/**
 * Shared body of the diagnostic appenders below: resolve the owning transcript,
 * stamp the standard `system` envelope, append, and swallow any failure.
 *
 * The lease assertion runs OUTSIDE the try on purpose, so a lease violation
 * still throws to the caller instead of disappearing into the best-effort
 * catch. `agentId` picks the agent-owned transcript when the record belongs to
 * a subagent; a null path means nothing owns a transcript, so nothing is
 * written (a diagnostic must never mint an orphan transcript).
 */
function appendSystemDiagnostic(
  subtype: string,
  entry: Record<string, unknown>,
  options?: { agentId?: AgentId; includeSessionId?: boolean },
): void {
  assertActiveTranscriptLease(getSessionId())
  try {
    const transcriptPath = options?.agentId
      ? getOwnedAgentTranscriptPath(options.agentId)
      : getOwnedTranscriptPath()
    if (transcriptPath === null) return
    appendEntryToFile(transcriptPath, {
      type: 'system',
      subtype,
      ...(options?.includeSessionId ? { sessionId: getSessionId() } : {}),
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
    })
  } catch {
    // Best-effort — don't let diagnostic writes crash the API path.
  }
}

/**
 * Append a codex_request_start diagnostic entry to the current session JSONL.
 *
 * The start-side counterpart of `recordCodexSendPath` /
 * `recordCodexStreamSurface`: both of those write when a stream ENDS, so a
 * provider request that hangs forever writes nothing at all and the absence of
 * a record cannot distinguish "no request was made" from "a request never
 * finished" — the ambiguity that cost the 2026-08-10 overnight hang hours
 * (`docs/reports/2026-08-10-overnight-turn-hang-investigation.md`,
 * `docs/migration/decisions/OBSERVABILITY-MINIMUM.md` §2).
 *
 * Metadata only: the transport this request dispatches on, prefixes, and the
 * model. Never the request body, message content, or a full conversation id
 * (OBSERVABILITY-MINIMUM §5). Log-only — nothing here bounds, aborts, or
 * retries the request, because killing a hung request destroys the state that
 * explains it (§3).
 *
 * One record per request dispatch, never per chunk, frame, or WS→HTTP
 * fallback: a request that starts on the websocket and finishes over HTTP is
 * one request and pairs with the one `codex_stream_surface` it ends with.
 *
 * No-op unless a real session owns the transcript — see
 * `getOwnedTranscriptPath()`.
 *
 * Sync and best-effort — never throws. Safe to call from the API path.
 */
export function recordCodexRequestStart(entry: {
  mode: 'websocket' | 'http'
  conversation_id_prefix: string | null
  account_id_prefix: string | null
  model: string
}): void {
  appendSystemDiagnostic('codex_request_start', entry)
}

/**
 * Append a codex_send_path diagnostic entry to the current session JSONL.
 * Records the WS send-path decision (incremental/full/prewarm/stale_retry)
 * and associated metadata so post-hoc analysis of cache misses doesn't
 * require cross-referencing debug logs.
 *
 * No-op unless a real session owns the transcript — see
 * `getOwnedTranscriptPath()`. Prewarm sends in particular fire before the
 * first user message, when nothing owns the file yet.
 *
 * Sync and best-effort — never throws. Safe to call from the API path.
 */
export function recordCodexSendPath(entry: {
  mode: 'incremental' | 'full' | 'prewarm' | 'stale_retry'
  prev_response_id_prefix: string | null
  sent_items: number
  prev_sent_items: number
  instructions_hash: string
  effort: string | null
  prompt_cache_key_prefix: string | null
  session_id_prefix: string | null
  account_id_prefix: string | null
  ttfb_ms?: number
  total_stream_ms?: number
  cached_tokens?: number
  input_tokens?: number
  route_headers?: Record<string, string>
}): void {
  appendSystemDiagnostic('codex_send_path', entry)
}

/**
 * Append a codex_stream_surface diagnostic entry to the current session JSONL.
 * Records raw Codex event timing at the adapter boundary so transport latency,
 * hidden reasoning, and visible-output gaps can be separated post-hoc.
 *
 * No-op unless a real session owns the transcript — see
 * `getOwnedTranscriptPath()`.
 *
 * Sync and best-effort — never throws. Safe to call from the API path.
 */
export function recordCodexStreamSurface(entry: {
  transport: 'websocket' | 'http'
  transport_path: 'websocket' | 'http' | 'websocket_then_http'
  conversation_id_prefix: string | null
  account_id_prefix: string | null
  model: string
  response_headers_ms?: number
  first_raw_event_ms?: number
  first_reasoning_delta_ms?: number
  first_reasoning_done_ms?: number
  first_text_delta_ms?: number
  first_visible_ms?: number
  completed_ms?: number
  input_tokens?: number
  cached_tokens?: number
  output_tokens?: number
  raw_event_count: number
  raw_event_types: Record<string, number>
  had_visible_output: boolean
  had_tool_calls: boolean
  completed: boolean
  error_name?: string
  fallback_error_name?: string
}): void {
  appendSystemDiagnostic('codex_stream_surface', entry)
}

/**
 * Transcript a diagnostic may append to for `agentId`, or `null` if nothing
 * owns one.
 *
 * Order matters. A live subagent's registered path is true ownership — recorded
 * at spawn/resume, dropped at terminal. The DERIVED path is accepted only when
 * it already exists, which keeps coverage for agent-shaped callers that own a
 * transcript without registering as a subagent (a backgrounded main-session
 * task links its own at `LocalMainSessionTask.ts:101` and passes that same
 * `agentId` to the API) while preserving the property that actually matters: a
 * diagnostic never CREATES an agent transcript, so it cannot mint an orphan.
 */
function getOwnedAgentTranscriptPath(agentId: AgentId): string | null {
  const registered = getActiveSubagentTranscriptPath(agentId)
  if (registered !== null) return registered
  const derived = getAgentTranscriptPath(agentId)
  try {
    getFsImplementation().statSync(derived)
    return derived
  } catch {
    return null
  }
}

/** Last snapshot written, so an unchanged run records once rather than per request. */
let lastRunFactsSnapshot: string | null = null

/**
 * Append a run_facts snapshot — the model, permission mode, effort and context
 * window one request actually ran with — to the current session JSONL.
 *
 * These four are otherwise only recoverable as byproducts of unrelated records:
 * model from an `assistant` message, permission mode from a typed user prompt,
 * effort from Codex WS completion telemetry (`recordCodexSendPath`, hence absent
 * on Anthropic, HTTP-fallback and aborted turns), and the context window not at
 * all. A reader assembling them independently can pair facts from turns that
 * never coexisted — a synthetic assistant's model beside an earlier turn's
 * usage. Writing all four from ONE resolved request keeps the snapshot coherent
 * by construction.
 *
 * `contextWindow` is captured here rather than re-derived at read time because
 * `getContextWindowForModel()` branches on the CURRENT environment (1M betas,
 * capability data, `CLAUDE_CODE_MAX_CONTEXT_TOKENS`), so resolving a historic
 * run against today's environment reports a window that was never in force.
 *
 * No-op unless the transcript has an owner — see `getOwnedTranscriptPath()`.
 * Resolved that way rather than through `getProject()`, which would construct
 * the Project (and register its cleanup handler) as a diagnostic side effect.
 *
 * Sync and best-effort — never throws. Safe to call from the API path.
 */
export function recordRunFacts(entry: {
  model: string
  permissionMode: string
  effort: string | null
  contextWindow: number
}): void {
  assertActiveTranscriptLease(getSessionId())
  try {
    const transcriptPath = getOwnedTranscriptPath()
    if (transcriptPath === null) return
    const sessionId = getSessionId()
    const snapshot = JSON.stringify([
      sessionId,
      entry.model,
      entry.permissionMode,
      entry.effort,
      entry.contextWindow,
    ])
    if (snapshot === lastRunFactsSnapshot) return
    lastRunFactsSnapshot = snapshot
    appendEntryToFile(transcriptPath, {
      type: 'system',
      subtype: 'run_facts',
      sessionId,
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
    })
  } catch {
    // Best-effort — don't let diagnostic writes crash the API path.
  }
}

/** Clear the dedupe so one test's writes don't depend on a prior test's. */
export function resetRunFactsDedupeForTest(): void {
  lastRunFactsSnapshot = null
}

/**
 * Append a prompt_cache_break diagnostic entry to the current session JSONL.
 * Records confirmed prompt cache misses with structured cause metadata so
 * post-hoc debugging does not rely on debug-log scraping.
 *
 * No-op unless the target transcript has an owner. Each branch asks an owner
 * for the path instead of deriving one from an id: the main session from
 * `getOwnedTranscriptPath()`, an agent from `getOwnedAgentTranscriptPath()`.
 * Deriving unconditionally (`getTranscriptPath()` / `getAgentTranscriptPath()`)
 * yields a path whether or not anything owns it, so an unowned write minted an
 * orphan transcript.
 *
 * Sync and best-effort — never throws. Safe to call from the API path.
 */
export function recordPromptCacheBreak(entry: {
  agentId?: AgentId
  querySource: string
  requestId?: string | null
  callNumber: number
  prevCacheReadTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  tokenDrop: number
  prevTotalInputTokens?: number
  totalInputTokens?: number
  prevMessageCount?: number
  messageCount: number
  timeSinceLastAssistantMsg?: number
  ttlBucket: 'under_5m' | 'over_5m' | 'over_1h' | 'unknown'
  reason: string
  contextTruncated: boolean
  staleResponseIdRetry: boolean
  systemPromptChanged: boolean
  toolSchemasChanged: boolean
  modelChanged: boolean
  fastModeChanged: boolean
  cacheControlChanged: boolean
  globalCacheStrategyChanged: boolean
  betasChanged: boolean
  autoModeChanged: boolean
  overageChanged: boolean
  cachedMCChanged: boolean
  effortChanged: boolean
  extraBodyChanged: boolean
  addedToolCount: number
  removedToolCount: number
  systemCharDelta: number
  addedTools: string[]
  removedTools: string[]
  changedToolSchemas: string[]
  addedBetas: string[]
  removedBetas: string[]
  previousModel: string
  newModel: string
  prevGlobalCacheStrategy: string
  newGlobalCacheStrategy: string
  prevEffortValue: string
  newEffortValue: string
  triggeringCommand?: string | null
}): void {
  appendSystemDiagnostic('prompt_cache_break', entry, {
    agentId: entry.agentId,
    includeSessionId: true,
  })
}

/**
 * Named awaits on the path between the final assistant message and result
 * emission. `storage_flush`, `provider_stream` and `unknown` are reserved
 * vocabulary — no call site arms them yet; see `query/postTurnStall.ts` for
 * which phases are wired.
 */
export type PostTurnStallPhase =
  | 'tool_use_summary'
  | 'reactive_compact'
  | 'stop_hooks'
  | 'computer_use_cleanup'
  | 'storage_flush'
  | 'provider_stream'
  | 'unknown'

/**
 * Append a post_turn_stall diagnostic entry to the current session JSONL.
 * Records that one named await between the final assistant message and result
 * emission has been outstanding past its threshold, so a run that never closes
 * names the phase it is stuck in instead of going silent for nine hours
 * (docs/reports/2026-08-10-overnight-turn-hang-investigation.md).
 *
 * Log only, by design: nothing here cancels the await. A timeout would unstick
 * the turn and destroy the evidence this record exists to capture — the run
 * must still be hung when someone samples the process.
 *
 * No-op unless the target transcript has an owner — the main session from
 * `getOwnedTranscriptPath()`, a subagent from `getOwnedAgentTranscriptPath()`.
 * Metadata only: no message, tool input, or hook output content.
 *
 * Sync and best-effort — never throws. Safe to call from a timer callback.
 */
export function recordPostTurnStall(entry: {
  phase: PostTurnStallPhase
  /**
   * The bar the watch was armed at. There is deliberately no elapsed figure:
   * the callback fires AT the threshold, so any "elapsed" it could report is
   * the threshold back again, and a field that reads like a stall duration
   * without being one sends the next reader down a false path.
   */
  threshold_ms: number
  turn_count: number
  query_source: string
  agentId?: AgentId
}): void {
  appendSystemDiagnostic('post_turn_stall', entry, {
    agentId: entry.agentId,
    includeSessionId: true,
  })
}

export type RemoteAgentMetadata = {
  taskId: string
  remoteTaskType: string
  /** CCR session ID — used to fetch live status from the Sessions API on resume. */
  sessionId: string
  title: string
  command: string
  spawnedAt: number
  toolUseId?: string
  isLongRunning?: boolean
  isUltraplan?: boolean
  isRemoteReview?: boolean
  remoteTaskMetadata?: Record<string, unknown>
}

function getRemoteAgentsDir(): string {
  // Same sessionProjectDir fallback as getAgentTranscriptPath — the project
  // dir (containing the .jsonl), not the session dir, so sessionId is joined.
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  return join(projectDir, getSessionId(), 'remote-agents')
}

function getRemoteAgentMetadataPath(taskId: string): string {
  return join(getRemoteAgentsDir(), `remote-agent-${taskId}.meta.json`)
}

/**
 * Persist metadata for a remote-agent task so it can be restored on session
 * resume. Per-task sidecar file (sibling dir to subagents/) survives
 * hydrateSessionFromRemote's .jsonl wipe; status is always fetched fresh
 * from CCR on restore — only identity is persisted locally.
 */
export async function writeRemoteAgentMetadata(
  taskId: string,
  metadata: RemoteAgentMetadata,
): Promise<void> {
  const path = getRemoteAgentMetadataPath(taskId)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(metadata))
}

export async function readRemoteAgentMetadata(
  taskId: string,
): Promise<RemoteAgentMetadata | null> {
  const path = getRemoteAgentMetadataPath(taskId)
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as RemoteAgentMetadata
  } catch (e) {
    if (isFsInaccessible(e)) return null
    throw e
  }
}

export async function deleteRemoteAgentMetadata(taskId: string): Promise<void> {
  const path = getRemoteAgentMetadataPath(taskId)
  try {
    await unlink(path)
  } catch (e) {
    if (isFsInaccessible(e)) return
    throw e
  }
}

/**
 * Scan the remote-agents/ directory for all persisted metadata files.
 * Used by restoreRemoteAgentTasks to reconnect to still-running CCR sessions.
 */
export async function listRemoteAgentMetadata(): Promise<
  RemoteAgentMetadata[]
> {
  const dir = getRemoteAgentsDir()
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (e) {
    if (isFsInaccessible(e)) return []
    throw e
  }
  const results: RemoteAgentMetadata[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.meta.json')) continue
    try {
      const raw = await readFile(join(dir, entry.name), 'utf-8')
      results.push(JSON.parse(raw) as RemoteAgentMetadata)
    } catch (e) {
      // Skip unreadable or corrupt files — a partial write from a crashed
      // fire-and-forget persist shouldn't take down the whole restore.
      logForDebugging(
        `listRemoteAgentMetadata: skipping ${entry.name}: ${String(e)}`,
      )
    }
  }
  return results
}

export function sessionIdExists(sessionId: string): boolean {
  const projectDir = getProjectDir(getOriginalCwd())
  const sessionFile = join(projectDir, `${sessionId}.jsonl`)
  const fs = getFsImplementation()
  try {
    fs.statSync(sessionFile)
    return true
  } catch {
    return false
  }
}

// exported for testing
export function getNodeEnv(): string {
  return process.env.NODE_ENV || 'development'
}

// exported for testing
export function getUserType(): string {
  return process.env.USER_TYPE || 'external'
}

function getEntrypoint(): string | undefined {
  return process.env.CLAUDE_CODE_ENTRYPOINT
}

export function isCustomTitleEnabled(): boolean {
  return true
}

let project: Project | null = null
let cleanupRegistered = false

function getProject(): Project {
  if (!project) {
    project = new Project()

    // Register flush as a cleanup handler (only once)
    if (!cleanupRegistered) {
      registerCleanup(async () => {
        // Flush queued writes first, then re-append session metadata
        // (customTitle, tag) so they always appear in the last 64KB tail
        // window. readLiteMetadata only reads the tail to extract these
        // fields — if enough messages are appended after a /rename, the
        // custom-title entry gets pushed outside the window and --resume
        // shows the auto-generated firstPrompt instead.
        await project?.flush()
        try {
          project?.reAppendSessionMetadata()
        } catch {
          // Best-effort — don't let metadata re-append crash the cleanup
        }
      })
      cleanupRegistered = true
    }
  }
  return project
}

/**
 * Reset the Project singleton's flush state for testing.
 * This ensures tests don't interfere with each other via shared counter state.
 */
export function resetProjectFlushStateForTesting(): void {
  project?._resetFlushState()
}

/**
 * Reset the entire Project singleton for testing.
 * This ensures tests with different CLAUDE_CONFIG_DIR values
 * don't share stale sessionFile paths.
 */
export function resetProjectForTesting(): void {
  project = null
}

export function setSessionFileForTesting(path: string): void {
  getProject().sessionFile = path
}

type InternalEventWriter = (
  eventType: string,
  payload: Record<string, unknown>,
  options?: { isCompaction?: boolean; agentId?: string },
) => Promise<void>

/**
 * Register a CCR v2 internal event writer for transcript persistence.
 * When set, transcript messages are written as internal worker events
 * instead of going through v1 Session Ingress.
 */
export function setInternalEventWriter(writer: InternalEventWriter): void {
  getProject().setInternalEventWriter(writer)
}

type InternalEventReader = () => Promise<
  { payload: Record<string, unknown>; agent_id?: string }[] | null
>

/**
 * Register a CCR v2 internal event reader for session resume.
 * When set, hydrateFromCCRv2InternalEvents() can fetch foreground and
 * subagent internal events to reconstruct conversation state on reconnection.
 */
export function setInternalEventReader(
  reader: InternalEventReader,
  subagentReader: InternalEventReader,
): void {
  getProject().setInternalEventReader(reader)
  getProject().setInternalSubagentEventReader(subagentReader)
}

/**
 * Set the remote ingress URL on the current Project for testing.
 * This simulates what hydrateRemoteSession does in production.
 */
export function setRemoteIngressUrlForTesting(url: string): void {
  getProject().setRemoteIngressUrl(url)
}

const REMOTE_FLUSH_INTERVAL_MS = 10

class Project {
  // Minimal cache for current session only (not all sessions)
  currentSessionTag: string | undefined
  /** Archive is a user-hidden flag, not a delete: the transcript is untouched. */
  currentSessionArchived: boolean | undefined
  currentSessionTitle: string | undefined
  currentSessionAgentName: string | undefined
  currentSessionAgentColor: string | undefined
  currentSessionLastPrompt: string | undefined
  currentSessionAgentSetting: string | undefined
  currentSessionMode: SessionMode | undefined
  // Tri-state: undefined = no goal metadata seen yet, null = cleared,
  // object = current goal state. reAppendSessionMetadata writes null so
  // resume preserves a cleared goal across compaction and exit.
  currentSessionThreadGoal: ThreadGoal | null | undefined
  // Tri-state: undefined = never touched (don't write), null = exited worktree,
  // object = currently in worktree. reAppendSessionMetadata writes null so
  // --resume knows the session exited (vs. crashed while inside).
  currentSessionWorktree: PersistedWorktreeSession | null | undefined
  currentSessionPrNumber: number | undefined
  currentSessionPrUrl: string | undefined
  currentSessionPrRepository: string | undefined

  sessionFile: string | null = null
  // Entries buffered while sessionFile is null. Flushed by materializeSessionFile
  // on the first user/assistant message — prevents metadata-only session files.
  private pendingEntries: Entry[] = []
  private remoteIngressUrl: string | null = null
  private internalEventWriter: InternalEventWriter | null = null
  private internalEventReader: InternalEventReader | null = null
  private internalSubagentEventReader: InternalEventReader | null = null
  private pendingWriteCount: number = 0
  private flushResolvers: Array<() => void> = []
  // Per-file write queues. Each entry carries a resolve callback so
  // callers of enqueueWrite can optionally await their specific write.
  private writeQueues = new Map<
    string,
    Array<{ entry: Entry; resolve: () => void }>
  >()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private activeDrain: Promise<void> | null = null
  // Every mutation of one transcript must serialize with queued appends and
  // with other tombstone removals. A counter (`trackWrite`) only tells flush()
  // that work exists; it cannot protect the read-modify-write filesystem span.
  private fileOperationChains = new Map<string, Promise<void>>()
  private FLUSH_INTERVAL_MS = 100
  private readonly MAX_CHUNK_BYTES = 100 * 1024 * 1024

  constructor() {}

  /** @internal Reset flush/queue state for testing. */
  _resetFlushState(): void {
    this.pendingWriteCount = 0
    this.flushResolvers = []
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.activeDrain = null
    this.writeQueues = new Map()
    this.fileOperationChains = new Map()
  }

  private incrementPendingWrites(): void {
    this.pendingWriteCount++
  }

  private decrementPendingWrites(): void {
    this.pendingWriteCount--
    if (this.pendingWriteCount === 0) {
      // Resolve all waiting flush promises
      for (const resolve of this.flushResolvers) {
        resolve()
      }
      this.flushResolvers = []
    }
  }

  private async trackWrite<T>(fn: () => Promise<T>): Promise<T> {
    this.incrementPendingWrites()
    try {
      return await fn()
    } finally {
      this.decrementPendingWrites()
    }
  }

  private serializeFileOperation<T>(
    filePath: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.fileOperationChains.get(filePath) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(operation)
    const completion = result.then(
      () => undefined,
      () => undefined,
    )
    this.fileOperationChains.set(filePath, completion)
    void completion.then(() => {
      if (this.fileOperationChains.get(filePath) === completion) {
        this.fileOperationChains.delete(filePath)
      }
    })
    return result
  }

  private enqueueWrite(filePath: string, entry: Entry): Promise<void> {
    return new Promise<void>(resolve => {
      let queue = this.writeQueues.get(filePath)
      if (!queue) {
        queue = []
        this.writeQueues.set(filePath, queue)
      }
      queue.push({ entry, resolve })
      this.scheduleDrain()
    })
  }

  private scheduleDrain(): void {
    if (this.flushTimer) {
      return
    }
    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null
      try {
        this.activeDrain = this.drainWriteQueue()
        await this.activeDrain
      } catch (err) {
        logForDebugging(
          `Failed to flush transcript queue: ${err instanceof Error ? err.message : String(err)}`,
          { level: 'warn' },
        )
      } finally {
        this.activeDrain = null
      }
      // If more items arrived during drain, schedule again
      if (this.writeQueues.size > 0) {
        this.scheduleDrain()
      }
    }, this.FLUSH_INTERVAL_MS)
  }

  private async appendToFile(filePath: string, data: string): Promise<void> {
    try {
      await fsAppendFile(filePath, data, { mode: 0o600 })
    } catch {
      // Directory may not exist — some NFS-like filesystems return
      // unexpected error codes, so don't discriminate on code.
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
      await fsAppendFile(filePath, data, { mode: 0o600 })
    }
  }

  private async drainWriteQueue(): Promise<void> {
    for (const [filePath, queue] of this.writeQueues) {
      if (queue.length === 0) {
        continue
      }
      const batch = queue.splice(0)

      try {
        if (filePath === this.sessionFile) {
          assertActiveTranscriptLease(getSessionId())
        }
        await this.serializeFileOperation(filePath, async () => {
          let content = ''
          const resolvers: Array<() => void> = []

          for (const { entry, resolve } of batch) {
            const line = jsonStringify(entry) + '\n'

            if (content.length + line.length >= this.MAX_CHUNK_BYTES) {
              // Flush chunk and resolve its entries before starting a new one.
              await this.appendToFile(filePath, content)
              for (const r of resolvers) r()
              resolvers.length = 0
              content = ''
            }

            content += line
            resolvers.push(resolve)
          }

          if (content.length > 0) {
            await this.appendToFile(filePath, content)
            for (const r of resolvers) r()
          }
        })
      } catch (err) {
        // The batch has not been durably acknowledged. Restore it at the front
        // so a later flush retries every entry instead of silently losing it.
        queue.unshift(...batch)
        throw err
      }
    }

    // Clean up empty queues
    for (const [filePath, queue] of this.writeQueues) {
      if (queue.length === 0) {
        this.writeQueues.delete(filePath)
      }
    }
  }

  resetSessionFile(): void {
    this.sessionFile = null
    this.pendingEntries = []
  }

  /**
   * Re-append cached session metadata to the end of the transcript file.
   * This ensures metadata stays within the tail window that readLiteMetadata
   * reads during progressive loading.
   *
   * Called from two contexts with different file-ordering implications:
   * - During compaction (compact.ts, reactiveCompact.ts): writes metadata
   *   just before the boundary marker is emitted - these entries end up
   *   before the boundary and are recovered by scanPreBoundaryMetadata.
   * - On session exit (cleanup handler): writes metadata at EOF after all
   *   boundaries - this is what enables loadTranscriptFile's pre-compact
   *   skip to find metadata without a forward scan.
   *
   * External-writer safety for SDK-mutable fields (custom-title, tag):
   * before re-appending, refresh the cache from the tail scan window. If an
   * external process (SDK renameSession/tagSession) wrote a fresher value,
   * our stale cache absorbs it and the re-append below persists it — not
   * the stale CLI value. If no entry is in the tail (evicted, or never
   * written by the SDK), the cache is the only source of truth and is
   * re-appended as-is.
   *
   * Re-append is unconditional (even when the value is already in the
   * tail): during compaction, a title 40KB from EOF is inside the current
   * tail window but will fall out once the post-compaction session grows.
   * Skipping the re-append would defeat the purpose of this call. Fields
   * the SDK cannot touch (last-prompt, agent-*, mode, pr-link) have no
   * external-writer concern — their caches are authoritative.
   */
  reAppendSessionMetadata(skipTitleRefresh = false): void {
    if (!this.sessionFile) return
    const sessionId = getSessionId() as UUID
    if (!sessionId) return

    // One sync tail read to refresh SDK-mutable fields. Same
    // LITE_READ_BUF_SIZE window readLiteMetadata uses. Empty string on
    // failure → extract returns null → cache is the only source of truth.
    const tail = readFileTailSync(this.sessionFile)

    // Absorb any fresher SDK-written title/tag into our cache. If the SDK
    // wrote while we had the session open, our cache is stale — the tail
    // value is authoritative. If the tail has nothing (evicted or never
    // written externally), the cache stands.
    //
    // Filter with startsWith to match only top-level JSONL entries (col 0)
    // and not "type":"tag" appearing inside a nested tool_use input that
    // happens to be JSON-serialized into a message.
    const tailLines = tail.split('\n')
    if (!skipTitleRefresh) {
      const titleLine = tailLines.findLast(l =>
        l.startsWith('{"type":"custom-title"'),
      )
      if (titleLine) {
        const tailTitle = extractLastJsonStringField(titleLine, 'customTitle')
        // `!== undefined` distinguishes no-match from empty-string match.
        // renameSession rejects empty titles, but the CLI is defensive: an
        // external writer with customTitle:"" should clear the cache so the
        // re-append below skips it (instead of resurrecting a stale title).
        if (tailTitle !== undefined) {
          this.currentSessionTitle = tailTitle || undefined
        }
      }
    }
    const tagLine = tailLines.findLast(l => l.startsWith('{"type":"tag"'))
    if (tagLine) {
      const tailTag = extractLastJsonStringField(tagLine, 'tag')
      // Same: tagSession(id, null) writes `tag:""` to clear.
      if (tailTag !== undefined) {
        this.currentSessionTag = tailTag || undefined
      }
    }
    // Archive is a boolean, so it cannot reuse extractLastJsonStringField's
    // empty-string-means-cleared convention: un-archiving writes `false`, which
    // is a value, not an absence. The last entry wins either way.
    const archivedLine = tailLines.findLast(l =>
      l.startsWith('{"type":"archived"'),
    )
    if (archivedLine) {
      this.currentSessionArchived = /"archived":\s*true/.test(archivedLine)
    }

    // lastPrompt is re-appended so readLiteMetadata can show what the
    // user was most recently doing. Written first so customTitle/tag/etc
    // land closer to EOF (they're the more critical fields for tail reads).
    if (this.currentSessionLastPrompt) {
      appendEntryToFile(this.sessionFile, {
        type: 'last-prompt',
        lastPrompt: this.currentSessionLastPrompt,
        sessionId,
      })
    }
    // Unconditional: cache was refreshed from tail above; re-append keeps
    // the entry at EOF so compaction-pushed content doesn't evict it.
    if (this.currentSessionTitle) {
      appendEntryToFile(this.sessionFile, {
        type: 'custom-title',
        customTitle: this.currentSessionTitle,
        sessionId,
      })
    }
    if (this.currentSessionTag) {
      appendEntryToFile(this.sessionFile, {
        type: 'tag',
        tag: this.currentSessionTag,
        sessionId,
      })
    }
    // Re-appended only when archived: the absence of the entry is the default,
    // so an un-archived session writes nothing here and stays cheap.
    if (this.currentSessionArchived) {
      appendEntryToFile(this.sessionFile, {
        type: 'archived',
        archived: true,
        sessionId,
      })
    }
    if (this.currentSessionAgentName) {
      appendEntryToFile(this.sessionFile, {
        type: 'agent-name',
        agentName: this.currentSessionAgentName,
        sessionId,
      })
    }
    if (this.currentSessionAgentColor) {
      appendEntryToFile(this.sessionFile, {
        type: 'agent-color',
        agentColor: this.currentSessionAgentColor,
        sessionId,
      })
    }
    if (this.currentSessionAgentSetting) {
      appendEntryToFile(this.sessionFile, {
        type: 'agent-setting',
        agentSetting: this.currentSessionAgentSetting,
        sessionId,
      })
    }
    if (this.currentSessionMode) {
      appendEntryToFile(this.sessionFile, {
        type: 'mode',
        mode: this.currentSessionMode,
        sessionId,
      })
    }
    if (this.currentSessionThreadGoal !== undefined) {
      if (this.currentSessionThreadGoal === null) {
        appendEntryToFile(this.sessionFile, {
          type: 'thread-goal-cleared',
          sessionId,
          timestamp: new Date().toISOString(),
        })
      } else {
        appendEntryToFile(this.sessionFile, {
          type: 'thread-goal-updated',
          sessionId,
          goal: this.currentSessionThreadGoal,
          timestamp: new Date().toISOString(),
        })
      }
    }
    if (this.currentSessionWorktree !== undefined) {
      appendEntryToFile(this.sessionFile, {
        type: 'worktree-state',
        worktreeSession: this.currentSessionWorktree,
        sessionId,
      })
    }
    if (
      this.currentSessionPrNumber !== undefined &&
      this.currentSessionPrUrl &&
      this.currentSessionPrRepository
    ) {
      appendEntryToFile(this.sessionFile, {
        type: 'pr-link',
        sessionId,
        prNumber: this.currentSessionPrNumber,
        prUrl: this.currentSessionPrUrl,
        prRepository: this.currentSessionPrRepository,
        timestamp: new Date().toISOString(),
      })
    }
  }

  async flush(): Promise<void> {
    // Cancel pending timer
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    // Wait for any in-flight drain to finish — including one started by ANOTHER
    // flush, not only by the timer. `drainWriteQueue` splices each queue out
    // before it writes, so an overlapping drain finds nothing left to do and
    // this flush would report durability for a write still in flight. A caller
    // that flushes and then exits the process loses exactly that write.
    if (this.activeDrain) {
      await this.activeDrain
    }
    // Drain anything remaining in the queues. Published on `activeDrain` for
    // the same reason: the next flush in has to be able to wait for it.
    const drain = this.drainWriteQueue()
    this.activeDrain = drain
    try {
      await drain
    } finally {
      // Only clear what this call published: a later drain may already own the
      // slot, and stomping it would let the next flush return over an in-flight
      // write, which is the bug this whole block exists to close.
      if (this.activeDrain === drain) this.activeDrain = null
    }

    // Wait for non-queue tracked operations (e.g. removeMessageByUuid)
    if (this.pendingWriteCount === 0) {
      return
    }
    return new Promise<void>(resolve => {
      this.flushResolvers.push(resolve)
    })
  }

  /**
   * Remove a message from the transcript by UUID.
   * Used for tombstoning orphaned messages from failed streaming attempts.
   *
   * The target is almost always the most recently appended entry, so we
   * read only the tail, locate the line, and splice it out with a
   * positional write + truncate instead of rewriting the whole file.
   */
  async removeMessageByUuid(targetUuid: UUID): Promise<void> {
    const sessionFile = this.sessionFile
    if (sessionFile === null) return

    // Move entries already queued for this transcript ahead of the removal.
    // Any later drain joins the same per-file operation chain below, so it
    // cannot append inside the removal's read-modify-write window.
    await this.drainWriteQueue()

    return this.trackWrite(() =>
      this.serializeFileOperation(sessionFile, async () => {
      try {
        let fileSize = 0
        const fh = await fsOpen(sessionFile, 'r+')
        try {
          const { size } = await fh.stat()
          fileSize = size
          if (size === 0) return

          const chunkLen = Math.min(size, LITE_READ_BUF_SIZE)
          const tailStart = size - chunkLen
          const buf = Buffer.allocUnsafe(chunkLen)
          const { bytesRead } = await fh.read(buf, 0, chunkLen, tailStart)
          const tail = buf.subarray(0, bytesRead)

          // Entries are serialized via JSON.stringify (no key-value
          // whitespace). Search for the full `"uuid":"..."` pattern, not
          // just the bare UUID, so we do not match the same value sitting
          // in `parentUuid` of a child entry. UUIDs are pure ASCII so a
          // byte-level search is correct.
          const needle = `"uuid":"${targetUuid}"`
          const matchIdx = tail.lastIndexOf(needle)

          if (matchIdx >= 0) {
            // 0x0a never appears inside a UTF-8 multi-byte sequence, so
            // byte-scanning for line boundaries is safe even if the chunk
            // starts mid-character.
            const prevNl = tail.lastIndexOf(0x0a, matchIdx)
            // If the preceding newline is outside our chunk and we did not
            // read from the start of the file, the line is longer than the
            // window - fall through to the slow path.
            if (prevNl >= 0 || tailStart === 0) {
              const lineStart = prevNl + 1 // 0 when prevNl === -1
              const nextNl = tail.indexOf(0x0a, matchIdx + needle.length)
              const lineEnd = nextNl >= 0 ? nextNl + 1 : bytesRead

              const absLineStart = tailStart + lineStart
              const afterLen = bytesRead - lineEnd
              // Truncate first, then re-append the trailing lines. In the
              // common case (target is the last entry) afterLen is 0 and
              // this is a single ftruncate.
              await fh.truncate(absLineStart)
              if (afterLen > 0) {
                await fh.write(tail, lineEnd, afterLen, absLineStart)
              }
              return
            }
          }
        } finally {
          await fh.close()
        }

        // Slow path: target was not in the last 64KB. Rare - requires many
        // large entries to have landed between the write and the tombstone.
        if (fileSize > MAX_TOMBSTONE_REWRITE_BYTES) {
          logForDebugging(
            `Skipping tombstone removal: session file too large (${formatFileSize(fileSize)})`,
            { level: 'warn' },
          )
          return
        }
        const content = await readFile(sessionFile, { encoding: 'utf-8' })
        const lines = content.split('\n').filter((line: string) => {
          if (!line.trim()) return true
          try {
            const entry = jsonParse(line)
            return entry.uuid !== targetUuid
          } catch {
            return true // Keep malformed lines
          }
        })
        writeFileSyncAndFlush_DEPRECATED(sessionFile, lines.join('\n'), {
          encoding: 'utf8',
          mode: 0o600,
        })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          logForDebugging(
            `Failed to remove tombstoned transcript message: ${err instanceof Error ? err.message : String(err)}`,
            { level: 'warn' },
          )
        }
      }
      }),
    )
  }

  /**
   * True when test env / cleanupPeriodDays=0 / --no-session-persistence /
   * CLAUDE_CODE_SKIP_PROMPT_HISTORY should suppress all transcript writes.
   * Shared guard for appendEntry and materializeSessionFile so both skip
   * consistently. The env var is set by tmuxSocket.ts so Tungsten-spawned
   * test sessions don't pollute the user's --resume list.
   */
  private shouldSkipPersistence(): boolean {
    const allowTestPersistence = isEnvTruthy(
      process.env.TEST_ENABLE_SESSION_PERSISTENCE,
    )
    return (
      (getNodeEnv() === 'test' && !allowTestPersistence) ||
      getSettings_DEPRECATED()?.cleanupPeriodDays === 0 ||
      isSessionPersistenceDisabled() ||
      isEnvTruthy(process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY)
    )
  }

  /**
   * Create the session file, write cached startup metadata, and flush
   * buffered entries. Called on the first user/assistant message.
   */
  private async materializeSessionFile(): Promise<void> {
    // Guard here too — reAppendSessionMetadata writes via appendEntryToFile
    // (not appendEntry) so it would bypass the per-entry persistence check
    // and create a metadata-only file despite --no-session-persistence.
    if (this.shouldSkipPersistence()) return
    await activateTranscriptLease(getSessionId())
    this.ensureCurrentSessionFile()
    // mode/agentSetting are cache-only pre-materialization; write them now.
    this.reAppendSessionMetadata()
    if (this.pendingEntries.length > 0) {
      const buffered = this.pendingEntries
      this.pendingEntries = []
      for (const entry of buffered) {
        await this.appendEntry(entry)
      }
    }
  }

  async insertMessageChain(
    messages: Transcript,
    isSidechain: boolean = false,
    agentId?: string,
    startingParentUuid?: UUID | null,
    teamInfo?: { teamName?: string; agentName?: string },
  ) {
    return this.trackWrite(async () => {
      let parentUuid: UUID | null = startingParentUuid ?? null

      // First user/assistant message materializes the session file.
      // Hook progress/attachment messages alone stay buffered.
      if (
        this.sessionFile === null &&
        messages.some(m => m.type === 'user' || m.type === 'assistant')
      ) {
        await this.materializeSessionFile()
      }

      // Get current git branch once for this message chain
      let gitBranch: string | undefined
      try {
        gitBranch = await getBranch()
      } catch {
        // Not in a git repo or git command failed
        gitBranch = undefined
      }

      // Get slug if one exists for this session (used for plan files, etc.)
      const sessionId = getSessionId()
      const slug = getPlanSlugCache().get(sessionId)

      for (const message of messages) {
        const isCompactBoundary = isCompactBoundaryMessage(message)

        // For tool_result messages, use the assistant message UUID from the message
        // if available (set at creation time), otherwise fall back to sequential parent
        let effectiveParentUuid = parentUuid
        if (
          message.type === 'user' &&
          'sourceToolAssistantUUID' in message &&
          message.sourceToolAssistantUUID
        ) {
          effectiveParentUuid = message.sourceToolAssistantUUID
        }

        const transcriptMessage: TranscriptMessage = {
          parentUuid: isCompactBoundary ? null : effectiveParentUuid,
          logicalParentUuid: isCompactBoundary ? parentUuid : undefined,
          isSidechain,
          teamName: teamInfo?.teamName,
          agentName: teamInfo?.agentName,
          promptId:
            message.type === 'user' ? (getPromptId() ?? undefined) : undefined,
          agentId,
          ...message,
          // Session-stamp fields MUST come after the spread. On --fork-session
          // and --resume, messages arrive as SerializedMessage (carries source
          // sessionId/cwd/etc. because removeExtraFields only strips parentUuid
          // and isSidechain). If sessionId isn't re-stamped, FRESH.jsonl ends up
          // with messages stamped sessionId=A but content-replacement entries
          // stamped sessionId=FRESH (from insertContentReplacement), and
          // loadFullLog's sessionId-keyed contentReplacements lookup misses →
          // replacement records lost → FROZEN misclassification.
          userType: getUserType(),
          entrypoint: getEntrypoint(),
          cwd: getCwd(),
          sessionId,
          version: VERSION,
          gitBranch,
          slug,
        }
        await this.appendEntry(transcriptMessage)
        if (isChainParticipant(message)) {
          parentUuid = message.uuid
        }
      }

      // Cache this turn's user prompt for reAppendSessionMetadata —
      // the --resume picker shows what the user was last doing.
      // Overwritten every turn by design.
      if (!isSidechain) {
        const text = getFirstMeaningfulUserMessageTextContent(messages)
        if (text) {
          const flat = text.replace(/\n/g, ' ').trim()
          this.currentSessionLastPrompt =
            flat.length > 200 ? flat.slice(0, 200).trim() + '…' : flat
        }
      }
    })
  }

  async insertFileHistorySnapshot(
    messageId: UUID,
    snapshot: FileHistorySnapshot,
    isSnapshotUpdate: boolean,
  ) {
    return this.trackWrite(async () => {
      const fileHistoryMessage: FileHistorySnapshotMessage = {
        type: 'file-history-snapshot',
        messageId,
        snapshot,
        isSnapshotUpdate,
      }
      await this.appendEntry(fileHistoryMessage)
    })
  }

  async insertQueueOperation(queueOp: QueueOperationMessage) {
    return this.trackWrite(async () => {
      await this.appendEntry(queueOp)
    })
  }

  async insertAttributionSnapshot(snapshot: AttributionSnapshotMessage) {
    return this.trackWrite(async () => {
      await this.appendEntry(snapshot)
    })
  }

  async insertContentReplacement(
    replacements: ContentReplacementRecord[],
    agentId?: AgentId,
  ) {
    return this.trackWrite(async () => {
      const entry: ContentReplacementEntry = {
        type: 'content-replacement',
        sessionId: getSessionId() as UUID,
        agentId,
        replacements,
      }
      await this.appendEntry(entry)
    })
  }

  async markActiveConversationTip(tipUuid: UUID | null): Promise<void> {
    if (this.shouldSkipPersistence()) return
    await activateTranscriptLease(getSessionId())
    this.ensureCurrentSessionFile()
    await this.appendEntry({
      type: ACTIVE_CONVERSATION_TIP_TYPE,
      sessionId: getSessionId() as UUID,
      tipUuid,
    })
  }

  async appendEntry(entry: Entry, sessionId: UUID = getSessionId() as UUID) {
    if (this.shouldSkipPersistence()) {
      return
    }

    const currentSessionId = getSessionId() as UUID
    const isCurrentSession = sessionId === currentSessionId

    let sessionFile: string
    if (isCurrentSession) {
      // Buffer until materializeSessionFile runs (first user/assistant message).
      if (this.sessionFile === null) {
        this.pendingEntries.push(entry)
        return
      }
      sessionFile = this.sessionFile
      assertActiveTranscriptLease(currentSessionId)
    } else {
      const existing = await this.getExistingSessionFile(sessionId)
      if (!existing) {
        logError(
          new Error(
            `appendEntry: session file not found for other session ${sessionId}`,
          ),
        )
        return
      }
      sessionFile = existing
    }

    // Only load current session messages if needed
    if (entry.type === 'summary') {
      // Summaries can always be appended
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'custom-title') {
      // Custom titles can always be appended
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'ai-title') {
      // AI titles can always be appended
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'last-prompt') {
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'task-summary') {
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'tag') {
      // Tags can always be appended
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'agent-name') {
      // Agent names can always be appended
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'agent-color') {
      // Agent colors can always be appended
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'agent-setting') {
      // Agent settings can always be appended
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'pr-link') {
      // PR links can always be appended
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'file-history-snapshot') {
      // File history snapshots can always be appended
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'attribution-snapshot') {
      // Attribution snapshots can always be appended
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'speculation-accept') {
      // Speculation accept entries can always be appended
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'mode') {
      // Mode entries can always be appended
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'worktree-state') {
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'content-replacement') {
      // Content replacement records can always be appended. Subagent records
      // go to the sidechain file (for AgentTool resume); main-thread
      // records go to the session file (for /resume).
      const targetFile = entry.agentId
        ? getAgentTranscriptPath(entry.agentId)
        : sessionFile
      void this.enqueueWrite(targetFile, entry)
    } else if (entry.type === 'marble-origami-commit') {
      // Always append. Commit order matters for restore (later commits may
      // reference earlier commits' summary messages), so these must be
      // written in the order received and read back sequentially.
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'marble-origami-snapshot') {
      // Always append. Last-wins on restore — later entries supersede.
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'deferred-continuation-result') {
      void this.enqueueWrite(sessionFile, entry)
    } else {
      const messageSet = await getSessionMessages(sessionId)
      if (entry.type === 'queue-operation') {
        // Queue operations are always appended to the session file
        void this.enqueueWrite(sessionFile, entry)
      } else if (!isTranscriptMessage(entry)) {
        // Restoring `messageQueueTypes.ts` un-`any`ed `Entry` and showed this
        // branch was reading `.uuid`, `.isSidechain` and `.agentId` off a union
        // that still admits subagent-spawned/terminal and thread-goal entries.
        // Unreachable today — those reach disk through `appendEntryToFile`
        // (`:452`, `:463`), never here — but the old code would not have failed
        // loudly if one arrived: `.uuid` is `undefined`, the first would write,
        // and every later one would dedup against `undefined` and be DROPPED.
        // Route it like any other non-transcript entry instead of assuming.
        void this.enqueueWrite(sessionFile, entry)
      } else {
        const isAgentSidechain =
          entry.isSidechain && entry.agentId !== undefined
        const targetFile = isAgentSidechain
          ? getAgentTranscriptPath(asAgentId(entry.agentId!))
          : sessionFile

        // For message entries, check if UUID already exists in current session.
        // Skip dedup for agent sidechain LOCAL writes — they go to a separate
        // file, and fork-inherited parent messages share UUIDs with the main
        // session transcript. Deduping against the main session's set would
        // drop them, leaving the persisted sidechain transcript incomplete
        // (resume-of-fork loads a 10KB file instead of the full 85KB inherited
        // context).
        //
        // The sidechain bypass applies ONLY to the local file write — remote
        // persistence (session-ingress) uses a single Last-Uuid chain per
        // sessionId, so re-POSTing a UUID it already has 409s and eventually
        // exhausts retries → gracefulShutdownSync(1). See inc-4718.
        const isNewUuid = !messageSet.has(entry.uuid)
        if (isAgentSidechain || isNewUuid) {
          // Enqueue write — appendToFile handles ENOENT by creating directories
          void this.enqueueWrite(targetFile, entry)

          if (!isAgentSidechain) {
            // messageSet is main-file-authoritative. Sidechain entries go to a
            // separate agent file — adding their UUIDs here causes recordTranscript
            // to skip them on the main thread (line ~1270), so the message is never
            // written to the main session file. The next main-thread message then
            // chains its parentUuid to a UUID that only exists in the agent file,
            // and --resume's buildConversationChain terminates at the dangling ref.
            // Same constraint for remote (inc-4718 above): sidechain persisting a
            // UUID the main thread hasn't written yet → 409 when main writes it.
            messageSet.add(entry.uuid)

            if (isTranscriptMessage(entry)) {
              await this.persistToRemote(sessionId, entry)
            }
          }
        }
      }
    }
  }

  /**
   * Loads the sessionFile variable.
   * Do not need to create session files until they are written to.
   */
  private ensureCurrentSessionFile(): string {
    if (this.sessionFile === null) {
      this.sessionFile = getTranscriptPath()
    }

    return this.sessionFile
  }

  /**
   * Returns the session file path if it exists, null otherwise.
   * Used for writing to sessions other than the current one.
   * Caches positive results so we only stat once per session.
   */
  private existingSessionFiles = new Map<string, string>()
  private async getExistingSessionFile(
    sessionId: UUID,
  ): Promise<string | null> {
    const cached = this.existingSessionFiles.get(sessionId)
    if (cached) return cached

    const targetFile = getTranscriptPathForSession(sessionId)
    try {
      await stat(targetFile)
      this.existingSessionFiles.set(sessionId, targetFile)
      return targetFile
    } catch (e) {
      if (isFsInaccessible(e)) return null
      throw e
    }
  }

  private async persistToRemote(sessionId: UUID, entry: TranscriptMessage) {
    if (isShuttingDown()) {
      return
    }

    // CCR v2 path: write as internal worker event
    if (this.internalEventWriter) {
      try {
        await this.internalEventWriter(
          'transcript',
          entry as unknown as Record<string, unknown>,
          {
            ...(isCompactBoundaryMessage(entry) && { isCompaction: true }),
            ...(entry.agentId && { agentId: entry.agentId }),
          },
        )
      } catch {
        logEvent('tengu_session_persistence_failed', {})
        logForDebugging('Failed to write transcript as internal event')
      }
      return
    }

    // v1 Session Ingress path
    if (
      !isEnvTruthy(process.env.ENABLE_SESSION_PERSISTENCE) ||
      !this.remoteIngressUrl
    ) {
      return
    }

    const success = await sessionIngress.appendSessionLog(
      sessionId,
      entry,
      this.remoteIngressUrl,
    )

    if (!success) {
      logEvent('tengu_session_persistence_failed', {})
      gracefulShutdownSync(1, 'other')
    }
  }

  setRemoteIngressUrl(url: string): void {
    this.remoteIngressUrl = url
    logForDebugging(`Remote persistence enabled with URL: ${url}`)
    if (url) {
      // If using CCR, don't delay messages by any more than 10ms.
      this.FLUSH_INTERVAL_MS = REMOTE_FLUSH_INTERVAL_MS
    }
  }

  setInternalEventWriter(writer: InternalEventWriter): void {
    this.internalEventWriter = writer
    logForDebugging(
      'CCR v2 internal event writer registered for transcript persistence',
    )
    // Use fast flush interval for CCR v2
    this.FLUSH_INTERVAL_MS = REMOTE_FLUSH_INTERVAL_MS
  }

  setInternalEventReader(reader: InternalEventReader): void {
    this.internalEventReader = reader
    logForDebugging(
      'CCR v2 internal event reader registered for session resume',
    )
  }

  setInternalSubagentEventReader(reader: InternalEventReader): void {
    this.internalSubagentEventReader = reader
    logForDebugging(
      'CCR v2 subagent event reader registered for session resume',
    )
  }

  getInternalEventReader(): InternalEventReader | null {
    return this.internalEventReader
  }

  getInternalSubagentEventReader(): InternalEventReader | null {
    return this.internalSubagentEventReader
  }
}

export type TeamInfo = {
  teamName?: string
  agentName?: string
}

// Filter out already-recorded messages before passing to insertMessageChain.
// Without this, after compaction messagesToKeep (same UUIDs as pre-compact
// messages) are dedup-skipped by appendEntry but still advance the parentUuid
// cursor in insertMessageChain, causing new messages to chain from pre-compact
// UUIDs instead of the post-compact summary — orphaning the compact boundary.
//
// `startingParentUuidHint`: used by useLogMessages to pass the parent from
// the previous incremental slice, avoiding an O(n) scan to rediscover it.
//
// Skip-tracking: already-recorded messages are tracked as the parent ONLY if
// they form a PREFIX (appear before any new message). This handles both cases:
//  - Growing-array callers (QueryEngine, queryHelpers, LocalMainSessionTask,
//    trajectory): recorded messages are always a prefix → tracked → correct
//    parent chain for new messages.
//  - Compaction (useLogMessages): new CB/summary appear FIRST, then recorded
//    messagesToKeep → not a prefix → not tracked → CB gets parentUuid=null
//    (correct: truncates --continue chain at compact boundary).
export async function recordTranscript(
  messages: Message[],
  teamInfo?: TeamInfo,
  startingParentUuidHint?: UUID,
  allMessages?: readonly Message[],
): Promise<UUID | null> {
  const cleanedMessages = cleanMessagesForLogging(messages, allMessages)
  const sessionId = getSessionId() as UUID
  const messageSet = await getSessionMessages(sessionId)
  const newMessages: typeof cleanedMessages = []
  let startingParentUuid: UUID | undefined = startingParentUuidHint
  let seenNewMessage = false
  for (const m of cleanedMessages) {
    if (messageSet.has(m.uuid as UUID)) {
      // Only track skipped messages that form a prefix. After compaction,
      // messagesToKeep appear AFTER new CB/summary, so this skips them.
      if (!seenNewMessage && isChainParticipant(m)) {
        startingParentUuid = m.uuid as UUID
      }
    } else {
      newMessages.push(m)
      seenNewMessage = true
    }
  }
  if (newMessages.length > 0) {
    await getProject().insertMessageChain(
      newMessages,
      false,
      undefined,
      startingParentUuid,
      teamInfo,
    )
  }
  // Return the last ACTUALLY recorded chain-participant's UUID, OR the
  // prefix-tracked UUID if no new chain participants were recorded. This lets
  // callers (useLogMessages) maintain the correct parent chain even when the
  // slice is all-recorded (rewind, /resume scenarios where every message is
  // already in messageSet). Progress is skipped — it's written to the JSONL
  // but nothing chains TO it (see isChainParticipant).
  const lastRecorded = newMessages.findLast(isChainParticipant)
  return (lastRecorded?.uuid as UUID | undefined) ?? startingParentUuid ?? null
}

export async function recordSidechainTranscript(
  messages: Message[],
  agentId?: string,
  startingParentUuid?: UUID | null,
) {
  await getProject().insertMessageChain(
    cleanMessagesForLogging(messages),
    true,
    agentId,
    startingParentUuid,
  )
}

export async function recordQueueOperation(queueOp: QueueOperationMessage) {
  await getProject().insertQueueOperation(queueOp)
}

/**
 * Remove a message from the transcript by UUID.
 * Used when a tombstone is received for an orphaned message.
 */
export async function removeTranscriptMessage(targetUuid: UUID): Promise<void> {
  await getProject().removeMessageByUuid(targetUuid)
}

export async function recordFileHistorySnapshot(
  messageId: UUID,
  snapshot: FileHistorySnapshot,
  isSnapshotUpdate: boolean,
) {
  await getProject().insertFileHistorySnapshot(
    messageId,
    snapshot,
    isSnapshotUpdate,
  )
}

export async function recordAttributionSnapshot(
  snapshot: AttributionSnapshotMessage,
) {
  await getProject().insertAttributionSnapshot(snapshot)
}

export async function recordContentReplacement(
  replacements: ContentReplacementRecord[],
  agentId?: AgentId,
) {
  await getProject().insertContentReplacement(replacements, agentId)
}

/**
 * Reset the session file pointer after switchSession/regenerateSessionId.
 * The new file is created lazily on the first user/assistant message.
 */
export async function resetSessionFilePointer() {
  getProject().resetSessionFile()
}

/**
 * Adopt the existing session file after --continue/--resume (non-fork).
 * Call after switchSession + resetSessionFilePointer + restoreSessionMetadata:
 * getTranscriptPath() now derives the resumed file's path from the switched
 * sessionId, and the cache holds the final metadata (--name title, resumed
 * mode/tag/agent).
 *
 * Setting sessionFile here — instead of waiting for materializeSessionFile
 * on the first user message — lets the exit cleanup handler's
 * reAppendSessionMetadata run (it bails when sessionFile is null). Without
 * this, `-c -n foo` + quit-before-message drops the title on the floor:
 * the in-memory cache is correct but never written. The resumed file
 * already exists on disk (we loaded from it), so this can't create an
 * orphan the way a fresh --name session would.
 *
 * skipTitleRefresh: restoreSessionMetadata populated the cache from the
 * same disk read microseconds ago, so refreshing from the tail here is a
 * no-op — unless --name was used, in which case it would clobber the fresh
 * CLI title with the stale disk value. After this write, disk == cache and
 * later calls (compaction, exit cleanup) absorb SDK writes normally.
 */
export function adoptResumedSessionFile(): void {
  const project = getProject()
  project.sessionFile = getTranscriptPath()
  project.reAppendSessionMetadata(true)
}

/**
 * Append a context-collapse commit entry to the transcript. One entry per
 * commit, in commit order. On resume these are collected into an ordered
 * array and handed to restoreFromEntries() which rebuilds the commit log.
 */
export async function recordContextCollapseCommit(commit: {
  collapseId: string
  summaryUuid: string
  summaryContent: string
  summary: string
  firstArchivedUuid: string
  lastArchivedUuid: string
}): Promise<void> {
  const sessionId = getSessionId() as UUID
  if (!sessionId) return
  await getProject().appendEntry({
    type: 'marble-origami-commit',
    sessionId,
    ...commit,
  })
}

/**
 * Snapshot the staged queue + spawn state. Written after each ctx-agent
 * spawn resolves (when staged contents may have changed). Last-wins on
 * restore — the loader keeps only the most recent snapshot entry.
 */
export async function recordContextCollapseSnapshot(snapshot: {
  staged: Array<{
    startUuid: string
    endUuid: string
    summary: string
    risk: number
    stagedAt: number
  }>
  armed: boolean
  lastSpawnTokens: number
}): Promise<void> {
  const sessionId = getSessionId() as UUID
  if (!sessionId) return
  await getProject().appendEntry({
    type: 'marble-origami-snapshot',
    sessionId,
    ...snapshot,
  })
}

export async function flushSessionStorage(): Promise<void> {
  await getProject().flush()
}

export async function markActiveConversationTip(
  tipUuid: UUID | null,
): Promise<void> {
  await getProject().markActiveConversationTip(tipUuid)
  await flushCurrentTranscriptDurably()
}

const DEFERRED_CONTINUATION_RESULT_OUTCOMES = new Set<
  DeferredContinuationResultEntryV1['outcome']
>([
  'completed',
  'quota_exhausted',
  'account_recovery',
  'transient_network',
  'ambiguous_rate_limit',
  'permission_required',
  'context_window',
  'max_turns',
  'max_budget',
  'session_restore',
  'aborted',
  'unknown',
])

export async function recordDeferredContinuationResult(
  entry: DeferredContinuationResultEntryV1,
): Promise<void> {
  const keys = Object.keys(entry).sort()
  if (
    keys.join(',') !==
      'attemptUuid,observedAt,outcome,sessionId,type,version' ||
    entry.type !== 'deferred-continuation-result' ||
    entry.version !== 1 ||
    entry.sessionId !== getSessionId() ||
    !validateUuid(entry.attemptUuid) ||
    !DEFERRED_CONTINUATION_RESULT_OUTCOMES.has(entry.outcome) ||
    !Number.isFinite(entry.observedAt) ||
    entry.observedAt < 0
  ) {
    throw new Error('Invalid deferred continuation result entry')
  }
  await getProject().appendEntry(entry)
}

export async function flushCurrentTranscriptDurably(
  expectedUuid?: string,
): Promise<void> {
  await flushSessionStorage()
  // Resolve through the owned path, not getTranscriptPath(): under
  // `cleanupPeriodDays: 0` / `--no-session-persistence` no `.jsonl` is ever
  // created, so deriving a path from the session id and opening it raised a
  // bare ENOENT at the deferred-continuation callsites. Nothing was written,
  // so there is nothing to make durable.
  const transcriptPath = getOwnedTranscriptPath()
  if (transcriptPath === null) return
  const handle = await fsOpen(
    transcriptPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  )
  try {
    await handle.sync()
    if (expectedUuid) {
      const stat = await handle.stat()
      const bytes = Math.min(stat.size, 1024 * 1024)
      const buffer = Buffer.alloc(bytes)
      await handle.read(buffer, 0, bytes, stat.size - bytes)
      if (!buffer.toString('utf8').includes(`\"uuid\":\"${expectedUuid}\"`)) {
        throw new Error('Deferred continuation UUID is not durable')
      }
    }
  } finally {
    await handle.close()
  }
  const parent = await fsOpen(dirname(transcriptPath), fsConstants.O_RDONLY)
  try {
    await parent.sync()
  } finally {
    await parent.close()
  }
}

export async function hydrateRemoteSession(
  sessionId: string,
  ingressUrl: string,
): Promise<boolean> {
  switchSession(asSessionId(sessionId))

  const project = getProject()

  try {
    const remoteLogs =
      (await sessionIngress.getSessionLogs(sessionId, ingressUrl)) || []

    // Ensure the project directory and session file exist
    const projectDir = getProjectDir(getOriginalCwd())
    await mkdir(projectDir, { recursive: true, mode: 0o700 })

    const sessionFile = getTranscriptPathForSession(sessionId)

    // Replace local logs with remote logs. writeFile truncates, so no
    // unlink is needed; an empty remoteLogs array produces an empty file.
    const content = remoteLogs.map(e => jsonStringify(e) + '\n').join('')
    await writeFile(sessionFile, content, { encoding: 'utf8', mode: 0o600 })

    logForDebugging(`Hydrated ${remoteLogs.length} entries from remote`)
    return remoteLogs.length > 0
  } catch (error) {
    logForDebugging(`Error hydrating session from remote: ${error}`)
    logForDiagnosticsNoPII('error', 'hydrate_remote_session_fail')
    return false
  } finally {
    // Set remote ingress URL after hydrating the remote session
    // to ensure we've always synced with the remote session
    // prior to enabling persistence
    project.setRemoteIngressUrl(ingressUrl)
  }
}

/**
 * Hydrate session state from CCR v2 internal events.
 * Fetches foreground and subagent events via the registered readers,
 * extracts transcript entries from payloads, and writes them to the
 * local transcript files (main + per-agent).
 * The server handles compaction filtering — it returns events starting
 * from the latest compaction boundary.
 */
export async function hydrateFromCCRv2InternalEvents(
  sessionId: string,
): Promise<boolean> {
  const startMs = Date.now()
  switchSession(asSessionId(sessionId))

  const project = getProject()
  const reader = project.getInternalEventReader()
  if (!reader) {
    logForDebugging('No internal event reader registered for CCR v2 resume')
    return false
  }

  try {
    // Fetch foreground events
    const events = await reader()
    if (!events) {
      logForDebugging('Failed to read internal events for resume')
      logForDiagnosticsNoPII('error', 'hydrate_ccr_v2_read_fail')
      return false
    }

    const projectDir = getProjectDir(getOriginalCwd())
    await mkdir(projectDir, { recursive: true, mode: 0o700 })

    // Write foreground transcript
    const sessionFile = getTranscriptPathForSession(sessionId)
    const fgContent = events.map(e => jsonStringify(e.payload) + '\n').join('')
    await writeFile(sessionFile, fgContent, { encoding: 'utf8', mode: 0o600 })

    logForDebugging(
      `Hydrated ${events.length} foreground entries from CCR v2 internal events`,
    )

    // Fetch and write subagent events
    let subagentEventCount = 0
    const subagentReader = project.getInternalSubagentEventReader()
    if (subagentReader) {
      const subagentEvents = await subagentReader()
      if (subagentEvents && subagentEvents.length > 0) {
        subagentEventCount = subagentEvents.length
        // Group by agent_id
        const byAgent = new Map<string, Record<string, unknown>[]>()
        for (const e of subagentEvents) {
          const agentId = e.agent_id || ''
          if (!agentId) continue
          let list = byAgent.get(agentId)
          if (!list) {
            list = []
            byAgent.set(agentId, list)
          }
          list.push(e.payload)
        }

        // Write each agent's transcript to its own file
        for (const [agentId, entries] of byAgent) {
          const agentFile = getAgentTranscriptPath(asAgentId(agentId))
          await mkdir(dirname(agentFile), { recursive: true, mode: 0o700 })
          const agentContent = entries
            .map(p => jsonStringify(p) + '\n')
            .join('')
          await writeFile(agentFile, agentContent, {
            encoding: 'utf8',
            mode: 0o600,
          })
        }

        logForDebugging(
          `Hydrated ${subagentEvents.length} subagent entries across ${byAgent.size} agents`,
        )
      }
    }

    logForDiagnosticsNoPII('info', 'hydrate_ccr_v2_completed', {
      duration_ms: Date.now() - startMs,
      event_count: events.length,
      subagent_event_count: subagentEventCount,
    })
    return events.length > 0
  } catch (error) {
    // Re-throw epoch mismatch so the worker doesn't race against gracefulShutdown
    if (
      error instanceof Error &&
      error.message === 'CCRClient: Epoch mismatch (409)'
    ) {
      throw error
    }
    logForDebugging(`Error hydrating session from CCR v2: ${error}`)
    logForDiagnosticsNoPII('error', 'hydrate_ccr_v2_fail')
    return false
  }
}

function extractFirstPrompt(transcript: TranscriptMessage[]): string {
  const textContent = getFirstMeaningfulUserMessageTextContent(transcript)
  if (textContent) {
    let result = textContent.replace(/\n/g, ' ').trim()

    // Store a reasonably long version for display-time truncation
    // The actual truncation will be applied at display time based on terminal width
    if (result.length > 200) {
      result = result.slice(0, 200).trim() + '…'
    }

    return result
  }

  return 'No prompt'
}

/**
 * Gets the last user message that was processed (i.e., before any non-user message appears).
 * Used to determine if a session has valid user interaction.
 */
export function getFirstMeaningfulUserMessageTextContent<T extends Message>(
  transcript: T[],
): string | undefined {
  for (const msg of transcript) {
    if (msg.type !== 'user' || msg.isMeta) continue
    // Skip compact summary messages - they should not be treated as the first prompt
    if ('isCompactSummary' in msg && msg.isCompactSummary) continue

    const content = msg.message?.content
    if (!content) continue

    // Collect all text values. For array content (common in VS Code where
    // IDE metadata tags come before the user's actual prompt), iterate all
    // text blocks so we don't miss the real prompt hidden behind
    // <ide_selection>/<ide_opened_file> blocks.
    const texts: string[] = []
    if (typeof content === 'string') {
      texts.push(content)
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          texts.push(block.text)
        }
      }
    }

    for (const textContent of texts) {
      if (!textContent) continue

      const commandNameTag = extractTag(textContent, COMMAND_NAME_TAG)
      if (commandNameTag) {
        const commandName = commandNameTag.replace(/^\//, '')

        // If it's a built-in command, then it's unlikely to provide
        // meaningful context (e.g. `/model sonnet`)
        if (builtInCommandNames().has(commandName)) {
          continue
        } else {
          // Otherwise, for custom commands, then keep it only if it has
          // arguments (e.g. `/review reticulate splines`)
          const commandArgs = extractTag(textContent, 'command-args')?.trim()
          if (!commandArgs) {
            continue
          }
          // Return clean formatted command instead of raw XML
          return `${commandNameTag} ${commandArgs}`
        }
      }

      // Format bash input with ! prefix (as user typed it). Checked before
      // the generic XML skip so bash-mode sessions get a meaningful title.
      const bashInput = extractTag(textContent, 'bash-input')
      if (bashInput) {
        return `! ${bashInput}`
      }

      // Skip non-meaningful messages (local command output, hook output,
      // autonomous tick prompts, task notifications, pure IDE metadata tags)
      if (SKIP_FIRST_PROMPT_PATTERN.test(textContent)) {
        continue
      }

      return textContent
    }
  }
  return undefined
}

export function removeExtraFields(
  transcript: TranscriptMessage[],
): SerializedMessage[] {
  return transcript.map(m => {
    const { isSidechain, parentUuid, ...serializedMessage } = m
    return serializedMessage
  })
}

/**
 * Splice the preserved segment back into the chain after compaction.
 *
 * Preserved messages exist in the JSONL with their ORIGINAL pre-compact
 * parentUuids (recordTranscript dedup-skipped them — can't rewrite).
 * The internal chain (keep[i+1]→keep[i]) is intact; only endpoints need
 * patching: head→anchor, and anchor's other children→tail. Anchor is the
 * last summary for suffix-preserving, boundary itself for prefix-preserving.
 *
 * Only the LAST seg-boundary is relinked — earlier segs were summarized
 * into it. Everything physically before the absolute-last boundary (except
 * preservedUuids) is deleted, which handles all multi-boundary shapes
 * without special-casing.
 *
 * Mutates the Map in place.
 */
type ResolvedPreservedSegment = {
  headUuid: UUID
  anchorUuid: UUID
  tailUuid: UUID
  /** Present only on boundaries written with explicit preserved membership. */
  durableUuids?: readonly UUID[]
}

/**
 * Explicit `preservedMessages` wins over the legacy `preservedSegment`, which
 * boundaries written before that field carry alone. Endpoints come from the
 * durable list so a non-persisted head cannot name a UUID that never reached
 * the transcript.
 */
function resolvePreservedSegment(
  entry: SystemCompactBoundaryMessage,
): ResolvedPreservedSegment | undefined {
  const explicit = entry.compactMetadata?.preservedMessages
  if (explicit && explicit.durableUuids.length > 0) {
    const durableUuids = explicit.durableUuids as readonly UUID[]
    return {
      headUuid: durableUuids[0]!,
      anchorUuid: explicit.anchorUuid as UUID,
      tailUuid: durableUuids.at(-1)!,
      durableUuids,
    }
  }
  return entry.compactMetadata?.preservedSegment as
    | ResolvedPreservedSegment
    | undefined
}

function applyPreservedSegmentRelinks(
  messages: Map<UUID, TranscriptMessage>,
): void {
  // Find the absolute-last boundary and the last seg-boundary (can differ:
  // manual /compact after reactive compact → seg is stale).
  let lastSeg: ResolvedPreservedSegment | undefined
  let lastSegBoundaryIdx = -1
  let absoluteLastBoundaryIdx = -1
  const entryIndex = new Map<UUID, number>()
  let i = 0
  for (const entry of messages.values()) {
    entryIndex.set(entry.uuid, i)
    if (isCompactBoundaryMessage(entry)) {
      absoluteLastBoundaryIdx = i
      const seg = resolvePreservedSegment(entry)
      if (seg) {
        lastSeg = seg
        lastSegBoundaryIdx = i
      }
    }
    i++
  }
  // No seg anywhere → no-op. findUnresolvedToolUse etc. read the full map.
  if (!lastSeg) return

  // Seg stale (no-seg boundary came after): skip relink, still prune at
  // absolute — otherwise the stale preserved chain becomes a phantom leaf.
  const segIsLive = lastSegBoundaryIdx === absoluteLastBoundaryIdx

  // Validate tail→head BEFORE mutating so malformed metadata is a true
  // no-op (walk stops at headUuid, doesn't need the relink to run first).
  const preservedUuids = new Set<UUID>()
  if (segIsLive) {
    const walkSeen = new Set<UUID>()
    let cur = messages.get(lastSeg.tailUuid)
    let reachedHead = false
    while (cur && !walkSeen.has(cur.uuid)) {
      walkSeen.add(cur.uuid)
      preservedUuids.add(cur.uuid)
      if (cur.uuid === lastSeg.headUuid) {
        reachedHead = true
        break
      }
      cur = cur.parentUuid ? messages.get(cur.parentUuid) : undefined
    }
    if (!reachedHead) {
      // tail→head walk broke — a UUID in the preserved segment isn't in the
      // transcript. Returning here skips the prune below, so resume loads
      // the full pre-compact history. Known cause: mid-turn-yielded
      // attachment pushed to mutableMessages but never recordTranscript'd
      // (SDK subprocess restarted before next turn's qe:420 flush).
      logEvent('tengu_relink_walk_broken', {
        tailInTranscript: messages.has(lastSeg.tailUuid),
        headInTranscript: messages.has(lastSeg.headUuid),
        anchorInTranscript: messages.has(lastSeg.anchorUuid),
        walkSteps: walkSeen.size,
        transcriptSize: messages.size,
        // Explicit membership names exactly what went missing; the walk alone
        // can only report where it stopped.
        durableCount: lastSeg.durableUuids?.length ?? -1,
        durableMissing:
          lastSeg.durableUuids?.filter(uuid => !messages.has(uuid)).length ?? -1,
      })
      return
    }

    // Preserved sets need not be one parent chain. Anything the compactor
    // named and that survived to disk is preserved, even off the walk.
    for (const uuid of lastSeg.durableUuids ?? []) {
      if (messages.has(uuid)) preservedUuids.add(uuid)
    }
  }

  if (segIsLive) {
    const head = messages.get(lastSeg.headUuid)
    if (head) {
      messages.set(lastSeg.headUuid, {
        ...head,
        parentUuid: lastSeg.anchorUuid,
      })
    }
    // Tail-splice: anchor's other children → tail. No-op if already pointing
    // at tail (the useLogMessages race case).
    for (const [uuid, msg] of messages) {
      if (msg.parentUuid === lastSeg.anchorUuid && uuid !== lastSeg.headUuid) {
        messages.set(uuid, { ...msg, parentUuid: lastSeg.tailUuid })
      }
    }
    // Zero stale usage: on-disk input_tokens reflect pre-compact context
    // (~190K) — stripStaleUsage only patched in-memory copies that were
    // dedup-skipped. Without this, resume → immediate autocompact spiral.
    for (const uuid of preservedUuids) {
      const msg = messages.get(uuid)
      if (msg?.type !== 'assistant') continue
      messages.set(uuid, {
        ...msg,
        message: {
          ...msg.message,
          usage: {
            ...msg.message.usage,
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      })
    }
  }

  // Prune everything physically before the absolute-last boundary that
  // isn't preserved. preservedUuids empty when !segIsLive → full prune.
  const toDelete: UUID[] = []
  for (const [uuid] of messages) {
    const idx = entryIndex.get(uuid)
    if (
      idx !== undefined &&
      idx < absoluteLastBoundaryIdx &&
      !preservedUuids.has(uuid)
    ) {
      toDelete.push(uuid)
    }
  }
  for (const uuid of toDelete) messages.delete(uuid)
}

/**
 * Rebuild preserved-segment topology for archival display without pruning the
 * pre-compact prefix. Preserved messages keep their old parents on disk, so a
 * raw walk bypasses the compact boundary. Move the segment to its post-compact
 * anchor and retarget the boundary's logical parent to the segment's former
 * predecessor; this keeps every archival UUID exactly once around the seam.
 */
function applyDisplayPreservedSegmentRelinks(
  messages: Map<UUID, TranscriptMessage>,
): void {
  for (const candidate of messages.values()) {
    if (!isCompactBoundaryMessage(candidate)) continue
    const segment = candidate.compactMetadata?.preservedSegment
    if (!segment) continue

    const head = messages.get(segment.headUuid)
    if (!head || !messages.has(segment.anchorUuid)) continue

    const preservedUuids = new Set<UUID>()
    let current = messages.get(segment.tailUuid)
    let reachedHead = false
    while (current && !preservedUuids.has(current.uuid)) {
      preservedUuids.add(current.uuid)
      if (current.uuid === segment.headUuid) {
        reachedHead = true
        break
      }
      current = current.parentUuid
        ? messages.get(current.parentUuid)
        : undefined
    }
    if (!reachedHead) continue

    const archivalReverse: TranscriptMessage[] = []
    const archivalSeen = new Set<UUID>()
    let archivalCurrent = candidate.logicalParentUuid
      ? messages.get(candidate.logicalParentUuid)
      : undefined
    while (archivalCurrent && !archivalSeen.has(archivalCurrent.uuid)) {
      archivalSeen.add(archivalCurrent.uuid)
      archivalReverse.push(archivalCurrent)
      const parentUuid =
        archivalCurrent.parentUuid ??
        (isCompactBoundaryMessage(archivalCurrent)
          ? archivalCurrent.logicalParentUuid
          : undefined)
      archivalCurrent = parentUuid ? messages.get(parentUuid) : undefined
    }
    if (
      [...preservedUuids].some(uuid => !archivalSeen.has(uuid))
    ) {
      continue
    }

    const archivalChain = archivalReverse.reverse()
    const firstArchival = archivalChain[0]
    let previousUuid: UUID | null = firstArchival
      ? (firstArchival.parentUuid ??
          (isCompactBoundaryMessage(firstArchival)
            ? firstArchival.logicalParentUuid
            : null)) ?? null
      : null
    for (const message of archivalChain) {
      if (preservedUuids.has(message.uuid)) continue
      if (isCompactBoundaryMessage(message)) {
        messages.set(message.uuid, {
          ...message,
          parentUuid: null,
          logicalParentUuid: previousUuid,
        })
      } else {
        messages.set(message.uuid, {
          ...message,
          parentUuid: previousUuid,
        })
      }
      previousUuid = message.uuid
    }
    messages.set(candidate.uuid, {
      ...candidate,
      logicalParentUuid: previousUuid,
    })
    messages.set(head.uuid, {
      ...head,
      parentUuid: segment.anchorUuid,
    })
    for (const [uuid, message] of messages) {
      if (
        uuid !== head.uuid &&
        message.parentUuid === segment.anchorUuid
      ) {
        messages.set(uuid, { ...message, parentUuid: segment.tailUuid })
      }
    }
  }
}

/**
 * Delete messages that Snip executions removed from the in-memory array,
 * and relink parentUuid across the gaps.
 *
 * Unlike compact_boundary which truncates a prefix, snip removes
 * middle ranges. The JSONL is append-only, so removed messages stay on disk
 * and the surviving messages' parentUuid chains walk through them. Without
 * this filter, buildConversationChain reconstructs the full unsnipped history
 * and resume immediately PTLs (adamr-20260320-165831: 397K displayed → 1.65M
 * actual).
 *
 * Deleting alone is not enough: the surviving message AFTER a removed range
 * has parentUuid pointing INTO the gap. buildConversationChain would hit
 * messages.get(undefined) and stop, orphaning everything before the gap. So
 * after delete we relink: for each survivor with a dangling parentUuid, walk
 * backward through the removed region's own parent links to the first
 * non-removed ancestor.
 *
 * The boundary records removedUuids at execution time so we can replay the
 * exact removal on load. Older boundaries without removedUuids are skipped —
 * resume loads their pre-snip history (the pre-fix behavior).
 *
 * Mutates the Map in place.
 */
function applySnipRemovals(messages: Map<UUID, TranscriptMessage>): void {
  // Structural check — snipMetadata only exists on the boundary subtype.
  // Avoids the subtype literal which is in excluded-strings.txt
  // (HISTORY_SNIP is ant-only; the literal must not leak into external builds).
  type WithSnipMeta = { snipMetadata?: { removedUuids?: UUID[] } }
  const toDelete = new Set<UUID>()
  for (const entry of messages.values()) {
    const removedUuids = (entry as WithSnipMeta).snipMetadata?.removedUuids
    if (!removedUuids) continue
    for (const uuid of removedUuids) toDelete.add(uuid)
  }
  if (toDelete.size === 0) return

  // Capture each to-delete entry's own parentUuid BEFORE deleting so we can
  // walk backward through contiguous removed ranges. Entries not in the Map
  // (already absent, e.g. from a prior compact_boundary prune) contribute no
  // link; the relink walk will stop at the gap and pick up null (chain-root
  // behavior — same as if compact truncated there, which it did).
  const deletedParent = new Map<UUID, UUID | null>()
  let removedCount = 0
  for (const uuid of toDelete) {
    const entry = messages.get(uuid)
    if (!entry) continue
    deletedParent.set(uuid, entry.parentUuid)
    messages.delete(uuid)
    removedCount++
  }

  // Relink survivors with dangling parentUuid. Walk backward through
  // deletedParent until we hit a UUID not in toDelete (or null). Path
  // compression: after resolving, seed the map with the resolved link so
  // subsequent survivors sharing the same chain segment don't re-walk.
  const resolve = (start: UUID): UUID | null => {
    const path: UUID[] = []
    let cur: UUID | null | undefined = start
    while (cur && toDelete.has(cur)) {
      path.push(cur)
      cur = deletedParent.get(cur)
      if (cur === undefined) {
        cur = null
        break
      }
    }
    for (const p of path) deletedParent.set(p, cur)
    return cur
  }
  let relinkedCount = 0
  for (const [uuid, msg] of messages) {
    if (!msg.parentUuid || !toDelete.has(msg.parentUuid)) continue
    messages.set(uuid, { ...msg, parentUuid: resolve(msg.parentUuid) })
    relinkedCount++
  }

  logEvent('tengu_snip_resume_filtered', {
    removed_count: removedCount,
    relinked_count: relinkedCount,
  })
}

/**
 * O(n) single-pass: find the message with the latest timestamp matching a predicate.
 * Replaces the `[...values].filter(pred).sort((a,b) => Date(b)-Date(a))[0]` pattern
 * which is O(n log n) + 2n Date allocations.
 */
function findLatestMessage<T extends { timestamp: string }>(
  messages: Iterable<T>,
  predicate: (m: T) => boolean,
): T | undefined {
  let latest: T | undefined
  let maxTime = -Infinity
  for (const m of messages) {
    if (!predicate(m)) continue
    const t = Date.parse(m.timestamp)
    if (t > maxTime) {
      maxTime = t
      latest = m
    }
  }
  return latest
}

/**
 * Builds a conversation chain from a leaf message to root
 * @param messages Map of all messages
 * @param leafMessage The leaf message to start from
 * @returns Array of messages from root to leaf
 */
export function buildConversationChain(
  messages: Map<UUID, TranscriptMessage>,
  leafMessage: TranscriptMessage,
  options?: { followCompactLogicalParents?: boolean },
): TranscriptMessage[] {
  const transcript: TranscriptMessage[] = []
  const seen = new Set<UUID>()
  let currentMsg: TranscriptMessage | undefined = leafMessage
  while (currentMsg) {
    if (seen.has(currentMsg.uuid)) {
      logError(
        new Error(
          `Cycle detected in parentUuid chain at message ${currentMsg.uuid}. Returning partial transcript.`,
        ),
      )
      logEvent('tengu_chain_parent_cycle', {})
      break
    }
    seen.add(currentMsg.uuid)
    transcript.push(currentMsg)
    const parentUuid =
      currentMsg.parentUuid ??
      (options?.followCompactLogicalParents &&
      isCompactBoundaryMessage(currentMsg)
        ? currentMsg.logicalParentUuid
        : undefined)
    currentMsg = parentUuid ? messages.get(parentUuid) : undefined
  }
  transcript.reverse()
  return recoverOrphanedParallelToolResults(messages, transcript, seen)
}

export type ActiveConversationSelection = {
  messages: TranscriptMessage[]
  tip: TranscriptMessage | null
  sessionId: UUID | undefined
}

export function selectActiveConversation(
  messages: Map<UUID, TranscriptMessage>,
  leafUuids: Set<UUID>,
  activeConversationTip?: ActiveConversationTipEntry,
): ActiveConversationSelection {
  if (activeConversationTip) {
    if (activeConversationTip.tipUuid === null) {
      return {
        messages: [],
        tip: null,
        sessionId: activeConversationTip.sessionId,
      }
    }
    const tip = messages.get(activeConversationTip.tipUuid)
    if (
      tip &&
      !tip.isSidechain &&
      (tip.type === 'user' || tip.type === 'assistant') &&
      tip.sessionId === activeConversationTip.sessionId
    ) {
      return {
        messages: buildConversationChain(messages, tip),
        tip,
        sessionId: activeConversationTip.sessionId,
      }
    }
  }

  const tip = findLatestMessage(
    messages.values(),
    message =>
      !message.isSidechain &&
      leafUuids.has(message.uuid) &&
      (message.type === 'user' || message.type === 'assistant'),
  )
  if (!tip) return { messages: [], tip: null, sessionId: undefined }
  return {
    messages: buildConversationChain(messages, tip),
    tip,
    sessionId: tip.sessionId as UUID | undefined,
  }
}

/** Display-only chain walk that preserves archival history across compaction. */
export function buildDisplayConversationChain(
  messages: Map<UUID, TranscriptMessage>,
  leafMessage: TranscriptMessage,
): TranscriptMessage[] {
  return buildConversationChain(messages, leafMessage, {
    followCompactLogicalParents: true,
  })
}

/**
 * Post-pass for buildConversationChain: recover sibling assistant blocks and
 * tool_results that the single-parent walk orphaned.
 *
 * Streaming (claude.ts:~2024) emits one AssistantMessage per content_block_stop
 * — N parallel tool_uses → N messages, distinct uuid, same message.id. Each
 * tool_result's sourceToolAssistantUUID points to its own one-block assistant,
 * so insertMessageChain's override (line ~894) writes each TR's parentUuid to a
 * DIFFERENT assistant. The topology is a DAG; the walk above is a linked-list
 * traversal and keeps only one branch.
 *
 * Two loss modes observed in production (both fixed here):
 *   1. Sibling assistant orphaned: walk goes prev→asstA→TR_A→next, drops asstB
 *      (same message.id, chained off asstA) and TR_B.
 *   2. Progress-fork (legacy, pre-#23537): each tool_use asst had a progress
 *      child (continued the write chain) AND a TR child. Walk followed
 *      progress; TRs were dropped. No longer written (progress removed from
 *      transcript persistence), but old transcripts still have this shape.
 *
 * Read-side fix: the write topology is already on disk for old transcripts;
 * this recovery pass handles them.
 */
function recoverOrphanedParallelToolResults(
  messages: Map<UUID, TranscriptMessage>,
  chain: TranscriptMessage[],
  seen: Set<UUID>,
): TranscriptMessage[] {
  type ChainAssistant = Extract<TranscriptMessage, { type: 'assistant' }>
  const chainAssistants = chain.filter(
    (m): m is ChainAssistant => m.type === 'assistant',
  )
  if (chainAssistants.length === 0) return chain

  // Anchor = last on-chain member of each sibling group. chainAssistants is
  // already in chain order, so later iterations overwrite → last wins.
  const anchorByMsgId = new Map<string, ChainAssistant>()
  for (const a of chainAssistants) {
    if (a.message.id) anchorByMsgId.set(a.message.id, a)
  }

  // O(n) precompute: sibling groups and TR index.
  // TRs indexed by parentUuid — insertMessageChain:~894 already wrote that
  // as the srcUUID, and --fork-session strips srcUUID but keeps parentUuid.
  const siblingsByMsgId = new Map<string, TranscriptMessage[]>()
  const toolResultsByAsst = new Map<UUID, TranscriptMessage[]>()
  for (const m of messages.values()) {
    if (m.type === 'assistant' && m.message.id) {
      const group = siblingsByMsgId.get(m.message.id)
      if (group) group.push(m)
      else siblingsByMsgId.set(m.message.id, [m])
    } else if (
      m.type === 'user' &&
      m.parentUuid &&
      Array.isArray(m.message.content) &&
      m.message.content.some(b => b.type === 'tool_result')
    ) {
      const group = toolResultsByAsst.get(m.parentUuid)
      if (group) group.push(m)
      else toolResultsByAsst.set(m.parentUuid, [m])
    }
  }

  // For each message.id group touching the chain: collect off-chain siblings,
  // then off-chain TRs for ALL members. Splice right after the last on-chain
  // member so the group stays contiguous for normalizeMessagesForAPI's merge
  // and every TR lands after its tool_use.
  const processedGroups = new Set<string>()
  const inserts = new Map<UUID, TranscriptMessage[]>()
  let recoveredCount = 0
  for (const asst of chainAssistants) {
    const msgId = asst.message.id
    if (!msgId || processedGroups.has(msgId)) continue
    processedGroups.add(msgId)

    const group = siblingsByMsgId.get(msgId) ?? [asst]
    const orphanedSiblings = group.filter(s => !seen.has(s.uuid))
    const orphanedTRs: TranscriptMessage[] = []
    for (const member of group) {
      const trs = toolResultsByAsst.get(member.uuid)
      if (!trs) continue
      for (const tr of trs) {
        if (!seen.has(tr.uuid)) orphanedTRs.push(tr)
      }
    }
    if (orphanedSiblings.length === 0 && orphanedTRs.length === 0) continue

    // Timestamp sort keeps content-block / completion order; stable-sort
    // preserves JSONL write order on ties.
    orphanedSiblings.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    orphanedTRs.sort((a, b) => a.timestamp.localeCompare(b.timestamp))

    const anchor = anchorByMsgId.get(msgId)!
    const recovered = [...orphanedSiblings, ...orphanedTRs]
    for (const r of recovered) seen.add(r.uuid)
    recoveredCount += recovered.length
    inserts.set(anchor.uuid, recovered)
  }

  if (recoveredCount === 0) return chain
  logEvent('tengu_chain_parallel_tr_recovered', {
    recovered_count: recoveredCount,
  })

  const result: TranscriptMessage[] = []
  for (const m of chain) {
    result.push(m)
    const toInsert = inserts.get(m.uuid)
    if (toInsert) result.push(...toInsert)
  }
  return result
}

/**
 * Find the latest turn_duration checkpoint in the reconstructed chain and
 * compare its recorded messageCount against the chain's position at that
 * point. Emits tengu_resume_consistency_delta for BigQuery monitoring of
 * write→load round-trip drift — the class of bugs where snip/compact/
 * parallel-TR operations mutate in-memory but the parentUuid walk on disk
 * reconstructs a different set (adamr-20260320-165831: 397K displayed →
 * 1.65M actual on resume).
 *
 * delta > 0: resume loaded MORE than in-session (the usual failure mode)
 * delta < 0: resume loaded FEWER (chain truncation — #22453 class)
 * delta = 0: round-trip consistent
 *
 * Called from loadConversationForResume — fires once per resume, not on
 * /share or log-listing chain rebuilds.
 */
export function checkResumeConsistency(chain: Message[]): void {
  for (let i = chain.length - 1; i >= 0; i--) {
    const m = chain[i]!
    if (m.type !== 'system' || m.subtype !== 'turn_duration') continue
    const expected = m.messageCount
    if (expected === undefined) return
    // `i` is the 0-based index of the checkpoint in the reconstructed chain.
    // The checkpoint was appended AFTER messageCount messages, so its own
    // position should be messageCount (i.e., i === expected).
    const actual = i
    logEvent('tengu_resume_consistency_delta', {
      expected,
      actual,
      delta: actual - expected,
      chain_length: chain.length,
      checkpoint_age_entries: chain.length - 1 - i,
    })
    return
  }
}

/**
 * Builds a filie history snapshot chain from the conversation
 */
function buildFileHistorySnapshotChain(
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotMessage>,
  conversation: TranscriptMessage[],
): FileHistorySnapshot[] {
  const snapshots: FileHistorySnapshot[] = []
  // messageId → last index in snapshots[] for O(1) update lookup
  const indexByMessageId = new Map<string, number>()
  for (const message of conversation) {
    const snapshotMessage = fileHistorySnapshots.get(message.uuid)
    if (!snapshotMessage) {
      continue
    }
    const { snapshot, isSnapshotUpdate } = snapshotMessage
    const existingIndex = isSnapshotUpdate
      ? indexByMessageId.get(snapshot.messageId)
      : undefined
    if (existingIndex === undefined) {
      indexByMessageId.set(snapshot.messageId, snapshots.length)
      snapshots.push(snapshot)
    } else {
      snapshots[existingIndex] = snapshot
    }
  }
  return snapshots
}

/**
 * Builds an attribution snapshot chain from the conversation.
 * Unlike file history snapshots, attribution snapshots are returned in full
 * because they use generated UUIDs (not message UUIDs) and represent
 * cumulative state that should be restored on session resume.
 */
function buildAttributionSnapshotChain(
  attributionSnapshots: Map<UUID, AttributionSnapshotMessage>,
  _conversation: TranscriptMessage[],
): AttributionSnapshotMessage[] {
  // Return all attribution snapshots - they will be merged during restore
  return Array.from(attributionSnapshots.values())
}

/**
 * Loads a transcript from a JSON or JSONL file and converts it to LogOption format
 * @param filePath Path to the transcript file (.json or .jsonl)
 * @returns LogOption containing the transcript messages
 * @throws Error if file doesn't exist or contains invalid data
 */
export async function loadTranscriptFromFile(
  filePath: string,
): Promise<LogOption> {
  if (filePath.endsWith('.jsonl')) {
    const {
      messages,
      summaries,
      customTitles,
      tags,
      fileHistorySnapshots,
      attributionSnapshots,
      contextCollapseCommits,
      contextCollapseSnapshot,
      leafUuids,
      contentReplacements,
      threadGoals,
      worktreeStates,
      activeConversationTip,
    } = await loadTranscriptFile(filePath)

    if (messages.size === 0) {
      throw new Error('No messages found in JSONL file')
    }

    const activeConversation = selectActiveConversation(
      messages,
      leafUuids,
      activeConversationTip,
    )
    const leafMessage = activeConversation.tip

    if (!leafMessage) {
      throw new Error('No valid conversation chain found in JSONL file')
    }

    const transcript = activeConversation.messages

    const summary = summaries.get(leafMessage.uuid)
    const customTitle = customTitles.get(leafMessage.sessionId as UUID)
    const tag = tags.get(leafMessage.sessionId as UUID)
    const sessionId = leafMessage.sessionId as UUID
    return {
      ...convertToLogOption(
        transcript,
        0,
        summary,
        customTitle,
        buildFileHistorySnapshotChain(fileHistorySnapshots, transcript),
        tag,
        filePath,
        buildAttributionSnapshotChain(attributionSnapshots, transcript),
        undefined,
        contentReplacements.get(sessionId) ?? [],
      ),
      contextCollapseCommits: contextCollapseCommits.filter(
        e => e.sessionId === sessionId,
      ),
      contextCollapseSnapshot:
        contextCollapseSnapshot?.sessionId === sessionId
          ? contextCollapseSnapshot
          : undefined,
      threadGoal: threadGoals.has(sessionId)
        ? (threadGoals.get(sessionId) ?? null)
        : undefined,
      worktreeSession: worktreeStates.has(sessionId)
        ? worktreeStates.get(sessionId)
        : undefined,
    }
  }

  // json log files
  const content = await readFile(filePath, { encoding: 'utf-8' })
  let parsed: unknown

  try {
    parsed = jsonParse(content)
  } catch (error) {
    throw new Error(`Invalid JSON in transcript file: ${error}`)
  }

  let messages: TranscriptMessage[]

  if (Array.isArray(parsed)) {
    messages = parsed
  } else if (parsed && typeof parsed === 'object' && 'messages' in parsed) {
    if (!Array.isArray(parsed.messages)) {
      throw new Error('Transcript messages must be an array')
    }
    messages = parsed.messages
  } else {
    throw new Error(
      'Transcript must be an array of messages or an object with a messages array',
    )
  }

  return convertToLogOption(
    messages,
    0,
    undefined,
    undefined,
    undefined,
    undefined,
    filePath,
  )
}

/**
 * Checks if a user message has visible content (text or image, not just tool_result).
 * Tool results are displayed as part of collapsed groups, not as standalone messages.
 * Also excludes meta messages which are not shown to the user.
 */
function hasVisibleUserContent(message: TranscriptMessage): boolean {
  if (message.type !== 'user') return false

  // Meta messages are not shown to the user
  if (message.isMeta) return false

  const content = message.message?.content
  if (!content) return false

  // String content is always visible
  if (typeof content === 'string') {
    return content.trim().length > 0
  }

  // Array content: check for text or image blocks (not tool_result)
  if (Array.isArray(content)) {
    return content.some(
      block =>
        block.type === 'text' ||
        block.type === 'image' ||
        block.type === 'document',
    )
  }

  return false
}

/**
 * Checks if an assistant message has visible text content (not just tool_use blocks).
 * Tool uses are displayed as grouped/collapsed UI elements, not as standalone messages.
 */
function hasVisibleAssistantContent(message: TranscriptMessage): boolean {
  if (message.type !== 'assistant') return false

  const content = message.message?.content
  if (!content || !Array.isArray(content)) return false

  // Check for text block (not just tool_use/thinking blocks)
  return content.some(
    block =>
      block.type === 'text' &&
      typeof block.text === 'string' &&
      block.text.trim().length > 0,
  )
}

/**
 * Counts visible messages that would appear as conversation turns in the UI.
 * Excludes:
 * - System, attachment, and progress messages
 * - User messages with isMeta flag (hidden from user)
 * - User messages that only contain tool_result blocks (displayed as collapsed groups)
 * - Assistant messages that only contain tool_use blocks (displayed as collapsed groups)
 */
function countVisibleMessages(transcript: TranscriptMessage[]): number {
  let count = 0
  for (const message of transcript) {
    switch (message.type) {
      case 'user':
        // Count user messages with visible content (text, image, not just tool_result or meta)
        if (hasVisibleUserContent(message)) {
          count++
        }
        break
      case 'assistant':
        // Count assistant messages with text content (not just tool_use)
        if (hasVisibleAssistantContent(message)) {
          count++
        }
        break
      case 'attachment':
      case 'system':
      case 'progress':
        // These message types are not counted as visible conversation turns
        break
    }
  }
  return count
}

function convertToLogOption(
  transcript: TranscriptMessage[],
  value: number = 0,
  summary?: string,
  customTitle?: string,
  fileHistorySnapshots?: FileHistorySnapshot[],
  tag?: string,
  fullPath?: string,
  attributionSnapshots?: AttributionSnapshotMessage[],
  agentSetting?: string,
  contentReplacements?: ContentReplacementRecord[],
  threadGoal?: ThreadGoal | null,
): LogOption {
  const lastMessage = transcript.at(-1)!
  const firstMessage = transcript[0]!

  // Get the first user message for the prompt
  const firstPrompt = extractFirstPrompt(transcript)

  // Create timestamps from message timestamps
  const created = new Date(firstMessage.timestamp)
  const modified = new Date(lastMessage.timestamp)

  return {
    date: lastMessage.timestamp,
    messages: removeExtraFields(transcript),
    fullPath,
    value,
    created,
    modified,
    firstPrompt,
    messageCount: countVisibleMessages(transcript),
    forked: transcript.some(message => message.forkedFrom !== undefined),
    isSidechain: firstMessage.isSidechain,
    teamName: firstMessage.teamName,
    agentName: firstMessage.agentName,
    agentSetting,
    leafUuid: lastMessage.uuid,
    summary,
    customTitle,
    tag,
    threadGoal,
    fileHistorySnapshots: fileHistorySnapshots,
    attributionSnapshots: attributionSnapshots,
    contentReplacements,
    gitBranch: lastMessage.gitBranch,
    projectPath: firstMessage.cwd,
  }
}

async function trackSessionBranchingAnalytics(
  logs: LogOption[],
): Promise<void> {
  const sessionIdCounts = new Map<string, number>()
  let maxCount = 0
  for (const log of logs) {
    const sessionId = getSessionIdFromLog(log)
    if (sessionId) {
      const newCount = (sessionIdCounts.get(sessionId) || 0) + 1
      sessionIdCounts.set(sessionId, newCount)
      maxCount = Math.max(newCount, maxCount)
    }
  }

  // Early exit if no duplicates detected
  if (maxCount <= 1) {
    return
  }

  // Count sessions with branches and calculate stats using functional approach
  const branchCounts = Array.from(sessionIdCounts.values()).filter(c => c > 1)
  const sessionsWithBranches = branchCounts.length
  const totalBranches = branchCounts.reduce((sum, count) => sum + count, 0)

  logEvent('tengu_session_forked_branches_fetched', {
    total_sessions: sessionIdCounts.size,
    sessions_with_branches: sessionsWithBranches,
    max_branches_per_session: Math.max(...branchCounts),
    avg_branches_per_session: Math.round(totalBranches / sessionsWithBranches),
    total_transcript_count: logs.length,
  })
}

export async function fetchLogs(limit?: number): Promise<LogOption[]> {
  const projectDir = getProjectDir(getOriginalCwd())
  const logs = await getSessionFilesLite(projectDir, limit, getOriginalCwd())

  await trackSessionBranchingAnalytics(logs)

  return logs
}

/**
 * Append an entry to a session file. Creates the parent dir if missing.
 */
/* eslint-disable custom-rules/no-sync-fs -- sync callers (exit cleanup, materialize) */
function appendEntryToFile(
  fullPath: string,
  entry: Record<string, unknown>,
): void {
  assertActiveTranscriptLease(getSessionId())
  const fs = getFsImplementation()
  const line = jsonStringify(entry) + '\n'
  try {
    fs.appendFileSync(fullPath, line, { mode: 0o600 })
  } catch {
    fs.mkdirSync(dirname(fullPath), { mode: 0o700 })
    fs.appendFileSync(fullPath, line, { mode: 0o600 })
  }
}

/**
 * Sync tail read for reAppendSessionMetadata's external-writer check.
 * fstat on the already-open fd (no extra path lookup); reads the same
 * LITE_READ_BUF_SIZE window that readLiteMetadata scans. Returns empty
 * string on any error so callers fall through to unconditional behavior.
 */
export function readFileTailSync(fullPath: string): string {
  let fd: number | undefined
  try {
    fd = openSync(fullPath, 'r')
    const st = fstatSync(fd)
    const tailOffset = Math.max(0, st.size - LITE_READ_BUF_SIZE)
    const buf = Buffer.allocUnsafe(
      Math.min(LITE_READ_BUF_SIZE, st.size - tailOffset),
    )
    const bytesRead = readSync(fd, buf, 0, buf.length, tailOffset)
    return buf.toString('utf8', 0, bytesRead)
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // closeSync can throw; swallow to preserve return '' contract
      }
    }
  }
}
/* eslint-enable custom-rules/no-sync-fs */

export async function saveCustomTitle(
  sessionId: UUID,
  customTitle: string,
  fullPath?: string,
  source: 'user' | 'auto' = 'user',
) {
  // Fall back to computed path if fullPath is not provided
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, {
    type: 'custom-title',
    customTitle,
    sessionId,
  })
  // Cache for current session only (for immediate visibility)
  if (sessionId === getSessionId()) {
    getProject().currentSessionTitle = customTitle
  }
  logEvent('tengu_session_renamed', {
    source:
      source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

/**
 * Persist an AI-generated title to the JSONL as a distinct `ai-title` entry.
 *
 * Writing a separate entry type (vs. reusing `custom-title`) is load-bearing:
 * - Read preference: readers prefer `customTitle` field over `aiTitle`, so
 *   a user rename always wins regardless of append order.
 * - Resume safety: `loadTranscriptFile` only populates the `customTitles`
 *   Map from `custom-title` entries, so `restoreSessionMetadata` never
 *   caches an AI title and `reAppendSessionMetadata` never re-appends one
 *   at EOF — avoiding the clobber-on-resume bug where a stale AI title
 *   overwrites a mid-session user rename.
 * - CAS semantics: VS Code's `onlyIfNoCustomTitle` check scans for the
 *   `customTitle` field only, so AI can overwrite its own previous AI
 *   title but never a user title.
 * - Metrics: `tengu_session_renamed` is not fired for AI titles.
 *
 * Because the entry is never re-appended, it scrolls out of the 64KB tail
 * window once enough messages accumulate. Readers (`readLiteMetadata`,
 * `listSessionsImpl`, VS Code `fetchSessions`) fall back to scanning the
 * head buffer for `aiTitle` in that case. Both head and tail reads are
 * bounded (64KB each via `extractLastJsonStringField`), never a full scan.
 *
 * Callers with a stale-write guard (e.g., VS Code client) should prefer
 * passing `persist: false` to the SDK control request and persisting
 * through their own rename path after the guard passes, to avoid a race
 * where the AI title lands after a mid-flight user rename.
 */
export function saveAiGeneratedTitle(sessionId: UUID, aiTitle: string): void {
  appendEntryToFile(getTranscriptPathForSession(sessionId), {
    type: 'ai-title',
    aiTitle,
    sessionId,
  })
}

/**
 * Append a periodic task summary for `claude ps`. Unlike ai-title this is
 * not re-appended by reAppendSessionMetadata — it's a rolling snapshot of
 * what the agent is doing *now*, so staleness is fine; ps reads the most
 * recent one from the tail.
 */
export function saveTaskSummary(sessionId: UUID, summary: string): void {
  appendEntryToFile(getTranscriptPathForSession(sessionId), {
    type: 'task-summary',
    summary,
    sessionId,
    timestamp: new Date().toISOString(),
  })
}

export function saveThreadGoal(goal: ThreadGoal): void {
  if (goal.threadId === getSessionId()) {
    getProject().currentSessionThreadGoal = goal
  }
  appendEntryToFile(getTranscriptPathForSession(goal.threadId as UUID), {
    type: 'thread-goal-updated',
    sessionId: goal.threadId,
    goal,
    timestamp: new Date().toISOString(),
  })
}

export function clearThreadGoal(goalId?: string): void {
  const sessionId = getSessionId() as UUID
  getProject().currentSessionThreadGoal = null
  appendEntryToFile(getTranscriptPathForSession(sessionId), {
    type: 'thread-goal-cleared',
    sessionId,
    ...(goalId ? { goalId } : {}),
    timestamp: new Date().toISOString(),
  })
}

export function getCurrentThreadGoal(sessionId?: string): ThreadGoal | null {
  const resolvedSessionId = (sessionId ?? getSessionId()) as UUID | undefined
  if (!resolvedSessionId) {
    return null
  }

  try {
    const entries = parseJSONL<Entry>(
      readFileSync(getTranscriptPathForSession(resolvedSessionId)),
    )
    const threadGoals = new Map<UUID, ThreadGoal | null>()
    for (const entry of entries) {
      applyThreadGoalEntry(threadGoals, entry)
    }
    return threadGoals.get(resolvedSessionId) ?? null
  } catch {
    return null
  }
}

/**
 * Archive or un-archive a session. Archive HIDES a session from the default
 * catalog view; it never removes or rewrites the transcript, so it is fully
 * reversible and safe to apply to a session another process is reading.
 *
 * Written as an appended metadata entry, the same mechanism `saveTag` uses, so
 * it survives without a live engine for that session and the last entry wins.
 */
export async function setSessionArchived(
  sessionId: UUID,
  archived: boolean,
  fullPath?: string,
): Promise<void> {
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, { type: 'archived', archived, sessionId })
  if (sessionId === getSessionId()) {
    getProject().currentSessionArchived = archived || undefined
  }
}

export async function saveTag(sessionId: UUID, tag: string, fullPath?: string) {
  // Fall back to computed path if fullPath is not provided
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, { type: 'tag', tag, sessionId })
  // Cache for current session only (for immediate visibility)
  if (sessionId === getSessionId()) {
    getProject().currentSessionTag = tag
  }
  logEvent('tengu_session_tagged', {})
}

/**
 * Link a session to a GitHub pull request.
 * This stores the PR number, URL, and repository for tracking and navigation.
 */
export async function linkSessionToPR(
  sessionId: UUID,
  prNumber: number,
  prUrl: string,
  prRepository: string,
  fullPath?: string,
): Promise<void> {
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, {
    type: 'pr-link',
    sessionId,
    prNumber,
    prUrl,
    prRepository,
    timestamp: new Date().toISOString(),
  })
  // Cache for current session so reAppendSessionMetadata can re-write after compaction
  if (sessionId === getSessionId()) {
    const project = getProject()
    project.currentSessionPrNumber = prNumber
    project.currentSessionPrUrl = prUrl
    project.currentSessionPrRepository = prRepository
  }
  logEvent('tengu_session_linked_to_pr', { prNumber })
}

export function getCurrentSessionTag(sessionId: UUID): string | undefined {
  // Only returns tag for current session (the only one we cache)
  if (sessionId === getSessionId()) {
    return getProject().currentSessionTag
  }
  return undefined
}

export function getCurrentSessionTitle(
  sessionId: SessionId,
): string | undefined {
  // Only returns title for current session (the only one we cache)
  if (sessionId === getSessionId()) {
    return getProject().currentSessionTitle
  }
  return undefined
}

export function getCurrentSessionAgentColor(): string | undefined {
  return getProject().currentSessionAgentColor
}

/**
 * Restore session metadata into in-memory cache on resume.
 * Populates the cache so metadata is available for display (e.g. the
 * agent banner) and re-appended on session exit via reAppendSessionMetadata.
 */
export function restoreSessionMetadata(meta: {
  customTitle?: string
  tag?: string
  agentName?: string
  agentColor?: string
  agentSetting?: string
  mode?: LegacySessionMode
  threadGoal?: ThreadGoal | null
  worktreeSession?: PersistedWorktreeSession | null
  prNumber?: number
  prUrl?: string
  prRepository?: string
}): void {
  const project = getProject()
  // ??= so --name (cacheSessionTitle) wins over the resumed
  // session's title. REPL.tsx clears before calling, so /resume is unaffected.
  if (meta.customTitle) project.currentSessionTitle ??= meta.customTitle
  if (meta.tag !== undefined) project.currentSessionTag = meta.tag || undefined
  if (meta.agentName) project.currentSessionAgentName = meta.agentName
  if (meta.agentColor) project.currentSessionAgentColor = meta.agentColor
  if (meta.agentSetting) project.currentSessionAgentSetting = meta.agentSetting
  const mode = normalizeSessionMode(meta.mode)
  if (mode) project.currentSessionMode = mode
  if (meta.threadGoal !== undefined)
    project.currentSessionThreadGoal = meta.threadGoal
  if (meta.worktreeSession !== undefined)
    project.currentSessionWorktree = meta.worktreeSession
  if (meta.prNumber !== undefined)
    project.currentSessionPrNumber = meta.prNumber
  if (meta.prUrl) project.currentSessionPrUrl = meta.prUrl
  if (meta.prRepository) project.currentSessionPrRepository = meta.prRepository
}

/**
 * Clear all cached session metadata (title, tag, agent name/color).
 * Called when /clear creates a new session so stale metadata
 * from the previous session does not leak into the new one.
 */
export function clearSessionMetadata(): void {
  const project = getProject()
  project.currentSessionTitle = undefined
  project.currentSessionTag = undefined
  project.currentSessionAgentName = undefined
  project.currentSessionAgentColor = undefined
  project.currentSessionLastPrompt = undefined
  project.currentSessionAgentSetting = undefined
  project.currentSessionMode = undefined
  project.currentSessionThreadGoal = undefined
  project.currentSessionWorktree = undefined
  project.currentSessionPrNumber = undefined
  project.currentSessionPrUrl = undefined
  project.currentSessionPrRepository = undefined
}

/**
 * Re-append cached session metadata (custom title, tag) to the end of the
 * transcript file. Call this after compaction so the metadata stays within
 * the 16KB tail window that readLiteMetadata reads during progressive loading.
 * Without this, enough post-compaction messages can push the metadata entry
 * out of the window, causing `--resume` to show the auto-generated firstPrompt
 * instead of the user-set session name.
 */
export function reAppendSessionMetadata(): void {
  getProject().reAppendSessionMetadata()
}

export async function saveAgentName(
  sessionId: UUID,
  agentName: string,
  fullPath?: string,
  source: 'user' | 'auto' = 'user',
) {
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, { type: 'agent-name', agentName, sessionId })
  // Cache for current session only (for immediate visibility)
  if (sessionId === getSessionId()) {
    getProject().currentSessionAgentName = agentName
    void updateSessionName(agentName)
  }
  logEvent('tengu_agent_name_set', {
    source:
      source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

export async function saveAgentColor(
  sessionId: UUID,
  agentColor: string,
  fullPath?: string,
) {
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, {
    type: 'agent-color',
    agentColor,
    sessionId,
  })
  // Cache for current session only (for immediate visibility)
  if (sessionId === getSessionId()) {
    getProject().currentSessionAgentColor = agentColor
  }
  logEvent('tengu_agent_color_set', {})
}

/**
 * Cache the session agent setting. Written to disk by materializeSessionFile
 * on the first user message, and re-stamped by reAppendSessionMetadata on exit.
 * Cache-only here to avoid creating metadata-only session files at startup.
 */
export function saveAgentSetting(agentSetting: string): void {
  getProject().currentSessionAgentSetting = agentSetting
}

/**
 * Cache a session title set at startup (--name). Written to disk by
 * materializeSessionFile on the first user message. Cache-only here so no
 * orphan metadata-only file is created before the session ID is finalized.
 */
export function cacheSessionTitle(customTitle: string): void {
  getProject().currentSessionTitle = customTitle
}

/**
 * Cache the session mode. Written to disk by materializeSessionFile on the
 * first user message, and re-stamped by reAppendSessionMetadata on exit.
 * Cache-only here to avoid creating metadata-only session files at startup.
 */
export function saveMode(mode: SessionMode): void {
  getProject().currentSessionMode = mode
}

/**
 * Record the session's worktree state for --resume. Written to disk by
 * materializeSessionFile on the first user message and re-stamped by
 * reAppendSessionMetadata on exit. Pass null when exiting a worktree
 * so --resume knows not to cd back into it.
 */
export function saveWorktreeState(
  worktreeSession: PersistedWorktreeSession | null,
): void {
  // Strip ephemeral fields (creationDurationMs, usedSparsePaths) that callers
  // may pass via full WorktreeSession objects — TypeScript structural typing
  // allows this, but we don't want them serialized to the transcript.
  const stripped: PersistedWorktreeSession | null = worktreeSession
    ? {
        originalCwd: worktreeSession.originalCwd,
        worktreePath: worktreeSession.worktreePath,
        worktreeName: worktreeSession.worktreeName,
        worktreeBranch: worktreeSession.worktreeBranch,
        originalBranch: worktreeSession.originalBranch,
        originalHeadCommit: worktreeSession.originalHeadCommit,
        sessionId: worktreeSession.sessionId,
        tmuxSessionName: worktreeSession.tmuxSessionName,
        hookBased: worktreeSession.hookBased,
      }
    : null
  const project = getProject()
  project.currentSessionWorktree = stripped
  // Write eagerly when the file already exists (mid-session enter/exit).
  // For --worktree startup, sessionFile is null — materializeSessionFile
  // will write it on the first message via reAppendSessionMetadata.
  if (project.sessionFile) {
    appendEntryToFile(project.sessionFile, {
      type: 'worktree-state',
      worktreeSession: stripped,
      sessionId: getSessionId(),
    })
  }
}

/**
 * Extracts the session ID from a log.
 * For lite logs, uses the sessionId field directly.
 * For full logs, extracts from the first message.
 */
export function getSessionIdFromLog(log: LogOption): UUID | undefined {
  // For lite logs, use the direct sessionId field
  if (log.sessionId) {
    return log.sessionId as UUID
  }
  // Fall back to extracting from first message (full logs)
  return log.messages[0]?.sessionId as UUID | undefined
}

/**
 * Checks if a log is a lite log that needs full loading.
 * Lite logs have messages: [] and sessionId set.
 */
export function isLiteLog(log: LogOption): boolean {
  return log.messages.length === 0 && log.sessionId !== undefined
}

/**
 * Loads full messages for a lite log by reading its JSONL file.
 * Returns a new LogOption with populated messages array.
 * If the log is already full or loading fails, returns the original log.
 */
export async function loadFullLog(log: LogOption): Promise<LogOption> {
  // If already full, return as-is
  if (!isLiteLog(log)) {
    return log
  }

  // Use the fullPath from the index entry directly
  const sessionFile = log.fullPath
  if (!sessionFile) {
    return log
  }

  try {
    const {
      messages,
      summaries,
      customTitles,
      tags,
      agentNames,
      agentColors,
      agentSettings,
      prNumbers,
      prUrls,
      prRepositories,
      modes,
      worktreeStates,
      fileHistorySnapshots,
      attributionSnapshots,
      contentReplacements,
      contextCollapseCommits,
      contextCollapseSnapshot,
      leafUuids,
      activeConversationTip,
    } = await loadTranscriptFile(sessionFile)

    if (messages.size === 0) {
      return log
    }

    const activeConversation = selectActiveConversation(
      messages,
      leafUuids,
      activeConversationTip,
    )
    if (!activeConversation.sessionId) {
      return log
    }

    const transcript = activeConversation.messages
    const mostRecentLeaf = activeConversation.tip
    // Active tip's sessionId — forked sessions copy chain[0] from the source, but
    // metadata entries (custom-title etc.) are keyed by the current session.
    const sessionId = activeConversation.sessionId
    return {
      ...log,
      messages: removeExtraFields(transcript),
      firstPrompt:
        transcript.length > 0 ? extractFirstPrompt(transcript) : log.firstPrompt,
      messageCount: countVisibleMessages(transcript),
      summary: mostRecentLeaf ? summaries.get(mostRecentLeaf.uuid) : undefined,
      customTitle: sessionId ? customTitles.get(sessionId) : log.customTitle,
      tag: sessionId ? tags.get(sessionId) : log.tag,
      agentName: sessionId ? agentNames.get(sessionId) : log.agentName,
      agentColor: sessionId ? agentColors.get(sessionId) : log.agentColor,
      agentSetting: sessionId ? agentSettings.get(sessionId) : log.agentSetting,
      mode: sessionId ? modes.get(sessionId) : normalizeSessionMode(log.mode),
      worktreeSession:
        sessionId && worktreeStates.has(sessionId)
          ? worktreeStates.get(sessionId)
          : log.worktreeSession,
      prNumber: sessionId ? prNumbers.get(sessionId) : log.prNumber,
      prUrl: sessionId ? prUrls.get(sessionId) : log.prUrl,
      prRepository: sessionId
        ? prRepositories.get(sessionId)
        : log.prRepository,
      gitBranch: mostRecentLeaf?.gitBranch ?? log.gitBranch,
      isSidechain: transcript[0]?.isSidechain ?? log.isSidechain,
      teamName: transcript[0]?.teamName ?? log.teamName,
      leafUuid: mostRecentLeaf?.uuid,
      fileHistorySnapshots: buildFileHistorySnapshotChain(
        fileHistorySnapshots,
        transcript,
      ),
      attributionSnapshots: buildAttributionSnapshotChain(
        attributionSnapshots,
        transcript,
      ),
      contentReplacements: sessionId
        ? (contentReplacements.get(sessionId) ?? [])
        : log.contentReplacements,
      // Filter to the resumed session's entries. loadTranscriptFile reads
      // the file sequentially so the array is already in commit order;
      // filter preserves that.
      contextCollapseCommits: sessionId
        ? contextCollapseCommits.filter(e => e.sessionId === sessionId)
        : undefined,
      contextCollapseSnapshot:
        sessionId && contextCollapseSnapshot?.sessionId === sessionId
          ? contextCollapseSnapshot
          : undefined,
    }
  } catch {
    // If loading fails, return the original log
    return log
  }
}

/**
 * Searches for sessions by custom title match.
 * Returns matches sorted by recency (newest first).
 * Uses case-insensitive matching for better UX.
 * Deduplicates by sessionId (keeps most recent per session).
 * Searches across same-repo worktrees by default.
 */
export async function searchSessionsByCustomTitle(
  query: string,
  options?: { limit?: number; exact?: boolean },
): Promise<LogOption[]> {
  const { limit, exact } = options || {}
  // Use worktree-aware loading to search across same-repo sessions
  const worktreePaths = await getWorktreePaths(getOriginalCwd())
  const allStatLogs = await getStatOnlyLogsForWorktrees(worktreePaths)
  // Enrich all logs to access customTitle metadata
  const { logs } = await enrichLogs(allStatLogs, 0, allStatLogs.length)
  const normalizedQuery = query.toLowerCase().trim()

  const matchingLogs = logs.filter(log => {
    const title = log.customTitle?.toLowerCase().trim()
    if (!title) return false
    return exact ? title === normalizedQuery : title.includes(normalizedQuery)
  })

  // Deduplicate by sessionId - multiple logs can have the same sessionId
  // if they're different branches of the same conversation. Keep most recent.
  const sessionIdToLog = new Map<UUID, LogOption>()
  for (const log of matchingLogs) {
    const sessionId = getSessionIdFromLog(log)
    if (sessionId) {
      const existing = sessionIdToLog.get(sessionId)
      if (!existing || log.modified > existing.modified) {
        sessionIdToLog.set(sessionId, log)
      }
    }
  }
  const deduplicated = Array.from(sessionIdToLog.values())

  // Sort by recency
  deduplicated.sort((a, b) => b.modified.getTime() - a.modified.getTime())

  // Apply limit if specified
  if (limit) {
    return deduplicated.slice(0, limit)
  }

  return deduplicated
}

/**
 * Metadata entry types that can appear before a compact boundary but must
 * still be loaded (they're session-scoped, not message-scoped).
 * Kept as raw JSON string markers for cheap line filtering during streaming.
 */
const METADATA_TYPE_MARKERS = [
  '"type":"summary"',
  '"type":"custom-title"',
  '"type":"tag"',
  '"type":"archived"',
  '"type":"agent-name"',
  '"type":"agent-color"',
  '"type":"agent-setting"',
  '"type":"mode"',
  '"type":"thread-goal-updated"',
  '"type":"thread-goal-cleared"',
  '"type":"worktree-state"',
  '"type":"pr-link"',
]
const METADATA_MARKER_BUFS = METADATA_TYPE_MARKERS.map(m => Buffer.from(m))
// Longest marker is 22 bytes; +1 for leading `{` = 23.
const METADATA_PREFIX_BOUND = 25

// null = carry spans whole chunk. Skips concat when carry provably isn't
// a metadata line (markers sit at byte 1 after `{`).
function resolveMetadataBuf(
  carry: Buffer | null,
  chunkBuf: Buffer,
): Buffer | null {
  if (carry === null || carry.length === 0) return chunkBuf
  if (carry.length < METADATA_PREFIX_BOUND) {
    return Buffer.concat([carry, chunkBuf])
  }
  if (carry[0] === 0x7b /* { */) {
    for (const m of METADATA_MARKER_BUFS) {
      if (carry.compare(m, 0, m.length, 1, 1 + m.length) === 0) {
        return Buffer.concat([carry, chunkBuf])
      }
    }
  }
  const firstNl = chunkBuf.indexOf(0x0a)
  return firstNl === -1 ? null : chunkBuf.subarray(firstNl + 1)
}

/**
 * Lightweight forward scan of [0, endOffset) collecting only metadata-entry lines.
 * Uses raw Buffer chunks and byte-level marker matching — no readline, no per-line
 * string conversion for the ~99% of lines that are message content.
 *
 * Fast path: if a chunk contains zero markers (the common case — metadata entries
 * are <50 per session), the entire chunk is skipped without line splitting.
 */
async function scanPreBoundaryMetadata(
  filePath: string,
  endOffset: number,
): Promise<string[]> {
  const { createReadStream } = await import('fs')
  const NEWLINE = 0x0a

  const stream = createReadStream(filePath, { end: endOffset - 1 })
  const metadataLines: string[] = []
  let carry: Buffer | null = null

  for await (const chunk of stream) {
    const chunkBuf = chunk as Buffer
    const buf = resolveMetadataBuf(carry, chunkBuf)
    if (buf === null) {
      carry = null
      continue
    }

    // Fast path: most chunks contain zero metadata markers. Skip line splitting.
    let hasAnyMarker = false
    for (const m of METADATA_MARKER_BUFS) {
      if (buf.includes(m)) {
        hasAnyMarker = true
        break
      }
    }

    if (hasAnyMarker) {
      let lineStart = 0
      let nl = buf.indexOf(NEWLINE)
      while (nl !== -1) {
        // Bounded marker check: only look within this line's byte range
        for (const m of METADATA_MARKER_BUFS) {
          const mIdx = buf.indexOf(m, lineStart)
          if (mIdx !== -1 && mIdx < nl) {
            metadataLines.push(buf.toString('utf-8', lineStart, nl))
            break
          }
        }
        lineStart = nl + 1
        nl = buf.indexOf(NEWLINE, lineStart)
      }
      carry = buf.subarray(lineStart)
    } else {
      // No markers in this chunk — just preserve the incomplete trailing line
      const lastNl = buf.lastIndexOf(NEWLINE)
      carry = lastNl >= 0 ? buf.subarray(lastNl + 1) : buf
    }

    // Guard against quadratic carry growth for pathological huge lines
    // (e.g., a 10 MB tool-output line with no newline). Real metadata entries
    // are <1 KB, so if carry exceeds this we're mid-message-content — drop it.
    if (carry.length > 64 * 1024) carry = null
  }

  // Final incomplete line (no trailing newline at endOffset)
  if (carry !== null && carry.length > 0) {
    for (const m of METADATA_MARKER_BUFS) {
      if (carry.includes(m)) {
        metadataLines.push(carry.toString('utf-8'))
        break
      }
    }
  }

  return metadataLines
}

/**
 * Byte-level pre-filter that excises dead fork branches before parseJSONL.
 *
 * Every rewind/ctrl-z leaves an orphaned chain branch in the append-only
 * JSONL forever. buildConversationChain walks parentUuid from the latest leaf
 * and discards everything else, but by then parseJSONL has already paid to
 * JSON.parse all of it. Measured on fork-heavy sessions:
 *
 *   41 MB, 99% dead: parseJSONL 56.0 ms -> 3.9 ms (-93%)
 *   151 MB, 92% dead: 47.3 ms -> 9.4 ms (-80%)
 *
 * Sessions with few dead branches (5-7%) see a small win from the overhead of
 * the index pass roughly canceling the parse savings, so this is gated on
 * buffer size (same threshold as SKIP_PRECOMPACT_THRESHOLD).
 *
 * Relies on two invariants verified across 25k+ message lines in local
 * sessions (0 violations):
 *
 *   1. Transcript messages always serialize with parentUuid as the first key.
 *      JSON.stringify emits keys in insertion order and recordTranscript's
 *      object literal puts parentUuid first. So `{"parentUuid":` is a stable
 *      line prefix that distinguishes transcript messages from metadata.
 *
 *   2. Top-level uuid detection is handled by a suffix check + depth check
 *      (see inline comment in the scan loop). toolUseResult/mcpMeta serialize
 *      AFTER uuid with arbitrary server-controlled objects, and agent_progress
 *      entries serialize a nested Message in data BEFORE uuid — both can
 *      produce nested `"uuid":"<36>","timestamp":"` bytes, so suffix alone
 *      is insufficient. When multiple suffix matches exist, a brace-depth
 *      scan disambiguates.
 *
 * The append-only write discipline guarantees parents appear at earlier file
 * offsets than children, so walking backward from EOF always finds them.
 */

/**
 * Disambiguate multiple `"uuid":"<36>","timestamp":"` matches in one line by
 * finding the one at JSON nesting depth 1. String-aware brace counter:
 * `{`/`}` inside string values don't count; `\"` and `\\` inside strings are
 * handled. Candidates is sorted ascending (the scan loop produces them in
 * byte order). Returns the first depth-1 candidate, or the last candidate if
 * none are at depth 1 (shouldn't happen for well-formed JSONL — depth-1 is
 * where the top-level object's fields live).
 *
 * Only called when ≥2 suffix matches exist (agent_progress with a nested
 * Message, or mcpMeta with a coincidentally-suffixed object). Cost is
 * O(max(candidates) - lineStart) — one forward byte pass, stopping at the
 * first depth-1 hit.
 */
function pickDepthOneUuidCandidate(
  buf: Buffer,
  lineStart: number,
  candidates: number[],
): number {
  const QUOTE = 0x22
  const BACKSLASH = 0x5c
  const OPEN_BRACE = 0x7b
  const CLOSE_BRACE = 0x7d
  let depth = 0
  let inString = false
  let escapeNext = false
  let ci = 0
  for (let i = lineStart; ci < candidates.length; i++) {
    if (i === candidates[ci]) {
      if (depth === 1 && !inString) return candidates[ci]!
      ci++
    }
    const b = buf[i]!
    if (escapeNext) {
      escapeNext = false
    } else if (inString) {
      if (b === BACKSLASH) escapeNext = true
      else if (b === QUOTE) inString = false
    } else if (b === QUOTE) inString = true
    else if (b === OPEN_BRACE) depth++
    else if (b === CLOSE_BRACE) depth--
  }
  return candidates.at(-1)!
}

function findActiveConversationTipInBuffer(
  buf: Buffer,
  expectedSessionId?: UUID,
): ActiveConversationTipEntry | undefined {
  const NEWLINE = 0x0a
  const PARENT_PREFIX = Buffer.from('{"parentUuid":')
  const ACTIVE_TIP_PREFIX = Buffer.from(
    `{"type":"${ACTIVE_CONVERSATION_TIP_TYPE}"`,
  )
  let activeTip: ActiveConversationTipEntry | undefined
  let activeRoot: UUID | null | undefined
  const activeDescendants = new Set<UUID>()
  let pos = 0

  while (pos < buf.length) {
    const nl = buf.indexOf(NEWLINE, pos)
    const lineEnd = nl === -1 ? buf.length : nl
    if (
      buf.compare(
        ACTIVE_TIP_PREFIX,
        0,
        ACTIVE_TIP_PREFIX.length,
        pos,
        Math.min(lineEnd, pos + ACTIVE_TIP_PREFIX.length),
      ) === 0
    ) {
      try {
        const parsed = parseActiveConversationTipEntry(
          JSON.parse(buf.toString('utf8', pos, lineEnd)),
        )
        activeTip =
          parsed &&
          (!expectedSessionId || parsed.sessionId === expectedSessionId)
            ? parsed
            : undefined
        activeRoot = activeTip?.tipUuid
        activeDescendants.clear()
      } catch {
        activeTip = undefined
        activeRoot = undefined
        activeDescendants.clear()
      }
    } else if (
      activeTip &&
      lineEnd - pos > PARENT_PREFIX.length &&
      buf.compare(
        PARENT_PREFIX,
        0,
        PARENT_PREFIX.length,
        pos,
        pos + PARENT_PREFIX.length,
      ) === 0
    ) {
      try {
        const candidate = JSON.parse(
          buf.toString('utf8', pos, lineEnd),
        ) as Entry
        if (isTranscriptMessage(candidate) && !candidate.isSidechain) {
          const parent = candidate.parentUuid
          const extendsActiveBranch =
            activeRoot === null
              ? parent === null ||
                (parent !== null && activeDescendants.has(parent))
              : parent === activeRoot ||
                (parent !== null && activeDescendants.has(parent))
          if (extendsActiveBranch) {
            activeDescendants.add(candidate.uuid)
            if (
              candidate.type === 'user' ||
              candidate.type === 'assistant'
            ) {
              activeTip = { ...activeTip, tipUuid: candidate.uuid }
            }
          }
        }
      } catch {
        // Malformed transcript lines do not make an older marker authoritative.
        activeTip = undefined
        activeRoot = undefined
        activeDescendants.clear()
      }
    }
    pos = nl === -1 ? buf.length : nl + 1
  }

  return activeTip
}

function walkChainBeforeParse(
  buf: Buffer,
  activeTipUuid?: UUID | null,
): Buffer {
  const NEWLINE = 0x0a
  const OPEN_BRACE = 0x7b
  const QUOTE = 0x22
  const PARENT_PREFIX = Buffer.from('{"parentUuid":')
  const UUID_KEY = Buffer.from('"uuid":"')
  const SIDECHAIN_TRUE = Buffer.from('"isSidechain":true')
  const UUID_LEN = 36
  const TS_SUFFIX = Buffer.from('","timestamp":"')
  const TS_SUFFIX_LEN = TS_SUFFIX.length
  const PREFIX_LEN = PARENT_PREFIX.length
  const KEY_LEN = UUID_KEY.length

  // Stride-3 flat index of transcript messages: [lineStart, lineEnd, parentStart].
  // parentStart is the byte offset of the parent uuid's first char, or -1 for null.
  // Metadata lines (summary, mode, file-history-snapshot, etc.) go in metaRanges
  // unfiltered - they lack the parentUuid prefix and downstream needs all of them.
  const msgIdx: number[] = []
  const metaRanges: number[] = []
  const uuidToSlot = new Map<string, number>()

  let pos = 0
  const len = buf.length
  while (pos < len) {
    const nl = buf.indexOf(NEWLINE, pos)
    const lineEnd = nl === -1 ? len : nl + 1
    if (
      lineEnd - pos > PREFIX_LEN &&
      buf[pos] === OPEN_BRACE &&
      buf.compare(PARENT_PREFIX, 0, PREFIX_LEN, pos, pos + PREFIX_LEN) === 0
    ) {
      // `{"parentUuid":null,` or `{"parentUuid":"<36 chars>",`
      const parentStart =
        buf[pos + PREFIX_LEN] === QUOTE ? pos + PREFIX_LEN + 1 : -1
      // The top-level uuid is immediately followed by `","timestamp":"` in
      // user/assistant/attachment entries (the create* helpers put them
      // adjacent; both always defined). But the suffix is NOT unique:
      //   - agent_progress entries carry a nested Message in data.message,
      //     serialized BEFORE top-level uuid — that inner Message has its
      //     own uuid,timestamp adjacent, so its bytes also satisfy the
      //     suffix check.
      //   - mcpMeta/toolUseResult come AFTER top-level uuid and hold
      //     server-controlled Record<string,unknown> — a server returning
      //     {uuid:"<36>",timestamp:"..."} would also match.
      // Collect all suffix matches; a single one is unambiguous (common
      // case), multiple need a brace-depth check to pick the one at
      // JSON nesting depth 1. Entries with NO suffix match (some progress
      // variants put timestamp BEFORE uuid → `"uuid":"<36>"}` at EOL)
      // have only one `"uuid":"` and the first-match fallback is sound.
      let firstAny = -1
      let suffix0 = -1
      let suffixN: number[] | undefined
      let from = pos
      for (;;) {
        const next = buf.indexOf(UUID_KEY, from)
        if (next < 0 || next >= lineEnd) break
        if (firstAny < 0) firstAny = next
        const after = next + KEY_LEN + UUID_LEN
        if (
          after + TS_SUFFIX_LEN <= lineEnd &&
          buf.compare(
            TS_SUFFIX,
            0,
            TS_SUFFIX_LEN,
            after,
            after + TS_SUFFIX_LEN,
          ) === 0
        ) {
          if (suffix0 < 0) suffix0 = next
          else (suffixN ??= [suffix0]).push(next)
        }
        from = next + KEY_LEN
      }
      const uk = suffixN
        ? pickDepthOneUuidCandidate(buf, pos, suffixN)
        : suffix0 >= 0
          ? suffix0
          : firstAny
      if (uk >= 0) {
        const uuidStart = uk + KEY_LEN
        // UUIDs are pure ASCII so latin1 avoids UTF-8 decode overhead.
        const uuid = buf.toString('latin1', uuidStart, uuidStart + UUID_LEN)
        uuidToSlot.set(uuid, msgIdx.length)
        msgIdx.push(pos, lineEnd, parentStart)
      } else {
        metaRanges.push(pos, lineEnd)
      }
    } else {
      metaRanges.push(pos, lineEnd)
    }
    pos = lineEnd
  }

  // An active rewind marker selects its retained target even though newer
  // discarded leaves remain in the append-only file. Otherwise use the latest
  // non-sidechain transcript entry, matching the normal pre-parse behavior.
  let leafSlot =
    activeTipUuid === undefined || activeTipUuid === null
      ? -1
      : (uuidToSlot.get(activeTipUuid) ?? -1)
  if (leafSlot >= 0) {
    const sidechainMarker = buf.indexOf(SIDECHAIN_TRUE, msgIdx[leafSlot]!)
    if (
      sidechainMarker !== -1 &&
      sidechainMarker < msgIdx[leafSlot + 1]!
    ) {
      leafSlot = -1
    }
  }
  if (leafSlot < 0) {
    for (let i = msgIdx.length - 3; i >= 0; i -= 3) {
      const sc = buf.indexOf(SIDECHAIN_TRUE, msgIdx[i]!)
      if (sc === -1 || sc >= msgIdx[i + 1]!) {
        leafSlot = i
        break
      }
    }
  }
  if (leafSlot < 0) return buf

  // Walk parentUuid to root. Collect kept-message line starts and sum their
  // byte lengths so we can decide whether the concat is worth it. A dangling
  // parent (uuid not in file) is the normal termination for forked sessions
  // and post-boundary chains -- same semantics as buildConversationChain.
  // Correctness against index poisoning rests on the timestamp suffix check
  // above: a nested `"uuid":"` match without the suffix never becomes uk.
  const seen = new Set<number>()
  const chain = new Set<number>()
  let chainBytes = 0
  let slot: number | undefined = leafSlot
  while (slot !== undefined) {
    if (seen.has(slot)) break
    seen.add(slot)
    chain.add(msgIdx[slot]!)
    chainBytes += msgIdx[slot + 1]! - msgIdx[slot]!
    const parentStart = msgIdx[slot + 2]!
    if (parentStart < 0) break
    const parent = buf.toString('latin1', parentStart, parentStart + UUID_LEN)
    slot = uuidToSlot.get(parent)
  }

  // parseJSONL cost scales with bytes, not entry count. A session can have
  // thousands of dead entries by count but only single-digit-% of bytes if
  // the dead branches are short turns and the live chain holds the fat
  // assistant responses (measured: 107 MB session, 69% dead entries, 30%
  // dead bytes - index+concat overhead exceeded parse savings). Gate on
  // bytes: only stitch if we would drop at least half the buffer. Metadata
  // is tiny so len - chainBytes approximates dead bytes closely enough.
  // Near break-even the concat memcpy (copying chainBytes into a fresh
  // allocation) dominates, so a conservative 50% gate stays safely on the
  // winning side.
  if (len - chainBytes < len >> 1) return buf

  // Merge chain entries with metadata in original file order. Both msgIdx and
  // metaRanges are already sorted by offset; interleave them into subarray
  // views and concat once.
  const parts: Buffer[] = []
  let m = 0
  for (let i = 0; i < msgIdx.length; i += 3) {
    const start = msgIdx[i]!
    while (m < metaRanges.length && metaRanges[m]! < start) {
      parts.push(buf.subarray(metaRanges[m]!, metaRanges[m + 1]!))
      m += 2
    }
    if (chain.has(start)) {
      parts.push(buf.subarray(start, msgIdx[i + 1]!))
    }
  }
  while (m < metaRanges.length) {
    parts.push(buf.subarray(metaRanges[m]!, metaRanges[m + 1]!))
    m += 2
  }
  return Buffer.concat(parts)
}

/**
 * Loads all messages, summaries, and file history snapshots from a transcript file.
 * Returns the messages, summaries, custom titles, tags, file history snapshots, and attribution snapshots.
 */
export async function loadTranscriptFile(
  filePath: string,
  opts?: {
    keepAllLeaves?: boolean
    keepCompactedHistory?: boolean
    maxReadBytes?: number
  },
): Promise<{
  messages: Map<UUID, TranscriptMessage>
  summaries: Map<UUID, string>
  customTitles: Map<UUID, string>
  tags: Map<UUID, string>
  archived: Map<UUID, boolean>
  agentNames: Map<UUID, string>
  agentColors: Map<UUID, string>
  agentSettings: Map<UUID, string>
  prNumbers: Map<UUID, number>
  prUrls: Map<UUID, string>
  prRepositories: Map<UUID, string>
  modes: Map<UUID, SessionMode>
  threadGoals: Map<UUID, ThreadGoal | null>
  worktreeStates: Map<UUID, PersistedWorktreeSession | null>
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotMessage>
  attributionSnapshots: Map<UUID, AttributionSnapshotMessage>
  contentReplacements: Map<UUID, ContentReplacementRecord[]>
  orderedContentReplacements: ContentReplacementRecord[]
  agentContentReplacements: Map<AgentId, ContentReplacementRecord[]>
  contextCollapseCommits: ContextCollapseCommitEntry[]
  contextCollapseSnapshot: ContextCollapseSnapshotEntry | undefined
  queueOperations: SessionQueueOperation[]
  leafUuids: Set<UUID>
  sourceTruncated: boolean
  activeConversationTip: ActiveConversationTipEntry | undefined
}> {
  const messages = new Map<UUID, TranscriptMessage>()
  const summaries = new Map<UUID, string>()
  const customTitles = new Map<UUID, string>()
  const tags = new Map<UUID, string>()
  const archived = new Map<UUID, boolean>()
  const agentNames = new Map<UUID, string>()
  const agentColors = new Map<UUID, string>()
  const agentSettings = new Map<UUID, string>()
  const prNumbers = new Map<UUID, number>()
  const prUrls = new Map<UUID, string>()
  const prRepositories = new Map<UUID, string>()
  const modes = new Map<UUID, SessionMode>()
  const threadGoals = new Map<UUID, ThreadGoal | null>()
  const worktreeStates = new Map<UUID, PersistedWorktreeSession | null>()
  const fileHistorySnapshots = new Map<UUID, FileHistorySnapshotMessage>()
  const attributionSnapshots = new Map<UUID, AttributionSnapshotMessage>()
  const contentReplacements = new Map<UUID, ContentReplacementRecord[]>()
  const orderedContentReplacements: ContentReplacementRecord[] = []
  const agentContentReplacements = new Map<
    AgentId,
    ContentReplacementRecord[]
  >()
  // Array, not Map — commit order matters (nested collapses).
  const contextCollapseCommits: ContextCollapseCommitEntry[] = []
  // Last-wins — later entries supersede.
  let contextCollapseSnapshot: ContextCollapseSnapshotEntry | undefined
  const queueOperations: SessionQueueOperation[] = []
  let sourceTruncated = false
  let activeConversationTip: ActiveConversationTipEntry | undefined
  let activeConversationRoot: UUID | null | undefined
  const activeConversationDescendants = new Set<UUID>()

  // Session-scoped metadata entries. Both passes below read them — the
  // pre-boundary metadata-only scan and the main entry walk — so the dispatch
  // lives here once: a new metadata entry type added to only one of the two
  // copies would load from short transcripts and silently vanish from
  // compacted ones. Returns whether the entry was one of these types.
  const applySessionMetadataEntry = (entry: Entry): boolean => {
    if (entry.type === 'summary' && entry.leafUuid) {
      summaries.set(entry.leafUuid, entry.summary)
    } else if (entry.type === 'custom-title' && entry.sessionId) {
      setLatestMapValue(customTitles, entry.sessionId, entry.customTitle)
    } else if (entry.type === 'tag' && entry.sessionId) {
      setLatestMapValue(tags, entry.sessionId, entry.tag)
    } else if (entry.type === 'archived' && entry.sessionId) {
      setLatestMapValue(archived, entry.sessionId, entry.archived === true)
    } else if (entry.type === 'agent-name' && entry.sessionId) {
      setLatestMapValue(agentNames, entry.sessionId, entry.agentName)
    } else if (entry.type === 'agent-color' && entry.sessionId) {
      setLatestMapValue(agentColors, entry.sessionId, entry.agentColor)
    } else if (entry.type === 'agent-setting' && entry.sessionId) {
      setLatestMapValue(agentSettings, entry.sessionId, entry.agentSetting)
    } else if (entry.type === 'mode' && entry.sessionId) {
      const mode = normalizeSessionMode(entry.mode)
      if (mode) setLatestMapValue(modes, entry.sessionId, mode)
    } else if (
      entry.type === 'thread-goal-updated' ||
      entry.type === 'thread-goal-cleared'
    ) {
      applyThreadGoalEntry(threadGoals, entry)
    } else if (entry.type === 'worktree-state' && entry.sessionId) {
      setLatestMapValue(worktreeStates, entry.sessionId, entry.worktreeSession)
    } else if (entry.type === 'pr-link' && entry.sessionId) {
      setLatestMapValue(prNumbers, entry.sessionId, entry.prNumber)
      setLatestMapValue(prUrls, entry.sessionId, entry.prUrl)
      setLatestMapValue(prRepositories, entry.sessionId, entry.prRepository)
    } else {
      return false
    }
    return true
  }

  try {
    // For large transcripts, avoid materializing megabytes of stale content.
    // Single forward chunked read: attribution-snapshot lines are skipped at
    // the fd level (never buffered), compact boundaries truncate the
    // accumulator in-stream. Peak allocation is the OUTPUT size, not the
    // file size — a 151 MB session that is 84% stale attr-snaps allocates
    // ~32 MB instead of 159+64 MB. This matters because mimalloc does not
    // return those pages to the OS even after JS-level GC frees the backing
    // buffers (measured: arrayBuffers=0 after Bun.gc(true) but RSS stuck at
    // ~316 MB on the old scan+strip path vs ~155 MB here).
    //
    // Pre-boundary metadata (agent-setting, mode, pr-link, etc.) is recovered
    // via a cheap byte-level forward scan of [0, boundary).
    let buf: Buffer | null = null
    let metadataLines: string[] | null = null
    let hasPreservedSegment = false
    if (opts?.keepCompactedHistory) {
      const { size } = await stat(filePath)
      const maxReadBytes = Math.max(1, opts.maxReadBytes ?? size)
      const start = Math.max(0, size - maxReadBytes)
      const length = size - start
      const tail = Buffer.allocUnsafe(length)
      const fd = await fsOpen(filePath, 'r')
      let offset = 0
      let startsAtLineBoundary = start === 0
      try {
        if (start > 0) {
          const precedingByte = Buffer.allocUnsafe(1)
          const { bytesRead } = await fd.read(precedingByte, 0, 1, start - 1)
          startsAtLineBoundary = bytesRead === 1 && precedingByte[0] === 0x0a
        }
        while (offset < length) {
          const { bytesRead } = await fd.read(
            tail,
            offset,
            length - offset,
            start + offset,
          )
          if (bytesRead === 0) break
          offset += bytesRead
        }
      } finally {
        await fd.close()
      }
      buf = tail.subarray(0, offset)
      if (start > 0) {
        sourceTruncated = true
        if (!startsAtLineBoundary) {
          const firstNewline = buf.indexOf(0x0a)
          buf = firstNewline >= 0
            ? buf.subarray(firstNewline + 1)
            : Buffer.alloc(0)
        }
      }
    } else if (!isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP)) {
      const { size } = await stat(filePath)
      if (size > SKIP_PRECOMPACT_THRESHOLD) {
        const scan = await readTranscriptForLoad(filePath, size)
        buf = scan.postBoundaryBuf
        hasPreservedSegment = scan.hasPreservedSegment
        // >0 means we truncated pre-boundary bytes and must recover
        // session-scoped metadata from that range. A preservedSegment
        // boundary does not truncate (preserved messages are physically
        // pre-boundary), so offset stays 0 unless an EARLIER non-preserved
        // boundary already truncated — in which case the preserved messages
        // for the later boundary are post-that-earlier-boundary and were
        // kept, and we still want the metadata scan.
        if (scan.boundaryStartOffset > 0) {
          metadataLines = await scanPreBoundaryMetadata(
            filePath,
            scan.boundaryStartOffset,
          )
        }
      }
    }
    buf ??= await readFile(filePath)
    // For large buffers (which here means readTranscriptForLoad output with
    // attr-snaps already stripped at the fd level — the <5MB readFile path
    // falls through the size gate below), the dominant cost is parsing dead
    // fork branches that buildConversationChain would discard anyway. Skip
    // when the caller needs all
    // leaves (loadAllLogsFromSessionFile for /insights picks the branch with
    // most user messages, not the latest), when the boundary has a
    // preservedSegment (those messages keep their pre-compact parentUuid on
    // disk -- applyPreservedSegmentRelinks splices them in-memory AFTER
    // parse, so a pre-parse chain walk would drop them as orphans), and when
    // CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP is set (that kill switch means
    // "load everything, skip nothing"; this is another skip-before-parse
    // optimization and the scan it depends on for hasPreservedSegment did
    // not run).
    if (
      !opts?.keepCompactedHistory &&
      !opts?.keepAllLeaves &&
      !hasPreservedSegment &&
      !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP) &&
      buf.length > SKIP_PRECOMPACT_THRESHOLD
    ) {
      const fileSessionId = validateUuid(
        basename(filePath).replace(/\.jsonl$/, ''),
      )
      const bufferedActiveTip = findActiveConversationTipInBuffer(
        buf,
        fileSessionId ?? undefined,
      )
      buf = walkChainBeforeParse(buf, bufferedActiveTip?.tipUuid)
    }

    // First pass: process metadata-only lines collected during the boundary scan.
    // These populate the session-scoped maps (agentSettings, modes, prNumbers,
    // etc.) for entries written before the compact boundary. Any overlap with
    // the post-boundary buffer is harmless — later values overwrite earlier ones.
    if (metadataLines && metadataLines.length > 0) {
      const metaEntries = parseJSONL<Entry>(
        Buffer.from(metadataLines.join('\n')),
      )
      for (const entry of metaEntries) {
        applySessionMetadataEntry(entry)
      }
    }

    const entries = parseJSONL<Entry>(buf)

    // Bridge map for legacy progress entries: progress_uuid → progress_parent_uuid.
    // PR #24099 removed progress from isTranscriptMessage, so old transcripts with
    // progress in the parentUuid chain would truncate at buildConversationChain
    // when messages.get(progressUuid) returns undefined. Since transcripts are
    // append-only (parents before children), we record each progress→parent link
    // as we see it, chain-resolving through consecutive progress entries, then
    // rewrite any subsequent message whose parentUuid lands in the bridge.
    const progressBridge = new Map<UUID, UUID | null>()

    for (const entry of entries) {
      // Legacy progress check runs before the Entry-typed else-if chain —
      // progress is not in the Entry union, so checking it after TypeScript
      // has narrowed `entry` intersects to `never`.
      if (isLegacyProgressEntry(entry)) {
        // Chain-resolve through consecutive progress entries so a later
        // message pointing at the tail of a progress run bridges to the
        // nearest non-progress ancestor in one lookup.
        const parent = entry.parentUuid
        progressBridge.set(
          entry.uuid,
          parent && progressBridge.has(parent)
            ? (progressBridge.get(parent) ?? null)
            : parent,
        )
        continue
      }
      if (isTranscriptMessage(entry)) {
        if (entry.parentUuid && progressBridge.has(entry.parentUuid)) {
          entry.parentUuid = progressBridge.get(entry.parentUuid) ?? null
        }
        if (activeConversationTip && !entry.isSidechain) {
          const parent = entry.parentUuid
          const extendsActiveBranch =
            activeConversationRoot === null
              ? parent === null ||
                (parent !== null &&
                  activeConversationDescendants.has(parent))
              : parent === activeConversationRoot ||
                (parent !== null &&
                  activeConversationDescendants.has(parent))
          if (extendsActiveBranch) {
            activeConversationDescendants.add(entry.uuid)
            if (entry.type === 'user' || entry.type === 'assistant') {
              activeConversationTip = {
                ...activeConversationTip,
                tipUuid: entry.uuid,
              }
            }
          }
        }
        messages.set(entry.uuid, entry)
        // Compact boundary: prior marble-origami-commit entries reference
        // messages that won't be in the post-boundary chain. The >5MB
        // backward-scan path discards them naturally by never reading the
        // pre-boundary bytes; the <5MB path reads everything, so discard
        // here. Without this, getStats().collapsedSpans in /context
        // overcounts (projectView silently skips the stale commits but
        // they're still in the log).
        if (isCompactBoundaryMessage(entry)) {
          contextCollapseCommits.length = 0
          contextCollapseSnapshot = undefined
        }
      } else if (entry.type === ACTIVE_CONVERSATION_TIP_TYPE) {
        activeConversationTip =
          parseActiveConversationTipEntry(entry) ?? undefined
        activeConversationRoot = activeConversationTip?.tipUuid
        activeConversationDescendants.clear()
      } else if (applySessionMetadataEntry(entry)) {
        // Handled above: session-scoped metadata shared with the pre-boundary pass.
      } else if (entry.type === 'file-history-snapshot') {
        fileHistorySnapshots.set(entry.messageId, entry)
      } else if (entry.type === 'attribution-snapshot') {
        attributionSnapshots.set(entry.messageId, entry)
      } else if (entry.type === 'content-replacement') {
        // Subagent decisions key by agentId (sidechain resume); main-thread
        // decisions key by sessionId (/resume).
        if (entry.agentId) {
          const existing = agentContentReplacements.get(entry.agentId) ?? []
          agentContentReplacements.set(entry.agentId, existing)
          existing.push(...entry.replacements)
        } else {
          const existing = contentReplacements.get(entry.sessionId) ?? []
          contentReplacements.set(entry.sessionId, existing)
          existing.push(...entry.replacements)
          orderedContentReplacements.push(...entry.replacements)
        }
      } else if (entry.type === 'marble-origami-commit') {
        contextCollapseCommits.push(entry)
      } else if (entry.type === 'marble-origami-snapshot') {
        contextCollapseSnapshot = entry
      } else if (entry.type === 'queue-operation') {
        queueOperations.push({
          operation: entry.operation,
          timestamp: entry.timestamp,
          sessionId: entry.sessionId,
          ...(entry.uuid !== undefined ? { uuid: entry.uuid } : {}),
          ...(entry.agentId !== undefined ? { agentId: entry.agentId } : {}),
          ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
          ...(entry.content !== undefined ? { content: entry.content } : {}),
        })
      }
    }
  } catch {
    // File doesn't exist or can't be read
  }

  if (opts?.keepCompactedHistory) {
    applyDisplayPreservedSegmentRelinks(messages)
  } else {
    applyPreservedSegmentRelinks(messages)
  }
  applySnipRemovals(messages)

  if (activeConversationTip?.tipUuid) {
    const tip = messages.get(activeConversationTip.tipUuid)
    if (
      !tip ||
      tip.isSidechain ||
      (tip.type !== 'user' && tip.type !== 'assistant') ||
      tip.sessionId !== activeConversationTip.sessionId
    ) {
      activeConversationTip = undefined
    }
  }
  const fileSessionId = validateUuid(basename(filePath).replace(/\.jsonl$/, ''))
  if (
    activeConversationTip &&
    fileSessionId &&
    activeConversationTip.sessionId !== fileSessionId
  ) {
    activeConversationTip = undefined
  }

  // Compute leaf UUIDs once at load time
  // Only user/assistant messages should be considered as leaves for anchoring resume.
  // Other message types (system, attachment) are metadata or auxiliary and shouldn't
  // anchor a conversation chain.
  //
  // We use standard parent relationship for main chain detection, but also need to
  // handle cases where the last message is a system/metadata message.
  // For each conversation chain (identified by following parent links), the leaf
  // is the most recent user/assistant message.
  const allMessages = [...messages.values()]

  // Standard leaf computation using parent relationships
  const parentUuids = new Set(
    allMessages
      .map(msg => msg.parentUuid)
      .filter((uuid): uuid is UUID => uuid !== null),
  )

  // Find all terminal messages (messages with no children)
  const terminalMessages = allMessages.filter(msg => !parentUuids.has(msg.uuid))

  const leafUuids = new Set<UUID>()
  let hasCycle = false

  if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_pebble_leaf_prune', false)) {
    // Build a set of UUIDs that have user/assistant children
    // (these are mid-conversation nodes, not dead ends)
    const hasUserAssistantChild = new Set<UUID>()
    for (const msg of allMessages) {
      if (msg.parentUuid && (msg.type === 'user' || msg.type === 'assistant')) {
        hasUserAssistantChild.add(msg.parentUuid)
      }
    }

    // For each terminal message, walk back to find the nearest user/assistant ancestor.
    // Skip ancestors that already have user/assistant children - those are mid-conversation
    // nodes where the conversation continued (e.g., an assistant tool_use message whose
    // progress child is terminal, but whose tool_result child continues the conversation).
    for (const terminal of terminalMessages) {
      const seen = new Set<UUID>()
      let current: TranscriptMessage | undefined = terminal
      while (current) {
        if (seen.has(current.uuid)) {
          hasCycle = true
          break
        }
        seen.add(current.uuid)
        if (current.type === 'user' || current.type === 'assistant') {
          if (!hasUserAssistantChild.has(current.uuid)) {
            leafUuids.add(current.uuid)
          }
          break
        }
        current = current.parentUuid
          ? messages.get(current.parentUuid)
          : undefined
      }
    }
  } else {
    // Original leaf computation: walk back from terminal messages to find
    // the nearest user/assistant ancestor unconditionally
    for (const terminal of terminalMessages) {
      const seen = new Set<UUID>()
      let current: TranscriptMessage | undefined = terminal
      while (current) {
        if (seen.has(current.uuid)) {
          hasCycle = true
          break
        }
        seen.add(current.uuid)
        if (current.type === 'user' || current.type === 'assistant') {
          leafUuids.add(current.uuid)
          break
        }
        current = current.parentUuid
          ? messages.get(current.parentUuid)
          : undefined
      }
    }
  }

  if (hasCycle) {
    logEvent('tengu_transcript_parent_cycle', {})
  }

  return {
    messages,
    summaries,
    customTitles,
    tags,
    archived,
    agentNames,
    agentColors,
    agentSettings,
    prNumbers,
    prUrls,
    prRepositories,
    modes,
    threadGoals,
    worktreeStates,
    fileHistorySnapshots,
    attributionSnapshots,
    contentReplacements,
    orderedContentReplacements,
    agentContentReplacements,
    contextCollapseCommits,
    contextCollapseSnapshot,
    queueOperations,
    leafUuids,
    sourceTruncated,
    activeConversationTip,
  }
}

export async function loadDisplayTranscriptFromJsonlPath(
  filePath: string,
  options: { maxMessages: number; maxBytes: number },
): Promise<{ messages: SerializedMessage[]; truncated: boolean }> {
  const loaded = await loadTranscriptFile(filePath, {
    keepCompactedHistory: true,
    maxReadBytes: options.maxBytes,
  })
  const active = selectActiveConversation(
    loaded.messages,
    loaded.leafUuids,
    loaded.activeConversationTip,
  )
  const tip = active.tip ?? undefined
  if (!tip) return { messages: [], truncated: loaded.sourceTruncated }

  const chain = buildDisplayConversationChain(loaded.messages, tip)
  const root = chain[0]
  const rootParentUuid = root
    ? root.parentUuid ??
      (isCompactBoundaryMessage(root) ? root.logicalParentUuid : undefined)
    : undefined
  const missingPredecessor = Boolean(
    rootParentUuid && !loaded.messages.has(rootParentUuid),
  )
  const capped = chain.length > options.maxMessages
  const retained = capped ? chain.slice(-options.maxMessages) : chain
  return {
    messages: removeExtraFields(retained),
    truncated:
      capped || (loaded.sourceTruncated && missingPredecessor),
  }
}

/**
 * Loads all messages, summaries, file history snapshots, and attribution snapshots from a specific session file.
 */
async function loadSessionFile(
  sessionId: UUID,
  options?: { keepAllLeaves?: boolean },
): Promise<{
  messages: Map<UUID, TranscriptMessage>
  summaries: Map<UUID, string>
  customTitles: Map<UUID, string>
  tags: Map<UUID, string>
  agentSettings: Map<UUID, string>
  threadGoals: Map<UUID, ThreadGoal | null>
  worktreeStates: Map<UUID, PersistedWorktreeSession | null>
  modes: Map<UUID, SessionMode>
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotMessage>
  attributionSnapshots: Map<UUID, AttributionSnapshotMessage>
  contentReplacements: Map<UUID, ContentReplacementRecord[]>
  orderedContentReplacements: ContentReplacementRecord[]
  contextCollapseCommits: ContextCollapseCommitEntry[]
  contextCollapseSnapshot: ContextCollapseSnapshotEntry | undefined
  queueOperations: SessionQueueOperation[]
  leafUuids: Set<UUID>
  activeConversationTip: ActiveConversationTipEntry | undefined
}> {
  const sessionFile = join(
    getSessionProjectDir() ?? getProjectDir(getOriginalCwd()),
    `${sessionId}.jsonl`,
  )
  return loadTranscriptFile(sessionFile, options)
}

export type SessionQueueOperation = {
  /**
   * Anything other than `enqueue` is a retraction: the command left the queue.
   * `popAll` (the terminal's UP-arrow pull-back) is written by
   * `messageQueueManager.logOperation` too, so readers must treat the set as
   * open and test for `enqueue` rather than enumerate the retractions.
   */
  operation: 'enqueue' | 'dequeue' | 'remove' | 'popAll'
  timestamp: string
  sessionId: string
  uuid?: UUID
  /**
   * Agent this notification was addressed to; undefined = main thread. Carried
   * on every operation, like `uuid` (`messageQueueManager.logOperation`).
   */
  agentId?: AgentId
  /**
   * Recorded on `enqueue` only, like `content`, and read there: it is how a
   * reader tells a user prompt from a task notification. A retraction is matched
   * by uuid alone, so repeating the mode on it told no reader anything.
   */
  mode?: string
  /**
   * Recorded on `enqueue` only. A prompt carrying images is a
   * `ContentBlockParam[]`, so this is not a string in every session. Absent for
   * a terminal prompt's pasted images, which live outside `command.value`
   * (`messageQueueManager.logOperation`).
   */
  content?: string | ContentBlockParam[]
}

/**
 * The queue-operation log in FILE order, which is call order (`enqueueWrite`
 * drains per file in push order). Order is load-bearing: one uuid can be
 * enqueued, retracted and enqueued again, so readers must replay rather than
 * fold the records into per-uuid sets (`app/sidecar/sessionResume.ts`).
 */
export async function getSessionQueueOperations(
  sessionId: string,
): Promise<{
  operations: SessionQueueOperation[]
  messageUuids: Set<UUID>
}> {
  const loaded = await loadSessionFile(sessionId as UUID, {
    keepAllLeaves: true,
  })
  return {
    operations: loaded.queueOperations,
    messageUuids: new Set(loaded.messages.keys()),
  }
}

/**
 * Clear the memoized session messages cache.
 * Call after compaction when old message UUIDs are no longer valid.
 */
export function clearSessionMessagesCache(): void {
  getSessionMessages.cache.clear?.()
}

/**
 * Check if a message UUID exists in the session storage
 */
export async function doesMessageExistInSession(
  sessionId: UUID,
  messageUuid: UUID,
): Promise<boolean> {
  const messageSet = await getSessionMessages(sessionId)
  return messageSet.has(messageUuid)
}

function getLatestSessionScopedValue<T>(values: Map<UUID, T>): T | undefined {
  let latest: T | undefined
  for (const value of values.values()) latest = value
  return latest
}

export async function getLastSessionLog(
  sessionId: UUID,
): Promise<LogOption | null> {
  // Single read: load all session data at once instead of reading the file twice
  const {
    messages,
    summaries,
    customTitles,
    tags,
    agentSettings,
    threadGoals,
    worktreeStates,
    modes,
    fileHistorySnapshots,
    attributionSnapshots,
    orderedContentReplacements,
    contextCollapseCommits,
    contextCollapseSnapshot,
    leafUuids,
    activeConversationTip,
  } = await loadSessionFile(sessionId)
  if (messages.size === 0) return null
  // Prime getSessionMessages cache so recordTranscript (called after REPL
  // mount on --resume) skips a second full file load. -170~227ms on large sessions.
  // Guard: only prime if cache is empty. Mid-session callers (e.g. IssueFeedback)
  // may call getLastSessionLog on the current session — overwriting a live cache
  // with a stale disk snapshot would lose unflushed UUIDs and break dedup.
  if (!getSessionMessages.cache.has(sessionId)) {
    getSessionMessages.cache.set(
      sessionId,
      Promise.resolve(new Set(messages.keys())),
    )
  }

  const activeConversation = selectActiveConversation(
    messages,
    leafUuids,
    activeConversationTip,
  )
  if (!activeConversation.sessionId) return null
  const transcript = activeConversation.messages
  const lastMessage = activeConversation.tip
  const fallbackMessage = findLatestMessage(
    messages.values(),
    m => !m.isSidechain && (m.type === 'user' || m.type === 'assistant'),
  )
  if (!fallbackMessage) return null

  const summary = lastMessage ? summaries.get(lastMessage.uuid) : undefined
  const leafSessionId = lastMessage?.sessionId as UUID | undefined
  if (leafSessionId && leafSessionId !== sessionId) {
    logForDebugging(
      `Transcript identity drift: file ${sessionId} contains latest message stamped ${leafSessionId}`,
      { level: 'warn' },
    )
  }
  const customTitle = getLatestSessionScopedValue(customTitles)
  const tag = getLatestSessionScopedValue(tags)
  const agentSetting = getLatestSessionScopedValue(agentSettings)
  const threadGoal = getLatestSessionScopedValue(threadGoals)
  const mixedSessionIds = new Set<UUID>([sessionId])
  for (const message of messages.values()) {
    if (message.sessionId) mixedSessionIds.add(message.sessionId as UUID)
  }
  const baseTranscript =
    transcript.length > 0
      ? transcript
      : buildConversationChain(messages, fallbackMessage)
  return {
    ...convertToLogOption(
      baseTranscript,
      0,
      summary,
      customTitle,
      buildFileHistorySnapshotChain(fileHistorySnapshots, transcript),
      tag,
      getTranscriptPathForSession(sessionId),
      buildAttributionSnapshotChain(attributionSnapshots, transcript),
      agentSetting,
      orderedContentReplacements,
      threadGoal !== undefined
        ? (threadGoal ?? null)
        : undefined,
    ),
    messages: removeExtraFields(transcript),
    messageCount: countVisibleMessages(transcript),
    leafUuid: lastMessage?.uuid,
    mode: messages.values().next().value?.type
      ? getLatestSessionScopedValue(modes)
      : undefined,
    worktreeSession: getLatestSessionScopedValue(worktreeStates),
    contextCollapseCommits: contextCollapseCommits.filter(
      e => mixedSessionIds.has(e.sessionId),
    ),
    contextCollapseSnapshot:
      contextCollapseSnapshot && mixedSessionIds.has(contextCollapseSnapshot.sessionId)
        ? contextCollapseSnapshot
        : undefined,
  }
}

/**
 * Loads the list of message logs
 * @param limit Optional limit on number of session files to load
 * @returns List of message logs sorted by date
 */
export async function loadMessageLogs(limit?: number): Promise<LogOption[]> {
  const sessionLogs = await fetchLogs(limit)
  // fetchLogs returns lite (stat-only) logs — enrich them to get metadata.
  // enrichLogs already filters out sidechains, empty sessions, etc.
  const { logs: enriched } = await enrichLogs(
    sessionLogs,
    0,
    sessionLogs.length,
  )

  // enrichLogs returns fresh unshared objects — mutate in place to avoid
  // re-spreading every 30-field LogOption just to renumber the index.
  const sorted = sortLogs(enriched)
  sorted.forEach((log, i) => {
    log.value = i
  })
  return sorted
}

/**
 * Loads message logs from all project directories.
 * @param limit Optional limit on number of session files to load per project (used when no index exists)
 * @returns List of message logs sorted by date
 */
export async function loadAllProjectsMessageLogs(
  limit?: number,
  options?: { skipIndex?: boolean; initialEnrichCount?: number },
): Promise<LogOption[]> {
  if (options?.skipIndex) {
    // Load all sessions with full message data (e.g. for /insights analysis)
    return loadAllProjectsMessageLogsFull(limit)
  }
  const result = await loadAllProjectsMessageLogsProgressive(
    limit,
    options?.initialEnrichCount ?? INITIAL_ENRICH_COUNT,
  )
  return result.logs
}

async function loadAllProjectsMessageLogsFull(
  limit?: number,
): Promise<LogOption[]> {
  const projectsDir = getProjectsDir()

  let dirents: Dirent[]
  try {
    dirents = await readdir(projectsDir, { withFileTypes: true })
  } catch {
    return []
  }

  const projectDirs = dirents
    .filter(dirent => dirent.isDirectory())
    .map(dirent => join(projectsDir, dirent.name))

  const logsPerProject = await Promise.all(
    projectDirs.map(projectDir => getLogsWithoutIndex(projectDir, limit)),
  )
  const allLogs = logsPerProject.flat()

  // Deduplicate — same session+leaf can appear in multiple project dirs.
  // This path creates one LogOption per leaf, so use sessionId+leafUuid key.
  const deduped = new Map<string, LogOption>()
  for (const log of allLogs) {
    const key = `${log.sessionId ?? ''}:${log.leafUuid ?? ''}`
    const existing = deduped.get(key)
    if (!existing || log.modified.getTime() > existing.modified.getTime()) {
      deduped.set(key, log)
    }
  }

  // deduped values are fresh from getLogsWithoutIndex — safe to mutate
  const sorted = sortLogs([...deduped.values()])
  sorted.forEach((log, i) => {
    log.value = i
  })
  return sorted
}

export async function loadAllProjectsMessageLogsProgressive(
  limit?: number,
  initialEnrichCount: number = INITIAL_ENRICH_COUNT,
): Promise<SessionLogResult> {
  const projectsDir = getProjectsDir()

  let dirents: Dirent[]
  try {
    dirents = await readdir(projectsDir, { withFileTypes: true })
  } catch {
    return { logs: [], allStatLogs: [], nextIndex: 0 }
  }

  const projectDirs = dirents
    .filter(dirent => dirent.isDirectory())
    .map(dirent => join(projectsDir, dirent.name))

  const rawLogs: LogOption[] = []
  for (const projectDir of projectDirs) {
    rawLogs.push(...(await getSessionFilesLite(projectDir, limit)))
  }
  // Deduplicate — same session can appear in multiple project dirs
  const sorted = deduplicateLogsBySessionId(rawLogs)

  const { logs, nextIndex } = await enrichLogs(sorted, 0, initialEnrichCount)

  // Re-sort the enriched batch by corrected `modified` (enrichLogs replaces the
  // mtime-based value with the real last-activity timestamp). `allStatLogs`
  // stays in mtime order — nextIndex indexes into it for progressive loading.
  // enrichLogs returns fresh unshared objects — safe to mutate in place.
  const enrichedSorted = sortLogs(logs)
  enrichedSorted.forEach((log, i) => {
    log.value = i
  })
  return { logs: enrichedSorted, allStatLogs: sorted, nextIndex }
}

/**
 * Loads message logs from all worktrees of the same git repository.
 * Falls back to loadMessageLogs if no worktrees provided.
 *
 * Uses pure filesystem metadata for fast loading.
 *
 * @param worktreePaths Array of worktree paths (from getWorktreePaths)
 * @param limit Optional limit on number of session files to load per project
 * @returns List of message logs sorted by date
 */
/**
 * Result of loading session logs with progressive enrichment support.
 */
export type SessionLogResult = {
  /** Enriched logs ready for display */
  logs: LogOption[]
  /** Full stat-only list for progressive loading (call enrichLogs to get more) */
  allStatLogs: LogOption[]
  /** Index into allStatLogs where progressive loading should continue from */
  nextIndex: number
}

export async function loadSameRepoMessageLogs(
  worktreePaths: string[],
  limit?: number,
  initialEnrichCount: number = INITIAL_ENRICH_COUNT,
): Promise<LogOption[]> {
  const result = await loadSameRepoMessageLogsProgressive(
    worktreePaths,
    limit,
    initialEnrichCount,
  )
  return result.logs
}

export async function loadSameRepoMessageLogsProgressive(
  worktreePaths: string[],
  limit?: number,
  initialEnrichCount: number = INITIAL_ENRICH_COUNT,
): Promise<SessionLogResult> {
  logForDebugging(
    `/resume: loading sessions for cwd=${getOriginalCwd()}, worktrees=[${worktreePaths.join(', ')}]`,
  )
  const allStatLogs = await getStatOnlyLogsForWorktrees(worktreePaths, limit)
  logForDebugging(`/resume: found ${allStatLogs.length} session files on disk`)

  const { logs, nextIndex } = await enrichLogs(
    allStatLogs,
    0,
    initialEnrichCount,
  )

  // Re-sort by corrected `modified`: allStatLogs is ordered by file mtime, but
  // enrichLogs replaces mtime with the real last-activity timestamp, so the
  // enriched batch needs re-sorting. enrichLogs returns fresh unshared objects
  // — safe to mutate in place.
  const sorted = sortLogs(logs)
  sorted.forEach((log, i) => {
    log.value = i
  })
  return { logs: sorted, allStatLogs, nextIndex }
}

/**
 * Gets stat-only logs for worktree paths (no file reads).
 */
async function getStatOnlyLogsForWorktrees(
  worktreePaths: string[],
  limit?: number,
): Promise<LogOption[]> {
  const projectsDir = getProjectsDir()

  if (worktreePaths.length <= 1) {
    const cwd = getOriginalCwd()
    const projectDir = getProjectDir(cwd)
    return getSessionFilesLite(projectDir, undefined, cwd)
  }

  // On Windows, drive letter case can differ between git worktree list
  // output (e.g. C:/Users/...) and how paths were stored in project
  // directories (e.g. c:/Users/...). Use case-insensitive comparison.
  const caseInsensitive = process.platform === 'win32'

  // Sort worktree paths by sanitized prefix length (longest first) so
  // more specific matches take priority over shorter ones. Without this,
  // a short prefix like -code-myrepo could match -code-myrepo-worktree1
  // before the longer, more specific prefix gets a chance.
  const indexed = worktreePaths.map(wt => {
    const sanitized = sanitizePath(wt)
    return {
      path: wt,
      prefix: caseInsensitive ? sanitized.toLowerCase() : sanitized,
    }
  })
  indexed.sort((a, b) => b.prefix.length - a.prefix.length)

  const allLogs: LogOption[] = []
  const seenDirs = new Set<string>()

  let allDirents: Dirent[]
  try {
    allDirents = await readdir(projectsDir, { withFileTypes: true })
  } catch (e) {
    // Fall back to current project
    logForDebugging(
      `Failed to read projects dir ${projectsDir}, falling back to current project: ${e}`,
    )
    const projectDir = getProjectDir(getOriginalCwd())
    return getSessionFilesLite(projectDir, limit, getOriginalCwd())
  }

  for (const dirent of allDirents) {
    if (!dirent.isDirectory()) continue
    const dirName = caseInsensitive ? dirent.name.toLowerCase() : dirent.name
    if (seenDirs.has(dirName)) continue

    for (const { path: wtPath, prefix } of indexed) {
      if (dirName === prefix || dirName.startsWith(prefix + '-')) {
        seenDirs.add(dirName)
        allLogs.push(
          ...(await getSessionFilesLite(
            join(projectsDir, dirent.name),
            undefined,
            wtPath,
          )),
        )
        break
      }
    }
  }

  // Deduplicate by sessionId — the same session can appear in multiple
  // worktree project dirs. Keep the entry with the newest modified time.
  return deduplicateLogsBySessionId(allLogs)
}

/**
 * Retrieves the transcript for a specific agent by agentId.
 * Directly loads the agent-specific transcript file.
 * @param agentId The agent ID to search for
 * @returns The conversation chain and budget replacement records for the agent,
 *          or null if not found
 */
export async function getAgentTranscript(agentId: AgentId): Promise<{
  messages: Message[]
  contentReplacements: ContentReplacementRecord[]
} | null> {
  return getAgentTranscriptFromPath(agentId, getAgentTranscriptPath(agentId))
}

export async function getAgentTranscriptForSession(
  sessionId: string,
  agentId: AgentId,
): Promise<{
  messages: Message[]
  contentReplacements: ContentReplacementRecord[]
} | null> {
  return getAgentTranscriptFromPath(
    agentId,
    getAgentTranscriptPathForSession(sessionId, agentId),
  )
}

async function getAgentTranscriptFromPath(
  agentId: AgentId,
  agentFile: string,
): Promise<{
  messages: Message[]
  contentReplacements: ContentReplacementRecord[]
} | null> {
  try {
    const { messages, agentContentReplacements } =
      await loadTranscriptFile(agentFile)

    // Find messages with matching agentId
    const agentMessages = Array.from(messages.values()).filter(
      msg => msg.agentId === agentId && msg.isSidechain,
    )

    if (agentMessages.length === 0) {
      return null
    }

    // Find the most recent leaf message with this agentId
    const parentUuids = new Set(agentMessages.map(msg => msg.parentUuid))
    const leafMessage = findLatestMessage(
      agentMessages,
      msg => !parentUuids.has(msg.uuid),
    )

    if (!leafMessage) {
      return null
    }

    // Build the conversation chain
    const transcript = buildConversationChain(messages, leafMessage)

    // Filter to only include messages with this agentId
    const agentTranscript = transcript.filter(msg => msg.agentId === agentId)

    return {
      // Convert TranscriptMessage[] to Message[]
      messages: agentTranscript.map(
        ({ isSidechain, parentUuid, ...msg }) => msg,
      ),
      contentReplacements: agentContentReplacements.get(agentId) ?? [],
    }
  } catch {
    return null
  }
}

/**
 * Extract agent IDs from progress messages in the conversation.
 * Agent/skill progress messages have type 'progress' with data.type
 * 'agent_progress' or 'skill_progress' and data.agentId.
 * This captures sync agents that emit progress messages during execution.
 */
export function extractAgentIdsFromMessages(messages: Message[]): string[] {
  const agentIds: string[] = []

  for (const message of messages) {
    if (
      message.type === 'progress' &&
      message.data &&
      typeof message.data === 'object' &&
      'type' in message.data &&
      (message.data.type === 'agent_progress' ||
        message.data.type === 'skill_progress') &&
      'agentId' in message.data &&
      typeof message.data.agentId === 'string'
    ) {
      agentIds.push(message.data.agentId)
    }
  }

  return uniq(agentIds)
}

/**
 * Extract teammate transcripts directly from AppState tasks.
 * In-process teammates store their messages in task.messages,
 * which is more reliable than loading from disk since each teammate turn
 * uses a random agentId for transcript storage.
 */
export function extractTeammateTranscriptsFromTasks(tasks: {
  [taskId: string]: {
    type: string
    identity?: { agentId: string }
    messages?: Message[]
  }
}): { [agentId: string]: Message[] } {
  const transcripts: { [agentId: string]: Message[] } = {}

  for (const task of Object.values(tasks)) {
    if (
      task.type === 'in_process_teammate' &&
      task.identity?.agentId &&
      task.messages &&
      task.messages.length > 0
    ) {
      transcripts[task.identity.agentId] = task.messages
    }
  }

  return transcripts
}

/**
 * Load subagent transcripts for the given agent IDs
 */
export async function loadSubagentTranscripts(
  agentIds: string[],
): Promise<{ [agentId: string]: Message[] }> {
  const results = await Promise.all(
    agentIds.map(async agentId => {
      try {
        const result = await getAgentTranscript(asAgentId(agentId))
        if (result && result.messages.length > 0) {
          return { agentId, transcript: result.messages }
        }
        return null
      } catch {
        // Skip if transcript can't be loaded
        return null
      }
    }),
  )

  const transcripts: { [agentId: string]: Message[] } = {}
  for (const result of results) {
    if (result) {
      transcripts[result.agentId] = result.transcript
    }
  }
  return transcripts
}

// Globs the session's subagents dir directly — unlike AppState.tasks, this survives task eviction.
export async function loadAllSubagentTranscriptsFromDisk(): Promise<{
  [agentId: string]: Message[]
}> {
  const subagentsDir = join(
    getSessionProjectDir() ?? getProjectDir(getOriginalCwd()),
    getSessionId(),
    'subagents',
  )
  let entries: Dirent[]
  try {
    entries = await readdir(subagentsDir, { withFileTypes: true })
  } catch {
    return {}
  }
  // Filename format is the inverse of getAgentTranscriptPath() — keep in sync.
  const agentIds = entries
    .filter(
      d =>
        d.isFile() && d.name.startsWith('agent-') && d.name.endsWith('.jsonl'),
    )
    .map(d => d.name.slice('agent-'.length, -'.jsonl'.length))
  return loadSubagentTranscripts(agentIds)
}

// Exported so useLogMessages can sync-compute the last loggable uuid
// without awaiting recordTranscript's return value (race-free hint tracking).
export function isLoggableMessage(m: Message): boolean {
  if (m.type === 'progress') return false
  // Attachments ARE persisted. The old non-ant drop existed to keep attachment
  // content out of public training data; this fork has one user and ships
  // USER_TYPE='external' (scripts/build.ts), so the drop was total and cost
  // real fidelity: mid-turn typing becomes a queued_command attachment that IS
  // sent to the model (attachments.ts getQueuedCommandAttachments, drained in
  // query.ts), so a transcript without attachments does not record what the
  // model was told, and a resumed prefix cannot match what was cached.
  // isTranscriptMessage already admits 'attachment' into the parentUuid chain
  // on the read side. Upstream reached the same place: its equivalent denylist
  // has been `new Set([])` since at least 2.1.214.
  //
  // A hook_success with no content and no output is the one exception, also
  // upstream's: hooks.ts deliberately writes content:'' for the ordinary
  // silent success, so persisting it would add a row per hook per turn that
  // says nothing.
  if (m.type === 'attachment') {
    // AttachmentMessage.attachment is typed `unknown` (types/message.ts), so
    // the shape has to be named here to read it.
    const attachment = m.attachment as {
      type?: string
      content?: string
      stdout?: string
      stderr?: string
    } | null
    if (
      attachment?.type === 'hook_success' &&
      !attachment.content &&
      !attachment.stdout?.trim() &&
      !attachment.stderr?.trim()
    ) {
      return false
    }
  }
  return true
}

function collectReplIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>()
  for (const m of messages) {
    if (m.type === 'assistant' && Array.isArray(m.message.content)) {
      for (const b of m.message.content) {
        if (b.type === 'tool_use' && b.name === REPL_TOOL_NAME) {
          ids.add(b.id)
        }
      }
    }
  }
  return ids
}

/**
 * For external users, make REPL invisible in the persisted transcript: strip
 * REPL tool_use/tool_result pairs and promote isVirtual messages to real. On
 * --resume the model then sees a coherent native-tool-call history (assistant
 * called Bash, got result, called Read, got result) without the REPL wrapper.
 * Ant transcripts keep the wrapper so /share training data sees REPL usage.
 *
 * replIds is pre-collected from the FULL session array, not the slice being
 * transformed — recordTranscript receives incremental slices where the REPL
 * tool_use (earlier render) and its tool_result (later render, after async
 * execution) land in separate calls. A fresh per-call Set would miss the id
 * and leave an orphaned tool_result on disk.
 */
function transformMessagesForExternalTranscript(
  messages: Transcript,
  replIds: Set<string>,
): Transcript {
  return messages.flatMap(m => {
    if (m.type === 'assistant' && Array.isArray(m.message.content)) {
      const content = m.message.content
      const hasRepl = content.some(
        b => b.type === 'tool_use' && b.name === REPL_TOOL_NAME,
      )
      const filtered = hasRepl
        ? content.filter(
            b => !(b.type === 'tool_use' && b.name === REPL_TOOL_NAME),
          )
        : content
      if (filtered.length === 0) return []
      if (m.isVirtual) {
        const { isVirtual: _omit, ...rest } = m
        return [{ ...rest, message: { ...m.message, content: filtered } }]
      }
      if (filtered !== content) {
        return [{ ...m, message: { ...m.message, content: filtered } }]
      }
      return [m]
    }
    if (m.type === 'user' && Array.isArray(m.message.content)) {
      const content = m.message.content
      const hasRepl = content.some(
        b => b.type === 'tool_result' && replIds.has(b.tool_use_id),
      )
      const filtered = hasRepl
        ? content.filter(
            b => !(b.type === 'tool_result' && replIds.has(b.tool_use_id)),
          )
        : content
      if (filtered.length === 0) return []
      if (m.isVirtual) {
        const { isVirtual: _omit, ...rest } = m
        return [{ ...rest, message: { ...m.message, content: filtered } }]
      }
      if (filtered !== content) {
        return [{ ...m, message: { ...m.message, content: filtered } }]
      }
      return [m]
    }
    // string-content user, system, attachment
    if ('isVirtual' in m && m.isVirtual) {
      const { isVirtual: _omit, ...rest } = m
      return [rest]
    }
    return [m]
  }) as Transcript
}

export function cleanMessagesForLogging(
  messages: Message[],
  allMessages: readonly Message[] = messages,
): Transcript {
  const filtered = messages.filter(isLoggableMessage) as Transcript
  return getUserType() !== 'ant'
    ? transformMessagesForExternalTranscript(
        filtered,
        collectReplIds(allMessages),
      )
    : filtered
}

/**
 * Gets a log by its index
 * @param index Index in the sorted list of logs (0-based)
 * @returns Log data or null if not found
 */
export async function getLogByIndex(index: number): Promise<LogOption | null> {
  const logs = await loadMessageLogs()
  return logs[index] || null
}

/**
 * Looks up unresolved tool uses in the transcript by tool_use_id.
 * Returns the assistant message containing the tool_use, or null if not found
 * or the tool call already has a tool_result.
 */
export async function findUnresolvedToolUse(
  toolUseId: string,
): Promise<AssistantMessage | null> {
  try {
    const transcriptPath = getTranscriptPath()
    const { messages } = await loadTranscriptFile(transcriptPath)

    let toolUseMessage = null

    // Find the tool use but make sure there's not also a result
    for (const message of messages.values()) {
      if (message.type === 'assistant') {
        const content = message.message.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_use' && block.id === toolUseId) {
              toolUseMessage = message
              break
            }
          }
        }
      } else if (message.type === 'user') {
        const content = message.message.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              block.type === 'tool_result' &&
              block.tool_use_id === toolUseId
            ) {
              // Found tool result, bail out
              return null
            }
          }
        }
      }
    }

    return toolUseMessage
  } catch {
    return null
  }
}

/**
 * Gets all session JSONL files in a project directory with their stats.
 * Returns a map of sessionId → {path, mtime, ctime, size}.
 * Stats are batched via Promise.all to avoid serial syscalls in the hot loop.
 */
export async function getSessionFilesWithMtime(
  projectDir: string,
): Promise<
  Map<string, { path: string; mtime: number; ctime: number; size: number }>
> {
  const sessionFilesMap = new Map<
    string,
    { path: string; mtime: number; ctime: number; size: number }
  >()

  let dirents: Dirent[]
  try {
    dirents = await readdir(projectDir, { withFileTypes: true })
  } catch {
    // Directory doesn't exist - return empty map
    return sessionFilesMap
  }

  const candidates: Array<{ sessionId: string; filePath: string }> = []
  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.endsWith('.jsonl')) continue
    const sessionId = validateUuid(basename(dirent.name, '.jsonl'))
    if (!sessionId) continue
    candidates.push({ sessionId, filePath: join(projectDir, dirent.name) })
  }

  await Promise.all(
    candidates.map(async ({ sessionId, filePath }) => {
      try {
        const st = await stat(filePath)
        sessionFilesMap.set(sessionId, {
          path: filePath,
          mtime: st.mtime.getTime(),
          ctime: st.birthtime.getTime(),
          size: st.size,
        })
      } catch {
        logForDebugging(`Failed to stat session file: ${filePath}`)
      }
    }),
  )

  return sessionFilesMap
}

type LiteMetadata = {
  firstPrompt: string
  gitBranch?: string
  entrypoint?: string
  isSidechain: boolean
  projectPath?: string
  teamName?: string
  customTitle?: string
  summary?: string
  tag?: string
  agentSetting?: string
  prNumber?: number
  prUrl?: string
  prRepository?: string
  lastTimestamp?: string
  /**
   * Whether the scanned window holds any real conversation entry (`user` /
   * `assistant`). False for a transcript that carries only bookkeeping or
   * diagnostic entries — e.g. the `codex_stream_surface`/`codex_send_path`
   * telemetry `recordCodexStreamSurface` appends when no real session owns the
   * write. Distinct from an empty `firstPrompt`: a session whose first message
   * exceeds the read window has no extractable prompt but DOES have the entry,
   * so consumers that want "is there a conversation here" must read this rather
   * than test for the `'(session)'` title fallback below.
   */
  hasConversation?: boolean
  forked: boolean
}

/**
 * Loads all logs from a single session file with full message data.
 * Builds a LogOption for each leaf message in the file.
 */
export async function loadAllLogsFromSessionFile(
  sessionFile: string,
  projectPathOverride?: string,
): Promise<LogOption[]> {
  const {
    messages,
    summaries,
    customTitles,
    tags,
    agentNames,
    agentColors,
    agentSettings,
    prNumbers,
    prUrls,
    prRepositories,
    modes,
    fileHistorySnapshots,
    attributionSnapshots,
    contentReplacements,
    leafUuids,
  } = await loadTranscriptFile(sessionFile, { keepAllLeaves: true })

  if (messages.size === 0) return []

  const leafMessages: TranscriptMessage[] = []
  // Build parentUuid → children index once (O(n)), so trailing-message lookup is O(1) per leaf
  const childrenByParent = new Map<UUID, TranscriptMessage[]>()
  for (const msg of messages.values()) {
    if (leafUuids.has(msg.uuid)) {
      leafMessages.push(msg)
    } else if (msg.parentUuid) {
      const siblings = childrenByParent.get(msg.parentUuid)
      if (siblings) {
        siblings.push(msg)
      } else {
        childrenByParent.set(msg.parentUuid, [msg])
      }
    }
  }

  const logs: LogOption[] = []

  for (const leafMessage of leafMessages) {
    const chain = buildConversationChain(messages, leafMessage)
    if (chain.length === 0) continue

    // Append trailing messages that are children of the leaf
    const trailingMessages = childrenByParent.get(leafMessage.uuid)
    if (trailingMessages) {
      // ISO-8601 UTC timestamps are lexically sortable
      trailingMessages.sort((a, b) =>
        a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
      )
      chain.push(...trailingMessages)
    }

    const firstMessage = chain[0]!
    const sessionId = leafMessage.sessionId as UUID

    logs.push({
      date: leafMessage.timestamp,
      messages: removeExtraFields(chain),
      fullPath: sessionFile,
      value: 0,
      created: new Date(firstMessage.timestamp),
      modified: new Date(leafMessage.timestamp),
      firstPrompt: extractFirstPrompt(chain),
      messageCount: countVisibleMessages(chain),
      isSidechain: firstMessage.isSidechain ?? false,
      sessionId,
      leafUuid: leafMessage.uuid,
      summary: summaries.get(leafMessage.uuid),
      customTitle: customTitles.get(sessionId),
      tag: tags.get(sessionId),
      agentName: agentNames.get(sessionId),
      agentColor: agentColors.get(sessionId),
      agentSetting: agentSettings.get(sessionId),
      mode: modes.get(sessionId),
      prNumber: prNumbers.get(sessionId),
      prUrl: prUrls.get(sessionId),
      prRepository: prRepositories.get(sessionId),
      gitBranch: leafMessage.gitBranch,
      projectPath: projectPathOverride ?? firstMessage.cwd,
      entrypoint: firstMessage.entrypoint,
      fileHistorySnapshots: buildFileHistorySnapshotChain(
        fileHistorySnapshots,
        chain,
      ),
      attributionSnapshots: buildAttributionSnapshotChain(
        attributionSnapshots,
        chain,
      ),
      contentReplacements: contentReplacements.get(sessionId) ?? [],
    })
  }

  return logs
}

/**
 * Gets logs by loading all session files fully, bypassing the session index.
 * Use this when you need full message data (e.g., for /insights analysis).

 */
async function getLogsWithoutIndex(
  projectDir: string,
  limit?: number,
): Promise<LogOption[]> {
  const sessionFilesMap = await getSessionFilesWithMtime(projectDir)
  if (sessionFilesMap.size === 0) return []

  // If limit specified, only load N most recent files by mtime
  let filesToProcess: Array<{ path: string; mtime: number }>
  if (limit && sessionFilesMap.size > limit) {
    filesToProcess = [...sessionFilesMap.values()]
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
  } else {
    filesToProcess = [...sessionFilesMap.values()]
  }

  const logs: LogOption[] = []
  for (const fileInfo of filesToProcess) {
    try {
      const fileLogOptions = await loadAllLogsFromSessionFile(fileInfo.path)
      logs.push(...fileLogOptions)
    } catch {
      logForDebugging(`Failed to load session file: ${fileInfo.path}`)
    }
  }

  return logs
}

/**
 * Reads the first and last ~64KB of a JSONL file and extracts lite metadata.
 *
 * Head (first 64KB): isSidechain, projectPath, teamName, firstPrompt.
 * Tail (last 64KB): customTitle, tag, PR link, latest gitBranch.
 *
 * Accepts a shared buffer to avoid per-file allocation overhead.
 */
async function readLiteMetadata(
  filePath: string,
  fileSize: number,
  buf: Buffer,
): Promise<LiteMetadata> {
  const { head, tail } = await readHeadAndTail(filePath, fileSize, buf)
  if (!head) return { firstPrompt: '', isSidechain: false, forked: false }

  // Extract stable metadata from the first line via string search.
  // Works even when the first line is truncated (>64KB message).
  const isSidechain =
    head.includes('"isSidechain":true') || head.includes('"isSidechain": true')
  const projectPath = extractJsonStringField(head, 'cwd')
  const entrypoint = extractJsonStringField(head, 'entrypoint')
  const teamName = extractJsonStringField(head, 'teamName')
  const agentSetting = extractJsonStringField(head, 'agentSetting')

  // Prefer the last-prompt tail entry — captured by extractFirstPrompt at
  // write time (filtered, authoritative) and shows what the user was most
  // recently doing. Head scan is the fallback for sessions written before
  // last-prompt entries existed. Raw string scrapes of head are last resort
  // and catch array-format content blocks (VS Code <ide_selection> metadata).
  const firstPrompt =
    extractLastJsonStringField(tail, 'lastPrompt') ||
    extractFirstPromptFromChunk(head) ||
    extractJsonStringFieldPrefix(head, 'content', 200) ||
    extractJsonStringFieldPrefix(head, 'text', 200) ||
    ''

  // Extract tail metadata via string search (last occurrence wins).
  // User titles (customTitle field, from custom-title entries) win over
  // AI titles (aiTitle field, from ai-title entries). The distinct field
  // names mean extractLastJsonStringField naturally disambiguates.
  const customTitle =
    extractLastJsonStringField(tail, 'customTitle') ??
    extractLastJsonStringField(head, 'customTitle') ??
    extractLastJsonStringField(tail, 'aiTitle') ??
    extractLastJsonStringField(head, 'aiTitle')
  const summary = extractLastJsonStringField(tail, 'summary')
  const tag = extractLastJsonStringField(tail, 'tag')
  const gitBranch =
    extractLastJsonStringField(tail, 'gitBranch') ??
    extractJsonStringField(head, 'gitBranch')

  // PR link fields — prNumber is a number not a string, so try both
  const prUrl = extractLastJsonStringField(tail, 'prUrl')
  const prRepository = extractLastJsonStringField(tail, 'prRepository')
  let prNumber: number | undefined
  const prNumStr = extractLastJsonStringField(tail, 'prNumber')
  if (prNumStr) {
    prNumber = parseInt(prNumStr, 10) || undefined
  }
  if (!prNumber) {
    const prNumMatch = tail.lastIndexOf('"prNumber":')
    if (prNumMatch >= 0) {
      const afterColon = tail.slice(prNumMatch + 11, prNumMatch + 25)
      const num = parseInt(afterColon.trim(), 10)
      if (num > 0) prNumber = num
    }
  }

  // Last in-file timestamp ≈ real last-activity time. Used to correct
  // `modified`, which the lite path otherwise sets from file mtime — and mtime
  // drifts (by days) when bookkeeping rewrites the file long after the final
  // message. This is a flat scan of the tail, so the match may be a timestamped
  // bookkeeping write (e.g. a file-history-snapshot's nested timestamp) rather
  // than the last message itself — acceptable: those land within the session,
  // always far closer to truth than a drifted mtime. Undefined if the tail has
  // no timestamp at all (then enrichLog keeps the mtime fallback).
  const lastTimestamp = extractLastJsonStringField(tail, 'timestamp')

  // Does this transcript hold any conversation at all? Both windows are already
  // in memory, so this costs no extra IO. Checked in head AND tail because a
  // long diagnostic preamble can fill the head window of a file that does go on
  // to hold real messages. Both spacing variants are matched: the transcript
  // writer emits compact JSON while the diagnostic appenders emit spaced JSON.
  const hasConversation = [head, tail].some(
    chunk =>
      chunk.includes('"type":"user"') ||
      chunk.includes('"type": "user"') ||
      chunk.includes('"type":"assistant"') ||
      chunk.includes('"type": "assistant"'),
  )
  const forked = [head, tail].some(
    chunk =>
      chunk.includes('"type":"forked-session"') ||
      chunk.includes('"type": "forked-session"') ||
      chunk.includes('"forkedFrom"'),
  )

  return {
    firstPrompt,
    hasConversation,
    forked,
    gitBranch,
    entrypoint,
    isSidechain,
    projectPath,
    teamName,
    customTitle,
    summary,
    tag,
    agentSetting,
    prNumber,
    prUrl,
    prRepository,
    lastTimestamp,
  }
}

/**
 * Scans a chunk of text for the first meaningful user prompt.
 */
function extractFirstPromptFromChunk(chunk: string): string {
  let start = 0
  let hasTickMessages = false
  let firstCommandFallback = ''
  while (start < chunk.length) {
    const newlineIdx = chunk.indexOf('\n', start)
    const line =
      newlineIdx >= 0 ? chunk.slice(start, newlineIdx) : chunk.slice(start)
    start = newlineIdx >= 0 ? newlineIdx + 1 : chunk.length

    if (!line.includes('"type":"user"') && !line.includes('"type": "user"')) {
      continue
    }
    if (line.includes('"tool_result"')) continue
    if (line.includes('"isMeta":true') || line.includes('"isMeta": true'))
      continue

    try {
      const entry = jsonParse(line) as Record<string, unknown>
      if (entry.type !== 'user') continue

      const message = entry.message as Record<string, unknown> | undefined
      if (!message) continue

      const content = message.content
      // Collect all text values from the message content. For array content
      // (common in VS Code where IDE metadata tags come before the user's
      // actual prompt), iterate all text blocks so we don't miss the real
      // prompt hidden behind <ide_selection>/<ide_opened_file> blocks.
      const texts: string[] = []
      if (typeof content === 'string') {
        texts.push(content)
      } else if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>
          if (b.type === 'text' && typeof b.text === 'string') {
            texts.push(b.text as string)
          }
        }
      }

      for (const text of texts) {
        if (!text) continue

        let result = text.replace(/\n/g, ' ').trim()

        // Skip command messages (slash commands) but remember the first one
        // as a fallback title. Matches skip logic in
        // getFirstMeaningfulUserMessageTextContent, but instead of discarding
        // command messages entirely, we format them cleanly (e.g. "/clear")
        // so the session still appears in the resume picker.
        const commandNameTag = extractTag(result, COMMAND_NAME_TAG)
        if (commandNameTag) {
          const name = commandNameTag.replace(/^\//, '')
          const commandArgs = extractTag(result, 'command-args')?.trim() || ''
          if (builtInCommandNames().has(name) || !commandArgs) {
            if (!firstCommandFallback) {
              firstCommandFallback = commandNameTag
            }
            continue
          }
          // Custom command with meaningful args — use clean display
          return commandArgs
            ? `${commandNameTag} ${commandArgs}`
            : commandNameTag
        }

        // Format bash input with ! prefix before the generic XML skip
        const bashInput = extractTag(result, 'bash-input')
        if (bashInput) return `! ${bashInput}`

        if (SKIP_FIRST_PROMPT_PATTERN.test(result)) {
          if (
            (feature('PROACTIVE') || feature('KAIROS')) &&
            result.startsWith(`<${TICK_TAG}>`)
          )
            hasTickMessages = true
          continue
        }
        if (result.length > 200) {
          result = result.slice(0, 200).trim() + '…'
        }
        return result
      }
    } catch {
      continue
    }
  }
  // Session started with a slash command but had no subsequent real message —
  // use the clean command name so the session still appears in the resume picker
  if (firstCommandFallback) return firstCommandFallback
  // Proactive sessions have only tick messages — give them a synthetic prompt
  // so they're not filtered out by enrichLogs
  if ((feature('PROACTIVE') || feature('KAIROS')) && hasTickMessages)
    return 'Proactive session'
  return ''
}

/**
 * Like extractJsonStringField but returns the first `maxLen` characters of the
 * value even when the closing quote is missing (truncated buffer). Newline
 * escapes are replaced with spaces and the result is trimmed.
 */
function extractJsonStringFieldPrefix(
  text: string,
  key: string,
  maxLen: number,
): string {
  const patterns = [`"${key}":"`, `"${key}": "`]
  for (const pattern of patterns) {
    const idx = text.indexOf(pattern)
    if (idx < 0) continue

    const valueStart = idx + pattern.length
    // Grab up to maxLen characters from the value, stopping at closing quote
    let i = valueStart
    let collected = 0
    while (i < text.length && collected < maxLen) {
      if (text[i] === '\\') {
        i += 2 // skip escaped char
        collected++
        continue
      }
      if (text[i] === '"') break
      i++
      collected++
    }
    const raw = text.slice(valueStart, i)
    return raw.replace(/\\n/g, ' ').replace(/\\t/g, ' ').trim()
  }
  return ''
}

/**
 * Deduplicates logs by sessionId, keeping the entry with the newest
 * modified time. Returns sorted logs with sequential value indices.
 */
function deduplicateLogsBySessionId(logs: LogOption[]): LogOption[] {
  const deduped = new Map<string, LogOption>()
  for (const log of logs) {
    if (!log.sessionId) continue
    const existing = deduped.get(log.sessionId)
    if (!existing || log.modified.getTime() > existing.modified.getTime()) {
      deduped.set(log.sessionId, log)
    }
  }
  return sortLogs([...deduped.values()]).map((log, i) => ({
    ...log,
    value: i,
  }))
}

/**
 * Returns lite LogOption[] from pure filesystem metadata (stat only).
 * No file reads — instant. Call `enrichLogs` to enrich
 * visible sessions with firstPrompt, gitBranch, customTitle, etc.
 */
export async function getSessionFilesLite(
  projectDir: string,
  limit?: number,
  projectPath?: string,
): Promise<LogOption[]> {
  const sessionFilesMap = await getSessionFilesWithMtime(projectDir)

  // Sort by mtime descending and apply limit
  let entries = [...sessionFilesMap.entries()].sort(
    (a, b) => b[1].mtime - a[1].mtime,
  )
  if (limit && entries.length > limit) {
    entries = entries.slice(0, limit)
  }

  const logs: LogOption[] = []

  for (const [sessionId, fileInfo] of entries) {
    logs.push({
      date: new Date(fileInfo.mtime).toISOString(),
      messages: [],
      isLite: true,
      fullPath: fileInfo.path,
      value: 0,
      created: new Date(fileInfo.ctime),
      modified: new Date(fileInfo.mtime),
      firstPrompt: '',
      messageCount: 0,
      fileSize: fileInfo.size,
      isSidechain: false,
      sessionId,
      projectPath,
    })
  }

  // logs are freshly pushed above — safe to mutate in place
  const sorted = sortLogs(logs)
  sorted.forEach((log, i) => {
    log.value = i
  })
  return sorted
}

/**
 * Enriches a lite log with metadata from its JSONL file.
 * Returns the enriched log, or null if the log has no meaningful content
 * (no firstPrompt, no customTitle — e.g., metadata-only session files).
 */
async function enrichLog(
  log: LogOption,
  readBuf: Buffer,
): Promise<LogOption | null> {
  if (!log.isLite || !log.fullPath) return log

  const meta = await readLiteMetadata(log.fullPath, log.fileSize ?? 0, readBuf)

  // Prefer the last in-file timestamp over the lite path's mtime fallback
  // (`log.modified`), which drifts when the file is rewritten after the final
  // message. Keep mtime if the timestamp is missing or unparseable.
  let modified = log.modified
  if (meta.lastTimestamp) {
    const parsed = new Date(meta.lastTimestamp)
    if (!Number.isNaN(parsed.getTime())) modified = parsed
  }

  const enriched: LogOption = {
    ...log,
    isLite: false,
    modified,
    firstPrompt: meta.firstPrompt,
    gitBranch: meta.gitBranch,
    entrypoint: meta.entrypoint,
    isSidechain: meta.isSidechain,
    teamName: meta.teamName,
    customTitle: meta.customTitle,
    summary: meta.summary,
    tag: meta.tag,
    agentSetting: meta.agentSetting,
    prNumber: meta.prNumber,
    prUrl: meta.prUrl,
    prRepository: meta.prRepository,
    projectPath: meta.projectPath ?? log.projectPath,
    hasConversation: meta.hasConversation,
    forked: meta.forked,
  }

  // Provide a fallback title for sessions where we couldn't extract the first
  // prompt (e.g., large first messages that exceed the 16KB read buffer).
  // Previously these sessions were silently dropped, making them inaccessible
  // via /resume after crashes or large-context sessions.
  if (!enriched.firstPrompt && !enriched.customTitle) {
    enriched.firstPrompt = '(session)'
  }
  // Filter: skip sidechains and agent sessions
  if (enriched.isSidechain) {
    logForDebugging(
      `Session ${log.sessionId} filtered from /resume: isSidechain=true`,
    )
    return null
  }
  if (enriched.teamName) {
    logForDebugging(
      `Session ${log.sessionId} filtered from /resume: teamName=${enriched.teamName}`,
    )
    return null
  }
  // A transcript with no user/assistant entry has nothing to resume: selecting it
  // fails with "no conversation found". These are files written by the diagnostic
  // appenders (`recordCodexSendPath`/`recordCodexStreamSurface`) when no real
  // session owned the write — 162 of 514 transcripts on one machine, listed as
  // '(session)' rows. Note this is NOT the same as the '(session)' title above: a
  // real session whose first prompt outgrew the read window also gets that title
  // and IS resumable, so the content flag decides, never the label.
  if (enriched.hasConversation === false) {
    logForDebugging(
      `Session ${log.sessionId} filtered from /resume: no conversation entries`,
    )
    return null
  }

  return enriched
}

/**
 * Enriches enough lite logs from `allLogs` (starting at `startIndex`) to
 * produce `count` valid results. Returns the valid enriched logs and the
 * index where scanning stopped (for progressive loading to continue from).
 */
export async function enrichLogs(
  allLogs: LogOption[],
  startIndex: number,
  count: number,
): Promise<{ logs: LogOption[]; nextIndex: number }> {
  const result: LogOption[] = []
  const readBuf = Buffer.alloc(LITE_READ_BUF_SIZE)
  let i = startIndex

  while (i < allLogs.length && result.length < count) {
    const log = allLogs[i]!
    i++

    const enriched = await enrichLog(log, readBuf)
    if (enriched) {
      result.push(enriched)
    }
  }

  const scanned = i - startIndex
  const filtered = scanned - result.length
  if (filtered > 0) {
    logForDebugging(
      `/resume: enriched ${scanned} sessions, ${filtered} filtered out, ${result.length} visible (${allLogs.length - i} remaining on disk)`,
    )
  }

  return { logs: result, nextIndex: i }
}
