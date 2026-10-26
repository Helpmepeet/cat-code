import { Menu, MenuItem } from 'electron'
import { LID_PRESETS, type LidModeCommand, type LidModeView } from '../shared/lidClosed.js'

// Native controls remain available on welcome and Pages without a composer.
export function lidClosedMenu(read: () => LidModeView | undefined | Promise<LidModeView | undefined>, command: (value: LidModeCommand) => void) {
  return function update(view?: LidModeView) {
    const menu = Menu.getApplicationMenu()
    const appMenu = menu?.items[0]?.submenu
    if (!menu || !appMenu) return
    if (!menu.getMenuItemById('lid-mode')) {
      const submenu = Menu.buildFromTemplate([
        { id: 'lid-until-finished', label: 'Until all work finishes', type: 'radio' as const,
          click: () => command({ action: 'set', target: 'work' }) },
        ...LID_PRESETS.map(target => ({ id: `lid-timed-${target}`, label: `${target} minutes`, type: 'radio' as const,
          click: () => command({ action: 'set', target }) })),
        { type: 'separator' },
        { id: 'lid-off', label: 'Turn off', click: () => command({ action: 'set', target: 'off' }) },
        { id: 'lid-sleep', label: 'End mode and sleep', click: () => command({ action: 'sleep' }) },
        { id: 'lid-retry', label: 'Retry sleep restoration', click: () => command({ action: 'retry' }) },
      ])
      submenu.on('menu-will-show', () => { void Promise.resolve(read()).then(update).catch(() => {}) })
      const quit = appMenu.items.findIndex(item => item.role === 'quit')
      appMenu.insert(quit < 0 ? appMenu.items.length : quit, new MenuItem({ id: 'lid-mode', label: 'Lid-closed mode', submenu }))
      Menu.setApplicationMenu(menu)
    }
    const busy = !view || ['setup', 'starting', 'restoring', 'unavailable', 'unresolved'].includes(view.phase)
    const untilFinished = menu.getMenuItemById('lid-until-finished')!
    untilFinished.enabled = !busy && view?.workAvailable === true
    untilFinished.checked = view?.phase === 'active' && view.mode === 'work'
    for (const target of LID_PRESETS) {
      const item = menu.getMenuItemById(`lid-timed-${target}`)!
      item.enabled = !busy
      item.checked = view?.phase === 'active' && view.mode === 'timed' && view.allowance === target
    }
    menu.getMenuItemById('lid-off')!.enabled = !!view && !['off', 'unavailable', 'unresolved'].includes(view.phase)
    menu.getMenuItemById('lid-sleep')!.enabled = view?.phase === 'active'
    menu.getMenuItemById('lid-retry')!.enabled = view?.phase === 'unresolved' && !view?.recovering
  }
}
