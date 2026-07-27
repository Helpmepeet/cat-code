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

export type OAuthContext = 'first-run' | 'reauth' | 'add-account' | null

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

export function deriveActivity(rows: NestedTranscriptRow[]): {
  verb: string
  target: string | null
} {
  const last = rows[rows.length - 1]
  if (!last) return { verb: 'Working', target: null }
  if (last.kind === 'tool-use' && last.status === 'pending') {
    return { verb: 'Running', target: last.toolName }
  }
  if (last.kind === 'thinking') return { verb: 'Thinking', target: null }
  if (last.kind === 'assistant-text' && last.isStreaming === true) {
    return { verb: 'Responding', target: null }
  }
  return { verb: 'Working', target: null }
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
