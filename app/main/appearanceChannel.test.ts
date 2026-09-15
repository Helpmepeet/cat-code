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
 *   - the channel exists on both sides under the SAME literal. Both ends now
 *     import that literal from `app/shared/ipcChannels.ts`, so a rename on one
 *     side IS a build error; what this checks is that the arrangement holds and
 *     neither side has gone back to a local copy;
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

function channelsSource(): string {
  return readFileSync(new URL('../shared/ipcChannels.ts', import.meta.url), 'utf8')
}

test('the appearance channel is one literal, declared on both sides', () => {
  expect(channelsSource()).toContain(`export const CH_SET_APPEARANCE = ${CHANNEL}`)
  expect(mainSource()).toContain('CH_SET_APPEARANCE')
  expect(preloadSource()).toContain('CH_SET_APPEARANCE')
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
 * A listener on `nativeTheme`'s `updated` event, calling `setVibrancy` on every
 * window, used to sit beside the channel, on the claim that macOS resolves a
 * window's material once at creation and leaves it in the appearance the window
 * was BORN in. That claim does not hold on Electron 33.4.11. Measured 2026-08-28
 * by capturing the composited window and reading the page ground's pixels, with
 * no `setVibrancy` call anywhere in the probe: a window carrying `createWindow`'s
 * exact options, born while `themeSource` was still `'system'`, reads #2E2E30
 * under dark, #929294 after an override to `'light'`, and #2E2E30 again on the
 * way back. A twin re-minted on every `updated` event matched within capture
 * variation. Independently, reasserting the same material twenty times leaves the
 * same `NSVisualEffectView` pointer and state, so the re-mint does not rebuild
 * the view it was meant to.
 *
 * WHAT THIS GUARD DOES NOT SAY, corrected 2026-08-28. It used to forbid every
 * `.setVibrancy(` call in the file, on the belief that the call cannot make a
 * non-vibrant window vibrant. That belief is false — the call does create the
 * effect view; on the window it was measured against, an opaque backing covered
 * the result — so a targeted repair using `setVibrancy` must stay POSSIBLE. What
 * is guarded is only the shape that was removed: an unconditional, every-window
 * re-mint hung off the appearance event. A future repair with a reason may call
 * it; this listener may not come back.
 */
test('an appearance change does not re-mint every window material', () => {
  const source = mainSource()
  expect(source).toContain("const WINDOW_VIBRANCY = 'under-window' as const")
  // The window is BORN with it...
  expect(source).toContain('vibrancy: WINDOW_VIBRANCY,')
  // ...and no second literal is left behind to drift from it.
  expect(source).not.toContain("vibrancy: 'under-window'")

  // The removed shape, not the API. Comments naming the event are how the
  // finding is kept, so the guard is on the listener registration itself.
  expect(source).not.toContain("nativeTheme.on('updated'")
  expect(source).not.toMatch(/getAllWindows\(\)[\s\S]{0,200}?\.setVibrancy\(/)
})
