/** Rail slash commands open the same composer cards a click opens. */

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, createRef, type ComponentProps } from 'react'

import {
  ComposerActionsBar,
  type ComposerRailCommands,
} from './ComposerActionsBar.js'
import { SessionPane } from './SessionPane.js'
import { idleSessionPaneProps } from './sessionPaneTestProps.js'
import { createTranscriptState, projectServerFrame } from './transcriptProjector.js'
import { PROTOCOL_VERSION } from '../../shared/protocol.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import type {
  AccountStatus,
  AnthropicAccountStatus,
  AccountSwitchMessage,
  PermissionContextSnapshot,
  PermissionSetModeMode,
  RunControlsSnapshot,
} from '../../shared/protocol.js'
import type { DesktopRailCommand } from './desktopChatCommands.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })

const LEVELS = ['low', 'medium', 'high', 'xhigh']

function runControls(fast: Partial<RunControlsSnapshot['fast']> = {}): RunControlsSnapshot {
  return {
    model: {
      current: 'gpt-5.6-sol',
      currentLabel: 'GPT-5.6 Sol',
      contextWindow: 372_000,
      selected: 'gpt-5.6-sol',
      provider: 'openai',
      providerSwitchLocked: false,
      options: [
        { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', provider: 'openai', effortOptions: LEVELS },
        { value: 'gpt-5.5', label: 'GPT-5.5', provider: 'openai', effortOptions: LEVELS },
      ],
    },
    effort: { current: 'high', selected: 'high', supported: true, options: LEVELS },
    fast: { active: false, supportedByModel: true, available: true, unavailableReason: null, ...fast },
    autoCompact: { enabled: true, threshold: 340_000, warningThreshold: 320_000 },
  }
}

function permissionContext(over: Partial<PermissionContextSnapshot> = {}): PermissionContextSnapshot {
  return {
    mode: 'default',
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    ruleMetadata: [],
    managedRulesOnly: false,
    permissionClassifierEnabled: false,
    additionalWorkingDirectories: [],
    isBypassPermissionsModeAvailable: false,
    ...over,
  }
}

function account(over: Partial<AccountStatus> = {}): AccountStatus {
  return {
    id: 'acct-1', credentialGeneration: 0, alias: 'main', status: 'healthy', statusReason: null,
    availability: 'available', availabilityLabel: 'Available', isDefault: true, hasVaultProfile: true,
    source: 'vault', usagePrimary: 10, usageWeekly: 20, usageLimitReached: false, usageResetAt: null,
    lastRefreshIso: null, lastError: null, planType: null, switchable: false, ...over,
  }
}

type Recorded = { models: (string | null)[]; fast: boolean[]; modes: PermissionSetModeMode[] }

/** The bar with a stand-in composer that holds focus, as the field does while typing. */
async function mountBar(over: Partial<ComponentProps<typeof ComposerActionsBar>> = {}) {
  const recorded: Recorded = { models: [], fast: [], modes: [] }
  const commands = createRef<ComposerRailCommands>()
  const tree = await harness.mount(
    <ComposerActionsBar
      attachDisabled={false}
      onAttach={() => {}}
      model="gpt-5.6-sol"
      reasoningEffort="high"
      fastMode={false}
      permissionContext={permissionContext()}
      onSetMode={mode => recorded.modes.push(mode)}
      account={null}
      contextUsage={null}
      runControls={runControls()}
      onSetModel={value => recorded.models.push(value)}
      onSetEffort={() => {}}
      onSetFast={active => recorded.fast.push(active)}
      commandsRef={commands}
      {...over}
    />,
  )
  const composer = document.createElement('button')
  composer.setAttribute('aria-label', 'Stand-in composer')
  tree.container.prepend(composer)
  composer.focus()
  const run = async (command: DesktopRailCommand) => {
    await act(async () => { commands.current!.run(command) })
    await harness.nextFrame()
  }
  return { tree, composer, recorded, run }
}

function openMenu(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="menu"]')
}

async function press(key: string): Promise<void> {
  await act(async () => {
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key }))
  })
  await harness.nextFrame()
}

