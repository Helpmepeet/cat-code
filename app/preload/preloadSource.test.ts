import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

test('every fixed renderer-to-main sender passes through the shared IPC guard', () => {
  const source = readFileSync(new URL('./preload.ts', import.meta.url), 'utf8')

  expect(source).toContain("const CH_RESTART = 'catcode:restart'")
  expect(source).toContain('restart(sessionId: SessionId): Promise<HostResult<void>>')
  expect(source).toContain("const CH_SET_MODE = 'catcode:set-mode'")
  expect(source).toContain(
    'setPermissionMode(sessionId: SessionId, mode: PermissionSetModeMode): void',
  )
  // C5 (P4-20) — AskUserQuestion answer sender rides its own fixed channel.
  expect(source).toContain(
    "const CH_ANSWER_QUESTIONS = 'catcode:answer-questions'",
  )
  expect(source).toContain('answerQuestions(')
  // P4-5 — account lifecycle verb sender rides its own fixed channel (HC3).
  expect(source).toContain("const CH_ACCOUNT_VERB = 'catcode:account-verb'")
  expect(source).toContain(
    'accountVerb(sessionId: SessionId, verb: AccountVerbMessage): void',
  )
  expect(source).toContain(
    "const CH_HOST_ACCOUNT_DELETE = 'catcode:host:account-delete'",
  )
  expect(source).toContain('deleteAccount(verb: AccountDeleteMessage)')
  // P4-15 — workspace-trust accept verb sender rides its own fixed channel (HC3).
  expect(source).toContain(
    "const CH_WORKSPACE_TRUST_VERB = 'catcode:workspace-trust-verb'",
  )
  expect(source).toContain(
    'workspaceTrustVerb(sessionId: SessionId, verb: WorkspaceTrustMessage): void',
  )
  // P4-8b — agent-mode set sender rides its own fixed channel (HC3).
  expect(source).toContain("const CH_AGENT_MODE_SET = 'catcode:agent-mode-set'")
  expect(source).toContain(
    'setAgentMode(sessionId: SessionId, active: boolean): void',
  )
  // P4-13 — RemoteSettings verb sender rides its own fixed channel (HC3).
  expect(source).toContain(
    "const CH_REMOTE_SETTINGS_VERB = 'catcode:remote-settings-verb'",
  )
  expect(source).toContain(
    'remoteSettingsVerb(sessionId: SessionId, verb: RemoteVerbMessage): void',
  )
  // P4-19 — settings write verb sender rides its own fixed channel (HC3).
  expect(source).toContain("const CH_SETTINGS_VERB = 'catcode:settings-verb'")
  expect(source).toContain(
    'settingsVerb(sessionId: SessionId, verb: SettingsVerbMessage): void',
  )
  // P4-24c — composer run-control verb sender rides its own fixed channel (HC3).
  expect(source).toContain("const CH_RUN_CONTROL_VERB = 'catcode:run-control-verb'")
  expect(source).toContain(
    'runControlVerb(sessionId: SessionId, verb: RunControlVerbMessage): void',
  )
  // P4-6b — session-action verb sender rides its own fixed channel (HC3).
  expect(source).toContain(
    "const CH_SESSION_ACTION_VERB = 'catcode:session-action-verb'",
  )
  expect(source).toContain(
    'sessionActionVerb(sessionId: SessionId, verb: SessionActionVerbMessage): void',
  )
  // Context-breakdown refresh sender rides its own fixed channel (HC3). Carries
  // only a requestId: the analysis reads engine-side state exclusively.
  expect(source).toContain(
    "const CH_CONTEXT_BREAKDOWN_VERB = 'catcode:context-breakdown-verb'",
  )
  expect(source).toContain('contextBreakdownVerb(')
  // Load-earlier read sender rides its own fixed channel (HC3). Carries only a
  // requestId: the sidecar owns which transcript is read and how much of it.
  expect(source).toContain(
    "const CH_HISTORY_LOAD_EARLIER = 'catcode:history-load-earlier'",
  )
  expect(source).toContain('loadEarlierHistory(')
  // P4-8b — task-control (worker Stop/kill) verb sender rides its own fixed channel (HC3).
  expect(source).toContain("const CH_TASK_CONTROL_VERB = 'catcode:task-control-verb'")
  expect(source).toContain(
    'taskControlVerb(sessionId: SessionId, verb: TaskControlVerbMessage): void',
  )
  // SESSIONS-UNIFICATION (2026-07-20) — open-from-history sender rides its own
  // fixed channel (HC3). The renderer carries only an engine session id.
  expect(source).toContain(
    "const CH_HOST_OPEN_HISTORY = 'catcode:host:open-history'",
  )
  expect(source).toContain('openHistorySession(')
  // 20 frame-plane senders (including the fixed metadata-only delivery ack; no
  // generic logging IPC) (incl. P4-5 accountVerb + P4-15 workspaceTrustVerb +
  // P4-8b setAgentMode + P4-8b taskControlVerb + P4-13 remoteSettingsVerb + P4-19
  // settingsVerb + P4-24c runControlVerb + P4-6b sessionActionVerb + C5/P4-20
  // answerQuestions + contextBreakdownVerb + D1b recallPrompts + loadEarlierHistory) + 11 payload-bearing control-plane
  // senders plus openWorkspaceFile + the DEV-only
  // debug-state sender (compiled out of the packaged preload.cjs). (pickDirectory/
  // createSession/createSessionInWorkspace/restoreSession/closeSession/listSessions/
  // previewSession/readSessionsCatalog/openHistorySession/P4-35 saveTextToFile/
  // session-independent deleteAccount).
  // subscribe / subscribeHost register a listener and send no payload, so they do
  // NOT (and must not) call the guard.
  // Usage stats query sender rides its own fixed channel (HC3).
  expect(source).toContain("const CH_STATS_QUERY = 'catcode:stats-query'")
  expect(source).toContain('queryStats(')
  // IDLE-PARK §4(b) — the visible-pane hint is a fixed one-way sender like the
  // rest, guarded here and re-validated at main (`parseVisibleSessions`).
  expect(source).toContain(
    "const CH_HOST_VISIBLE_SESSIONS = 'catcode:host:visible-sessions'",
  )
  expect(source).toContain('reportVisibleSessions(sessionIds: SessionId[]): void')
  // The appearance sender (2026-08-27). Fixed and one-way like the rest,
  // narrowed here to the three-value choice and re-validated at main, which is
  // the boundary (`app/main/appearanceChannel.test.ts`).
  expect(source).toContain("const CH_SET_APPEARANCE = 'catcode:set-appearance'")
  expect(source).toContain(
    "setAppearance(scheme: 'system' | 'light' | 'dark'): void",
  )
  // Glass mode is the other window-only, fixed sender. It carries a boolean
  // preference and main persists it so renderer-free paint gaps retain an opaque
  // background when glass is off.
  expect(source).toContain("const CH_SET_GLASS_MODE = 'catcode:set-glass-mode'")
  expect(source).toContain('setGlassMode(enabled: boolean): void')
  expect(source.match(/sendGuard\.assertAllowed/g)).toHaveLength(44)
  // D1b — the recall sender is fixed and one-way like the rest (HC3).
  expect(source).toContain("const CH_PROMPT_RECALL = 'catcode:prompt-recall'")
  expect(source).toContain(
    'recallPrompts(sessionId: SessionId, verb: PromptRecallMessage): void',
  )
  expect(source).toContain("const CH_PROMPT_FORCE = 'catcode:prompt-force'")
  expect(source).toContain(
    'forcePrompt(sessionId: SessionId, verb: PromptForceMessage): void',
  )
  expect(source).toContain("const CH_DELIVERY_ACK = 'catcode:delivery-ack'")
  expect(source).toContain('deliveryAck(sessionId, sequence, deliveryAttempt, streamEpoch, traceId, stage): void')
  expect(source).toContain("const CH_OPEN_LOGS = 'catcode:open-logs'")
  expect(source).toContain(
    "const CH_REFRESH_ACCOUNTS_POOL = 'catcode:refresh-accounts-pool'",
  )
  expect(source).toContain('refreshAccountsPool(): void')
  expect(source).toContain("const CH_SAVE_DIAGNOSTICS = 'catcode:save-diagnostics'")
  expect(source).toContain("const CH_DEBUG_SHELL_STATE = 'catcode:debug:shell-state'")
  expect(source).toContain('reportDebugShellState')
  expect(source).toContain('pickDirectory(activeSessionId?: SessionId | null)')
  expect(source).toContain(
    "const CH_HOST_OPEN_WORKSPACE_FILE = 'catcode:host:open-workspace-file'",
  )
  expect(source).toContain(
    "const CH_HOST_ACCOUNT_DELETE = 'catcode:host:account-delete'",
  )
  expect(source).toContain('openWorkspaceFile(')
  expect(source).toContain('target?: OpenWorkspaceFileTarget')
})

