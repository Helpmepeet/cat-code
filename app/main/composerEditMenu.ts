import { BrowserWindow, Menu, MenuItem, webContents, type WebContents } from 'electron'

const hosts = new WeakSet<WebContents>()
export type ComposerEditDirection = 'undo' | 'redo'

/** Native Undo emits no beforeinput at all when Chromium's own stack is empty.
 * Ask only the focused host composer first; all other editors stay native. */
export async function dispatchComposerEdit(contents: WebContents, direction: ComposerEditDirection): Promise<void> {
  if (contents.isDestroyed()) return
  if (hosts.has(contents)) {
    const handled = await contents.mainFrame.executeJavaScript(`(() => {
      const field = document.activeElement;
      if (!(field instanceof HTMLElement) || !field.hasAttribute('data-composer-input')) return false;
      return !field.dispatchEvent(new InputEvent('beforeinput', {
        inputType: '${direction === 'undo' ? 'historyUndo' : 'historyRedo'}', bubbles: true, cancelable: true
      }));
    })()`)
    if (handled === true || contents.isDestroyed()) return
  }
  contents[direction]()
}

export function installComposerEditMenu(host: WebContents): void {
  hosts.add(host)
  const current = Menu.getApplicationMenu()
  if (!current || current.getMenuItemById('composer-undo')) return
  const containsHistory = (menu: Menu): boolean => menu.items.some(item =>
    item.role === 'undo' || item.role === 'redo' || item.submenu && containsHistory(item.submenu))
  if (!containsHistory(current)) return
  const rewrite = (menu: Menu): Menu => {
    const next = new Menu()
    for (const item of menu.items) {
      if (item.role === 'undo' || item.role === 'redo') {
        const direction = item.role
        next.append(new MenuItem({
          id: `composer-${direction}`, label: item.label,
          accelerator: item.accelerator ?? (direction === 'undo' ? 'CommandOrControl+Z' : 'CommandOrControl+Shift+Z'),
          click: (_item, focusedWindow) => {
            const focused = webContents.getFocusedWebContents()
              ?? (focusedWindow instanceof BrowserWindow ? focusedWindow.webContents : undefined)
            if (!focused) return
            void dispatchComposerEdit(focused, direction).catch(error => {
              console.error(`[main] composer ${direction} failed`, error)
            })
          },
        }))
      } else if (item.submenu && containsHistory(item.submenu)) {
        next.append(new MenuItem({
          id: item.id, label: item.label, role: item.role,
          submenu: rewrite(item.submenu), enabled: item.enabled, visible: item.visible,
        }))
      } else next.append(item)
    }
    return next
  }
  Menu.setApplicationMenu(rewrite(current))
}
