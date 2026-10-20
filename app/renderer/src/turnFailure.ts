import type { NestedTranscriptRow, ResultRow } from './transcriptProjector.js'

export function turnFailureCopy(row: Pick<ResultRow, 'subtype' | 'providerCode' | 'providerMessage' | 'errorStatus'>) {
  const message = row.providerMessage ?? ''
  if (row.subtype === 'error_auth_required' || row.providerCode === 'authentication_failed') {
    return { title: 'Sign-in expired', detail: 'Sign in again in Accounts to continue.', action: 'accounts' as const }
  }
  if (row.errorStatus === 529 || /\b529\b.*\bOverloaded\b/i.test(message)) {
    return { title: 'The service is overloaded', detail: '', action: null }
  }
  if (/^(?:Codex (?:account )?)?usage limit reached\b/i.test(message) || /\busage_limit_reached\b/.test(message)) {
    return { title: 'Usage limit reached', detail: 'Switch to another account to continue.', action: 'accounts' as const }
  }
  const detail = message
    .replace(/(?:[.·]\s*)?(?:Please\s+)?(?:run|use)\s+\/(?:login|switch-account|accounts)\b[^\n]*/gi, '')
    .trim()
  return { title: 'This turn could not finish', detail: detail || 'Try again. If this keeps happening, save a diagnostics bundle.', action: 'diagnostics' as const }
}

/** Only an unambiguous plain-text turn can be resent without attachment state. */
export function retryableTurn(rows: readonly NestedTranscriptRow[]): { resultId: string; text: string } | null {
  let resultIndex = rows.length - 1
  while (resultIndex >= 0 && rows[resultIndex]!.kind !== 'result') resultIndex--
  const result = rows[resultIndex]
  if (result?.kind !== 'result' || !result.isError || result.subtype === 'interrupted') return null
  if (rows.slice(resultIndex + 1).some(row => row.kind === 'user-text' || row.kind === 'user-image' || row.kind === 'assistant-text')) return null
  let userIndex = resultIndex - 1
  while (userIndex >= 0 && rows[userIndex]!.kind !== 'user-text') {
    const kind = rows[userIndex]!.kind
    if (kind === 'result' || kind === 'turn-stopped' || kind === 'injected-turn' || kind === 'command-echo' || kind === 'user-image') return null
    userIndex--
  }
  const user = rows[userIndex]
  if (user?.kind !== 'user-text' || !user.content.trim() || user.content.trimStart().startsWith('/')) return null
  if (rows.some(row => (row.kind === 'user-image' || row.kind === 'user-text') && row.frameId === user.frameId && row.id !== user.id)) return null
  return { resultId: result.id, text: user.content }
}