test('control-plane senders are fixed per-method channels (HC3), no generic invoke', () => {
  const source = readFileSync(new URL('./preload.ts', import.meta.url), 'utf8')

  // The seven host/control-plane methods each ride a FIXED channel constant.
  expect(source).toContain("const CH_HOST_CREATE = 'catcode:host:create'")
  expect(source).toContain(
    "const CH_HOST_CREATE_IN_WORKSPACE = 'catcode:host:create-in-workspace'",
  )
  expect(source).toContain("const CH_HOST_RESTORE = 'catcode:host:restore'")
  expect(source).toContain("const CH_HOST_CLOSE = 'catcode:host:close'")
  expect(source).toContain("const CH_HOST_LIST = 'catcode:host:list'")
  expect(source).toContain("const CH_HOST_PICK_DIR = 'catcode:host:pick-directory'")
  expect(source).toContain(
    "const CH_HOST_PICK_ATTACHMENT_FILE = 'catcode:host:pick-attachment-file'",
  )
  expect(source).toContain("const CH_HOST_PREVIEW = 'catcode:host:preview'")
  // P4-35 — the file sink rides its own fixed channel (HC3). The renderer carries
  // text plus a name suggestion; main owns the destination (HC1).
  expect(source).toContain("const CH_HOST_SAVE_TEXT = 'catcode:host:save-text'")
  expect(source).toContain(
    "const CH_HOST_OPEN_WORKSPACE_FILE = 'catcode:host:open-workspace-file'",
  )
  // F2 — read-only cold-launch sessions-catalog baseline rides its own fixed channel.
  expect(source).toContain(
    "const CH_HOST_SESSIONS_CATALOG = 'catcode:host:sessions-catalog'",
  )
  expect(source).toContain(
    "const CH_HOST_OPEN_HISTORY = 'catcode:host:open-history'",
  )
  expect(source).toContain("const CH_HOST_EVENT = 'catcode:host:event'")

  // Every invoke targets one of those FIXED constants — never a renderer-supplied
  // channel name. Extract the first argument of each ipcRenderer.invoke(...) and
  // assert it is a known CH_HOST_* constant (HC3: no renderer-controlled channel).
  const invokeChannels = [...source.matchAll(/ipcRenderer\.invoke\((\w+)/g)].map(
    m => m[1],
  )
  expect(invokeChannels.length).toBe(15)
  const allowed = new Set([
    'CH_HOST_CREATE',
    'CH_HOST_CREATE_IN_WORKSPACE',
    'CH_HOST_RESTORE',
    'CH_HOST_CLOSE',
    'CH_HOST_LIST',
    'CH_HOST_PICK_DIR',
    'CH_HOST_PICK_ATTACHMENT_FILE',
    'CH_HOST_PREVIEW',
    'CH_HOST_SESSIONS_CATALOG',
    'CH_HOST_OPEN_HISTORY',
    'CH_HOST_SAVE_TEXT',
    'CH_HOST_OPEN_WORKSPACE_FILE',
    'CH_HOST_ACCOUNT_DELETE',
    'CH_SAVE_DIAGNOSTICS',
    'CH_RESTART',
  ])
  for (const channel of invokeChannels) {
    expect(allowed.has(channel)).toBe(true)
  }
  expect(source).not.toContain('ipcRenderer.invoke(CH_DEBUG_SHELL_STATE')

  // Default-deny stays intact: no generic escape hatches. Strip comments first
  // so the prose that DESCRIBES the forbidden pattern ("no generic send(channel,
  // payload)") does not trip the check — only real code counts.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
  expect(code).not.toContain('send(channel')
  expect(code).not.toContain('invoke(channel')
  // No control-plane method returns filesystem contents — the picker returns a
  // single realpath string, never a directory listing or file bytes.
  expect(code).not.toContain('readdir')
  expect(code).not.toContain('readFile')
  // P4-35 — and none of them touches the filesystem in the other direction
  // either. The preload runs in the renderer's process, so a write here would be
  // a renderer-reachable file write with no user dialog in front of it; the sink
  // is main's `CH_HOST_SAVE_TEXT` handler and only main's.
  expect(code).not.toContain('writeFile')
  expect(code).not.toContain("'node:fs'")
})

test('the account-pool refresh sender is fixed and carries no renderer payload', () => {
  const source = readFileSync(new URL('./preload.ts', import.meta.url), 'utf8')
  const start = source.indexOf('refreshAccountsPool(): void {')
  const end = source.indexOf('\n  },', start)
  if (start < 0 || end <= start) {
    throw new Error('preload.ts no longer exposes refreshAccountsPool')
  }
  const sender = source.slice(start, end)

  expect(sender).toContain('sendGuard.assertAllowed({ refreshAccountsPool: true })')
  expect(sender).toContain('ipcRenderer.send(CH_REFRESH_ACCOUNTS_POOL)')
  expect(sender).not.toContain('payload')
  expect(sender).not.toContain('ipcRenderer.invoke')
})

test('account deletion terminates in a one-shot worker, not a session forward', () => {
  const source = readFileSync(new URL('../main/main.ts', import.meta.url), 'utf8')
  const start = source.indexOf('ipcMain.handle(\n    CH_HOST_ACCOUNT_DELETE')
  const end = source.indexOf(
    'ipcMain.handle(CH_HOST_OPEN_WORKSPACE_FILE',
    start,
  )
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const handler = source.slice(start, end)

  expect(handler).toContain('parseAccountDeleteMessage(input)')
  expect(handler).toContain("'--account-delete'")
  expect(handler).toContain('runAccountsPoolWorker({')
  expect(handler).toContain('signal: abort.signal')
  expect(handler).toContain('forceKillOnAbort: true')
  expect(handler).toContain('accountsPoolPublicationGate.invalidate()')
  expect(handler).toContain('notifySidecarsOfAccountDeletion(')
  expect(handler).not.toContain('activeSessionId')
  expect(handler).not.toContain('forward(')
  expect(source).toContain('accountDeleteAbort?.abort()')
  expect(source).toContain('accountsPoolPublicationGate.canPublish(generation)')
  expect(source).toContain("type: 'account.profileDeleted'")
})

test('P4-35: the file sink carries no destination the renderer could author (HC1)', () => {
  const source = readFileSync(new URL('./preload.ts', import.meta.url), 'utf8')
  const start = source.indexOf('saveTextToFile(input: SaveTextInput)')
  if (start < 0) throw new Error('preload.ts no longer exposes saveTextToFile')
  const end = source.indexOf('subscribeHost(', start)
  if (end <= start) throw new Error('preload.ts save-text region no longer ends at subscribeHost')
  // Comments stripped first, for the same reason the default-deny check above
  // strips them: the prose DESCRIBING the absent field is not the field.
  const save = source.slice(start, end).replace(/\/\/.*$/gm, '')

  // The renderer supplies text + a name SUGGESTION. Any of these words appearing
  // here would mean a destination became expressible on this channel.
  expect(save).not.toContain('filePath')
  expect(save).not.toContain('directory')
  expect(save).not.toContain('defaultPath')
  expect(save).not.toMatch(/\bpath\b/)
  // The guard still runs (rate cap, T7), and the body carries its own bound
  // rather than silently riding the inbound frame cap.
  expect(save).toContain('sendGuard.assertAllowed')
  expect(save).toContain('MAX_SAVE_TEXT_BYTES')
})

test('failure-path senders keep the rate guard but never let its rejection escape', () => {
  const source = readFileSync(new URL('./preload.ts', import.meta.url), 'utf8')
  const queueSource = readFileSync(new URL('./deliveryAckQueue.ts', import.meta.url), 'utf8')

  // 2026-08-09 black window: all of these run when something has ALREADY gone
  // wrong — the ack flush on a React effect stack, the fault reporter from
  // `componentDidCatch` — and a throw from either unmounted the renderer. The
  // guard must still run, so an over-budget payload is DROPPED rather than sent
  // and T7's cap is unchanged; only the exception is contained.
  // All THREE telemetry senders, including the health probe: the commit that
  // wrapped it claimed parity with the other two, and only a pin makes that true.
  for (const [open, close] of [
    ['reportRendererFault(kind, message): void {', '\n  },'],
    ['ipcRenderer.on(CH_DELIVERY_HEALTH_PROBE, () => {', '\n})'],
  ] as const) {
    const start = source.indexOf(open)
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf(close, start))
    expect(body).toContain('sendGuard.assertAllowed')
    expect(body.indexOf('try {')).toBeGreaterThan(-1)
    expect(body.indexOf('try {')).toBeLessThan(body.indexOf('sendGuard.assertAllowed'))
    expect(body).toContain('} catch')
    expect(body.indexOf('ipcRenderer.send')).toBeGreaterThan(body.indexOf('sendGuard.assertAllowed'))
    expect(body.indexOf('ipcRenderer.send')).toBeLessThan(body.indexOf('} catch'))
  }

  // The extracted delivery ack queue flush method keeps the guard inside try/catch
  const flushStart = queueSource.indexOf('private flush(): void {')
  expect(flushStart).toBeGreaterThan(-1)
  const flushBody = queueSource.slice(flushStart, queueSource.indexOf('\n  }', flushStart))
  expect(flushBody).toContain('this.deps.assertAllowed')
  expect(flushBody.indexOf('try {')).toBeGreaterThan(-1)
  expect(flushBody.indexOf('try {')).toBeLessThan(flushBody.indexOf('this.deps.assertAllowed'))
  expect(flushBody).toContain('} catch')
  expect(flushBody.indexOf('this.deps.send')).toBeGreaterThan(flushBody.indexOf('this.deps.assertAllowed'))
  expect(flushBody.indexOf('this.deps.send')).toBeLessThan(flushBody.indexOf('} catch'))
})

