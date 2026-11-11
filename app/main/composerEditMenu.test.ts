import { expect, test } from 'bun:test'

test('composer menu routes only registered hosts and preserves other native actions', () => {
  const result = Bun.spawnSync([process.execPath, '--eval', `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    class MenuItem { constructor(options) { Object.assign(this, options) } }
    class Menu {
      items = []
      static current
      static getApplicationMenu() { return this.current }
      static setApplicationMenu(value) { this.current = value }
      append(item) { this.items.push(item) }
      getMenuItemById(id) {
        for (const item of this.items) {
          if (item.id === id) return item
          const found = item.submenu?.getMenuItemById(id)
          if (found) return found
        }
      }
    }
    let focused
    mock.module('electron', () => ({ BrowserWindow: class {}, Menu, MenuItem, webContents: { getFocusedWebContents: () => focused } }))
    const { installComposerEditMenu, dispatchComposerEdit } = await import(${JSON.stringify(new URL('./composerEditMenu.ts', import.meta.url).pathname)})
    let handled = true
    let destroyed = false
    const calls = []
    const host = {
      isDestroyed: () => destroyed,
      mainFrame: { executeJavaScript: async source => { calls.push(source.includes('historyUndo') ? 'composer-undo' : 'composer-redo'); return handled } },
      undo: () => calls.push('native-undo'), redo: () => calls.push('native-redo'),
    }
    const edit = new Menu()
    edit.append(new MenuItem({ role: 'undo', label: 'Undo', accelerator: 'CommandOrControl+Z' }))
    edit.append(new MenuItem({ role: 'redo', label: 'Redo' }))
    const copy = new MenuItem({ role: 'copy' })
    edit.append(copy)
    const root = new Menu()
    root.append(new MenuItem({ role: 'editMenu', label: 'Edit', submenu: edit }))
    const other = new MenuItem({ id: 'unrelated', label: 'Keep me', click() {} })
    root.append(other)
    Menu.current = root
    installComposerEditMenu(host)
    const installed = Menu.current
    assert.equal(installed.items[1], other)
    assert.equal(installed.items[0].submenu.items[2], copy)
    assert.equal(installed.getMenuItemById('composer-undo').role, undefined)
    assert.equal(installed.getMenuItemById('composer-redo').accelerator, 'CommandOrControl+Shift+Z')
    installComposerEditMenu(host)
    assert.equal(Menu.current, installed)
    focused = host
    installed.getMenuItemById('composer-undo').click()
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(calls, ['composer-undo'])
    handled = false
    await dispatchComposerEdit(host, 'redo')
    assert.deepEqual(calls.slice(-2), ['composer-redo', 'native-redo'])
    const remote = { ...host, mainFrame: { executeJavaScript() { throw new Error('Untrusted frame must not be scripted') } } }
    await dispatchComposerEdit(remote, 'undo')
    assert.equal(calls.at(-1), 'native-undo')
    destroyed = true
    const count = calls.length
    await dispatchComposerEdit(host, 'undo')
    assert.equal(calls.length, count)
  `], { stdout: 'pipe', stderr: 'pipe' })
  expect(result.stderr.toString()).toBe('')
  expect(result.exitCode).toBe(0)
})
