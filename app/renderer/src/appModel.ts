import type { SDKMessage } from '@cat-code/engine/sdk'
import type {
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
import type {
  NestedTranscriptRow,
  TranscriptRow,
} from './transcriptProjector.js'

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
 * The operator's own turn boundary, shared by the activity verb and the token
 * byline: it must NOT count `task-notification`.
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
 *
 * Returns the map it was given when nothing moved, so the caller's `setState`
 * is a no-op on the frames that change something else.
 */
export function reduceTurnStarts(
  starts: ReadonlyMap<SessionId, number>,
  connection: ConnectionState,
  now: number,
): ReadonlyMap<SessionId, number> {
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
    if (isTurnRunning(snapshot)) {
      if (!next.has(sessionId)) {
        next.set(sessionId, now)
        changed = true
      }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Fold one partial usage's output into an accumulator, mirroring the engine's
 * `updateUsage` (`src/services/api/claude.ts:3237-3259`): each stream event
 * restates the message's usage SO FAR, so the newest present reading wins. It
 * is not a sum. Only `output_tokens` is read here — the byline reports what the
 * model produced, and the input buckets belong to the context gauge.
 *
 * DELIBERATE DUPLICATION, pending: `contextUsage.ts` holds the four-bucket
 * version of this fold and its own `isRecord`. It was mid-rewrite in another
 * session when this landed, so importing from it would have meant depending on a
 * file being restructured. Dedupe both once that settles; a shared helper needs
 * the four-bucket shape, since this one reads output only.
 */
function foldOutputTokens(prior: number, part: unknown): number {
  if (!isRecord(part)) return prior
  const next = part.output_tokens
  return typeof next === 'number' && Number.isFinite(next) ? next : prior
}

/**
 * Real `output_tokens` per API message id, for every assistant message the
 * stream layer has carried through to `message_stop`.
 *
 * Reasoning is billed INSIDE `output_tokens` on both providers: Anthropic's
 * `Usage` has no separate thinking field
 * (`node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts:1368`) and
 * the Codex adapter maps OpenAI's `output_tokens` into that same field
 * (`src/services/api/codex-fetch-adapter.ts:2908`). So this counts an encrypted
 * `redacted-thinking` blob and a summarized GPT reasoning trace exactly, where
 * counting the characters of the visible rows counts the first as zero and the
 * second as a fraction.
 *
 * `message_stop` is the completion gate, not `message_delta`, and that is what
 * keeps the byline moving. Anthropic seeds `output_tokens: 1` on
 * `message_start`; the Codex adapter seeds `{0,0,0,0}` and fills real numbers
 * only on its final delta (`codex-fetch-adapter.ts:1719,2908`). Publishing
 * either seed would freeze the counter for the whole message and then jump. The
 * fold-then-close shape is the engine's own, per message
 * (`src/QueryEngine.ts:908-936`).
 *
 * Bounded gap: the raw log evicts oldest-first past its retention caps
 * (`rawMessageLog.ts:35`), so a single turn long enough to outrun them can lose
 * a `message_start` and leave that message with no entry. It then falls through
 * to the character estimate below, which is the pre-existing behaviour, never a
 * zero.
 */
function selectCompletedOutputTokens(
  messages: readonly SDKMessage[],
): Map<string, number> {
  const completed = new Map<string, number>()
  let openMessageId: string | null = null
  let openOutput = 0
  for (const message of messages) {
    if (!message || message.type !== 'stream_event') continue
    const event = isRecord(message.event) ? message.event : null
    if (!event) continue
    if (event.type === 'message_start') {
      const started = isRecord(event.message) ? event.message : null
      openMessageId =
        typeof started?.id === 'string' && started.id.length > 0
          ? started.id
          : null
      openOutput = foldOutputTokens(0, started?.usage)
    } else if (event.type === 'message_delta') {
      openOutput = foldOutputTokens(openOutput, event.usage)
    } else if (event.type === 'message_stop') {
      if (openMessageId !== null) completed.set(openMessageId, openOutput)
      openMessageId = null
      openOutput = 0
    }
  }
  return completed
}

/**
 * The byline's per-turn output count: real tokens for the messages that have
 * finished, a character estimate for the one still streaming.
 *
 * Hybrid because the two halves fail in opposite directions. `message_delta`
 * reports output only at the END of a message, so a pure-usage counter would
 * sit still for a minute and then jump. Characters undercount unevenly: opaque
 * reasoning has no text at all, a GPT reasoning summary is a fraction of what
 * was billed, thinking deltas project no row until their block closes, and
 * chars/4 is a heuristic on top of that.
 *
 * THE JOIN. Turn boundaries are a projected-ROW fact and real usage is a RAW
 * MESSAGE fact, and the two are married by `row.messageId`, which is the same
 * API message id `message_start` announces (`transcriptProjector.ts:821`, and
 * `:1495` for the streaming rows). Nothing re-derives a turn boundary on the raw
 * side, which is the trap here: `type: 'user'` also covers tool results, command
 * results and four engine-injected origins (`transcriptProjector.ts:272-299`),
 * so classifying it again would duplicate engine machinery the projector already
 * owns. A message with no entry in the usage map — still streaming, replayed
 * history, or evicted from the raw log — falls through to the character
 * estimate, so this degrades to the previous behaviour instead of to zero.
 *
 * Subagent traffic is excluded, as it was before: its rows nest under their Task
 * card rather than sitting at top level, and the engine never forwards subagent
 * stream deltas, so neither half can see it. The context gauge draws the same
 * line (`contextUsage.ts` `isMainThread`).
 *
 * Fixed 2026-08-02 along the way: this used to treat `task-notification` as a
 * turn boundary, so a background agent finishing mid-turn restarted the count
 * from zero. The defect was left in place while the number was a rough estimate;
 * with real tokens the reset throws away a number that was correct, so it now
 * shares the operator boundary that `deriveActivity` already uses.
 */
export function selectLiveTokenEstimate(
  rows: readonly NestedTranscriptRow[],
  messages: readonly SDKMessage[],
): number {
  const start = lastOperatorTurnStart(rows)
  if (start === -1) return 0
  const completed = selectCompletedOutputTokens(messages)
  const counted = new Set<string>()
  let reported = 0
  let chars = 0
  for (let i = start + 1; i < rows.length; i++) {
    const row = rows[i]
    if ('messageId' in row) {
      const output = completed.get(row.messageId)
      // One message, one reading: its blocks are many rows but its usage is
      // stated once for the whole message.
      if (output !== undefined) {
        if (!counted.has(row.messageId)) {
          counted.add(row.messageId)
          reported += output
        }
        continue
      }
    }
    if (row.kind === 'assistant-text' || row.kind === 'thinking') {
      chars += row.content.length
    } else if (row.kind === 'tool-use') {
      chars += JSON.stringify(row.input).length
    }
  }
  return reported + Math.round(chars / 4)
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
