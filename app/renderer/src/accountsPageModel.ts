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
  AnthropicAccountStatus,
} from '../../shared/protocol.js'
import type { ToastTone } from './toastModel.js'
import type { Tone } from './tone.js'

const newRequestId = (): string => crypto.randomUUID()

export function accountRecoveryReason(reason: string): string {
  switch (reason) {
    case 'duplicate_identity': return 'This account is saved more than once. Sign in again to restore it.'
    case 'invalid_generation': return 'The saved sign-in is incomplete. Sign in again.'
    case 'lifecycle_unavailable': return 'The saved sign-in could not be checked. Try again or sign in again.'
    case 'generation_mismatch': return 'The saved sign-in has changed. Sign in again to restore this profile.'
    case 'lifecycle_not_credentialed': return 'This profile has no usable sign-in. Sign in again.'
    case 'profile_recovery_required': return 'This saved profile needs a fresh sign-in.'
    default: return 'This account needs attention. Sign in again.'
  }
}

export function claudeRateLimitTier(tier: string | null | undefined): string | null {
  if (!tier) return null
  if (tier === 'default_claude_max_5x') return 'Max 5x'
  if (tier === 'default_claude_max_20x') return 'Max 20x'
  return 'Claude subscription'
}

export function accountTakenAliases(snapshot: AccountsSnapshot | null): string[] {
  if (!snapshot) return []
  return [
    ...snapshot.accounts,
    ...snapshot.signedOutProfiles,
    ...snapshot.anthropicAccounts,
    ...(snapshot.anthropicSignedOutProfiles ?? []),
  ].flatMap(account => account.alias ? [account.alias] : [])
}

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
  provider?: 'anthropic' | 'openai',
): AccountRenameMessage {
  return { type: 'account.rename', requestId: newRequestId(), accountId, alias, ...(provider ? { provider } : {}) }
}

export function deleteVerb(
  accountId: string,
  expectedCredentialGeneration: number,
  provider?: 'anthropic' | 'openai',
): AccountDeleteMessage {
  return {
    type: 'account.delete',
    requestId: newRequestId(),
    accountId,
    expectedCredentialGeneration,
    confirm: true,
    ...(provider ? { provider } : {}),
  }
}

export function logoutVerb(
  accountId: string,
  expectedCredentialGeneration: number,
  requestId = newRequestId(),
  provider?: 'anthropic' | 'openai',
): AccountLogoutMessage {
  return {
    type: 'account.logout',
    requestId,
    accountId,
    expectedCredentialGeneration,
    ...(provider ? { provider } : {}),
  }
}

export function touchAllVerb(provider?: 'anthropic' | 'openai', accountId?: string): AccountTouchAllMessage {
  return { type: 'account.touchAll', requestId: newRequestId(), ...(provider ? { provider } : {}), ...(accountId ? { accountId } : {}) }
}

export function loginVerb(
  provider: 'anthropic' | 'openai' = 'openai',
  makeDefault?: boolean,
): AccountLoginMessage {
  return {
    type: 'account.login',
    requestId: newRequestId(),
    provider,
    ...(makeDefault !== undefined ? { makeDefault } : {}),
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
  if (pct === null) return 'default'
  return pct >= 90 ? 'danger' : pct >= 65 ? 'warn' : 'good'
}

export function statusDotTone(account: AccountStatus): Tone {
  if (account.status === 'healthy' && account.usageLimitReached) return 'warn'
  if (account.isDefault) return 'accent'
  if (account.status === 'healthy') return 'good'
  if (account.status === 'capped') return 'danger'
  if (account.status === 'dead') return 'warn'
  return 'default'
}

export function anthropicAccountCapped(account: AnthropicAccountStatus): boolean {
  return (account.usageFiveHour ?? 0) >= 100 || (account.usageWeekly ?? 0) >= 100
}

/** A nickname leads with the email beneath it; without one the email shows once. */
export function anthropicAccountName(
  account: Pick<AnthropicAccountStatus, 'alias' | 'email'>,
): { title: string; detail: string | null } {
  const alias = account.alias?.trim()
  return alias && alias !== account.email
    ? { title: alias, detail: account.email }
    : { title: account.email, detail: null }
}

export function anthropicCredentialLabel(account: AnthropicAccountStatus): string | null {
  if (account.credentialHealth === 'persistence_pending') return 'Sign-in was not saved. Sign in again before reconnecting.'
  if (account.credentialHealth === 'refresh_uncertain') return 'Sign-in renewal could not be confirmed. Sign in again.'
  if (account.credentialHealth === 'sign_in_required' || account.status === 'dead') return 'Sign-in is no longer valid. Sign in again.'
  if (account.boundLoginGeneration !== undefined && account.loginGeneration !== undefined &&
    account.boundLoginGeneration !== account.loginGeneration) {
    return 'Account is signed in. Reconnect this chat to use the new sign-in.'
  }
  return null
}

export function anthropicStatusDotTone(account: AnthropicAccountStatus): Tone {
  if (anthropicCredentialLabel(account)) return 'warn'
  if (account.status === 'dead' || anthropicAccountCapped(account)) return 'warn'
  return account.isDefault ? 'accent' : 'good'
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
 * Codex only, and the label says so. Anthropic recovery stays on its account
 * rows rather than contributing to this provider-specific count.
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
  | 'retry_logout'
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
  signOutState?: 'submitting' | 'checking' | 'refreshing',
): AccountMenuItem[] {
  if (signOutState === 'submitting' || signOutState === 'refreshing') return []
  if (signOutState === 'checking') {
    return [{ key: 'retry_logout', label: 'Check sign-out status' }]
  }
  const items: AccountMenuItem[] = []
  if (account.switchable) {
    items.push({ key: 'switch', label: 'Make default for new chats' })
  }
  if (isRelinkable(account)) {
    items.push({ key: 'relink', label: 'Sign in again' })
  }
  if (account.hasVaultProfile) items.push({ key: 'rename', label: 'Rename' })
  items.push({ key: 'logout', label: 'Sign out' })
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
