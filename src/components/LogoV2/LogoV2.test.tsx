import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { PassThrough } from 'stream'
import stripAnsi from 'strip-ansi'
import * as React from 'react'
import { render, ThemeProvider, useApp } from '../../ink.js'
import { AppStateProvider, getDefaultAppState, useAppState, useSetAppState } from '../../state/AppState.js'
import * as logoV2UtilsModule from '../../utils/logoV2Utils.js'
import * as providersModule from '../../utils/model/providers.js'
import * as usageModule from '../../services/api/usage.js'
import * as codexUsageModule from '../../services/api/codexUsage.js'
import * as codexPoolModule from '../../services/api/codexAccountPool.js'
import { resetClaudeAccountPoolForTest } from '../../services/api/claudeAccountPool.js'
import { resetCodexLeaseManagerForTest, seedCodexLeaseForTest } from '../../services/api/codexAccountLeaseManager.js'
import { _setGlobalConfigCacheForTesting } from 'src/utils/config.js'

const SYNC_START = '\x1b[?2026h'
const SYNC_END = '\x1b[?2026l'

function extractLastFrame(output: string): string {
  let frame = stripAnsi(output)
  let searchFrom = 0
  let lastNonEmptyFrame = ''

  while (true) {
    const start = output.indexOf(SYNC_START, searchFrom)
    if (start < 0) break

    const contentStart = start + SYNC_START.length
    const end = output.indexOf(SYNC_END, contentStart)
    if (end < 0) break

    frame = output.slice(contentStart, end)
    const plainFrame = stripAnsi(frame)
    if (plainFrame.trim().length > 0) {
      lastNonEmptyFrame = plainFrame
    }
    searchFrom = end + SYNC_END.length
  }

  return lastNonEmptyFrame || stripAnsi(frame)
}

function createCodexAccount(accountId: string, alias: string, lastUsedAt = 0) {
  return {
    accountId,
    accessToken: `${accountId}-access`,
    refreshToken: `${accountId}-refresh`,
    expiresAt: Date.now() + 60_000,
    source: 'vault' as const,
    status: 'healthy' as const,
    lastUsedAt,
    alias,
  }
}

function createCodexUsageSnapshot(
  firstAccountId: string,
  firstPrimary: number,
  firstSecondary: number,
  secondAccountId: string,
  secondPrimary: number,
  secondSecondary: number,
) {
  const baseResetAt = Date.now() + 60 * 60 * 1000

  return {
    accounts: [
      {
        accountId: firstAccountId,
        userId: `${firstAccountId}-user`,
        email: `${firstAccountId}@example.com`,
        planType: 'plus',
        allowed: true,
        limitReached: false,
        primaryWindow: {
          usedPercent: firstPrimary,
          limitWindowSeconds: 5 * 60 * 60,
          resetAfterSeconds: 30 * 60,
          resetAt: baseResetAt,
        },
        secondaryWindow: {
          usedPercent: firstSecondary,
          limitWindowSeconds: 7 * 24 * 60 * 60,
          resetAfterSeconds: 2 * 24 * 60 * 60,
          resetAt: baseResetAt,
        },
        credits: {
          hasCredits: true,
          unlimited: false,
          balance: '10',
        },
        fetchedAt: Date.now(),
      },
      {
        accountId: secondAccountId,
        userId: `${secondAccountId}-user`,
        email: `${secondAccountId}@example.com`,
        planType: 'plus',
        allowed: true,
        limitReached: false,
        primaryWindow: {
          usedPercent: secondPrimary,
          limitWindowSeconds: 5 * 60 * 60,
          resetAfterSeconds: 45 * 60,
          resetAt: baseResetAt,
        },
        secondaryWindow: {
          usedPercent: secondSecondary,
          limitWindowSeconds: 7 * 24 * 60 * 60,
          resetAfterSeconds: 3 * 24 * 60 * 60,
          resetAt: baseResetAt,
        },
        credits: {
          hasCredits: true,
          unlimited: false,
          balance: '10',
        },
        fetchedAt: Date.now(),
      },
    ],
    fetchedAt: Date.now(),
    errors: [],
  }
}

async function renderFinalFrame(node: React.ReactNode, columns = 100): Promise<string> {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
    columns: number
  }
  stdout.columns = columns

  let output = ''
  ;(stdout as unknown as PassThrough).on('data', chunk => {
    output += chunk.toString()
  })

  const stdin = new PassThrough() as unknown as NodeJS.ReadStream
  const stderr = new PassThrough() as unknown as NodeJS.WriteStream

  const instance = await render(node, {
    stdout,
    stdin,
    stderr,
    exitOnCtrlC: false,
    patchConsole: false,
  })

  await instance.waitUntilExit()
  return extractLastFrame(output)
}

