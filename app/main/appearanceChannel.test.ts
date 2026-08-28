/**
 * The boundary test for `catcode:set-appearance`, the one channel the light
 * appearance had to add (`app/renderer/src/colorScheme.ts`,
 * `docs/migration/decisions/SECURITY-MINIMUM.md` HC3).
 *
 * It is written as a source guard rather than a live handler test for the same
 * reason `mainSourceGuards.test.ts` is: `main.ts` boots an Electron app and a
 * supervisor at import time, so the handler cannot be imported in isolation. A
 * source guard is weaker than an invocation, and it is the strongest evidence
 * available here. What it is guarding against is specific and has a shape:
 *
 *   - the channel exists on both sides under the SAME literal, since a renamed
 *     constant on one side is a silently dead preference, not a build error;
 *   - main narrows the payload itself. The preload also checks, but the preload
 *     is not the trust boundary, and this is the check that has to hold if a
 *     renderer is ever compromised;
 *   - the narrowing is a CLOSED SET of three, and `'system'` is a REQUIRED
 *     member rather than a widening: `themeSource` is an override, so a channel
 *     carrying only `light`/`dark` pins the appearance the first time anyone
 *     leaves the app on "Match system" and the OS can never move it again. An
 *     earlier version of this file asserted the opposite and encoded that bug;
 *   - it never reaches the sidecar. The appearance is a property of this window;
 *     the engine has no opinion about it and must never gain one.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const CHANNEL = "'catcode:set-appearance'"

function mainSource(): string {
  return readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
}

function preloadSource(): string {
  return readFileSync(new URL('../preload/preload.ts', import.meta.url), 'utf8')
}

test('the appearance channel is one literal, declared on both sides', () => {
  expect(mainSource()).toContain(`const CH_SET_APPEARANCE = ${CHANNEL}`)
  expect(preloadSource()).toContain(`const CH_SET_APPEARANCE = ${CHANNEL}`)
})

test('the preload exposes it as the three-value choice and guards the send', () => {
  const source = preloadSource()
  expect(source).toContain("setAppearance(scheme: 'system' | 'light' | 'dark'): void")
  expect(source).toContain('sendGuard.assertAllowed({ scheme })')
  expect(source).toContain('ipcRenderer.send(CH_SET_APPEARANCE, scheme)')
})

/**
 * The narrowing, asserted on main's own copy. `unknown` in the handler signature
 * is the load-bearing part: typing the parameter as the union would make the
 * guard look redundant to a future reader and invite its removal, when the whole
 * point is that nothing across an IPC boundary is typed.
 */
test('main re-validates the payload against the closed set and drops the rest', () => {
  const source = mainSource()
  const handler = source.slice(source.indexOf('ipcMain.on(CH_SET_APPEARANCE'))
  const body = handler.slice(0, handler.indexOf('\n  })'))
  expect(body).toContain('scheme: unknown')
  expect(body).toContain(
    "if (scheme !== 'system' && scheme !== 'light' && scheme !== 'dark') return",
  )
  expect(body).toContain('nativeTheme.themeSource = scheme')
  // The rejection has to come first, or the assignment is reachable with junk.
  expect(body.indexOf('return')).toBeLessThan(body.indexOf('nativeTheme.themeSource'))
})

/**
 * The regression guard for the defect this channel shipped with, and the reason
 * `'system'` has to travel the whole way rather than being resolved away.
 *
 * `themeSource` is an OVERRIDE, and the renderer resolves the `system` choice
 * against `prefers-color-scheme`, which that override PINS. A channel carrying
 * only the resolved appearance therefore forced `light` or `dark` the moment
 * anyone left the app on "Match system", after which the OS could never move it:
 * measured as Match system, then Light, then Match system again leaving a dark
 * Mac on a light window permanently, with `getEffectiveAppearance()` agreeing.
 * `'system'` is the release, so it must be reachable from the bridge signature
 * all the way to the assignment.
 */
