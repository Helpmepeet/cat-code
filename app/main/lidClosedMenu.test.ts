import { expect, test } from 'bun:test'

// Keep the Electron mock in a child process so other desktop tests see real imports.
test('lid menu gates activation without blocking stop or recovery controls', () => {
  const result = Bun.spawnSync([process.execPath, '--eval', `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    class MenuItem {
      enabled = true
      checked = false
      constructor(options) { Object.assign(this, options) }
    }
    class Menu {
      items = []
      static current
      static getApplicationMenu() { return this.current }
      static setApplicationMenu(menu) { this.current = menu }
      static buildFromTemplate(template) {
        const menu = new Menu()
        menu.items = template.map(item => new MenuItem(item))
        return menu
      }
      insert(index, item) { this.items.splice(index, 0, item) }
      on() {}
      getMenuItemById(id) {
        for (const item of this.items) {
          if (item.id === id) return item
          const nested = item.submenu?.getMenuItemById(id)
          if (nested) return nested
        }
      }
    }
    mock.module('electron', () => ({ Menu, MenuItem }))
    const { lidClosedMenu } = await import(${JSON.stringify(new URL('./lidClosedMenu.ts', import.meta.url).pathname)})
    const menu = Menu.buildFromTemplate([{ submenu: new Menu() }])
    Menu.current = menu
    const commands = []
    const update = lidClosedMenu(() => undefined, command => commands.push(command))
    const item = id => menu.getMenuItemById(id)
    const view = (phase, extra = {}) => ({
      phase, mode: null, allowance: 0, remainingSeconds: 0, workAvailable: true,
      activeSessions: 0, activeSubagents: 0, waitingForApproval: false,
      installed: true, sleepRequested: false, ...extra,
    })
    for (const phase of [undefined, 'off', 'setup', 'starting', 'active', 'restoring', 'ended', 'unavailable', 'unresolved']) {
      update(phase ? view(phase) : undefined)
      const activation = ['off', 'active', 'ended'].includes(phase)
      assert.equal(item('lid-until-finished').enabled, activation, phase)
      for (const target of [15, 30, 60, 120]) assert.equal(item('lid-timed-' + target).enabled, activation, phase)
      assert.equal(item('lid-off').enabled, ['setup', 'starting', 'active', 'restoring', 'ended'].includes(phase), phase)
      assert.equal(item('lid-sleep').enabled, phase === 'active', phase)
      assert.equal(item('lid-retry').enabled, phase === 'unresolved', phase)
      assert.equal(item('lid-mode').enabled, true, phase)
    }
    update(view('unresolved', { recovering: true, repairRequired: true }))
    assert.equal(item('lid-retry').enabled, false)
    update(view('unresolved', { repairRequired: true }))
    assert.equal(item('lid-retry').enabled, true)
    item('lid-retry').click()
    update(view('active', { mode: 'timed', allowance: 30, workAvailable: false }))
    assert.equal(item('lid-until-finished').enabled, false)
    assert.equal(item('lid-timed-30').checked, true)
    assert.equal(item('lid-timed-15').checked, false)
    item('lid-off').click()
    item('lid-sleep').click()
    update(view('active', { mode: 'work' }))
    assert.equal(item('lid-until-finished').checked, true)
    assert.equal(item('lid-timed-30').checked, false)
    assert.deepEqual(commands, [{ action: 'retry' }, { action: 'set', target: 'off' }, { action: 'sleep' }])
  `], { stdout: 'pipe', stderr: 'pipe' })
  expect(result.stderr.toString()).toBe('')
  expect(result.exitCode).toBe(0)
})
