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