test('/model opens the run card on its model list with the current model focused', async () => {
  const { run } = await mountBar()
  await run('model')
  expect(openMenu()?.getAttribute('aria-label')).toBe('Model')
  const focused = document.activeElement
  expect(focused?.getAttribute('aria-checked')).toBe('true')
  expect(focused?.textContent).toContain('GPT-5.6 Sol')
})

test('a card opened from the composer hands focus back to the composer, not the face', async () => {
  const { composer, run } = await mountBar()
  await run('model')
  await press('Escape')
  expect(openMenu()?.getAttribute('aria-label')).toBe('Run controls')
  await press('Escape')
  expect(openMenu()).toBeNull()
  expect(document.activeElement === composer).toBe(true)
})

test('picking from a card opened by /mode closes it and returns to the composer', async () => {
  const { composer, recorded, run } = await mountBar()
  await run('mode')
  expect(openMenu()?.getAttribute('aria-label')).toBe('Permission mode')
  const plan = Array.from(openMenu()!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
    .find(row => row.textContent?.includes('Plan'))
  await act(async () => { plan!.click() })
  await harness.nextFrame()
  expect(recorded.modes).toEqual(['plan'])
  expect(openMenu()).toBeNull()
  expect(document.activeElement === composer).toBe(true)
})

test('picking from a card opened by /model closes it and returns to the composer', async () => {
  const { composer, recorded, run } = await mountBar()
  await run('model')
  const next = Array.from(openMenu()!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
    .find(row => row.textContent?.includes('GPT-5.5'))
  await act(async () => { next!.click() })
  await harness.nextFrame()
  expect(recorded.models).toEqual(['gpt-5.5'])
  expect(openMenu()).toBeNull()
  expect(document.activeElement === composer).toBe(true)
})

test('picking a level from a card opened by /effort closes it and returns to the composer', async () => {
  const efforts: string[] = []
  const { composer, run } = await mountBar({ onSetEffort: effort => efforts.push(effort) })
  await run('effort')
  await act(async () => {
    openMenu()!.querySelector<HTMLButtonElement>('[data-effort-rung="xhigh"]')!.click()
  })
  await harness.nextFrame()
  expect(efforts).toEqual(['xhigh'])
  expect(openMenu()).toBeNull()
  expect(document.activeElement === composer).toBe(true)
})

test('a card opened by /model stays open for an effort change made on its way', async () => {
  const efforts: string[] = []
  const { run } = await mountBar({ onSetEffort: effort => efforts.push(effort) })
  await run('model')
  await press('Escape')
  await act(async () => {
    openMenu()!.querySelector<HTMLButtonElement>('[data-effort-rung="xhigh"]')!.click()
  })
  expect(efforts).toEqual(['xhigh'])
  expect(openMenu()?.getAttribute('aria-label')).toBe('Run controls')
})

test('a face click after a slash request keeps the card open on a model pick', async () => {
  const { tree, recorded, run } = await mountBar()
  await run('model')
  await press('Escape')
  await press('Escape')
  await act(async () => {
    tree.container.querySelector<HTMLElement>('[data-composer-face="run-controls"]')!.click()
  })
  await harness.nextFrame()
  await act(async () => { openMenu()!.querySelector<HTMLButtonElement>('[data-run-model]')!.click() })
  await harness.nextFrame()
  const next = Array.from(openMenu()!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
    .find(row => row.textContent?.includes('GPT-5.5'))
  await act(async () => { next!.click() })
  expect(recorded.models).toEqual(['gpt-5.5'])
  expect(openMenu()?.getAttribute('aria-label')).toBe('Run controls')
})

test('/effort opens the main card with the current effort rung focused', async () => {
  const { run } = await mountBar()
  await run('effort')
  expect(openMenu()?.getAttribute('aria-label')).toBe('Run controls')
  expect(document.activeElement?.getAttribute('data-effort-rung')).toBe('high')
})

test('a click after a slash request still opens on the model row', async () => {
  const { tree, run } = await mountBar()
  await run('effort')
  await press('Escape')
  await act(async () => {
    tree.container.querySelector<HTMLElement>('[data-composer-face="run-controls"]')!.click()
  })
  await harness.nextFrame()
  expect(document.activeElement?.hasAttribute('data-run-model')).toBe(true)
})

test('/fast toggles without opening a card', async () => {
  const off = await mountBar()
  await off.run('fast')
  expect(off.recorded.fast).toEqual([true])
  expect(openMenu()).toBeNull()
  await harness.unmountAll()
  const on = await mountBar({ runControls: runControls({ active: true }) })
  await on.run('fast')
  expect(on.recorded.fast).toEqual([false])
})

test('/plan enters plan mode and leaves it for the recorded previous mode', async () => {
  const enter = await mountBar()
  await enter.run('plan')
  expect(enter.recorded.modes).toEqual(['plan'])
  await harness.unmountAll()
  const leave = await mountBar({ permissionContext: permissionContext({ mode: 'plan', prePlanMode: 'acceptEdits' }) })
  await leave.run('plan')
  expect(leave.recorded.modes).toEqual(['acceptEdits'])
  expect(openMenu()).toBeNull()
})

test('/account opens the switcher on the active account', async () => {
  let opened = 0
  const active = account()
  const { run } = await mountBar({
    account: active,
    accounts: [active, account({ id: 'acct-2', alias: 'work', isDefault: false, switchable: true })],
    onSwitchAccount: () => {},
    onOpenAccountSwitcher: () => { opened++ },
  })
  await run('account')
  expect(openMenu()?.getAttribute('aria-label')).toBe('Accounts')
  expect(document.activeElement?.getAttribute('aria-current')).toBe('true')
  expect(opened).toBe(1)
})

test('/context opens usage like a click, with focus on its face', async () => {
  let breakdowns = 0
  const { tree, run } = await mountBar({
    contextUsage: { usedTokens: 20_000, contextWindow: 200_000, percentUsed: 10 },
    onRequestContextBreakdown: () => { breakdowns++ },
  })
  await run('context')
  expect(document.querySelector('[role="dialog"][aria-label="Usage"]')).not.toBeNull()
  expect(document.activeElement === tree.container.querySelector('[data-composer-face="context"]')).toBe(true)
  expect(breakdowns).toBe(1)
})

/* ---------- through the composer field ---------- */

const origin: SessionDescriptor = {
  appSessionId: 'session-1', engineSessionId: null, cwd: '/tmp/project', title: null,
  forked: false, titleUpdatedAt: null, status: 'ready', restorable: false, parked: false,
  createdAt: 1, lastAttachedAt: 1, lastMessageSentAt: null, binding: { kind: 'project' },
}

async function mountPane(prompt: string, over: Partial<ComponentProps<typeof SessionPane>> = {}) {
  const prompts: string[] = []
  let submits = 0
  const tree = await harness.mount(<SessionPane {...idleSessionPaneProps()}
    activeDescriptor={origin}
    activeConnection={{ status: 'ready', inputEnabled: true }}
    prompt={prompt}
    setPrompt={next => { prompts.push(next) }}
    submit={event => { event.preventDefault(); submits++ }}
    runControls={runControls()}
    onSetModel={() => {}}
    onSetEffort={() => {}}
    onSetFast={() => {}}
    permissionContext={permissionContext()}
    {...over} />)
  const field = tree.container.querySelector<HTMLElement>('[aria-label="Prompt"]')!
  await act(async () => { field.focus() })
  const key = async (name: string) => {
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
    })
    await harness.nextFrame()
  }
  return { tree, field, key, prompts, submits: () => submits }
}

test('Enter on /model in the picker opens the card and clears the draft instead of completing', async () => {
  const pane = await mountPane('/model')
  expect(pane.tree.container.querySelector('[aria-label="Insert slash command /model"]')).not.toBeNull()
  await pane.key('Enter')
  expect(pane.prompts).toEqual([''])
  expect(pane.submits()).toBe(0)
  expect(openMenu()?.getAttribute('aria-label')).toBe('Model')
})

test('Tab still completes a rail command, and Enter on the completed draft runs it', async () => {
  const typing = await mountPane('/mode')
  await typing.key('Tab')
  expect(typing.prompts).toEqual(['/mode '])
  await harness.unmountAll()
  const completed = await mountPane('/mode ')
  await completed.key('Enter')
  expect(completed.prompts).toEqual([''])
  expect(completed.submits()).toBe(0)
  expect(openMenu()?.getAttribute('aria-label')).toBe('Permission mode')
})

test('an unavailable rail command is held in the draft, never sent to the engine', async () => {
  const pane = await mountPane('/model ', { runControls: null })
  expect(pane.tree.container.querySelector<HTMLButtonElement>('[aria-label="Send prompt"]')?.disabled).toBe(true)
  await pane.key('Enter')
  expect(pane.submits()).toBe(0)
  expect(pane.prompts).toEqual([])
  expect(openMenu()).toBeNull()
})

test('Enter on an unavailable rail command in the fallback picker completes the draft without opening a card', async () => {
  const transcript = projectServerFrame(createTranscriptState(), {
    kind: 'ready',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: 'session-1',
    engineSessionId: 'engine-session-1',
    payload: {
      type: 'app.ready',
      protocolVersion: 1,
      inputEnabled: true,
      activeTurn: false,
      abort: { status: 'idle' },
      goalSnapshot: null,
      pendingPermissionRequests: [],
    },
  })
  transcript.sessions['session-1']!.slashCommands = ['model', 'compact']
  const pane = await mountPane('/mod', { runControls: null, slashCatalog: [], transcript })
  expect(pane.tree.container.querySelector('[aria-label="Insert slash command /model"]')).not.toBeNull()
  await pane.key('Enter')
  expect(pane.prompts).toEqual(['/model '])
  expect(pane.submits()).toBe(0)
  expect(openMenu()).toBeNull()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

test('a rail command sent with the Send button still returns focus to the field', async () => {
  const pane = await mountPane('/mode ')
  const send = pane.tree.container.querySelector<HTMLButtonElement>('[aria-label="Send prompt"]')!
  await act(async () => { send.focus(); send.click() })
  await harness.nextFrame()
  expect(openMenu()?.getAttribute('aria-label')).toBe('Permission mode')
  await press('Escape')
  expect(openMenu()?.getAttribute('aria-label')).toBe('Run controls')
  await press('Escape')
  expect(openMenu()).toBeNull()
  expect(document.activeElement === pane.field).toBe(true)
})

test('the picker offers only rail commands that can act', async () => {
  const pane = await mountPane('/', { runControls: runControls({ supportedByModel: false }) })
  const offered = (name: string) =>
    pane.tree.container.querySelector(`[aria-label="Insert slash command /${name}"]`) !== null
  expect(offered('model')).toBe(true)
  expect(offered('mode')).toBe(true)
  expect(offered('fast')).toBe(false)
  expect(offered('account')).toBe(false)
})

test('/account in a Claude pane opens both pools and sends a Claude switch verb', async () => {
  const active: AnthropicAccountStatus = {
    id: 'claude-main', alias: 'work', email: 'work@example.com', status: 'healthy',
    isDefault: true, hasVaultProfile: true, subscriptionType: 'max',
    usageFiveHour: 35, usageWeekly: 18,
  }
  const alternate = { ...active, id: 'claude-alt', alias: 'personal', isDefault: false }
  const switches: AccountSwitchMessage[] = []
  let refreshes = 0
  const pane = await mountPane('/account ', {
    activeAccount: null,
    activeAnthropicAccount: active,
    accountsSnapshot: {
      ...idleSessionPaneProps().accountsSnapshot!,
      accounts: [account({ switchable: true })],
      anthropicAccounts: [active, alternate],
    },
    onSwitchAccount: verb => switches.push(verb),
    onOpenAccountSwitcher: () => { refreshes++ },
  })
  await pane.key('Enter')
  expect(pane.prompts).toEqual([''])
  expect(pane.submits()).toBe(0)
  expect(refreshes).toBe(1)
  expect(openMenu()?.textContent).toContain('35%')
  const codexRow = Array.from(openMenu()!.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    .find(row => row.textContent?.includes('main'))!
  expect(codexRow.getAttribute('aria-disabled')).toBe('true')
  await act(async () => { codexRow.click() })
  expect(switches).toEqual([])
  await act(async () => {
    openMenu()!.querySelector<HTMLButtonElement>('[title="Switch to personal"]')!.click()
  })
  await harness.nextFrame()
  expect(switches).toEqual([expect.objectContaining({
    type: 'account.switch', provider: 'anthropic', accountId: 'claude-alt',
    requestId: expect.any(String),
  })])
  expect(openMenu()).toBeNull()
  expect(document.activeElement === pane.field).toBe(true)
})
