import type {
  AccountDeleteMessage,
  AccountLoginMessage,
  AccountLogoutMessage,
  AccountOAuthAliasMessage,
  AccountOAuthCancelMessage,
  AccountOAuthPasteCodeMessage,
  AccountRenameMessage,
  AccountsSnapshot,
  AccountStatus,
  AccountSwitchMessage,
  AccountTouchAllMessage,
} from '../../shared/protocol.js'
import type { ToastTone } from './toastModel.js'
import type { Tone } from './tone.js'

const newRequestId = (): string => crypto.randomUUID()

export function selectAnthropicReadyLabel(
  snapshot: AccountsSnapshot | null,
): string {
  if (!snapshot) return '0 of 0 ready'
  if (
    snapshot.anthropicPoolCount === 0 &&
    snapshot.anthropicRouteAvailable
  ) {
    return 'route configured'
  }
  return `${snapshot.anthropicReadyCount} of ${snapshot.anthropicPoolCount} ready`
}

export function switchVerb(
  accountId: string,
  provider: 'anthropic' | 'openai' = 'openai',
): AccountSwitchMessage {
  return {
    type: 'account.switch',
    requestId: newRequestId(),
    accountId,
    provider,
  }
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

export function logoutVerb(
  accountId: string,
  expectedCredentialGeneration: number,
): AccountLogoutMessage {
  return {
    type: 'account.logout',
    requestId: newRequestId(),
    accountId,
    expectedCredentialGeneration,
  }
}

export function touchAllVerb(): AccountTouchAllMessage {
  return { type: 'account.touchAll', requestId: newRequestId() }
}

export function loginVerb(
  provider: 'anthropic' | 'openai' = 'openai',
): AccountLoginMessage {
  return {
    type: 'account.login',
    requestId: newRequestId(),
    provider,
  }
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

/**
 * How many CODEX pool accounts need a fresh sign-in.
 *
 * Deliberately NOT a banner trigger. A dead account among healthy ones stays
 * silent above the transcript by operator ruling (`decisions/STARTUP-GATES.md`,
 * the P4-24 revision and #12): the pool fails over, so interrupting is the wrong
 * behavior. This drives a passive count on the Accounts destination instead, so
 * the state is discoverable without being raised.
 *
 * Codex only, and the label says so. `anthropicAccounts` also carries a `dead`
 * status, but those rows offer no repair at all (their only control is Switch,
 * gated on healthy), so counting them would advertise an action that does not
 * exist. Giving that pool the same treatment is a separate change.
 *
 * `initialized` is the same guard the health bar uses: an unfinished or failed
 * pool read can still carry rows (`initAccountPool` resets the flag in its catch
 * AFTER `loadPoolForObservation` has populated the pool,
 * `src/services/api/codexAccountPool.ts:241`), and marking off a snapshot the
 * bar would refuse to act on makes the two surfaces disagree about one fact.
 */
export function selectAccountsNeedingSignIn(
  snapshot: AccountsSnapshot | null,
): number {
  if (!snapshot || !snapshot.initialized) return 0
  return snapshot.accounts.filter(account => account.status === 'dead').length
}

/** The count as a label, or null when nothing needs attention. */
export function formatAccountsNeedingSignIn(count: number): string | null {
  if (count <= 0) return null
  return count === 1
    ? '1 Codex account needs sign-in'
    : `${count} Codex accounts need sign-in`
}

export type AccountMenuKey =
  | 'switch'
  | 'relink'
  | 'rename'
  | 'logout'
  | 'delete'
export type AccountMenuItem = {
  key: AccountMenuKey
  label: string
  danger?: boolean
}

/**
 * `dead` ONLY, never the other unusable states. `dead` means `auth_dead`: the
 * refresh verdict correlates to the token in the file, so a fresh sign-in is
 * what repairs it (`codexAccountPool.ts:1219`). A `capped` account is a live
 * credential waiting on a usage window, and `quarantined` is an unverified
 * verdict the engine's own probe is still re-deriving
 * (`codexAccountPool.ts:1190`); offering sign-in on either would send the user
 * through a browser round trip that changes nothing.
 */
function isRelinkable(account: AccountStatus): boolean {
  return account.status === 'dead'
}

export function selectAccountMenuItems(
  account: AccountStatus,
): AccountMenuItem[] {
  const items: AccountMenuItem[] = []
  if (account.switchable) {
    items.push({ key: 'switch', label: 'Switch to this account' })
  }
  if (isRelinkable(account)) {
    items.push({ key: 'relink', label: 'Sign in again' })
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

/**
 * Identity of ONE usage cap, so dismissing its banner cannot silence the next
 * one. An account plus the reset window it is waiting on: a different account,
 * or the same account in a later window, is a different cap the user has not
 * seen yet. `selectCapAccount` re-reads the live snapshot every render, so the
 * account behind the banner genuinely changes underneath it.
 */
export function capIncidentKey(account: AccountStatus | null): string | null {
  if (!account) return null
  return `${account.id}|${account.usageResetAt ?? 'none'}`
}

/** Show a cap banner unless this exact cap is the one the user dismissed. */
export function shouldShowCapBanner(
  capKey: string | null,
  dismissedKey: string | null,
): boolean {
  return capKey !== null && capKey !== dismissedKey
}

/**
 * Drop the dismissal as soon as nothing is capped. `usageResetAt` is null
 * whenever the pool has no fresh usage hint, so a cleared cap that returns can
 * carry the same key; without this the banner would stay hidden for it.
 */
export function nextDismissedCapKey(
  dismissedKey: string | null,
  capKey: string | null,
): string | null {
  return capKey === null ? null : dismissedKey
}

export function formatResetLabel(sec: number | null, now = Date.now()): string {
  if (!sec) return 'soon'
  const ms = sec * 1000 - now
  if (ms <= 0) return 'now'
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `in ${mins}m`
  const hrs = Math.floor(mins / 60)
  const rem = mins % 60
  return rem ? `in ${hrs}h ${rem}m` : `in ${hrs}h`
}
