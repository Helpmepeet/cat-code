import type { NestedTranscriptRow, ResultRow } from './transcriptProjector.js'

export const OPEN_ACCOUNTS_LABEL = 'Open Accounts'
export const RETRY_LABEL = 'Retry'
export const USAGE_LIMIT_TITLE = 'Usage limit reached'
export type NotificationRetryBlocker = 'attachment' | 'folder'

export function retryComposerBlocked(input: {
  draft: string
  imageCount: number
  hasFile: boolean
  attachmentPending: boolean
  workspaceBusy: boolean
  folderUnavailable: boolean
  hasProjectRoute: boolean
}): boolean {
  return !!input.draft.trim() || input.imageCount > 0 || input.hasFile ||
    input.attachmentPending || input.workspaceBusy || input.folderUnavailable || input.hasProjectRoute
}

export const RESULT_ERROR_LABELS = new Map([
  ['error_max_turns', 'Stopped · max turns reached'],
  ['error_max_budget_usd', 'Stopped · budget limit reached'],
  ['error_max_structured_output_retries', 'Stopped · max output retries'],
])

export function turnResultFailureCopy(row: Pick<ResultRow, 'subtype' | 'providerCode' | 'providerMessage' | 'errorStatus' | 'durationMs' | 'totalCostUsd'>) {
  if (row.subtype === 'error_auth_required' || row.subtype === 'error_during_execution') return turnFailureCopy(row)
  return {
    title: RESULT_ERROR_LABELS.get(row.subtype) ?? 'Turn failed',
    detail: [
      row.durationMs === undefined ? null : `${(row.durationMs / 1000).toFixed(1)}s`,
      row.totalCostUsd === undefined ? null : `$${row.totalCostUsd.toFixed(4)}`,
    ].filter((part): part is string => part !== null).join(' · '),
    action: null,
  }
}

/** Claim before sending: failed transport must not permit a second resend. */
export function claimTurnRetry(claimed: Set<string>, resultId: string): boolean {
  if (claimed.has(resultId)) return false
  claimed.add(resultId)
  return true
}

export function turnFailureCopy(row: Pick<ResultRow, 'subtype' | 'providerCode' | 'providerMessage' | 'errorStatus'>) {
  const message = row.providerMessage ?? ''
  if (row.subtype === 'error_auth_required' || row.providerCode === 'authentication_failed') {
    return { title: 'Sign-in expired', detail: 'Sign in again in Accounts to continue.', action: 'accounts' as const }
  }
  if (row.errorStatus === 529 || /\b529\b.*\bOverloaded\b/i.test(message)) {
    return { title: 'The service is overloaded', detail: '', action: null }
  }
  if (/^(?:Codex (?:account )?)?usage limit reached\b/i.test(message) || /\busage_limit_reached\b/.test(message)) {
    return { title: USAGE_LIMIT_TITLE, detail: 'Switch to another account to continue.', action: 'accounts' as const }
  }
  const detail = message
    .replace(/(?:[.·]\s*)?(?:Please\s+)?(?:run|use)\s+\/(?:login|switch-account|accounts)\b[^\n]*/gi, '')
    .trim()
  return { title: 'This turn could not finish', detail: detail || 'Try again. If this keeps happening, save a diagnostics bundle.', action: 'diagnostics' as const }
}

/**
 * A resend is refused only while an attached turn is running, where it would
 * queue into that turn. Every other state goes through the ordinary submit
 * planner, which holds the prompt for a parked or spawning session.
 */
export function retrySendBlocked(connection: { status: string; inputEnabled: boolean }, logInputEnabled: boolean): boolean {
  return connection.status === 'ready' && !(connection.inputEnabled && logInputEnabled)
}

/** Only an unambiguous plain-text turn can be resent without attachment state. */
export function retryableTurn(rows: readonly NestedTranscriptRow[]): { resultId: string; text: string } | null {
  let resultIndex = rows.length - 1
  while (resultIndex >= 0 && rows[resultIndex]!.kind !== 'result') resultIndex--
  const result = rows[resultIndex]
  if (result?.kind !== 'result' || !result.isError || result.subtype === 'interrupted') return null
  if (rows.slice(resultIndex + 1).some(row => row.kind === 'user-text' || row.kind === 'user-image' || row.kind === 'question-reply' || row.kind === 'assistant-text')) return null
  let userIndex = resultIndex - 1
  while (userIndex >= 0 && rows[userIndex]!.kind !== 'user-text') {
    const kind = rows[userIndex]!.kind
    if (kind === 'result' || kind === 'turn-stopped' || kind === 'injected-turn' || kind === 'question-reply' || kind === 'command-echo' || kind === 'user-image') return null
    userIndex--
  }
  const user = rows[userIndex]
  if (user?.kind !== 'user-text' || !user.content.trim() || user.content.trimStart().startsWith('/')) return null
  if (rows.some(row => (row.kind === 'user-image' || row.kind === 'user-text') && row.frameId === user.frameId && row.id !== user.id)) return null
  return { resultId: result.id, text: user.content }
}
