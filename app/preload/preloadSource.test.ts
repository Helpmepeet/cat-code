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
  // 15 frame-plane senders (incl. P4-5 accountVerb + P4-15 workspaceTrustVerb +
  // P4-8b setAgentMode + P4-13 remoteSettingsVerb + P4-19 settingsVerb + P4-24c
  // runControlVerb + P4-6b sessionActionVerb + C5/P4-20 answerQuestions) + 6
  // payload-bearing control-plane senders + the DEV-only debug-state sender
  // (compiled out of the packaged preload.cjs). (pickDirectory/createSession/
  // restoreSession/closeSession/listSessions/previewSession). subscribe /
  // subscribeHost register a listener and send no payload, so they do NOT (and
  // must not) call the guard.
  expect(source.match(/sendGuard\.assertAllowed/g)).toHaveLength(22)
  expect(source).toContain("const CH_DEBUG_SHELL_STATE = 'catcode:debug:shell-state'")
  expect(source).toContain('reportDebugShellState')
  expect(source).toContain('pickDirectory(activeSessionId?: SessionId | null)')
})

test('control-plane senders are fixed per-method channels (HC3), no generic invoke', () => {
  const source = readFileSync(new URL('./preload.ts', import.meta.url), 'utf8')

  // The six host/control-plane methods each ride a FIXED channel constant.
  expect(source).toContain("const CH_HOST_CREATE = 'catcode:host:create'")
  expect(source).toContain("const CH_HOST_RESTORE = 'catcode:host:restore'")
  expect(source).toContain("const CH_HOST_CLOSE = 'catcode:host:close'")
  expect(source).toContain("const CH_HOST_LIST = 'catcode:host:list'")
  expect(source).toContain("const CH_HOST_PICK_DIR = 'catcode:host:pick-directory'")
  expect(source).toContain("const CH_HOST_PREVIEW = 'catcode:host:preview'")
  expect(source).toContain("const CH_HOST_EVENT = 'catcode:host:event'")

  // Every invoke targets one of those FIXED constants — never a renderer-supplied
  // channel name. Extract the first argument of each ipcRenderer.invoke(...) and
  // assert it is a known CH_HOST_* constant (HC3: no renderer-controlled channel).
  const invokeChannels = [...source.matchAll(/ipcRenderer\.invoke\((\w+)/g)].map(
    m => m[1],
  )
  expect(invokeChannels.length).toBe(6)
  const allowed = new Set([
    'CH_HOST_CREATE',
    'CH_HOST_RESTORE',
    'CH_HOST_CLOSE',
    'CH_HOST_LIST',
    'CH_HOST_PICK_DIR',
    'CH_HOST_PREVIEW',
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
})
