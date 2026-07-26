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

import type { AppState } from '../../src/state/AppStateStore.js'
import type { Store } from '../../src/state/store.js'
import type { ToolPermissionContext } from '../../src/Tool.js'
import { feature } from 'bun:bundle'
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

function readPermissionDisplayFacts(): PermissionDisplayFacts {
  return {
    managedRulesOnly: shouldAllowManagedPermissionRulesOnly(),
    permissionClassifierEnabled: feature('TRANSCRIPT_CLASSIFIER')
      ? isAutoModeGateEnabled()
      : false,
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
      // Policy guards already ran at the boundary: `auto` is always rejected,
      // and `bypassPermissions` reaches here ONLY when the trusted launch flag
      // enabled it (isBypassPermissionsModeAvailable) — otherwise the boundary
      // rejected it. `transitionPermissionMode` applies the resulting mode.
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
