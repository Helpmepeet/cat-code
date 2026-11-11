import { app, BrowserWindow, Menu, session } from 'electron'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { dispatchComposerEdit, installComposerEditMenu } from '../main/composerEditMenu.js'

const state = mkdtempSync(join(tmpdir(), 'composer-undo-native-'))
app.setPath('userData', state)
app.setPath('sessionData', join(state, 'session'))
app.setPath('crashDumps', join(state, 'crashes'))
app.setAppLogsPath(join(state, 'logs'))
app.on('window-all-closed', () => {})
const results: string[] = []
async function run() {
  await app.whenReady()
  app.dock?.hide()
  const isolated = session.fromPartition('composer-undo-regression')
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  isolated.setPermissionCheckHandler(() => false)
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file|data):/.test(details.url) }))
  const window = new BrowserWindow({ show: false, width: 1100, height: 900, webPreferences: {
    session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false,
  } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  const wc = window.webContents
  installComposerEditMenu(wc)
  const js = (source: string) => wc.executeJavaScript(source)
  const call = async (method: string, ...args: unknown[]) => {
    const result = await js(`window.composerUndoRegression.${method}(${args.map(value => JSON.stringify(value)).join(',')})`)
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    return result
  }
  const snapshot = () => call('snapshot')
  const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
  const key = async (key: string, modifiers = 0, code = `Key${key.toUpperCase()}`) => {
    const virtualKey = ({ Enter: 13, Backspace: 8, Tab: 9, ArrowUp: 38, ArrowDown: 40 } as Record<string, number>)[key] ?? key.toUpperCase().charCodeAt(0)
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode: virtualKey })
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: virtualKey })
    await call('snapshot')
  }
  const undo = () => key('z', process.platform === 'darwin' ? 4 : 2)
  const redo = () => key('z', (process.platform === 'darwin' ? 4 : 2) | 8)
  const type = async (text: string) => {
    for (const character of text) {
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyDown', key: character, text: character, code: `Key${character.toUpperCase()}`,
      })
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: character })
    }
    await call('snapshot')
  }
  const expectDraft = async (value: string, label: string) => {
    const actual = await snapshot()
    assert(actual.draft === value, `${label}: expected ${JSON.stringify(value)}, got ${JSON.stringify(actual)}`)
  }
  try {
    await window.loadFile(resolve(process.argv[2]!))
    wc.debugger.attach('1.3')
    assert((await snapshot()).whiteSpace === 'pre-wrap', 'fixture must use production editable whitespace rules')
    assert(Menu.getApplicationMenu()?.getMenuItemById('composer-undo'), 'composer Undo menu was not installed')
    assert(Menu.getApplicationMenu()?.getMenuItemById('composer-redo'), 'composer Redo menu was not installed')
    // Always print the observed baseline, even when assertions below fail. This
    // distinguishes DOM replacement from native undo behavior, not just text.
    await call('reset')
    await type('baseline')
    await call('capture')
    await call('paste', ' pasted')
    const afterPaste = await snapshot()
    const execResult = await call('exec', 'undo')
    const afterExecUndo = await snapshot()
    await undo()
    const afterKeyboardUndo = await snapshot()
    console.log(JSON.stringify({ baseline: { afterPaste, execResult, afterExecUndo, afterKeyboardUndo } }))
    if (process.argv.includes('--baseline')) return

    await call('reset')
    await type('hello')
    await undo(); await expectDraft('', 'ordinary typing undo')
    await redo(); await expectDraft('hello', 'ordinary typing redo')
    assert((await snapshot()).selection.end === 5, 'typing redo caret')
    results.push('ordinary typing and trusted keyboard undo/redo')
    await call('paste', '!')
    await undo(); await expectDraft('hello', 'short paste undo')
    await redo(); await expectDraft('hello!', 'short paste redo')
    results.push('short paste')

    await call('reset', 'alpha beta omega')
    await call('select', 6, 10)
    await call('paste', 'REPLACED')
    await expectDraft('alpha REPLACED omega', 'selected paste')
    await undo(); await expectDraft('alpha beta omega', 'selected paste undo')
    const restored = await snapshot()
    assert(restored.selection.start === 6 && restored.selection.end === 10, `selection not restored: ${JSON.stringify(restored.selection)}`)
    await redo(); await expectDraft('alpha REPLACED omega', 'selected paste redo')
    assert((await snapshot()).selection.end === 14, 'replacement redo caret')
    results.push('selected replacement and selection restoration')

    await call('reset', 'line')
    await key('Enter', 8, 'Enter')
    await expectDraft('line\n', 'Shift+Enter')
    await undo(); await expectDraft('line', 'Shift+Enter undo')
    await redo(); await expectDraft('line\n', 'Shift+Enter redo')
    results.push('Shift+Enter')
    for (const modifier of [1, process.platform === 'darwin' ? 4 : 2]) {
      await call('reset', 'modified')
      await key('Enter', modifier, 'Enter')
      await expectDraft('modified\n', 'modified Enter newline')
      await undo(); await expectDraft('modified', 'modified Enter undo')
      await redo(); await expectDraft('modified\n', 'modified Enter redo')
    }
    results.push('other modified Enter does not submit')

    await call('reset')
    await call('paste', 'plain\nsecond <literal>')
    await expectDraft('plain\nsecond <literal>', 'plain multiline')
    assert(!/<(?:b|img)\b/.test((await snapshot()).html), 'rich HTML entered composer')
    await undo(); await expectDraft('', 'multiline undo')
    await redo(); await expectDraft('plain\nsecond <literal>', 'multiline redo')
    results.push('sanitized multiline paste')

    await call('reset')
    const payload = 'payload\n'.repeat(200)
    await call('paste', payload)
    const pill = await snapshot()
    assert(pill.entries.length === 1 && pill.entries[0].content === payload, 'collapsed payload missing')
    await undo(); await expectDraft('', 'pill undo')
    assert((await snapshot()).entries.length === 0, 'undone payload retained')
    await redo(); await expectDraft(pill.draft, 'pill redo')
    assert((await snapshot()).entries[0]?.content === payload, 'redo payload not restored')
    await call('select', 0, pill.draft.length)
    await key('Backspace', 0, 'Backspace')
    await expectDraft('', 'pill delete')
    assert((await snapshot()).entries.length === 0, 'deleted payload retained')
    await undo(); await expectDraft(pill.draft, 'pill delete undo')
    assert((await snapshot()).entries[0]?.content === payload, 'deleted payload not restored')
    assert((await snapshot()).html.includes('data-paste-token'), 'restored token is not a pill')
    await call('removePill')
    await expectDraft('', 'pill remove button')
    await undo(); await expectDraft(pill.draft, 'pill remove button undo')
    await call('select', pill.draft.length)
    await key('Backspace', 0, 'Backspace')
    await expectDraft('', 'atomic pill Backspace')
    await undo(); await expectDraft(pill.draft, 'atomic pill Backspace undo')
    results.push('collapsed pills undo redo delete and payload restoration')

    await call('reset', 'base')
    await call('paste', 'A')
    await undo(); await type('B'); await redo()
    await expectDraft('baseB', 'typing must drop redo')
    results.push('undo then typing drops redo')

    await call('reset')
    await type('@ex')
    await key('Tab', 0, 'Tab')
    await expectDraft('@explore ', 'mention completion')
    await undo(); await expectDraft('@ex', 'mention completion undo')
    await redo(); await expectDraft('@explore ', 'mention completion redo')
    results.push('mention completion')

    await call('reset')
    await key('ArrowUp', 0, 'ArrowUp')
    await expectDraft('previous local prompt', 'history recall')
    await key('ArrowDown', 0, 'ArrowDown')
    await expectDraft('', 'history draft restoration')
    results.push('history navigation')

    await call('reset', 'composing')
    await call('composition', 'compositionstart')
    await key('Enter', 0, 'Enter')
    await expectDraft('composing', 'IME Enter must not submit')
    await call('composition', 'compositionend')
    results.push('IME composition Enter guard')

    await call('reset')
    await type('before ')
    await wc.debugger.sendCommand('Input.imeSetComposition', {
      text: '日本', selectionStart: 2, selectionEnd: 2,
    })
    await wc.debugger.sendCommand('Input.insertText', { text: '日本' })
    await call('snapshot')
    await expectDraft('before 日本', 'IME text commit')
    await undo(); await expectDraft('before ', 'IME commit undo')
    await redo(); await expectDraft('before 日本', 'IME commit redo')
    results.push('Chromium IME composition transaction')

    await call('reset')
    await type('sent draft')
    await call('paste', ' with edits')
    await key('Enter', 0, 'Enter')
    await expectDraft('', 'submit clear')
    await undo(); await expectDraft('', 'submit must not revive sent draft')
    await redo(); await expectDraft('', 'submit must not redo sent draft')
    await call('exec', 'undo'); await expectDraft('', 'native undo after submit must not revive draft')
    results.push('submitted clear resets history')

    await call('reset', 'session one')
    await call('paste', '!')
    await call('bind', 'session-2')
    await undo(); await expectDraft('', 'new session undo isolation')
    await call('bind', 'session-1')
    await undo(); await expectDraft('session one!', 'rebound session history reset')
    results.push('session rebinding isolation')

    // Native menu methods and execCommand are separate entry points, not
    // substitutes for the trusted keyboard assertions above.
    await call('reset', 'menu')
    await call('paste', '!')
    // Exercise the installed menu callback with Electron's focus arguments.
    // A hidden test window must not take the operator's native window focus.
    Menu.getApplicationMenu()!.getMenuItemById('composer-undo')!.click({}, window, wc)
    await call('snapshot'); await expectDraft('menu', 'native menu undo')
    Menu.getApplicationMenu()!.getMenuItemById('composer-redo')!.click({}, window, wc)
    await call('snapshot'); await expectDraft('menu!', 'native menu redo')
    results.push('native menu dispatch with no native edit entries')
    await call('otherEditor')
    await type('other editor')
    await dispatchComposerEdit(wc, 'undo')
    assert(await call('otherValue') === '', 'other editor native undo was stolen')
    await dispatchComposerEdit(wc, 'redo')
    assert(await call('otherValue') === 'other editor', 'other editor native redo was stolen')
    results.push('other text fields keep native history')
    await call('reset')
    await type('command')
    await call('paste', '!')
    await call('exec', 'undo'); await expectDraft('command', 'execCommand undo')
    await call('exec', 'redo'); await expectDraft('command!', 'execCommand redo')
    results.push('native menu and execCommand undo redo')
    assert((await snapshot()).trustedKeys.some((event: { key: string; trusted: boolean }) => event.key === 'z' && event.trusted), 'no trusted undo keyboard event')
    console.log(JSON.stringify({ results }))
  } finally {
    if (wc.debugger.isAttached()) wc.debugger.detach()
    window.destroy()
  }
}
const timeout = setTimeout(() => { console.error('Composer regression timed out'); void finish(1) }, 90_000)
void run().then(() => finish(0), error => { console.error(error); return finish(1) })
async function finish(code: number) {
  clearTimeout(timeout)
  rmSync(state, { recursive: true, force: true })
  await new Promise<void>(resolve => process.stdout.write(`${JSON.stringify({ nativeExitCode: code, temporaryStateRemoved: !existsSync(state) })}\n`, () => resolve()))
  app.exit(code)
}
