import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const CHANNEL = "'catcode:set-glass-mode'"

function mainSource(): string {
  return readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
}

function preloadSource(): string {
  return readFileSync(new URL('../preload/preload.ts', import.meta.url), 'utf8')
}

function channelsSource(): string {
  return readFileSync(new URL('../shared/ipcChannels.ts', import.meta.url), 'utf8')
}

test('the glass preference sender is fixed, guarded, and declared on both sides', () => {
  // One declaration, imported at both ends, so the two cannot drift apart.
  expect(channelsSource()).toContain(`export const CH_SET_GLASS_MODE = ${CHANNEL}`)
  expect(mainSource()).toContain('CH_SET_GLASS_MODE')
  expect(preloadSource()).toContain('CH_SET_GLASS_MODE')
  expect(preloadSource()).toContain('setGlassMode(enabled: boolean): void')
  expect(preloadSource()).toContain('sendGuard.assertAllowed({ enabled })')
  expect(preloadSource()).toContain('ipcRenderer.send(CH_SET_GLASS_MODE, enabled)')
})

test('main accepts glass preferences only from the main window with a boolean payload', () => {
  const source = mainSource()
  const handler = source.slice(source.indexOf('ipcMain.on(CH_SET_GLASS_MODE'))
  const body = handler.slice(0, handler.indexOf('\n  })'))

  expect(body).toContain('event, enabled: unknown')
  expect(body).toContain('if (!isMainWindowSender(event) || typeof enabled !== \'boolean\') return')
  expect(body).toContain("writeGlassPreference(app.getPath('userData'), enabled)")
  expect(body).toContain("mainWindow?.setBackgroundColor(enabled ? '#00000000' : '#09090b')")
})

test('window creation uses the persisted preference for the native background', () => {
  const source = mainSource()
  const createWindow = source.slice(source.indexOf('function createWindow(): void'))

  expect(createWindow).toContain("const glassEnabled = readGlassPreference(app.getPath('userData'))")
  expect(createWindow).toContain("backgroundColor: glassEnabled ? '#00000000' : '#09090b'")
})
