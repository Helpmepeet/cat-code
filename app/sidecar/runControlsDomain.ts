/**
 * Composer run-controls domain (P4-24c, `decisions/COMPOSER-RUN-CONTROLS.md`) —
 * the WRITE half of the composer's Model / Reasoning-effort / Fast faces (the
 * P4-24 read-only faces become interactive). Two responsibilities, both over the
 * engine's OWN machinery (never a re-implementation — mistakes #1/#10):
 *
 *   1. Read seam — a live `RunControlsSnapshot`: the current model/effort/fast PLUS
 *      the real selectable options + availability the pickers need, built from the
 *      engine's OWN `getModelOptions()` / `getSupportedEffortLevels()` / fast-mode
 *      helpers (never a renderer-invented list). Emitted on attach and re-broadcast
 *      whenever a run-control-relevant app-state field changes.
 *   2. Write seam — `setModel` / `setEffort` / `setFast`, each dispatched to the
 *      engine's OWN per-session setter through the executor seam, a LIVE change with
 *      NO respawn.
 *
 * The setters mutate GLOBAL engine state (`setMainLoopModelOverride`,
 * `setSessionProvider`) and per-session app-state (`store.setState`). Because the
 * sidecar is one process per session (N-process, LOCKED), the "global" overrides
 * are correctly session-scoped. The executor is behind a seam (like
 * `agentModeDomain`): the real one wires the engine functions; tests inject a fake
 * so the domain round-trip is proven without mutating real process globals.
 *
 * Read-only snapshot is secretGuard-clean by construction: model ids / effort
 * levels / booleans only, never a token.
 */

import {
  getMainLoopModelOverride,
  getSdkBetas,
  getTotalInputTokens,
  isProviderSwitchLocked,
  setMainLoopModelOverride,
  setProviderSwitchLocked,
  setSessionProvider,
} from '../../src/bootstrap/state.js'
import { applyFastMode } from '../../src/commands/fast/fast.js'
import { executeEffort } from '../../src/commands/effort/effort.js'
import type { AppState } from '../../src/state/AppStateStore.js'
import type { Store } from '../../src/state/store.js'
import {
  convertEffortValueToLevel,
  getSupportedEffortLevels,
  modelSupportsEffort,
  reconcileEffortForModel,
  resolveAppliedEffort,
} from '../../src/utils/effort.js'
import {
  getFastModeUnavailableReason,
  isFastModeAvailable,
  isFastModeSupportedByModel,
} from '../../src/utils/fastMode.js'
import { getContextWindowForModel } from '../../src/utils/context.js'
import {
  WARNING_THRESHOLD_BUFFER_TOKENS,
  getAutoCompactThreshold,
  getEffectiveContextWindowSize,
  isAutoCompactEnabled,
} from '../../src/services/compact/autoCompact.js'
import {
  getMainLoopModel,
  getMarketingNameForModel,
} from '../../src/utils/model/model.js'
import {
  getModelOptions,
  optionCoversModelSetting,
} from '../../src/utils/model/modelOptions.js'
import {
  getAPIProvider,
  getConfiguredAnthropicProvider,
  persistStartupProviderPreference,
  resolveModelSelectionProvider,
  type APIProvider,
} from '../../src/utils/model/providers.js'
import type {
  RunControlModelOption,
  RunControlsSnapshot,
} from '../shared/protocol.js'

/** The redacted outcome of a run-control write (no transport, no secret). */
export type RunControlSetResult = {
  ok: boolean
  message: string
  /** Whether the write actually moved a run-control field (drives snapshot re-broadcast). */
  changed: boolean
}

/**
 * The engine run-control ops, behind a seam (P4-24c). The real implementation
 * wires the engine's OWN `/model`, `/effort`, and `/fast` write logic; tests inject
 * a fake so a headless round-trip proves the wiring without mutating the real
 * process globals (mirrors `agentModeDomain`'s executor seam).
 */
