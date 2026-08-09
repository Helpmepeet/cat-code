import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { PassThrough } from 'stream'
import stripAnsi from 'strip-ansi'
import * as React from 'react'

import { Box, render, Text, ThemeProvider } from '../../ink.js'
import { AppStateProvider, getDefaultAppState } from '../../state/AppState.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { settingsCloseResult } from './Settings.js'

// bun never unregisters a `mock.module`, and `mock.restore()` does not undo one
// either, so every registration below stays installed for the rest of the test
// process. `active` is true only while this file's own tests run; outside that
// window each override delegates to the real implementation, which is what
// stops this file from imposing its stubs on later files (the Usage-tab stub
// used to blank out Settings/Usage.test.tsx and the useExitOnCtrlCD stub used
// to break tasks/AsyncAgentDetailDialog.test.tsx).
let active = false
let hasCodexAccounts = false

// `mock.module` MUTATES the namespace object a prior `import` returned, so a
// pass-through that reads the export off the namespace at call time would call
// the mock itself and recurse forever. Capture every implementation up front.
const poolModule = await import('../../services/api/codexAccountPool.js')
const terminalSizeModule = await import('../../hooks/useTerminalSize.js')
const modalContextModule = await import('../../context/modalContext.js')
const exitOnCtrlCDModule = await import(
  '../../hooks/useExitOnCtrlCDWithKeybindings.js'
)
const keybindingModule = await import('../../keybindings/useKeybinding.js')
const paneModule = await import('../design-system/Pane.js')
const tabsModule = await import('../design-system/Tabs.js')
const statusModule = await import('./Status.js')
const configModule = await import('./Config.js')
const usageModule = await import('./Usage.js')
const resetModule = await import('./Reset.js')

const real = {
  hasAnyPoolAccount: poolModule.hasAnyPoolAccount,
  useTerminalSize: terminalSizeModule.useTerminalSize,
  useIsInsideModal: modalContextModule.useIsInsideModal,
  useModalOrTerminalSize: modalContextModule.useModalOrTerminalSize,
  useExitOnCtrlCDWithKeybindings:
    exitOnCtrlCDModule.useExitOnCtrlCDWithKeybindings,
  useKeybinding: keybindingModule.useKeybinding,
  Pane: paneModule.Pane,
  Tab: tabsModule.Tab,
  Tabs: tabsModule.Tabs,
  Status: statusModule.Status,
  buildDiagnostics: statusModule.buildDiagnostics,
  Config: configModule.Config,
  Usage: usageModule.Usage,
  Reset: resetModule.Reset,
}

await mock.module('../../services/api/codexAccountPool.js', () => ({
  ...poolModule,
  hasAnyPoolAccount: () =>
    active ? hasCodexAccounts : real.hasAnyPoolAccount(),
}))
await mock.module('../../hooks/useTerminalSize.js', () => ({
  ...terminalSizeModule,
  useTerminalSize: () =>
    active ? { columns: 120, rows: 40 } : real.useTerminalSize(),
}))
await mock.module('../../context/modalContext.js', () => ({
  ...modalContextModule,
  useIsInsideModal: () => (active ? false : real.useIsInsideModal()),
  useModalOrTerminalSize: (size: { columns: number; rows: number }) =>
    active ? size : real.useModalOrTerminalSize(size),
}))
await mock.module('../../hooks/useExitOnCtrlCDWithKeybindings.js', () => ({
  ...exitOnCtrlCDModule,
  useExitOnCtrlCDWithKeybindings: (
    ...args: Parameters<typeof real.useExitOnCtrlCDWithKeybindings>
  ) =>
    active ? undefined : real.useExitOnCtrlCDWithKeybindings(...args),
}))
await mock.module('../../keybindings/useKeybinding.js', () => ({
  ...keybindingModule,
  useKeybinding: (...args: Parameters<typeof real.useKeybinding>) =>
    active ? undefined : real.useKeybinding(...args),
}))
await mock.module('../design-system/Pane.js', () => ({
  ...paneModule,
  Pane: (props: { children: React.ReactNode }) =>
    active ? <Box>{props.children}</Box> : <real.Pane {...props} />,
}))
await mock.module('../design-system/Tabs.js', () => ({
  ...tabsModule,
  Tab: (props: { children: React.ReactNode }) =>
    active ? <>{props.children}</> : <real.Tab {...props} />,
  Tabs: (props: { children: React.ReactNode }) =>
    active ? (
      <Box flexDirection="column">
        {React.Children.map(props.children, child =>
          React.isValidElement<{ title: string }>(child) ? (
            <Text>{child.props.title}</Text>
          ) : null,
        )}
      </Box>
    ) : (
      <real.Tabs {...props} />
    ),
}))
await mock.module('./Status.js', () => ({
  ...statusModule,
  Status: (props: Record<string, unknown>) =>
    active ? <Text>Status body</Text> : <real.Status {...props} />,
  buildDiagnostics: async () => (active ? [] : real.buildDiagnostics()),
}))
await mock.module('./Config.js', () => ({
  ...configModule,
  Config: (props: React.ComponentProps<typeof real.Config>) =>
    active ? <Text>Config body</Text> : <real.Config {...props} />,
}))
await mock.module('./Usage.js', () => ({
  ...usageModule,
  Usage: (props: React.ComponentProps<typeof real.Usage>) =>
    active ? <Text>Usage body</Text> : <real.Usage {...props} />,
}))
await mock.module('./Reset.js', () => ({
  ...resetModule,
  Reset: (props: React.ComponentProps<typeof real.Reset>) =>
    active ? <Text>Reset body</Text> : <real.Reset {...props} />,
}))

beforeAll(() => {
  active = true
})

afterAll(() => {
  active = false
})

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

  test('retains redemption audit lines when Config closes Settings', () => {
    expect(
      settingsCloseResult('Set model to gpt-5.6', undefined, [
        'Redeemed reset for account@example.com',
      ]),
    ).toEqual({
      result:
        'Redeemed reset for account@example.com\nSet model to gpt-5.6',
      options: undefined,
    })
  })
})
