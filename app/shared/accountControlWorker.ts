/** Session-independent account commands. See ACCOUNTS-OWNERSHIP.md. */
import type { AccountVerbMessage, AccountResultFrame, AccountLoginProvider, OAuthLoginProgress } from './protocol.js'
import { MAX_TEXT_FIELD_CHARS } from './limits.js'
import { isBoolean, isRecord, isStringOrNull, narrowExact, oneOf, optional } from './narrow.js'

export type AccountControlVerb = Exclude<AccountVerbMessage, { type: 'account.delete' | 'account.logout' }>
export const MAX_ACCOUNT_CONTROL_RECORD_BYTES = 256 * 1024
export const ACCOUNT_CONTROL_VERSION = 2
export type AccountControlEvent =
  | { type: 'progress'; version: 2; provider: AccountLoginProvider; progress: OAuthLoginProgress | null }
  | { type: 'result'; version: 2; requestId: string; verb: AccountControlVerb['type']; ok: boolean; message: string; changed: boolean; touchAllResults?: AccountResultFrame['touchAllResults'] }

const types = ['account.switch', 'account.rename', 'account.touchAll', 'account.login', 'account.oauthPasteCode', 'account.oauthAlias', 'account.oauthCancel'] as const
const provider = oneOf(['openai', 'anthropic'] as const)
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_TEXT_FIELD_CHARS
const nonempty = (value: unknown): value is string => text(value) && value.length > 0

/** Engine installation authority only. Never construct this from renderer intent. */
export type AccountLoginReceipt = {
  provider: AccountLoginProvider
  accountId: string
  operationId: string
  outcome: 'committed' | 'persistence_pending'
  loginGeneration: number | null
}

export function parseAccountLoginReceipt(value: unknown): AccountLoginReceipt | null {
  const receipt = narrowExact(value, {
    provider, accountId: nonempty, operationId: nonempty,
    outcome: oneOf(['committed', 'persistence_pending'] as const),
    loginGeneration: (v: unknown): v is number | null =>
      v === null || (typeof v === 'number' && Number.isSafeInteger(v) && v > 0),
  })
  if (!receipt || (receipt.outcome === 'committed' && receipt.loginGeneration === null)) return null
  return receipt
}

export function parseAccountControlVerb(value: unknown): AccountControlVerb | null {
  if (!isRecord(value)) return null
  switch (value.type) {
    case 'account.switch': return narrowExact(value, { type: oneOf(['account.switch'] as const), requestId: nonempty, accountId: nonempty, provider: optional(provider), expectedLoginGeneration: optional((v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) })
    case 'account.rename': return narrowExact(value, { type: oneOf(['account.rename'] as const), requestId: nonempty, accountId: nonempty, alias: nonempty })
    case 'account.login': return narrowExact(value, { type: oneOf(['account.login'] as const), requestId: nonempty, provider: optional(provider) })
    case 'account.oauthPasteCode': return narrowExact(value, { type: oneOf(['account.oauthPasteCode'] as const), requestId: nonempty, code: nonempty })
    case 'account.oauthAlias': return narrowExact(value, { type: oneOf(['account.oauthAlias'] as const), requestId: nonempty, alias: text })
    case 'account.touchAll':
    case 'account.oauthCancel': return narrowExact(value, { type: oneOf(['account.touchAll', 'account.oauthCancel'] as const), requestId: nonempty })
    default: return null
  }
}

function parseProgress(value: unknown): OAuthLoginProgress | null {
  if (!isRecord(value)) return null
  if (value.state === 'waiting_for_login') return narrowExact(value, { state: oneOf(['waiting_for_login'] as const), url: nonempty })
  if (value.state === 'error') return narrowExact(value, { state: oneOf(['error'] as const), message: nonempty })
  if (value.state === 'success') {
    const progress = narrowExact(value, {
      state: oneOf(['success'] as const), loginRequestId: optional(nonempty),
      receipt: optional((v: unknown): v is AccountLoginReceipt => parseAccountLoginReceipt(v) !== null),
    })
    if (!progress || Boolean(progress.receipt) !== Boolean(progress.loginRequestId)) return null
    return progress
  }
  return narrowExact(value, { state: oneOf(['starting', 'waiting_for_alias'] as const) })
}

function isTouchResults(value: unknown): value is NonNullable<AccountResultFrame['touchAllResults']> {
  return Array.isArray(value) && value.length <= 512 && value.every(row => narrowExact(row, { alias: isStringOrNull, result: oneOf(['OK', 'LOCKED', 'FAILED'] as const) }) !== null)
}

export function parseAccountControlEvent(value: unknown): AccountControlEvent | null {
  if (!isRecord(value)) return null
  if (value.type === 'progress') {
    const record = narrowExact(value, { type: oneOf(['progress'] as const), version: oneOf([ACCOUNT_CONTROL_VERSION] as const), provider, progress: (v: unknown): v is OAuthLoginProgress | null => v === null || parseProgress(v) !== null })
    if (record?.progress?.state === 'success' && record.progress.receipt &&
      record.progress.receipt.provider !== record.provider) return null
    return record
  }
  return narrowExact(value, {
    type: oneOf(['result'] as const), version: oneOf([ACCOUNT_CONTROL_VERSION] as const),
    requestId: nonempty, verb: oneOf(types), ok: isBoolean, message: nonempty, changed: isBoolean, touchAllResults: optional(isTouchResults),
  })
}
