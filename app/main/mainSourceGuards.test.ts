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
  // The signature is matched only as far as its first parameter: `forward` now
  // RETURNS the refusal code so a submit can be answered with why it failed,
  // and pinning the whole signature made this guard fail for a change that left
  // the property below untouched. The property is what matters, not the shape.
  const forward = region(
    'function forward(\n  sessionId: SessionId,',
    'function sanitizeSubmitOptions(',
  )
  expect(forward).toContain('if (!SESSION_ID_RE.test(sessionId)) return')
})

test('a replay is never stamped delivered before delivery is decided', () => {
  const rendererReady = region('ipcMain.on(CH_RENDERER_READY', 'ipcMain.on(CH_DELIVERY_ACK')
  // The 2026-08-14 defect in one expression: chaining the stage onto the gate's
  // output stamps every replayed frame, including the ones `deliver` then
  // declines. It reported 1,883 deliveries that never happened
  // (`docs/reports/2026-08-14-desktop-logging-feedback.md` D1).
  expect(rendererReady).not.toContain('attachmentGate.onRendererReady().map(')
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

test('a duplicate restore is refused before the winning replay gate can be touched', () => {
  // Electron main is not importable in this unit graph. AttachmentGate's
  // idempotence is covered behaviorally; this narrow wiring guard pins the
  // remaining ordering at the IPC handler.
  const restore = region(
    'ipcMain.handle(\n    CH_HOST_RESTORE',
    'ipcMain.handle(\n    CH_HOST_CLOSE',
  )
  const duplicateCheck = restore.indexOf('if (restoringSessions.has(sessionId))')
  const claim = restore.indexOf('restoringSessions.add(sessionId)')
  const replayStart = restore.indexOf(
    'attachmentGate.startReplayCoalescing(sessionId)',
  )
  const hostRestore = restore.indexOf('await host.restoreSession(sessionId)')

  expect(duplicateCheck).toBeGreaterThanOrEqual(0)
  expect(duplicateCheck).toBeLessThan(claim)
  expect(claim).toBeLessThan(replayStart)
  expect(replayStart).toBeLessThan(hostRestore)
})

test('the dev app name never depends on the userData path', () => {
  const appNaming = region(
    "if (IS_DEV) app.setName('Cat Code Dev')",
    'const APP_ICON_PATH',
  )
  expect(appNaming).not.toContain("app.getPath('userData')")
  expect(appNaming).not.toContain('app.getPath("userData")')
})

test('the account-pool refresh channel has no payload and reuses the existing driver', () => {
  expect(source).toContain(
    "const CH_REFRESH_ACCOUNTS_POOL = 'catcode:refresh-accounts-pool'",
  )
  const refresh = region(
    'ipcMain.on(CH_REFRESH_ACCOUNTS_POOL',
    'ipcMain.on(CH_OPEN_LOGS',
  )
  expect(refresh).toContain('isMainWindowSender(event)')
  expect(refresh).toContain('refreshAccountsPoolNow()')
  expect(refresh).not.toContain('payload')
  expect(refresh).not.toContain('forward(')
})

test('HC1: the picker hands back a token, never the path the user chose', () => {
  const pick = region(
    'ipcMain.handle(\n    CH_HOST_PICK_DIR',
    'ipcMain.handle(\n    CH_HOST_CREATE',
  )
  expect(pick).not.toContain('return chosen.realpath')
})

test('HC1: non-image file attachments resolve opaque tokens without returning paths', () => {
  const pick = region(
    'ipcMain.handle(\n    CH_HOST_PICK_ATTACHMENT_FILE',
    'ipcMain.handle(\n    CH_HOST_CREATE',
  )

  expect(pick).toContain('attachmentFileTokens.mint(appSessionId, realpath)')
  expect(pick).not.toContain('return realpath')
})

test('HC1: the save-text handler never hands the chosen path back to the renderer', () => {
  // P4-35. The renderer learns whether a file was written, never where: the user
  // chose the destination in main's own dialog, so main has no reason to echo it
  // across the boundary — and echoing it would make the picker's whole
  // token-instead-of-path posture pointless one channel over.
  const save = region(
    'ipcMain.handle(\n    CH_HOST_SAVE_TEXT',
    'ipcMain.handle(CH_HOST_OPEN_WORKSPACE_FILE',
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

test('F2: a torn-down host after registry launch resets the transcript-backfill latch', () => {
  // `backfillTranscriptCaches` latches `transcriptBackfillStarted = true`
  // synchronously (needed so a second concurrent call cannot start a second
  // pass) and only THEN awaits `registryLaunchSettled`. Its abort controller
  // is not created/stored until after that await, so if the last window
  // closes while it is still pending, `stopBackgroundDrivers()` has nothing
  // to abort, and `window-all-closed` nulls `host`. Without a reset on this
  // exact return path, the latch stays true for the life of the process and
  // every later window paint's retry is turned away by the guard at the top
  // of the function.
  const backfill = region(
    'const h = host',
    '// Discovery must not synchronously parse',
  )
  const nullHostBranch = backfill.indexOf('if (!h)')
  expect(nullHostBranch).toBeGreaterThanOrEqual(0)
  const reset = backfill.indexOf('transcriptBackfillStarted = false')
  const returnStatement = backfill.indexOf('return', nullHostBranch)
  expect(reset).toBeGreaterThan(nullHostBranch)
  expect(reset).toBeLessThan(returnStatement)
})

test('HR2/HR6: a host.request is consumed by main and never reaches the renderer', () => {
  // The one property this frame's whole design rests on: `host.request` carries
  // a MODEL-AUTHORED payload, and the renderer is the least trusted zone on this
  // wire, so the branch must return BEFORE the attachment gate — which is both
  // the replay buffer and the route to `webContents.send`. Its retention entry
  // in `replayBuffer.ts` classifies a frame this return makes unreachable; that
  // table is exhaustive by construction, not a permission to forward.
  //
  // A source guard because importing Electron main launches the application.
  // What it proves is an ORDERING inside one function, which is exactly the
  // shape the duplicate-restore guard above proves, and it fails loudly if the
  // region moves rather than narrowing to an empty string.
  const bridge = region(
    'function wireRendererBridge(sup: SidecarSupervisor): void',
    'function wireHostEvents(h: Host): void',
  )
  const branch = bridge.indexOf("if (frame.kind === 'host.request')")
  expect(branch).toBeGreaterThanOrEqual(0)
  const handled = bridge.indexOf('peerPlane?.handleRequest(', branch)
  const gate = bridge.indexOf('attachmentGate.onFrame(event.sessionId, traced)')
  const returnStatement = bridge.indexOf('return', handled)
  expect(handled).toBeGreaterThan(branch)
  expect(returnStatement).toBeGreaterThan(handled)
  expect(returnStatement).toBeLessThan(gate)
  // …and it is never handed to `deliver`, the only path to `webContents.send`.
  const interceptRegion = bridge.slice(branch, returnStatement)
  expect(interceptRegion).not.toContain('deliver(')
})

test('the roster reads the run-controls fields the engine RESOLVED, not the ones it was asked for', () => {
  // The same JOIN argument as the liveness composition below, and the same
  // honesty about what a grep proves. Both halves are covered for real (the
  // frame's shape in the protocol, the plane's store in
  // `peerRequestPlane.test.ts`), and the one line that joins them is in main,
  // which no unit test can call.
  //
  // It is asserted because tsc cannot: `current` and `selected` are both
  // `string | null` on the same object, and `selected` is the user's SETTING,
  // null whenever the session runs a provider default or a model from the
  // environment. Wired to it, the roster would report nothing for exactly the
  // sessions whose model was never typed into a picker, with a green battery.
  const bridge = region(
    'function wireRendererBridge(sup: SidecarSupervisor): void',
    'function wireHostEvents(h: Host): void',
  )
  const branch = bridge.indexOf("if (frame.kind === 'run-controls.snapshot')")
  expect(branch).toBeGreaterThanOrEqual(0)
  const observation = bridge.slice(branch, branch + 700)
  expect(observation).toContain('peerPlane?.recordRunControls(')
  expect(observation).toContain('model: frame.runControls.model.current')
  expect(observation).toContain('effort: frame.runControls.effort.current')
})

test('the peer plane is composed with the supervisor-backed liveness predicate', () => {
  // T2 — the one line that turns `mainDecisions.ts`'s predicate into the plane's
  // `isLive`. Both halves are covered for real (the predicate in
  // `mainDecisions.test.ts`, the plane in `peerRequestPlane.test.ts`) and the
  // JOIN between them was covered by nothing: every plane test injects its own
  // `isLive`, so a composition wired to `listSessions().some(...)` again, or to
  // nothing at all, would break delivery with a fully green battery.
  //
  // Same shape as the `host.request` ordering guard above: an ORDERING and a
  // presence inside one region, failing loudly if the region moves.
  const composition = region(
    'peerPlane = createPeerRequestPlane({',
    '// IS-A startup GC',
  )
  expect(composition).toContain('isSessionLive(supervisor.listSessions(), appSessionId)')
  // Membership is the defect this replaced; it must not come back.
  expect(composition).not.toContain('listSessions().some(')
  // F6, same reasoning one dep further along: the plane reads raw registry rows,
  // so the roster's reachability filter is this one line. Every plane test
  // injects its own `canResume`, so a composition wired to a constant would
  // re-advertise transcript-less rows with a fully green battery.
  expect(composition).toContain('canResume: appSessionId => liveHost.canResume(appSessionId)')
})

test('the plane sends through the entry point that raises no renderer error frame', () => {
  // A SOURCE guard, not a behavioural one, for the reason at the top of this
  // file: `forwardInternal` lives in `main.ts`, and importing `main.ts` starts
  // an Electron app, so no unit test can call it. What is asserted here is
  // therefore the composition and an ABSENCE inside one region — the shape this
  // file is honest about — while the plane's own use of its `forward` dep is
  // covered for real in `peerRequestPlane.test.ts`.
  //
  // The property: plane traffic is a `host.result` answering the engine's own
  // request and a `peer.deliver` no pane asked for. Sent through the
  // renderer-facing `forward`, a failure is turned into an error frame and
  // delivered, and `connectionState.ts` reduces `session_not_found`,
  // `session_not_ready` and `session_disconnected` into a pane's connection
  // status by CODE, ignoring the request id. So one failed internal ack shows a
  // danger banner and locks the composer of a session the user never touched.
  const composition = region(
    'peerPlane = createPeerRequestPlane({',
    '// IS-A startup GC',
  )
  expect(composition).toContain('forward: forwardInternal')

  // …and the entry point it names must actually skip the notification. The
  // failure code still travels back — the plane picks `delivery_failed` vs
  // `wake_failed` from it — so only the notification half may be dropped.
  const wrapper = region('function forwardInternal(', 'function handOff(')
  expect(wrapper).toContain("return handOff(sessionId, message, 'internal')")
  expect(wrapper).not.toContain('deliver(')

  // In the shared body every `deliver` sits inside the renderer branch, so the
  // internal audience reaches none of them: one guard per delivery, none of
  // them before the first guard.
  const guard = /if \(audience === 'renderer'\) \{/g
  const body = region('function handOff(', 'function sanitizeSubmitOptions(')
  expect(body).toContain("audience: 'renderer' | 'internal'")
  const segments = body.split(guard)
  expect(body.match(/deliver\(/g) ?? []).not.toHaveLength(0)
  expect(segments[0]).not.toContain('deliver(')
  for (const segment of segments.slice(1)) {
    expect(segment.match(/deliver\(/g) ?? []).toHaveLength(1)
  }
})
