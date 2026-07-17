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
  setMainLoopModelOverride,
  setSessionProvider,
} from '../../src/bootstrap/state.js'
import { applyFastMode } from '../../src/commands/fast/fast.js'
import { executeEffort } from '../../src/commands/effort/effort.js'
import type { AppState } from '../../src/state/AppStateStore.js'
import type { Store } from '../../src/state/store.js'
import {
  getSupportedEffortLevels,
  modelSupportsEffort,
} from '../../src/utils/effort.js'
import {
  getFastModeUnavailableReason,
  isFastModeAvailable,
  isFastModeSupportedByModel,
} from '../../src/utils/fastMode.js'
import { getMainLoopModel } from '../../src/utils/model/model.js'
import { getModelOptions } from '../../src/utils/model/modelOptions.js'
import { getProviderForModel } from '../../src/utils/model/providers.js'
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
  setModel(model: string): void
  /** Set this session's reasoning effort (the `/effort` write); returns the outcome message. */
  setEffort(effort: string): string
  /** Toggle this session's fast mode (the `/fast` write). */
  setFast(active: boolean): void
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
  function applyModelOverride(model: string): void {
    setSessionProvider(getProviderForModel(model))
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
  }
}

export type SidecarRunControlsDomain = {
  /** The live run-controls snapshot (current values + real options + availability). */
  getSnapshot(): RunControlsSnapshot
  /** Set the model through the engine's own setter; report whether a field moved. */
  setModel(model: string): RunControlSetResult
  /** Set the reasoning effort through the engine's own `/effort` write. */
  setEffort(effort: string): RunControlSetResult
  /** Toggle fast mode through the engine's own `/fast` write. */
  setFast(active: boolean): RunControlSetResult
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
  } = {},
): SidecarRunControlsDomain {
  const executor = options.executor ?? createRealRunControlExecutor(store)
  const buildSnapshot = options.buildSnapshot ?? buildRunControlsSnapshot

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
      return buildSnapshot(store.getState())
    },
    setModel(model) {
      const snapshot = buildSnapshot(store.getState())
      const supported =
        model === snapshot.model.current ||
        snapshot.model.options.some(option => option.value === model)
      if (!supported) {
        return {
          ok: false,
          message: `Unsupported model: ${model}.`,
          changed: false,
        }
      }
      return runWrite(
        () => executor.setModel(model),
        `Model set to ${model}.`,
        'Could not set model',
      )
    },
    setEffort(effort) {
      const snapshot = buildSnapshot(store.getState())
      const supported =
        effort === 'auto' ||
        effort === 'unset' ||
        effort === snapshot.effort.current ||
        snapshot.effort.options.includes(effort)
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
      return runWrite(
        () => executor.setFast(active),
        active ? 'Fast mode on.' : 'Fast mode off.',
        'Could not toggle fast mode',
      )
    },
    subscribe(listener) {
      let prev = runControlSignature(store.getState())
      return store.subscribe(() => {
        const next = runControlSignature(store.getState())
        if (next !== prev) {
          prev = next
          listener()
        }
      })
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
  // override is live so this reflects the change. Raw setting drives option
  // highlighting.
  const current = safe(() => getMainLoopModel(), null)
  const selected = safe(() => getMainLoopModelOverride() ?? null, null)

  const options: RunControlModelOption[] = safe(
    () => getModelOptions(state.fastMode ?? false),
    [],
  )
    .filter(
      (option): option is (typeof option) & { value: string } =>
        typeof option.value === 'string',
    )
    // Desktop composer picker shows Codex/OpenAI models only — Anthropic models
    // are removed from the list (user decision, 2026-07-13).
    .filter(option => getProviderForModel(option.value) === 'openai')
    .map(option => ({
      value: option.value,
      label: option.label,
      provider: 'openai' as const,
    }))

  const effortSupported = current
    ? safe(() => modelSupportsEffort(current), false)
    : false
  const effortOptions =
    current && effortSupported
      ? safe(() => [...getSupportedEffortLevels(current)], [])
      : []

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
    model: { current, selected, options },
    effort: {
      current: state.effortValue == null ? null : String(state.effortValue),
      supported: effortSupported,
      options: effortOptions,
    },
    fast: {
      active: fastActive,
      supportedByModel: fastSupportedByModel,
      available: fastAvailable,
      unavailableReason: fastUnavailableReason,
    },
  }
}