export type RunControlExecutor = {
  /** Set this session's main-loop model (the `/model` write, session-scoped). */
  setModel(model: string | null): void
  /** Set this session's reasoning effort (the `/effort` write); returns the outcome message. */
  setEffort(effort: string): string
  /** Toggle this session's fast mode (the `/fast` write). */
  setFast(active: boolean): void
  /** Activate the provider chosen by first-run sign-in and its provider-local default. */
  activateProvider?(provider: 'anthropic' | 'openai'): void
}

export function createRealRunControlExecutor(
  store: Store<AppState>,
): RunControlExecutor {
  // Mirror `onChangeAppState.ts:104-112` (the `/model` write's global sync). The
  // engine reads `getMainLoopModel()` (→ `getMainLoopModelOverride()`) per turn
  // (`QueryEngine.ts:283`), and the sidecar store has NO `onChangeAppState` wired,
  // so the override MUST be set HERE for the change to take effect (not just
  // display). `setSessionProvider` keeps provider routing consistent (gpt-* →
  // openai). Both are in-memory + session-scoped (N-process, LOCKED); nothing is
  // persisted to global startup preference or user settings from a composer tweak.
  function applyModelOverride(model: string | null): void {
    setSessionProvider(resolveModelSelectionProvider(model))
    setMainLoopModelOverride(model)
  }
  return {
    setModel(model) {
      applyModelOverride(model)
      store.setState(prev => {
        // Mirror the `/model` picker's fast reconciliation (`model.tsx:79-90`): a
        // model that cannot run fast turns fast OFF rather than leaving a stale ⚡.
        const fastOff = prev.fastMode && !isFastModeSupportedByModel(model)
        return {
          ...prev,
          mainLoopModel: model,
          mainLoopModelForSession: null,
          effortValue: reconcileEffortForModel(getMainLoopModel(), prev.effortValue),
          ...(fastOff ? { fastMode: false } : {}),
        }
      })
    },
    setEffort(effort) {
      // The engine's own `/effort` write: validates the level (or auto/unset),
      // persists via `setEffortValue`/`toPersistableEffort`, and returns the outcome
      // message + the value to reflect. QueryEngine reads `appState.effortValue` per
      // request (`query.ts:744`), so applying it to the store takes effect live.
      const result = executeEffort(effort)
      if (result.effortUpdate) {
        const value = result.effortUpdate.value
        store.setState(prev => ({ ...prev, effortValue: value }))
      }
      return result.message
    },
    setFast(active) {
      const before = store.getState().mainLoopModel
      // The engine's own fast-mode switch (`fast.tsx:15`): clears the cooldown and,
      // when enabling on a non-fast model, switches to a fast-capable one.
      applyFastMode(active, store.setState)
      const after = store.getState().mainLoopModel
      // `applyFastMode` may switch the model (`fast.tsx:22-26`); sync the override so
      // that switch actually takes effect (no `onChangeAppState` in the sidecar).
      if (after !== before && typeof after === 'string') {
        applyModelOverride(after)
      }
    },
    activateProvider(provider) {
      const route =
        provider === 'openai' ? 'openai' : getConfiguredAnthropicProvider()
      const model = provider === 'openai' ? 'gpt-5.6-terra' : null
      setSessionProvider(route)
      setMainLoopModelOverride(model)
      persistStartupProviderPreference(route)
      store.setState(prev => ({
        ...prev,
        mainLoopModel: model,
        mainLoopModelForSession: null,
        fastMode: false,
        effortValue: reconcileEffortForModel(getMainLoopModel(), prev.effortValue),
      }))
    },
  }
}

export type SidecarRunControlsDomain = {
  /** The live run-controls snapshot (current values + real options + availability). */
  getSnapshot(): RunControlsSnapshot
  /** Set the model through the engine's own setter; report whether a field moved. */
  setModel(model: string | null): RunControlSetResult
  /** Set the reasoning effort through the engine's own `/effort` write. */
  setEffort(effort: string): RunControlSetResult
  /** Toggle fast mode through the engine's own `/fast` write. */
  setFast(active: boolean): RunControlSetResult
  /** Lock provider-family changes as soon as the first turn is accepted. */
  lockProviderSwitches(): boolean
  /** Activate the provider explicitly chosen by first-run authentication. */
  activateProvider(provider: 'anthropic' | 'openai'): RunControlSetResult
  /**
   * Fires ONLY when a run-control-relevant app-state field actually changes
   * (change-detected — no per-token re-broadcast storm during a turn).
   */
  subscribe(listener: () => void): () => void
}