test('only the acknowledgement flush is diagnostics class', () => {
  const source = readFileSync(new URL('./preload.ts', import.meta.url), 'utf8')
  const queueSource = readFileSync(new URL('./deliveryAckQueue.ts', import.meta.url), 'utf8')

  // The entire rate-budget reservation (IPC-RATE-BUDGET §4) is this one
  // argument in the acknowledgement queue.
  const flushStart = queueSource.indexOf('private flush(): void {')
  expect(flushStart).toBeGreaterThan(-1)
  const flush = queueSource.slice(flushStart)
  expect(flush).toContain("this.deps.assertAllowed(payload, 'diagnostics')")

  const queueDiagnosticsCallSites = [...queueSource.matchAll(/assertAllowed\([^)]*'diagnostics'/g)]
  expect(queueDiagnosticsCallSites.length).toBe(1)

  // The fault reporter and the health probe are telemetry too, but stay CONTROL
  // class deliberately: the reporter matters most exactly when the window is
  // saturating, and a starved health response manufactures a fake outage.
  for (const open of [
    'reportRendererFault(kind, message): void {',
    'ipcRenderer.on(CH_DELIVERY_HEALTH_PROBE, () => {',
  ]) {
    const start = source.indexOf(open)
    const body = source.slice(start, source.indexOf('\n}', start))
    expect(body).not.toContain("'diagnostics'")
  }
})

