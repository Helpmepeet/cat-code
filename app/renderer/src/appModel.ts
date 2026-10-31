import type {
  AccountResultFrame,
  AccountsSnapshot,
  CatCodeBridge,
  PermissionResponseInput,
  RunControlsSnapshot,
  SessionId,
} from '../../shared/protocol.js'
import type { HostError } from '../../shared/hostApi.js'
import type {
  ConnectionSnapshot,
  ConnectionState,
} from './connectionState.js'
import type { RawMessageSessionLog } from './rawMessageLog.js'
import type { WorkspaceMoveDisplay } from '../../shared/hostApi.js'
import type {
  NestedTranscriptRow,
  TranscriptRow,
} from './transcriptProjector.js'

/** Message text for anything thrown or rejected — shared by the shell and the
 * pane, so neither has to import the other. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function hostErrorMessage(error: HostError): string {
  return `${error.code}: ${error.message}`
}

export async function restartConnection(
  bridge: Pick<CatCodeBridge, 'restart'>,
  sessionId: SessionId,
): Promise<string | null> {
  try {
    const result = await bridge.restart(sessionId)
    return result.ok ? null : hostErrorMessage(result.error)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

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

/**
 * A paste-code or alias submission made from the OAuth surface. Both verbs can
 * be refused by the engine (an unparseable code, a taken alias) while the flow
 * itself stays where it was, so the surface needs the verb's own outcome to
 * explain why nothing moved.
 */
export type OAuthSubmitStatus =
  | { state: 'idle' }
  | { state: 'pending'; requestId: string }
  | { state: 'accepted' }
  | { state: 'rejected'; message: string }

/** Settle a pending submission once its own `account.result` arrives. */
export function settleOAuthSubmitStatus(
  current: OAuthSubmitStatus,
  result: AccountResultFrame | null,
): OAuthSubmitStatus {
  if (
    current.state !== 'pending' ||
    result === null ||
    result.requestId !== current.requestId
  ) {
    return current
  }
  return result.ok
    ? { state: 'accepted' }
    : { state: 'rejected', message: result.message }
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
 * The operator's own activity boundary must NOT count `task-notification`.
 * Output accounting uses engine turn events independently of these rows.
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
 *
 * `Compacting` outranks even a pending tool, and is the one verb that does not
 * come from the rows: compaction runs between turns of the loop, mints no row
 * while it works, and used to fall all the way through to "Working". Its source
 * is the engine's own status signal, projected to `selectIsCompacting`. A tool
 * left pending by the turn that triggered an auto-compaction is not what the
 * session is doing.
 */
export function deriveActivity(
  rows: NestedTranscriptRow[],
  compacting = false,
): {
  verb: string
  target: string | null
} {
  if (compacting) return { verb: 'Compacting', target: null }
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
        if (row.toolName === 'JumpWorkspace' || row.toolName === 'JumpToProject') continue
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

/** A turn is running in this session: the engine is attached and it has taken
 * the input away. The same gate the composer and the activity byline read, in
 * one place so the elapsed clock below cannot disagree with them. */
export function isTurnRunning(snapshot: ConnectionSnapshot): boolean {
  return snapshot.status === 'ready' && !snapshot.inputEnabled
}

/**
 * When each session's current turn started, keyed by session.
 *
 * This lives above the panes on purpose. A pane is mounted only while its
 * session is on screen, so a clock owned by the pane restamped its start on
 * every tab switch: the elapsed count restarted at 0s, and the token byline
 * (gated on 30s of turn time) disappeared with it. Connection frames arrive for
 * background sessions too, so a start recorded here is stamped once, when that
 * session's turn begins, and held until the turn ends whatever is on screen.
 * An accepted workspace jump holds that start across source idle and engine
 * replacement. Once the destination turn has run, its live idle edge releases
 * the start even if the host's final outcome has not arrived yet.
 *
 * Returns the map it was given when nothing moved, so the caller's `setState`
 * is a no-op on the frames that change something else.
 */
export type TurnStart = { at: number; jumpId: string | null; continuationStarted: boolean }

export function reduceTurnStarts(
  starts: ReadonlyMap<SessionId, TurnStart>,
  connection: ConnectionState,
  descriptors: Readonly<Record<SessionId, { workspaceMove?: WorkspaceMoveDisplay | null } | undefined>>,
  now: number,
): ReadonlyMap<SessionId, TurnStart> {
  const next = new Map(starts)
  let changed = false
  for (const sessionId of next.keys()) {
    if (!(sessionId in connection.sessions)) {
      next.delete(sessionId)
      changed = true
    }
  }
  for (const [sessionId, snapshot] of Object.entries(connection.sessions) as [
    SessionId,
    ConnectionSnapshot,
  ][]) {
    const move = descriptors[sessionId]?.workspaceMove
    const jumpActive = move?.agentJump === true &&
      move.continuation !== undefined && move.continuation !== 'finished' &&
      (move.phase === 'moving' || move.phase === 'arrived')
    const previous = next.get(sessionId)
    if (isTurnRunning(snapshot)) {
      if (!previous) {
        next.set(sessionId, {
          at: now,
          jumpId: jumpActive ? move.id : null,
          continuationStarted: jumpActive && move.phase === 'arrived',
        })
        changed = true
      }
      else if (jumpActive && previous.jumpId !== move.id) {
        next.set(sessionId, { ...previous, jumpId: move.id, continuationStarted: move.phase === 'arrived' })
        changed = true
      } else if (jumpActive && move.phase === 'arrived' && !previous.continuationStarted) {
        next.set(sessionId, { ...previous, continuationStarted: true })
        changed = true
      }
    } else if (jumpActive && previous?.jumpId === move.id && !previous.continuationStarted) {
      continue
    } else if (next.delete(sessionId)) {
      changed = true
    }
  }
  return changed ? next : starts
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
${
  rawLog.truncated
    ? 'Expect this section to be SHORTER than the projected transcript above. The raw log is capped per session and drops its oldest events once the cap is hit; the projected transcript is not capped. The two sections covering different spans is normal, not a bug.\n'
    : ''
}
\`\`\`json
${JSON.stringify(rawLog.messages, null, 2)}
\`\`\`
`
}
