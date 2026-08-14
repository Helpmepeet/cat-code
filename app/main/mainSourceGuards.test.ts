import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

/**
 * ABSENCE guards over `main.ts`'s own source text. This file is not coverage.
 *
 * `main.ts` is the Electron entry point, so importing it starts an Electron app
 * and no unit test can call into it. Everything here is therefore a grep, and a
 * grep can only prove one thing honestly: that a string is ABSENT. For a handful
 * of trust-boundary invariants the absence IS the invariant — the renderer must
 * never receive a real path, main must never grow an engine import — so a grep
 * is the right tool and the only one available.
 *
 * A grep proves nothing in the other direction. Asserting that main's source
 * CONTAINS a call proves the text exists: not that it runs, not that it runs in
 * the asserted order, not that it is passed the right arguments. The call could
 * sit inside `if (false)` or be handed `null as never` and the assertion would
 * stay green. This file previously held ~40 such assertions across 18 tests and
 * executed zero production code. They are gone: main's decisions that need no
 * Electron API now live in `mainDecisions.ts` and are exercised for real in
 * `mainDecisions.test.ts`. What remains inside `main.ts` is Electron wiring,
 * which only a live run can verify.
 *
 * Anchor lookups throw rather than assert, so a region that moved fails loudly
 * instead of silently narrowing to an empty string that passes every `not`.
 */

const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')

function region(startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle)
  if (start < 0) throw new Error(`main.ts no longer contains: ${startNeedle}`)
  const end = source.indexOf(endNeedle, start)
  if (end <= start) {
    throw new Error(`main.ts no longer contains ${endNeedle} after ${startNeedle}`)
  }
  return source.slice(start, end)
}

test('main never imports the engine graph', () => {
  // Electron main must stay engine-free: an import here pulls the ~189 MB engine
  // onto the launch critical path and into the process that owns the window.
  expect(source).not.toMatch(/from ['"]\.\.\/\.\.\/src\//)
})

test('the P1-1 pinned boot cwd literal stays retired', () => {
  expect(source).not.toContain('P1_1_CWD')
})

test('ids are never drawn from Math.random', () => {
  // Request ids and directory tokens are correlation/capability values; a
  // predictable generator makes a token guessable (HC1).
  expect(source).not.toContain('Math.random')
  expect(source).not.toContain('cryptoRandomId')
})

test('renderer frame forwarding rejects non-supervisor session ids before buffering errors', () => {
  // This is a source guard because importing Electron main would launch the
  // application. The runtime behavior is covered by the focused sidecar and
  // host tests; here we pin the sole forwarding choke point against a future
  // handler-level validation regression.
  const forward = region(
    'function forward(sessionId: SessionId, message: SidecarClientMessage): void',
    'function sanitizeSubmitOptions(',
  )
  expect(forward).toContain('if (!SESSION_ID_RE.test(sessionId)) return')
})

test('a normal startup never opts into the sidecar probe', () => {
  const createSupervisor = region(
    'function createSupervisor(): SidecarSupervisor',
    'function validateCwd(',
  )
  expect(createSupervisor).not.toContain('CATCODE_SIDECAR_PROBE')
})

test('host startup leaves session creation to an explicit renderer action', () => {
  const ensureHost = region('function ensureHost(): Host', 'function errText(')

  expect(ensureHost).not.toContain('.createSession(')
})

test('the dev app name never depends on the userData path', () => {
  expect(source).not.toContain("app.getPath('userData')")
  expect(source).not.toContain('app.getPath("userData")')
})

test('HC1: the picker hands back a token, never the path the user chose', () => {
  const pick = region(
    'ipcMain.handle(\n    CH_HOST_PICK_DIR',
    'ipcMain.handle(\n    CH_HOST_CREATE',
  )
  expect(pick).not.toContain('return chosen.realpath')
})

test('HC1: the save-text handler never hands the chosen path back to the renderer', () => {
  // P4-35. The renderer learns whether a file was written, never where: the user
  // chose the destination in main's own dialog, so main has no reason to echo it
  // across the boundary — and echoing it would make the picker's whole
  // token-instead-of-path posture pointless one channel over.
  const save = region(
    'ipcMain.handle(\n    CH_HOST_SAVE_TEXT',
    'function registerDebugStateHandler',
  ).replace(/\/\/.*$/gm, '')

  // The dialog's answer is used in EXACTLY two places, both pinned below: the
  // cancellation check and the write itself. A third occurrence would be the path
  // escaping into a returned value or a message, so the count is the guard.
  expect(save.match(/filePath/g)).toHaveLength(2)
  expect(save).toContain(
    'if (result.canceled || !result.filePath) return { ok: true, saved: false }',
  )
  expect(save).toContain('await writeFile(result.filePath, validated.text')

  // The write target is the dialog's answer, never a renderer-supplied string:
  // the payload is read only through the pure validator.
  expect(save).toContain('validateSaveTextRequest(input)')
  expect(save).not.toContain('readString(input')
  // Validation is not optional: a rejected payload returns before any dialog.
  expect(save.indexOf('validateSaveTextRequest')).toBeLessThan(
    save.indexOf('showSaveDialog'),
  )
})

test('HC1: the create handler reads no renderer cwd and no renderer resume id', () => {
  const create = region(
    'ipcMain.handle(\n    CH_HOST_CREATE',
    'ipcMain.handle(\n    CH_HOST_RESTORE',
  )
  expect(create).not.toMatch(/readString\([^)]*['"]cwd['"]\)/)
  // Resume is reachable only through a registry row or the open-from-history
  // resolver, both main-resolved; a renderer-supplied id must not reach spawn.
  expect(create).not.toContain('resumeEngineSessionId')
})

test('the control plane adds zero socket frame types (stays off the wire in v1)', () => {
  // Control-plane calls are host-API invocations, never SidecarClientMessages —
  // main never forwards a create/close/list as a frame to a sidecar.
  expect(source).not.toContain("type: 'app.createSession'")
  expect(source).not.toContain("type: 'host.")

  // The only forward() targets that construct a `type:` literal are the engine
  // commands + the app-owned frames main mints/relays a literal for
  // (permission.setMode, agent-mode.set, C5/P4-20 askUserQuestion.answer).
  // Object-forwarded verbs (account.*, workspace.*, remoteSettings.*, settings.*)
  // pass `arg.verb` and never match. A new literal here is a widened outbound
  // vocabulary and must be a deliberate decision, not a drive-by.
  const forwardTypes = [
    ...source.matchAll(/forward\([^,]+,\s*\{\s*\n?\s*type:\s*'([^']+)'/g),
  ].map(match => match[1])
  expect(forwardTypes.length).toBeGreaterThan(0)
  for (const type of forwardTypes) {
    expect([
      'app.submit',
      'app.abort',
      'permission.response',
      'permission.setMode',
      'agent-mode.set',
      'askUserQuestion.answer',
      'app.ping',
    ]).toContain(type)
  }
})
