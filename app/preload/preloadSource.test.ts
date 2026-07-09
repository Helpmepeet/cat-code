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
  // P4-5 — account lifecycle verb sender rides its own fixed channel (HC3).
  expect(source).toContain("const CH_ACCOUNT_VERB = 'catcode:account-verb'")
  expect(source).toContain(
    'accountVerb(sessionId: SessionId, verb: AccountVerbMessage): void',
  )
  // P4-13 — RemoteSettings verb sender rides its own fixed channel (HC3).
  expect(source).toContain(
    "const CH_REMOTE_SETTINGS_VERB = 'catcode:remote-settings-verb'",
  )
  expect(source).toContain(
    'remoteSettingsVerb(sessionId: SessionId, verb: RemoteVerbMessage): void',
  )
  // 9 frame-plane senders (incl. P4-5 accountVerb + P4-13 remoteSettingsVerb) +
  // 5 payload-bearing control-plane senders + the DEV-only debug-state sender
  // (compiled out of packaged preload.cjs). (pickDirectory/createSession/
  // restoreSession/closeSession/listSessions). subscribe / subscribeHost
  // register a listener and send no payload, so they do NOT (and must not)
  // call the guard.
  expect(source.match(/sendGuard\.assertAllowed/g)).toHaveLength(15)
  expect(source).toContain("const CH_DEBUG_SHELL_STATE = 'catcode:debug:shell-state'")
  expect(source).toContain('reportDebugShellState')
  expect(source).toContain('pickDirectory(activeSessionId?: SessionId | null)')
})

test('control-plane senders are fixed per-method channels (HC3), no generic invoke', () => {
  const source = readFileSync(new URL('./preload.ts', import.meta.url), 'utf8')

  // The five host methods each ride a FIXED channel constant.
  expect(source).toContain("const CH_HOST_CREATE = 'catcode:host:create'")
  expect(source).toContain("const CH_HOST_RESTORE = 'catcode:host:restore'")
  expect(source).toContain("const CH_HOST_CLOSE = 'catcode:host:close'")
  expect(source).toContain("const CH_HOST_LIST = 'catcode:host:list'")
  expect(source).toContain("const CH_HOST_PICK_DIR = 'catcode:host:pick-directory'")
  expect(source).toContain("const CH_HOST_EVENT = 'catcode:host:event'")

  // Every invoke targets one of those FIXED constants — never a renderer-supplied
  // channel name. Extract the first argument of each ipcRenderer.invoke(...) and
  // assert it is a known CH_HOST_* constant (HC3: no renderer-controlled channel).
  const invokeChannels = [...source.matchAll(/ipcRenderer\.invoke\((\w+)/g)].map(
    m => m[1],
  )
  expect(invokeChannels.length).toBe(5)
  const allowed = new Set([
    'CH_HOST_CREATE',
    'CH_HOST_RESTORE',
    'CH_HOST_CLOSE',
    'CH_HOST_LIST',
    'CH_HOST_PICK_DIR',
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
