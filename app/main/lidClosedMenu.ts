import { Menu, MenuItem } from 'electron'
import { LID_PRESETS, type LidModeCommand, type LidModeView } from '../shared/lidClosed.js'

// Native controls remain available on welcome and Pages without a composer.
export function lidClosedMenu(read: () => LidModeView | undefined, command: (value: LidModeCommand) => void) {
  return (view?: LidModeView) => {
    const menu = Menu.getApplicationMenu()
    const appMenu = menu?.items[0]?.submenu
    if (!menu || !appMenu) return
    if (!menu.getMenuItemById('lid-mode')) {
      const submenu = Menu.buildFromTemplate([
        ...LID_PRESETS.map(minutes => ({ id: `lid-${minutes}`, label: `${minutes} minutes`, type: 'checkbox' as const,
          click: () => command({ action: read()?.phase === 'active' ? 'adjust' : 'start', minutes }) })),
        { type: 'separator' },
        { id: 'lid-stop', label: 'Stop', click: () => command({ action: 'stop' }) },
        { id: 'lid-sleep', label: 'End mode and sleep', click: () => command({ action: 'sleep' }) },
        { id: 'lid-retry', label: 'Retry sleep restoration', click: () => command({ action: 'retry' }) },
      ])
      const quit = appMenu.items.findIndex(item => item.role === 'quit')
      appMenu.insert(quit < 0 ? appMenu.items.length : quit, new MenuItem({ id: 'lid-mode', label: 'Lid-closed mode', submenu }))
      Menu.setApplicationMenu(menu)
    }
    const busy = !view || ['setup', 'starting', 'restoring', 'unresolved'].includes(view.phase)
    for (const minutes of LID_PRESETS) {
      const item = menu.getMenuItemById(`lid-${minutes}`)!
      item.enabled = !busy
      item.checked = view?.phase === 'active' && view?.allowance === minutes
    }
    menu.getMenuItemById('lid-stop')!.enabled = view?.phase === 'active'
    menu.getMenuItemById('lid-sleep')!.enabled = view?.phase === 'active'
    menu.getMenuItemById('lid-retry')!.enabled = view?.phase === 'unresolved' && !view?.recovering
  }
}