test('acknowledgement flushing batches across tasks rather than per delivered frame', () => {
  const queueSource = readFileSync(new URL('./deliveryAckQueue.ts', import.meta.url), 'utf8')

  // A microtask drains at the end of the current task and each frame arrives in
  // its own task, so `queueMicrotask` coalesced nothing in steady state: one
  // frame cost one guarded send against the budget real user actions draw on.
  expect(queueSource).not.toContain('queueMicrotask')
  expect(queueSource).toContain('this.deps.setTimeout')
})

// The hardening smoke asserts the exposed bridge equals a hand-kept allowlist,
// but it runs INSIDE Electron, so the environments most likely to add a bridge
// method cannot run it. That gap let `openWorkspaceFile` sit unlisted from
// 2026-08-13 through seven app/ commits, and `recordRenderCommit` repeat it the
// same day. This compares the two lists as SOURCE TEXT so the drift is caught by
// plain `bun test app/`, wherever it runs.
test('the hardening allowlist matches the bridge preload actually exposes', () => {
  const source = readFileSync(new URL('./preload.ts', import.meta.url), 'utf8')
  const start = source.indexOf('const bridge: CatCodeBridge = {')
  const end = source.indexOf("contextBridge.exposeInMainWorld('catcode', bridge)")
  if (start < 0 || end < 0) {
    throw new Error('preload.ts no longer declares the bridge the way this test locates it')
  }
  const exposed = [
    ...source.slice(start, end).matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*)\(/gm),
  ]
    .map(match => match[1])
    .sort()

  const smoke = readFileSync(
    new URL('../scripts/hardening-smoke.ts', import.meta.url),
    'utf8',
  )
  const listStart = smoke.indexOf('const expectedBridgeKeys = [')
  if (listStart < 0) {
    throw new Error('hardening-smoke.ts no longer declares expectedBridgeKeys')
  }
  const listEnd = smoke.indexOf('].sort()', listStart)
  const allowlisted = [
    ...smoke.slice(listStart, listEnd).matchAll(/'([A-Za-z][A-Za-z0-9]*)'/g),
  ]
    .map(match => match[1])
    .sort()

  // Report both directions: an unlisted method is a widened surface, and a
  // listed-but-absent one means the allowlist is describing a bridge that is
  // gone. Either way the security gate is no longer checking what it claims to.
  expect(exposed.filter(name => !allowlisted.includes(name))).toEqual([])
  expect(allowlisted.filter(name => !exposed.includes(name))).toEqual([])
})
