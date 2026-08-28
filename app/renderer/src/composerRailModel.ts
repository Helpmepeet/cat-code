/**
 * What the composer rail says, and what it lets you do — decided in one place.
 *
 * The rail reads five per-session seams (run controls, permission context,
 * accounts, connection, and the preview cache). Each answers two DIFFERENT
 * questions that a single null used to conflate:
 *
 *   DISPLAY    — what is this session running on? Survives the process. A
 *                disconnected, parked or crashed session ran on a model, at an
 *                effort, with an account, and its context is still the size it
 *                is. Losing the engine makes none of that untrue.
 *   CAPABILITY — may I change it? Dies with the process, because a picker with
 *                no sidecar behind it is a dead click.
 *
 * Conflating them is what blanked the whole rail on an idle-park: the snapshots
 * null on the `lifecycle` frame, which correctly disarmed every picker and
 * incorrectly erased every answer.
 *
 * This lives in its own module, driven by its own test, because the alternative
 * was asserting on `App.tsx` source text — and a source tripwire cannot see a
 * changed BINDING. A review proved it: rebinding `panelLastRunControls` to the
 * live selector restored the entire original bug with every asserted substring
 * intact and the full suite green. That is the CC-21 failure mode, on record in
 * STATUS.md. A derivation the tests can actually call is the fix.
 */

import type {
  AccountsSnapshot,
  RunControlProvider,
  RunControlsSnapshot,
  SessionId,
} from '../../shared/protocol.js'
import {
  selectAccountsSnapshot,
  selectFirstAccountsSnapshot,
  selectLastAccountsSnapshot,
  type AccountsState,
} from './accountsState.js'
import type { ConnectionSnapshot } from './connectionState.js'
import {
  selectLastPermissionMode,
  type PermissionState,
} from './permissionState.js'
import {
  selectLastRunControlsSnapshot,
  selectRunControlsSnapshot,
  type RunControlsState,
} from './runControlsState.js'

export type ComposerRailSources = {
  runControls: RunControlsState
  permissions: PermissionState
  accounts: AccountsState
  /** The session's own connection snapshot status, not the active pane's. */
  connectionStatus: ConnectionSnapshot['status']
  sessionId: SessionId
}

export type ComposerRailModel = {
  /* ---- display: outlives the engine ---- */
  /** The resolved model id. Feeds the face AND `selectContextUsage`'s lookup. */
  model: string | null
  /**
   * The model's product name (`Sonnet 4.5`), when the engine gave one.
   *
   * Carried separately from `model` because they are consumed differently: the
   * face shows the label, `selectContextUsage` matches `modelUsage` on the id.
   * Without it the read-only face printed `claude-sonnet-4-5-20250929` the
   * moment a session parked, which is the defect `be6522a` and `ModelChip`
   * already fixed once each.
   */
  modelLabel: string | null
  reasoningEffort: string | null
  /**
   * Fast state, or null when nothing knows: no snapshot yet, or a model that
   * cannot do fast at all (the live chip renders nothing in that case, so the
   * read-only one must not either). False is a real answer and DOES render —
   * parking a session with fast off used to drop the face while every sibling
   * stayed.
   */
  fastMode: boolean | null
  /** The engine-resolved window, so a parked donut keeps its real denominator. */
  contextWindow: number | null
  lastPermissionMode: string | null
  /** The pool view this pane should render. See `railAccounts` for the order. */
  accountsSnapshot: AccountsSnapshot | null
  provider: RunControlProvider | null

  /* ---- capability: dies with the engine ---- */
  /** Non-null only while a sidecar can take a run-control verb. */
  liveRunControls: RunControlsSnapshot | null
  /** Whether the account face may be an interactive switcher. */
  canSwitchAccount: boolean
}

/**
 * `ready`, not `connectionHasEngine`.
 *
 * `connectionHasEngine` is true for `connecting` and `starting` as well, and
 * those are exactly the window a restore passes through. Since `provider` now
 * survives the lifecycle null, gating on it armed the account switcher for the
 * whole spawn, where `supervisor.send` answers `session_not_ready` — and the
 * verb is fire-and-forget, so nothing surfaces the refusal and the pane is left
 * tracking a requestId that never resolves. Every sibling control already
 * requires `ready` (`composerState.ts` `canSendUntypedSubmit`); this matches.
 */
function engineReady(status: ConnectionSnapshot['status']): boolean {
  return status === 'ready'
}

/**
 * Which accounts view a pane should show, freshest-first.
 *
 * The host-owned global pool wins whenever its worker has published one. It is
 * the current process-global usage view, while a session snapshot is refreshed
 * only at attachment and after that session mutates the pool.
 *
 * Before the host's first worker result, retain the existing session-first
 * fallback so the face does not blank during startup.
 */
function railAccounts(
  accounts: AccountsState,
  sessionId: SessionId,
  ready: boolean,
): AccountsSnapshot | null {
  if (accounts.pool) return accounts.pool
  if (ready) {
    return (
      selectAccountsSnapshot(accounts, sessionId) ??
      selectFirstAccountsSnapshot(accounts)
    )
  }
  return (
    selectLastAccountsSnapshot(accounts, sessionId) ??
    selectFirstAccountsSnapshot(accounts)
  )
}

export function selectComposerRail(
  sources: ComposerRailSources,
): ComposerRailModel {
  const { accounts, connectionStatus, permissions, runControls, sessionId } =
    sources
  const ready = engineReady(connectionStatus)
  const last = selectLastRunControlsSnapshot(runControls, sessionId)
  const live = selectRunControlsSnapshot(runControls, sessionId)
  return {
    model: last?.model.current ?? null,
    modelLabel: last?.model.currentLabel ?? null,
    reasoningEffort: last?.effort.current ?? null,
    fastMode: last && last.fast.supportedByModel ? last.fast.active : null,
    contextWindow: last?.model.contextWindow ?? null,
    lastPermissionMode: selectLastPermissionMode(permissions, sessionId),
    accountsSnapshot: railAccounts(accounts, sessionId, ready),
    provider: last?.model.provider ?? null,
    liveRunControls: live,
    canSwitchAccount: ready && last?.model.provider === 'openai',
  }
}