test('the system choice reaches themeSource, because it is the release', () => {
  const protocol = readFileSync(
    new URL('../shared/protocol.ts', import.meta.url),
    'utf8',
  )
  expect(protocol).toContain(
    "setAppearance(scheme: 'system' | 'light' | 'dark'): void",
  )
  expect(preloadSource()).toContain("scheme !== 'system'")

  const source = mainSource()
  const handler = source.slice(source.indexOf('ipcMain.on(CH_SET_APPEARANCE'))
  const body = handler.slice(0, handler.indexOf('\n  })'))
  // The guard lists what is ALLOWED, so `system` is proved reachable by its
  // presence in the allow-list and the absence of any separate rejection.
  expect(body).toContain("scheme !== 'system' &&")
  expect(body).not.toMatch(/scheme === 'system'[^\n]*return/)
})

/**
 * The appearance stays on the main plane. It is not a frame kind, the sidecar
 * has no schema for it, and nothing forwards it onward.
 */
test('the appearance never becomes sidecar vocabulary', () => {
  const protocol = readFileSync(
    new URL('../shared/protocol.ts', import.meta.url),
    'utf8',
  )
  // Present as a bridge method on the control plane...
  expect(protocol).toContain(
    "setAppearance(scheme: 'system' | 'light' | 'dark'): void",
  )
  // ...and absent from the inbound frame vocabulary.
  expect(protocol).not.toContain("kind: 'setAppearance'")
  expect(protocol).not.toContain("'set-appearance'")

  const source = mainSource()
  const handler = source.slice(source.indexOf('ipcMain.on(CH_SET_APPEARANCE'))
  const body = handler.slice(0, handler.indexOf('\n  })'))
  for (const forwarder of ['sup.', 'supervisor', 'sendToSidecar', 'webContents.send']) {
    expect(body).not.toContain(forwarder)
  }
})

/**
 * The half of the preference that lives outside the channel, and the guard that
 * keeps a removed listener removed.
 *
 * A listener on `nativeTheme`'s `updated` event, calling `setVibrancy` on every window,
 * used to sit beside the channel, on the claim that macOS resolves a window's
 * material once at creation and leaves it in the appearance the window was BORN
 * in. That claim is false on Electron 33.4.11. Measured 2026-08-28 by capturing
 * the composited window and reading the page ground's pixels, with no
 * `setVibrancy` call anywhere in the probe: a window carrying `createWindow`'s
 * exact options, born while `themeSource` was still `'system'`, reads #2E2E30
 * under dark, #929294 after an override to `'light'`, and #2E2E30 again on the
 * way back. A second window re-minted on every `updated` event was pixel-identical
 * at all three points.
 *
 * It is guarded because re-adding it is the obvious "fix" for a symptom it does
 * not fix. `setVibrancy` cannot make a non-vibrant window vibrant (a window born
 * without the option stays on its opaque ground, measured #252525 unchanged), so
 * the listener has no repair value; and because `createWindow` clears the
 * window's own background to hand the material the ground, a window that loses
 * its `NSVisualEffectView` is a HOLE the desktop composites through, not a solid
 * window. One unrecoverable failure mode, no measured upside.
 */
test('the window material is set once at creation and never re-asserted', () => {
  const source = mainSource()
  expect(source).toContain("const WINDOW_VIBRANCY = 'under-window' as const")
  // The window is BORN with it...
  expect(source).toContain('vibrancy: WINDOW_VIBRANCY,')
  // ...and no second literal is left behind to drift from it.
  expect(source).not.toContain("vibrancy: 'under-window'")

  // Nothing calls it at runtime. Comments naming it are how the finding is kept,
  // so the guard is on the call, not the word.
  expect(source).not.toMatch(/\.setVibrancy\(/)
  expect(source).not.toContain("nativeTheme.on('updated'")
})