async function renderFrameForDuration(
  node: React.ReactNode,
  columns = 100,
  durationMs = 30,
): Promise<string> {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
    columns: number
  }
  stdout.columns = columns

  let output = ''
  ;(stdout as unknown as PassThrough).on('data', chunk => {
    output += chunk.toString()
  })

  const stdin = new PassThrough() as unknown as NodeJS.ReadStream
  const stderr = new PassThrough() as unknown as NodeJS.WriteStream

  const instance = await render(node, {
    stdout,
    stdin,
    stderr,
    exitOnCtrlC: false,
    patchConsole: false,
  })

  await new Promise(resolve => setTimeout(resolve, durationMs))
  instance.unmount()
  return extractLastFrame(output)
}

afterEach(() => {
  mock.restore()
  codexPoolModule.resetCodexAccountPoolForTest()
  resetCodexLeaseManagerForTest()
  resetClaudeAccountPoolForTest()
  _setGlobalConfigCacheForTesting(null)
  delete process.env.DEMO_VERSION
})

describe('LogoV2', () => {
  test('uses Claude profile name without reading active Codex account for non-Codex providers', async () => {
    const originalNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    process.env.DEMO_VERSION = 'test'
    const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'test-key'

    try {
      _setGlobalConfigCacheForTesting({
        numStartups: 0,
        theme: 'dark',
        oauthAccount: {
          displayName: 'Claude Name',
        },
        customApiKeyResponses: {
          approved: [],
          rejected: [],
        },
      } as never)

      spyOn(providersModule, 'getAPIProvider').mockReturnValue('firstParty')
      spyOn(logoV2UtilsModule, 'getLogoDisplayData').mockReturnValue({
        cwd: '/repo',
        billingType: null,
        agentName: '',
      })
      const getActiveAccountSpy = spyOn(codexPoolModule, 'getActiveAccount')
      await mock.module('./Opus1mMergeNotice.js', () => ({
        shouldShowOpus1mMergeNotice: () => false,
        Opus1mMergeNotice: () => null,
      }))

      const { LogoV2 } = await import('./LogoV2.js')

      const output = await renderFrameForDuration(
        <AppStateProvider>
          <LogoV2 />
        </AppStateProvider>,
      )

      expect(output).toContain('Welcome back Claude Name!')
      expect(getActiveAccountSpy).not.toHaveBeenCalled()
    } finally {
      if (originalAnthropicApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
      }
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = originalNodeEnv
      }
    }
  })

  test('uses read-only pool status for Codex welcome text', async () => {
    process.env.DEMO_VERSION = 'test'

    const activeAccount = {
      ...createCodexAccount('codex-account-one', 'codex-one', 1),
      status: 'capped' as const,
    }
    const healthyAccount = createCodexAccount('codex-account-two', 'codex-two', 2)

    codexPoolModule.seedCodexAccountPoolForTest({
      accounts: [activeAccount, healthyAccount],
      activeAccountId: activeAccount.accountId,
    })

    spyOn(providersModule, 'getAPIProvider').mockReturnValue('openai')
    spyOn(logoV2UtilsModule, 'getLogoDisplayData').mockReturnValue({
      cwd: '/repo',
      billingType: null,
      agentName: '',
    })
    const getActiveAccountSpy = spyOn(codexPoolModule, 'getActiveAccount')

    const { LogoV2 } = await import('./LogoV2.js')

    const output = await renderFrameForDuration(
      <AppStateProvider>
        <LogoV2 />
      </AppStateProvider>,
    )

    expect(output).toContain('Welcome back codex-one!')
    expect(output).not.toContain('Welcome back codex-two!')
    expect(getActiveAccountSpy).not.toHaveBeenCalled()
  })

  test('messages remount the logo on authVersion and refresh Codex welcome text', async () => {
    process.env.DEMO_VERSION = 'test'

    const firstAccount = createCodexAccount('codex-account-one', 'codex-one', 1)
    const secondAccount = createCodexAccount('codex-account-two', 'codex-two', 2)

    codexPoolModule.seedCodexAccountPoolForTest({
      accounts: [firstAccount, secondAccount],
      activeAccountId: firstAccount.accountId,
    })

    _setGlobalConfigCacheForTesting({
      numStartups: 0,
      theme: 'dark',
      oauthAccount: {
        displayName: 'Claude Name',
      },
      customApiKeyResponses: {
        approved: [],
        rejected: [],
      },
    } as never)

    spyOn(logoV2UtilsModule, 'getLogoDisplayData').mockReturnValue({
      cwd: '/repo',
      billingType: null,
      agentName: '',
    })
    spyOn(providersModule, 'getAPIProvider').mockReturnValue('openai')
    spyOn(usageModule, 'fetchUtilization').mockResolvedValue({})
    spyOn(codexUsageModule, 'fetchPoolUsage').mockResolvedValue(
      createCodexUsageSnapshot(
        firstAccount.accountId,
        11,
        22,
        secondAccount.accountId,
        33,
        44,
      ),
    )
    await mock.module('./Opus1mMergeNotice.js', () => ({
      shouldShowOpus1mMergeNotice: () => false,
      Opus1mMergeNotice: () => null,
    }))
    await mock.module('../StatusNotices.js', () => ({
      StatusNotices: () => null,
    }))

    const { Messages } = await import('../Messages.js')

    function Harness() {
      const setAppState = useSetAppState()
      const authVersion = useAppState(s => s.authVersion)
      const { exit } = useApp()

      React.useEffect(() => {
        const timer = setTimeout(() => {
          codexPoolModule.setActiveAccount(secondAccount.accountId)
          setAppState(prev => ({
            ...prev,
            authVersion: prev.authVersion + 1,
          }))
        }, 10)

        return () => clearTimeout(timer)
      }, [setAppState])

      React.useEffect(() => {
        const timer = setTimeout(exit, 150)
        return () => clearTimeout(timer)
      }, [exit])

      React.useEffect(() => {
        if (authVersion !== 1) return

        const timer = setTimeout(exit, 30)
        return () => clearTimeout(timer)
      }, [authVersion, exit])

      return (
        <Messages
          messages={[]}
          tools={[] as never}
          commands={[]}
          verbose={false}
          toolJSX={null}
          toolUseConfirmQueue={[]}
          inProgressToolUseIDs={new Set()}
          isMessageSelectorVisible={false}
          conversationId="conversation-1"
          screen={'main' as never}
          streamingToolUses={[]}
          agentDefinitions={{ activeAgents: [], allowedAgentTypes: [] } as never}
          hideLogo={false}
          isLoading={false}
          streamingThinking={null}
          streamingText={null}
        />
      )
    }

    const output = await renderFinalFrame(
      <AppStateProvider initialState={{ ...getDefaultAppState(), authVersion: 0 }}>
        <Harness />
      </AppStateProvider>,
    )

    expect(output).toContain('Welcome back codex-two!')
  })

  test('accounts panel refreshes active accounts and usage when authVersion changes', async () => {
    process.env.DEMO_VERSION = 'test'

    const firstAccount = createCodexAccount('codex-account-one', 'codex-one', 1)
    const secondAccount = createCodexAccount('codex-account-two', 'codex-two', 2)

    codexPoolModule.seedCodexAccountPoolForTest({
      accounts: [firstAccount, secondAccount],
      activeAccountId: firstAccount.accountId,
    })

    _setGlobalConfigCacheForTesting({
      numStartups: 0,
      theme: 'dark',
      customApiKeyResponses: {
        approved: [],
        rejected: [],
      },
    } as never)

    let utilization = {
      five_hour: {
        utilization: 11,
        resets_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
      seven_day: {
        utilization: 22,
        resets_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      },
    }
    let codexSnapshot = createCodexUsageSnapshot(
      firstAccount.accountId,
      33,
      44,
      secondAccount.accountId,
      55,
      66,
    )

    spyOn(logoV2UtilsModule, 'getLogoDisplayData').mockReturnValue({
      cwd: '/repo',
      billingType: null,
      agentName: '',
    })
    spyOn(usageModule, 'fetchUtilization').mockImplementation(async () => utilization)
    spyOn(codexUsageModule, 'fetchPoolUsage').mockImplementation(async () => codexSnapshot)

    const { AccountsPanel } = await import('./AccountsPanel.js')

    function Harness() {
      const setAppState = useSetAppState()
      const authVersion = useAppState(s => s.authVersion)
      const { exit } = useApp()

      React.useEffect(() => {
        const timer = setTimeout(() => {
          utilization = {
            five_hour: {
              utilization: 77,
              resets_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
            },
            seven_day: {
              utilization: 88,
              resets_at: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
            },
          }
          codexSnapshot = createCodexUsageSnapshot(
            firstAccount.accountId,
            12,
            23,
            secondAccount.accountId,
            67,
            78,
          )
          _setGlobalConfigCacheForTesting({
            numStartups: 0,
            theme: 'dark',
            customApiKeyResponses: {
              approved: [],
              rejected: [],
            },
          } as never)
          codexPoolModule.setActiveAccount(secondAccount.accountId)
          setAppState(prev => ({
            ...prev,
            authVersion: prev.authVersion + 1,
          }))
        }, 10)

        return () => clearTimeout(timer)
      }, [setAppState])

      React.useEffect(() => {
        const timer = setTimeout(exit, 150)
        return () => clearTimeout(timer)
      }, [exit])

      React.useEffect(() => {
        if (authVersion !== 1) return

        const timer = setTimeout(exit, 30)
        return () => clearTimeout(timer)
      }, [authVersion, exit])

      return <AccountsPanel availableWidth={100} />
    }

    const output = await renderFinalFrame(
      <AppStateProvider initialState={{ ...getDefaultAppState(), authVersion: 0 }}>
        <Harness />
      </AppStateProvider>,
    )

    expect(output).toContain('codex-two')
    expect(output).toContain('67%')
    expect(output).toContain('78%')
    expect(output).not.toContain('55%')
    expect(output).not.toContain('66%')
  })

  test('accounts panel marks the main lease account active before pool activeIndex', async () => {
    process.env.DEMO_VERSION = 'test'

    const firstAccount = createCodexAccount('codex-account-one', 'codex-one', 1)
    const secondAccount = createCodexAccount('codex-account-two', 'codex-two', 2)

    codexPoolModule.seedCodexAccountPoolForTest({
      accounts: [firstAccount, secondAccount],
      activeAccountId: firstAccount.accountId,
    })
    seedCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'Main thread',
      accountId: secondAccount.accountId,
      strategy: 'follow-main',
    })

    _setGlobalConfigCacheForTesting({
      numStartups: 0,
      theme: 'dark',
      customApiKeyResponses: {
        approved: [],
        rejected: [],
      },
    } as never)

    spyOn(usageModule, 'fetchUtilization').mockResolvedValue({})
    spyOn(codexUsageModule, 'fetchPoolUsage').mockResolvedValue(
      createCodexUsageSnapshot(
        firstAccount.accountId,
        11,
        22,
        secondAccount.accountId,
        33,
        44,
      ),
    )

    const { AccountsPanel } = await import('./AccountsPanel.js')

    const output = await renderFrameForDuration(
      <AppStateProvider initialState={getDefaultAppState()}>
        <AccountsPanel availableWidth={100} />
      </AppStateProvider>,
    )

    expect(output).toContain('○ codex-one')
    expect(output).toContain('● codex-two')
  })

  test('can switch from full to compact layout without changing hook order', async () => {
    const originalNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'

    const { default: Ink } = await import('../../ink/ink.js')
    const { LogoV2 } = await import('./LogoV2.js')

    function logoTree() {
      return React.createElement(
        ThemeProvider,
        null,
        React.createElement(
          AppStateProvider,
          null,
          React.createElement(LogoV2),
        ),
      )
    }

    const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
      columns: number
      rows: number
    }
    stdout.columns = 100
    stdout.rows = 40
    let output = ''
    stdout.on('data', chunk => {
      output += chunk.toString()
    })

    const errors: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    }

    let ink: InstanceType<typeof Ink> | undefined
    const originalDemoVersion = process.env.DEMO_VERSION
    try {
      process.env.DEMO_VERSION = 'test'
      _setGlobalConfigCacheForTesting({
        numStartups: 0,
        theme: 'dark',
        customApiKeyResponses: {
          approved: [],
          rejected: [],
        },
      } as never)
      const stdin = new PassThrough() as unknown as NodeJS.ReadStream
      const stderr = new PassThrough() as unknown as NodeJS.WriteStream
      ink = new Ink({
        stdout,
        stdin,
        stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      })

      ink.render(logoTree())
      ;(ink as unknown as { terminalColumns: number }).terminalColumns = 60
      stdout.columns = 60

      ink.render(logoTree())
      await new Promise(resolve => setTimeout(resolve, 20))
    } finally {
      ink?.unmount()
      _setGlobalConfigCacheForTesting(null)
      if (originalDemoVersion === undefined) {
        delete process.env.DEMO_VERSION
      } else {
        process.env.DEMO_VERSION = originalDemoVersion
      }
      console.error = originalError
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = originalNodeEnv
      }
    }

    expect(errors.join('\n')).not.toContain('Rendered fewer hooks than expected')
    expect(errors.join('\n')).not.toContain('Rendered more hooks than during the previous render')
    expect(output).not.toContain('Rendered fewer hooks than expected')
    expect(output).not.toContain('Rendered more hooks than during the previous render')
  })
})
