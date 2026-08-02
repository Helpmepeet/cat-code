import type {
  AccountsSnapshot,
  CatCodeBridge,
  PermissionResponseInput,
  RunControlsSnapshot,
  SessionId,
} from '../../shared/protocol.js'
import type { RawMessageSessionLog } from './rawMessageLog.js'
import type {
  NestedTranscriptRow,
  TranscriptRow,
} from './transcriptProjector.js'

export function shouldShowFirstRunOAuth(
  snapshot: AccountsSnapshot | null,
  trustGateVisible: boolean,
): boolean {
  return (
    !trustGateVisible &&
    snapshot !== null &&
    snapshot.initialized &&
    snapshot.anthropicInitialized &&
    !snapshot.anthropicRouteAvailable &&
    snapshot.poolCount + snapshot.anthropicPoolCount === 0
  )
}

/**
 * Which surface owns the shared `account.login` flow.
 *
 * `'reauth'` was removed with the floating reauth card (P4-34): the banner that
 * used to launch it went with ruling #12
 * (`docs/migration/decisions/STARTUP-GATES.md`), leaving a context only the
 * card's own Retry button could set. Re-authentication is the same act as any
 * other sign-in and runs through these two surfaces.
 */
export type OAuthContext = 'first-run' | 'add-account' | null

export function claimOAuthContextForAccountLogin(
  current: OAuthContext,
): Exclude<OAuthContext, null> {
  return current ?? 'add-account'
}

export function shouldShowAnthropicPoolAccount(
  provider: RunControlsSnapshot['model']['provider'] | null,
  snapshot: AccountsSnapshot | null,
): boolean {
  return (
    provider === 'anthropic' &&
    snapshot?.anthropicSubscriptionActive === true
  )
}

/**
 * The operator's own turn boundary. Deliberately NOT `TURN_BOUNDARY_KINDS`
 * below, which also counts `task-notification`.
 *
 * A background agent's completion is injected MID-TURN — the drain is the live
 * path by which an engine-injected turn reaches an out-of-process UI
 * (`src/QueryEngine.ts:995`, drained at `src/query.ts:1605`). Counting it as a
 * boundary would start a fresh window in the middle of real work, orphan every
 * tool still running, and report the session as idle while it works: exactly
 * the defect the scan below exists to fix.
 *
 * Injected turns project to their own row kinds (`task-notification`,
 * `injected-turn`) rather than to `user-text`, so these three are precisely the
 * rows an operator authored.
 */
const OPERATOR_TURN_BOUNDARY_KINDS: ReadonlySet<NestedTranscriptRow['kind']> =
  new Set(['user-text', 'user-image', 'command-echo'])

function lastOperatorTurnStart(rows: readonly NestedTranscriptRow[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (OPERATOR_TURN_BOUNDARY_KINDS.has(rows[i].kind)) return i
  }
  return -1
}

/**
 * What the activity row says while a turn runs.
 *
 * Reports the state of the TURN, not of the last row. Reading only the tail
 * (the original shape) got this wrong whenever more than one tool ran: three
 * parallel calls whose last row finished first flipped the verb to "Working"
 * with two tools still executing.
 *
 * A pending tool outranks everything else because it is the most specific true
 * statement available. The scan is scoped to the current operator turn for a
 * second reason beyond parallelism: an aborted turn leaves its `tool-use` row
 * `pending` forever, since no `tool_result` ever arrives, so an unscoped search
 * would pin the verb to that dead tool for every later turn.
 *
 * `Thinking` stays tail-driven and is close to unreachable today, because
 * thinking deltas project no row and the thinking row is never last within its
 * own message. It is deliberately NOT synthesized from the absence of other
 * activity, which would assert a state the renderer cannot observe; it becomes
 * real once thinking streams.
 */
