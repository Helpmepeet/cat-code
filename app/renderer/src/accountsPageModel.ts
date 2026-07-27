import type {
  AccountDeleteMessage,
  AccountLoginMessage,
  AccountLogoutMessage,
  AccountOAuthAliasMessage,
  AccountOAuthCancelMessage,
  AccountOAuthPasteCodeMessage,
  AccountRenameMessage,
  AccountStatus,
  AccountSwitchMessage,
  AccountTouchAllMessage,
} from '../../shared/protocol.js'
import type { ToastTone } from './toastModel.js'
import type { Tone } from './tone.js'

const newRequestId = (): string => crypto.randomUUID()

export function switchVerb(accountId: string): AccountSwitchMessage {
  return { type: "account.switch", requestId: newRequestId(), accountId }
}

export function renameVerb(
  accountId: string,
  alias: string,
): AccountRenameMessage {
  return { type: 'account.rename', requestId: newRequestId(), accountId, alias }
}

export function deleteVerb(accountId: string): AccountDeleteMessage {
  return {
    type: 'account.delete',
    requestId: newRequestId(),
    accountId,
    confirm: true,
  }
}

export function logoutVerb(): AccountLogoutMessage {
  return { type: 'account.logout', requestId: newRequestId() }
}

export function touchAllVerb(): AccountTouchAllMessage {
  return { type: 'account.touchAll', requestId: newRequestId() }
}

export function loginVerb(): AccountLoginMessage {
  return { type: "account.login", requestId: newRequestId() }
}

export function oauthPasteCodeVerb(code: string): AccountOAuthPasteCodeMessage {
  return { type: 'account.oauthPasteCode', requestId: newRequestId(), code }
}

export function oauthAliasVerb(alias: string): AccountOAuthAliasMessage {
  return { type: 'account.oauthAlias', requestId: newRequestId(), alias }
}

export function oauthCancelVerb(): AccountOAuthCancelMessage {
  return { type: 'account.oauthCancel', requestId: newRequestId() }
}

export function resultToastTone(ok: boolean): ToastTone {
  return ok ? 'success' : 'danger'
}

export function usageTone(pct: number | null): Tone {
  const p = pct ?? 0
  return p >= 90 ? 'danger' : p >= 65 ? 'warn' : 'good'
}

export function statusDotTone(account: AccountStatus): Tone {
  if (account.status === 'healthy' && account.usageLimitReached) return 'warn'
  if (account.isDefault) return 'accent'
  if (account.status === 'healthy') return 'good'
  if (account.status === 'capped') return 'danger'
  if (account.status === 'dead') return 'warn'
  return 'default'
}

export function statusLabelTone(account: AccountStatus): Tone {
  if (account.status === 'healthy' && account.usageLimitReached) return 'warn'
  if (account.status === 'healthy') return 'good'
  if (account.status === 'capped') return 'danger'
  if (account.status === 'dead') return 'warn'
  return 'default'
}

export type AccountMenuKey = 'switch' | 'rename' | 'logout' | 'delete'
export type AccountMenuItem = {
  key: AccountMenuKey
  label: string
  danger?: boolean
}

export function selectAccountMenuItems(
  account: AccountStatus,
): AccountMenuItem[] {
  const items: AccountMenuItem[] = []
  if (account.switchable) {
    items.push({ key: 'switch', label: 'Switch to this account' })
  }
  if (account.hasVaultProfile) items.push({ key: 'rename', label: 'Rename' })
  if (account.isDefault) items.push({ key: 'logout', label: 'Sign out' })
  if (account.hasVaultProfile) {
    items.push({ key: 'delete', label: 'Delete', danger: true })
  }
  return items
}

const ALIAS_RE = /^[a-zA-Z0-9_-]{1,32}$/

export function renameError(
  value: string,
  currentAlias: string | null,
  takenAliases: string[],
): string | null {
  if (!value) return 'Alias required'
  if (!ALIAS_RE.test(value)) return '1–32 chars · letters, numbers, - or _'
  const taken = takenAliases
    .filter(a => a !== currentAlias)
    .map(a => a.toLowerCase())
  if (taken.includes(value.toLowerCase())) return 'That alias is already in use'
  return null
}

export function formatResetLabel(sec: number | null): string {
  if (!sec) return 'soon'
  const ms = sec * 1000 - Date.now()
  if (ms <= 0) return 'now'
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `in ${mins}m`
  const hrs = Math.floor(mins / 60)
  const rem = mins % 60
  return rem ? `in ${hrs}h ${rem}m` : `in ${hrs}h`
}
