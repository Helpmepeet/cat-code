/**
 * Navigation / window-open decision policy (SECURITY-MINIMUM §3 Navigation, T3;
 * review findings F8/F16).
 *
 * These are the pure decisions behind the Electron `will-navigate`,
 * `will-redirect`, and `setWindowOpenHandler` guards. They are factored out of
 * `main.ts` (which cannot run outside Electron) so the security policy — what
 * navigation is allowed, and what a `window.open` is allowed to do — is
 * unit-testable without an Electron process. `main.ts` wires these into the real
 * Electron events; the effect (`event.preventDefault`, `shell.openExternal`)
 * lives there, the DECISION lives here.
 */

import { fileURLToPath } from 'node:url'

export type NavigationConfig =
  | { isDev: true; devOrigin: string }
  | { isDev: false; packagedIndexPath: string }

/**
 * Whether a navigation/redirect target is the app itself. Everything else is
 * blocked (T3): in dev only the Vite dev origin; in production ONLY the exact
 * packaged renderer entry file (F8 — not every `file:` URL, or an
 * attacker-planted local HTML file would load with the preload bridge attached).
 */
export function isAppOrigin(url: string, config: NavigationConfig): boolean {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return false // opaque/relative/`javascript:`-with-no-parse → not app origin
  }
  if (config.isDev) {
    let dev: URL
    try {
      dev = new URL(config.devOrigin)
    } catch {
      return false
    }
    // The dev server is an http(s) origin (Vite). Require that explicitly: an
    // opaque scheme (`file:`, `data:`, `javascript:`) serializes its origin to
    // the literal string "null", and a misconfigured non-http `devOrigin` is
    // ALSO "null" — so a bare `target.origin === dev.origin` would let a
    // `file:///etc/passwd` navigation match a `file:` devOrigin. Pin the dev
    // origin to http/https and compare protocol + origin so no opaque target can
    // slip through (F16).
    if (dev.protocol !== 'http:' && dev.protocol !== 'https:') return false
    if (target.protocol !== dev.protocol) return false
    return target.origin === dev.origin && target.origin !== 'null'
  }
  if (target.protocol !== 'file:') return false
  try {
    return fileURLToPath(target) === config.packagedIndexPath
  } catch {
    return false
  }
}

export type WindowOpenDecision =
  | { action: 'deny' }
  | { action: 'deny'; openExternal: string }

/**
 * What to do with a renderer-initiated `window.open` / `target=_blank`. The
 * action is ALWAYS `deny` — the renderer may never spawn a new Electron
 * BrowserWindow. Only an `https:` URL is additionally handed to the OS browser
 * via `shell.openExternal`; `http:`, `file:`, `javascript:`, `data:`, etc. are
 * denied with no external hand-off.
 */
export function decideWindowOpen(url: string): WindowOpenDecision {
  if (isSafeExternalUrl(url)) {
    return { action: 'deny', openExternal: url }
  }
  return { action: 'deny' }
}

/** Only `https:` is handed to the OS browser. Anything else is not opened. */
export function isSafeExternalUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}
