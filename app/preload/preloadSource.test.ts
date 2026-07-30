import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

test('every fixed renderer-to-main sender passes through the shared IPC guard', () => {
  const source = readFileSync(new URL('./preload.ts', import.meta.url), 'utf8')

  expect(source).toContain("const CH_RESTART = 'catcode:restart'")
  expect(source).toContain('restart(sessionId: SessionId): void')
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
  // 16 frame-plane senders (incl. P4-5 accountVerb + P4-15 workspaceTrustVerb +
  // P4-8b setAgentMode + P4-8b taskControlVerb + P4-13 remoteSettingsVerb + P4-19
  // settingsVerb + P4-24c runControlVerb + P4-6b sessionActionVerb + C5/P4-20
  // answerQuestions) + 10 payload-bearing control-plane senders + the DEV-only
  // debug-state sender (compiled out of the packaged preload.cjs). (pickDirectory/
  // createSession/createSessionInWorkspace/restoreSession/closeSession/listSessions/
  // previewSession/readSessionsCatalog/openHistorySession/P4-35 saveTextToFile).
  // subscribe / subscribeHost register a listener and send no payload, so they do
  // NOT (and must not) call the guard.
  expect(source.match(/sendGuard\.assertAllowed/g)).toHaveLength(27)
  expect(source).toContain("const CH_DEBUG_SHELL_STATE = 'catcode:debug:shell-state'")
  expect(source).toContain('reportDebugShellState')
  expect(source).toContain('pickDirectory(activeSessionId?: SessionId | null)')
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
  expect(source).toContain("const CH_HOST_PREVIEW = 'catcode:host:preview'")
  // P4-35 — the file sink rides its own fixed channel (HC3). The renderer carries
  // text plus a name suggestion; main owns the destination (HC1).
  expect(source).toContain("const CH_HOST_SAVE_TEXT = 'catcode:host:save-text'")
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
  expect(invokeChannels.length).toBe(10)
  const allowed = new Set([
    'CH_HOST_CREATE',
    'CH_HOST_CREATE_IN_WORKSPACE',
    'CH_HOST_RESTORE',
    'CH_HOST_CLOSE',
    'CH_HOST_LIST',
    'CH_HOST_PICK_DIR',
    'CH_HOST_PREVIEW',
    'CH_HOST_SESSIONS_CATALOG',
    'CH_HOST_OPEN_HISTORY',
    'CH_HOST_SAVE_TEXT',
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
