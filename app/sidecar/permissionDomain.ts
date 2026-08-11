/**
 * Permissions domain capability — the sidecar-side seam between the boundary
 * (`SidecarServer`) and the engine's live permission state (P2-4, the W4
 * domain-recipe template).
 *
 * Shape every later W4 domain copies:
 *   1. a narrow capability type the server consumes (no store, no engine
 *      internals leak into the boundary);
 *   2. a `create…Domain(appStateStore)` factory living in the sidecar (which
 *      genuinely runs engine code) that implements it with the engine's OWN
 *      idioms — never a re-derivation.
 *
 * This module has ZERO transport knowledge: frames, validation, and limits
 * stay in `sidecarServer.ts`.
 */

import { feature } from 'bun:bundle'
import type { AppState } from '../../src/state/AppStateStore.js'
import type { Store } from '../../src/state/store.js'
import type { ToolPermissionContext } from '../../src/Tool.js'
import {
  isAutoModeGateEnabled,
  transitionPermissionMode,
} from '../../src/utils/permissions/permissionSetup.js'
import { shouldAllowManagedPermissionRulesOnly } from '../../src/utils/permissions/permissionsLoader.js'
import type { PermissionSetModeMode } from '../shared/protocol.js'

export type PermissionDisplayFacts = {
  managedRulesOnly: boolean
  permissionClassifierEnabled: boolean
}

/**
 * The desktop launches this unbundled module with Bun's
 * `--feature=TRANSCRIPT_CLASSIFIER`, matching the engine build's default feature
 * set. Requiring that runtime feature here is the fail-closed backstop: an
 * incorrectly launched sidecar must not advertise Auto when its classifier
 * branches were compiled out. `isAutoModeGateEnabled()` then applies the live
 * model, settings, and circuit-breaker checks.
 *
 * It is NOT throw-free, though: it resolves the main-loop model, which reaches
 * credential discovery and can raise. This runs on every app-state notification
 * and on the attach path, so a raise here would take the session down over a
 * display flag. Degrade to "unavailable" instead.
 */
function readPermissionDisplayFacts(): PermissionDisplayFacts {
  let permissionClassifierEnabled = false
  try {
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      permissionClassifierEnabled = isAutoModeGateEnabled()
    }
  } catch {
    permissionClassifierEnabled = false
  }
  return {
    managedRulesOnly: shouldAllowManagedPermissionRulesOnly(),
    permissionClassifierEnabled,
  }
}

export type SidecarPermissionDomain = {
  /**
   * Apply a boundary-validated external mode. Session-scoped by construction:
   * this writes the in-memory context only and never touches
   * `permissions.defaultMode` (decisions/PERMISSION-BOUNDARY.md §3 — no
   * destination exists on the wire).
   */
  setMode(mode: PermissionSetModeMode): void
  /** The engine's live context — the C3 snapshot source of truth. */
  getToolPermissionContext(): ToolPermissionContext
  /**
   * Read-only engine facts used by the rules viewer. These are deliberately
   * read at snapshot time so policy/gate changes cannot be reconstructed or
   * guessed in the renderer.
   */
  getDisplayFacts(): PermissionDisplayFacts
  /**
   * Fires whenever the live context reference changes, INCLUDING changes made
   * without boundary involvement (C1 updates applied by the engine's decision
   * path, PermissionRequest hooks applying rules mid-turn). Returns an
   * unsubscribe function.
   */
  subscribeToolPermissionContext(
    listener: (context: ToolPermissionContext) => void,
  ): () => void
}

export function createSidecarPermissionDomain(
  appStateStore: Store<AppState>,
): SidecarPermissionDomain {
  return {
    setMode(mode) {
      // The apply idiom (PERMISSION-BOUNDARY.md §3): mirror the bridge's
      // remote mode switch (useReplBridge.tsx:449-461) — the centralized
      // `transitionPermissionMode` so prePlanMode stash/clear, the plan-exit
      // flag, and auto-mode strip/restore all fire. NOT a bare
      // `applyPermissionUpdate({type:'setMode'})`, which skips that cleanup.
      // Policy guards already ran at the boundary: `auto` reaches here only
      // while the classifier feature and live gate are enabled, and
      // `bypassPermissions` reaches here only after the user selects it in the
      // app. `transitionPermissionMode` applies the resulting mode.
      appStateStore.setState(prev => {
        const current = prev.toolPermissionContext.mode
        if (current === mode) return prev
        const next = transitionPermissionMode(
          current,
          mode,
          prev.toolPermissionContext,
        )
        return { ...prev, toolPermissionContext: { ...next, mode } }
      })
    },

    getToolPermissionContext() {
      return appStateStore.getState().toolPermissionContext
    },

    getDisplayFacts() {
      return readPermissionDisplayFacts()
    },

    subscribeToolPermissionContext(listener) {
      // The store notifies on ANY app-state change; re-emit only when the
      // permission context itself changed (reference compare — engine code
      // replaces the context object on every permission mutation). P4-34 also
      // re-emits when either read-only display fact changes (managed settings
      // reload or classifier availability), even if the context reference did
      // not.
      let last = appStateStore.getState().toolPermissionContext
      let lastFacts = readPermissionDisplayFacts()
      return appStateStore.subscribe(() => {
        const next = appStateStore.getState().toolPermissionContext
        const nextFacts = readPermissionDisplayFacts()
        if (
          next === last &&
          nextFacts.managedRulesOnly === lastFacts.managedRulesOnly &&
          nextFacts.permissionClassifierEnabled ===
            lastFacts.permissionClassifierEnabled
        ) {
          return
        }
        last = next
        lastFacts = nextFacts
        listener(next)
      })
    },
  }
}
