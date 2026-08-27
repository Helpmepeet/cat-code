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
 *   - the narrowing is a CLOSED PAIR. `nativeTheme.themeSource` also accepts
 *     `'system'`, so a handler that coerced instead of rejecting would let a
 *     malformed payload hand the window's appearance back to the OS while the
 *     page went on painting the forced one;
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

test('the preload exposes it as a two-value union and guards the send', () => {
  const source = preloadSource()
  expect(source).toContain("setAppearance(appearance: 'light' | 'dark'): void")
  expect(source).toContain('sendGuard.assertAllowed({ appearance })')
  expect(source).toContain('ipcRenderer.send(CH_SET_APPEARANCE, appearance)')
})

/**
 * The narrowing, asserted on main's own copy. `unknown` in the handler signature
 * is the load-bearing part: typing the parameter as the union would make the
 * guard look redundant to a future reader and invite its removal, when the whole
 * point is that nothing across an IPC boundary is typed.
 */
test('main re-validates the payload against the closed pair and drops the rest', () => {
  const source = mainSource()
  const handler = source.slice(source.indexOf('ipcMain.on(CH_SET_APPEARANCE'))
  const body = handler.slice(0, handler.indexOf('\n  })'))
  expect(body).toContain('appearance: unknown')
  expect(body).toContain("if (appearance !== 'light' && appearance !== 'dark') return")
  expect(body).toContain('nativeTheme.themeSource = appearance')
  // The rejection has to come first, or the assignment is reachable with junk.
  expect(body.indexOf('return')).toBeLessThan(body.indexOf('nativeTheme.themeSource'))
})

test('main never widens the appearance to the system value', () => {
  const source = mainSource()
  const handler = source.slice(source.indexOf('ipcMain.on(CH_SET_APPEARANCE'))
  expect(handler.slice(0, handler.indexOf('\n  })'))).not.toContain("'system'")
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
  expect(protocol).toContain("setAppearance(appearance: 'light' | 'dark'): void")
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
