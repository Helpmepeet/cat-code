import { describe, expect, mock, test } from 'bun:test'
import { PassThrough } from 'stream'
import stripAnsi from 'strip-ansi'
import * as React from 'react'

import { Box, render, Text, ThemeProvider } from '../../ink.js'
import { AppStateProvider, getDefaultAppState } from '../../state/AppState.js'
import type { LocalJSXCommandContext } from '../../commands.js'

let hasCodexAccounts = false
// eslint-disable-next-line @typescript-eslint/no-require-imports
const realPoolModule = { ...require('../../services/api/codexAccountPool.js') }

await mock.module('../../services/api/codexAccountPool.js', () => ({
  ...realPoolModule,
  hasAnyPoolAccount: () => hasCodexAccounts,
}))
await mock.module('../../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 120, rows: 40 }),
}))
await mock.module('../../context/modalContext.js', () => ({
  useIsInsideModal: () => false,
  useModalOrTerminalSize: (size: { columns: number; rows: number }) => size,
}))
await mock.module('../../hooks/useExitOnCtrlCDWithKeybindings.js', () => ({
  useExitOnCtrlCDWithKeybindings: () => undefined,
}))
await mock.module('../../keybindings/useKeybinding.js', () => ({
  useKeybinding: () => undefined,
}))
await mock.module('../design-system/Pane.js', () => ({
  Pane: ({ children }: { children: React.ReactNode }) => <Box>{children}</Box>,
}))
await mock.module('../design-system/Tabs.js', () => ({
  Tab: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tabs: ({ children }: { children: React.ReactNode }) => (
    <Box flexDirection="column">
      {React.Children.map(children, child =>
        React.isValidElement<{ title: string }>(child) ? (
          <Text>{child.props.title}</Text>
        ) : null,
      )}
    </Box>
  ),
}))
await mock.module('./Status.js', () => ({
  Status: () => <Text>Status body</Text>,
  buildDiagnostics: async () => [],
}))
await mock.module('./Config.js', () => ({
  Config: () => <Text>Config body</Text>,
}))
await mock.module('./Usage.js', () => ({
  Usage: () => <Text>Usage body</Text>,
}))
await mock.module('./Reset.js', () => ({
  Reset: () => <Text>Reset body</Text>,
}))

async function renderSettingsTabTitles(): Promise<string> {
  const { Settings } = await import('./Settings.js')
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
    columns: number
  }
  stdout.columns = 120
  let output = ''
  ;(stdout as unknown as PassThrough).on('data', chunk => {
    output += chunk.toString()
  })
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & {
    isTTY: boolean
    setRawMode: (enabled: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => undefined
  stdin.ref = () => undefined
  stdin.unref = () => undefined
  const stderr = new PassThrough() as unknown as NodeJS.WriteStream

  const instance = await render(
    <ThemeProvider>
      <AppStateProvider initialState={getDefaultAppState()}>
        <Settings
          onClose={() => undefined}
          context={{} as LocalJSXCommandContext}
          defaultTab="Usage"
        />
      </AppStateProvider>
    </ThemeProvider>,
    {
      stdout,
      stdin,
      stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )

  await new Promise(resolve => setTimeout(resolve, 30))
  instance.unmount()
  return stripAnsi(output)
}

describe('Settings tabs', () => {
  test('hides the Reset tab when no Codex accounts exist', async () => {
    hasCodexAccounts = false

    const output = await renderSettingsTabTitles()

    expect(output).toContain('Usage')
    expect(output).not.toContain('Reset')
  })

  test('shows the Reset tab after Usage when Codex accounts exist', async () => {
    hasCodexAccounts = true

    const output = await renderSettingsTabTitles()

    expect(output).toContain('Usage')
    expect(output).toContain('Reset')
    expect(output.indexOf('Usage')).toBeLessThan(output.indexOf('Reset'))
  })
})