export function createSidecarRunControlsDomain(
  store: Store<AppState>,
  options: {
    executor?: RunControlExecutor
    buildSnapshot?: (state: AppState) => RunControlsSnapshot
    providerSwitchLocked?: boolean
  } = {},
): SidecarRunControlsDomain {
  const executor = options.executor ?? createRealRunControlExecutor(store)
  const buildSnapshot = options.buildSnapshot ?? buildRunControlsSnapshot
  let providerSwitchLocked =
    options.providerSwitchLocked === true ||
    isProviderSwitchLocked() ||
    getTotalInputTokens() > 0
  if (providerSwitchLocked) setProviderSwitchLocked(true)
  const listeners = new Set<() => void>()
  let unsubscribeStore: (() => void) | null = null

  function snapshot(): RunControlsSnapshot {
    const built = buildSnapshot(store.getState())
    return {
      ...built,
      model: {
        ...built.model,
        providerSwitchLocked:
          providerSwitchLocked || built.model.providerSwitchLocked,
      },
    }
  }

  function runWrite(
    run: () => void,
    okMessage: string,
    failPrefix: string,
  ): RunControlSetResult {
    const before = runControlSignature(store.getState())
    try {
      run()
    } catch (error) {
      return {
        ok: false,
        message: `${failPrefix}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        changed: false,
      }
    }
    const changed = runControlSignature(store.getState()) !== before
    return { ok: true, message: okMessage, changed }
  }

  return {
    getSnapshot() {
      return snapshot()
    },
    setModel(model) {
      const currentSnapshot = snapshot()
      if (
        currentSnapshot.model.providerSwitchLocked &&
        (currentSnapshot.model.provider === 'openai') !==
          (resolveModelSelectionProvider(model) === 'openai')
      ) {
        return {
          ok: false,
          message:
            'Provider cannot be changed after the first turn. Start a new session to switch providers.',
          changed: false,
        }
      }
      const supported =
        model === currentSnapshot.model.current ||
        currentSnapshot.model.options.some(option => option.value === model)
      if (!supported) {
        return {
          ok: false,
          message: `Unsupported model: ${model}.`,
          changed: false,
        }
      }
      return runWrite(
        () => executor.setModel(model),
        model === null ? 'Model set to provider default.' : `Model set to ${model}.`,
        'Could not set model',
      )
    },
    setEffort(effort) {
      const currentSnapshot = snapshot()
      const supported =
        effort === 'auto' ||
        effort === 'unset' ||
        effort === currentSnapshot.effort.current ||
        currentSnapshot.effort.options.includes(effort)
      if (!supported) {
        return {
          ok: false,
          message: `Unsupported effort: ${effort}.`,
          changed: false,
        }
      }
      // Capture the engine's outcome message after membership validation against
      // the same engine-owned effort options exposed by the live snapshot.
      let message = effort === 'auto' || effort === 'unset'
        ? 'Effort set to auto.'
        : `Effort set to ${effort}.`
      const result = runWrite(
        () => {
          message = executor.setEffort(effort)
        },
        message,
        'Could not set effort',
      )
      return result.ok ? { ...result, message } : result
    },
    setFast(active) {
      const currentSnapshot = snapshot()
      if (active && !currentSnapshot.fast.supportedByModel) {
        return {
          ok: false,
          message: 'Fast mode is not supported by the current model.',
          changed: false,
        }
      }
      if (active && !currentSnapshot.fast.available) {
        return {
          ok: false,
          message:
            currentSnapshot.fast.unavailableReason ??
            'Fast mode is unavailable for this account.',
          changed: false,
        }
      }
      return runWrite(
        () => executor.setFast(active),
        active ? 'Fast mode on.' : 'Fast mode off.',
        'Could not toggle fast mode',
      )
    },
    activateProvider(provider) {
      const currentSnapshot = snapshot()
      const crossing =
        (currentSnapshot.model.provider === 'openai') !==
        (provider === 'openai')
      if (currentSnapshot.model.providerSwitchLocked && crossing) {
        return {
          ok: false,
          message:
            'Provider cannot be changed after the first turn. Start a new session to switch providers.',
          changed: false,
        }
      }
      return runWrite(
        () => {
          if (!executor.activateProvider) {
            throw new Error('Provider activation is unavailable.')
          }
          executor.activateProvider(provider)
        },
        `Provider set to ${provider === 'openai' ? 'Codex' : 'Anthropic'}.`,
        'Could not activate provider',
      )
    },
    lockProviderSwitches() {
      if (providerSwitchLocked) return false
      providerSwitchLocked = true
      setProviderSwitchLocked(true)
      for (const listener of listeners) listener()
      return true
    },
    subscribe(listener) {
      listeners.add(listener)
      if (!unsubscribeStore) {
        let prev = runControlSignature(store.getState())
        unsubscribeStore = store.subscribe(() => {
          const next = runControlSignature(store.getState())
          if (next !== prev) {
            prev = next
            for (const subscribed of listeners) subscribed()
          }
        })
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          unsubscribeStore?.()
          unsubscribeStore = null
        }
      }
    },
  }
}

/**
 * A cheap signature over ONLY the run-control-relevant app-state fields, so the
 * store subscription re-broadcasts on a real model/effort/fast change and stays
 * silent through the flood of per-token store mutations during a turn.
 */
function runControlSignature(state: AppState): string {
  return JSON.stringify([
    state.mainLoopModel ?? null,
    state.mainLoopModelForSession ?? null,
    state.effortValue ?? null,
    state.fastMode ?? false,
  ])
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/**
 * Pure snapshot builder over the live app-state + the engine's OWN model/effort/
 * fast helpers. Throw-free (display = degrade gracefully): any engine read that
 * fails degrades that slice to a safe default rather than crashing the snapshot.
 */
export function buildRunControlsSnapshot(state: AppState): RunControlsSnapshot {
  // Resolved model (the SAME resolver QueryEngine uses); after a `model.set` the
  // override is live so this reflects the change. The saved setting drives option
  // highlighting, once aligned to the option that offers the same model.
  const current = safe(() => getMainLoopModel(), null)
  const savedSelection = safe(() => getMainLoopModelOverride() ?? null, null)

  const options: RunControlModelOption[] = safe(
    () => getModelOptions(state.fastMode ?? false),
    [],
  )
    .map(option => ({
      value: option.value,
      label: option.label,
      provider: toRunControlProvider(
        resolveModelSelectionProvider(option.value),
      ),
    }))

  const selected = safe(
    () => alignSelectionWithOptions(savedSelection, options),
    savedSelection,
  )

  // The two display facts about `current` that only the engine can answer. Both
  // are resolved from the SAME functions the rest of cat-code uses — the picker
  // labels come from `getMarketingNameForModel` via `getModelOptions`, and the
  // live gauge's denominator comes from `getContextWindowForModel` via the cost
  // tracker (`src/cost-tracker.ts:107`) — so the composer never grows a second
  // name table or window table of its own (§10).
  const currentLabel = current
    ? safe(() => getMarketingNameForModel(current) ?? null, null)
    : null
  const contextWindow = current ? readContextWindow(current) : null

  const effortSupported = current
    ? safe(() => modelSupportsEffort(current), false)
    : false
  const effortOptions =
    current && effortSupported
      ? safe(() => [...getSupportedEffortLevels(current)], [])
      : []
  const selectedEffort =
    state.effortValue == null ? null : String(state.effortValue)
  const appliedEffort =
    current && effortSupported
      ? safe(
          () => {
            const resolved = resolveAppliedEffort(current, state.effortValue)
            return resolved === undefined
              ? null
              : convertEffortValueToLevel(resolved)
          },
          null,
        )
      : null

  const fastActive = state.fastMode ?? false
  const fastSupportedByModel = safe(
    () => isFastModeSupportedByModel(current ?? state.mainLoopModel ?? null),
    false,
  )
  const fastAvailable = safe(() => isFastModeAvailable(), false)
  const fastUnavailableReason = fastAvailable
    ? null
    : safe(() => getFastModeUnavailableReason(), null)

  return {
    model: {
      current,
      currentLabel,
      contextWindow,
      selected,
      provider: toRunControlProvider(safe(() => getAPIProvider(), 'firstParty')),
      providerSwitchLocked: safe(
        () => isProviderSwitchLocked() || getTotalInputTokens() > 0,
        false,
      ),
      options,
    },
    effort: {
      current: appliedEffort,
      selected: selectedEffort,
      supported: effortSupported,
      options: effortOptions,
    },
    fast: {
      active: fastActive,
      supportedByModel: fastSupportedByModel,
      available: fastAvailable,
      unavailableReason: fastUnavailableReason,
    },
    autoCompact: readAutoCompact(current),
  }
}

/**
 * The composer warning glyph's two thresholds, mirrored off the ENGINE rather
 * than recomputed (§10). Both come from the same functions
 * `calculateTokenWarningState` uses (`src/services/compact/autoCompact.ts:256-269`),
 * so the glyph appears exactly when the engine would report
 * `isAboveWarningThreshold` and its percentage matches the engine's `percentLeft`.
 *
 * Guarded like {@link readContextWindow}: a failed resolve costs the glyph (it
 * stays hidden, the honest state when we cannot say how close compaction is),
 * never the whole snapshot.
 */
function readAutoCompact(model: string | null): RunControlsSnapshot['autoCompact'] {
  const enabled = safe(() => isAutoCompactEnabled(), false)
  if (!model) return { enabled, threshold: null, warningThreshold: null }

  // The engine picks the auto-compact threshold only while auto-compact is on;
  // with it off the percentage runs against the effective window instead
  // (`autoCompact.ts:257-259`). Mirror that choice here, not in the renderer.
  const threshold = positive(
    safe(
      () =>
        enabled
          ? getAutoCompactThreshold(model)
          : getEffectiveContextWindowSize(model),
      null,
    ),
  )
  return {
    enabled,
    threshold,
    warningThreshold:
      threshold == null ? null : threshold - WARNING_THRESHOLD_BUFFER_TOKENS,
  }
}

function positive(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null
}

/**
 * The window `model` runs with, or null. Guarded like the backfill worker's
 * resolver (`transcriptRunFacts.ts`): a nonsense answer costs the gauge its
 * exact denominator (the renderer keeps its default), never the whole snapshot.
 */
function readContextWindow(model: string): number | null {
  const window = safe(() => getContextWindowForModel(model, getSdkBetas()), null)
  return typeof window === 'number' && Number.isFinite(window) && window > 0
    ? window
    : null
}

/**
 * The renderer highlights the picker row by plain string equality, so a saved
 * setting the engine offers under a different string (settings hold the
 * canonical `claude-sonnet-5`; the first-party picker offers the alias
 * `sonnet`) would highlight NO row at all. Resolve the saved setting onto the
 * option that means the same model HERE: model resolution is engine knowledge
 * and never belongs in the renderer.
 */
function alignSelectionWithOptions(
  selection: string | null,
  options: RunControlModelOption[],
): string | null {
  if (selection === null) return null
  if (options.some(option => option.value === selection)) return selection
  const match = options.find(option =>
    optionCoversModelSetting(option.value, selection),
  )
  return match ? match.value : selection
}

function toRunControlProvider(provider: APIProvider): RunControlsSnapshot['model']['provider'] {
  return provider === 'firstParty' ? 'anthropic' : provider
}