export function deriveActivity(rows: NestedTranscriptRow[]): {
  verb: string
  target: string | null
} {
  const working = { verb: 'Working', target: null }
  const last = rows[rows.length - 1]
  if (!last) return working

  const start = lastOperatorTurnStart(rows)
  if (start !== -1) {
    for (let i = start + 1; i < rows.length; i++) {
      const row = rows[i]
      // The FIRST pending tool in the turn, so the target stays put while
      // siblings finish out of order instead of flickering between names.
      // Naming several at once is a user-visible text decision that has not
      // been made; until it is, this reports one tool that is genuinely running
      // rather than inventing a format.
      if (row.kind === 'tool-use' && row.status === 'pending') {
        return { verb: 'Running', target: row.toolName }
      }
    }
  }

  if (last.kind === 'thinking') return { verb: 'Thinking', target: null }
  if (last.kind === 'assistant-text' && last.isStreaming === true) {
    return { verb: 'Responding', target: null }
  }
  return working
}

export function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0
    ? `${minutes}m ${String(seconds).padStart(2, '0')}s`
    : `${seconds}s`
}

export function fmtTok(n: number): string {
  const r = Math.round(n)
  if (r < 1000) return String(r)
  const k = r / 1000
  return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`
}

/**
 * KNOWN DEFECT, pre-existing and not owned here: `task-notification` is
 * injected mid-turn (see `OPERATOR_TURN_BOUNDARY_KINDS` above), so a background
 * agent finishing while the turn runs restarts this estimate from zero. Use
 * `OPERATOR_TURN_BOUNDARY_KINDS` for anything new; this set is left as-is
 * because changing it changes a number already on screen.
 */
const TURN_BOUNDARY_KINDS: ReadonlySet<NestedTranscriptRow['kind']> = new Set([
  'user-text',
  'user-image',
  'command-echo',
  'task-notification',
])

export function selectLiveTokenEstimate(
  rows: readonly NestedTranscriptRow[],
): number {
  let start = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (TURN_BOUNDARY_KINDS.has(rows[i].kind)) {
      start = i
      break
    }
  }
  if (start === -1) return 0
  let chars = 0
  for (let i = start + 1; i < rows.length; i++) {
    const row = rows[i]
    if (row.kind === 'assistant-text' || row.kind === 'thinking') {
      chars += row.content.length
    } else if (row.kind === 'tool-use') {
      chars += JSON.stringify(row.input).length
    }
  }
  return Math.round(chars / 4)
}

export function sendPermissionResponse(
  bridge: Pick<CatCodeBridge, 'respondPermission'>,
  sessionId: SessionId,
  requestId: string,
  response: PermissionResponseInput,
): string | null {
  try {
    bridge.respondPermission(sessionId, requestId, response)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export type PromptDraftState = Record<SessionId, string>

export function selectPromptDraft(
  drafts: PromptDraftState,
  sessionId: SessionId | null,
): string {
  if (!sessionId) return ''
  return drafts[sessionId] ?? ''
}

export function reducePromptDrafts(
  drafts: PromptDraftState,
  sessionId: SessionId | null,
  value: string,
): PromptDraftState {
  if (!sessionId) return drafts
  if (value.length === 0) {
    if (!(sessionId in drafts)) return drafts
    const next = { ...drafts }
    delete next[sessionId]
    return next
  }
  if (drafts[sessionId] === value) return drafts
  return { ...drafts, [sessionId]: value }
}

export function buildDebugExport(
  transcriptRows: TranscriptRow[],
  rawLog: RawMessageSessionLog,
): string {
  return `# CatCode debug export

> ⚠️ [!WARNING]
> **POTENTIALLY SENSITIVE:** The raw transcript and debug clipboard output may contain
> sensitive file contents, command inputs/outputs, or credential material that passed
> the outbound key-name secret guard. Handle this export with care.

## Transcript (projected)

\`\`\`json
${JSON.stringify(transcriptRows, null, 2)}
\`\`\`

## Raw SDKMessage events

Raw retention: ${rawLog.truncated ? 'TRUNCATED' : 'complete'} (${rawLog.retainedBytes} UTF-8 JSON bytes retained)

\`\`\`json
${JSON.stringify(rawLog.messages, null, 2)}
\`\`\`
`
}
