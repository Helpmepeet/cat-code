import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import { ComposerActionsBar } from './ComposerActionsBar.js'
import { AccountsPage } from './AccountsPage.js'
import { WelcomeScreen } from './WelcomeScreen.js'
import { TasksDialog } from './TasksDialog.js'
import { SessionActionsMenu } from './SessionActionsMenu.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import type { PermissionContextSnapshot, PermissionSetModeMode } from '../../shared/protocol.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })

const context: PermissionContextSnapshot = {
  mode: 'default', alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {},
  ruleMetadata: [], managedRulesOnly: false, permissionClassifierEnabled: true,
  additionalWorkingDirectories: [], isBypassPermissionsModeAvailable: true,
}

function bar(onSetMode: (mode: PermissionSetModeMode) => void, props: Partial<Parameters<typeof ComposerActionsBar>[0]> = {}) {
  return createElement(ComposerActionsBar, {
    attachDisabled: false, onAttach() {}, model: null, reasoningEffort: null,
    fastMode: null, permissionContext: context, onSetMode, account: null,
    contextUsage: null,
    runControls: {
      model: {
        current: 'gpt-5.6-sol', currentLabel: 'GPT-5.6 Sol', selected: 'gpt-5.6-sol',
        contextWindow: 200_000, provider: 'openai', providerSwitchLocked: false,
        options: [],
      },
      effort: { current: null, selected: null, supported: false, options: [] },
      fast: { active: false, supportedByModel: false, available: false, unavailableReason: null },
      autoCompact: { enabled: true, threshold: null, warningThreshold: null },
    },
    onSetModel: () => {}, onSetEffort: () => {}, onSetFast: () => {},
    ...props,
  })
}

function modeFace(container: HTMLElement): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[data-composer-face="run-controls"]')!
}

async function open(trigger: HTMLButtonElement) {
  await act(async () => { trigger.focus(); trigger.click() })
  await act(async () => { await harness.nextFrame() })
  const mode = document.querySelector<HTMLButtonElement>('[role="menuitem"][aria-label^="Permission mode: "]')!
  await act(async () => mode.click())
  await act(async () => { await harness.nextFrame() })
  return document.querySelector<HTMLElement>('[role="menu"][aria-label="Permission mode"]')!
}

test('a Default-only model list disables the empty model submenu', async () => {
  const runControls = bar(() => {}).props.runControls
  if (!runControls) throw new Error('Expected run controls in the bar fixture')
  const tree = await harness.mount(bar(() => {}, {
    runControls: {
      ...runControls,
      model: {
        ...runControls.model,
        options: [{ value: null, label: 'Default', provider: 'openai', effortOptions: [] }],
      },
    },
  }))
  const trigger = modeFace(tree.container)
  await act(async () => trigger.click())
  await act(async () => { await harness.nextFrame() })
  const model = document.querySelector<HTMLButtonElement>('[role="menuitem"][aria-label^="Model: "]')!
  expect(model).not.toBeNull()
  expect(model.disabled).toBe(true)
  await act(async () => model.click())
  expect(document.querySelector('[role="menu"][aria-label="Model"]')).toBeNull()
})

// Browser captures own actual clipping/geometry. This DOM case protects the
// separate pointer/focus risk when a menu is outside its trigger's DOM subtree.
test('menu pointer selection and Escape restore the owning face, while outside click keeps its focus', async () => {
  const modes: PermissionSetModeMode[] = []
  const tree = await harness.mount(bar(mode => modes.push(mode)))
  const trigger = modeFace(tree.container)
  let menu = await open(trigger)
  expect(document.activeElement?.getAttribute('aria-checked')).toBe('true')
  const plan = menu.querySelector<HTMLButtonElement>('[role="menuitemradio"]')!
  await act(async () => { plan.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
  expect(document.querySelector('[role="menu"]')).toBe(menu)
  await act(async () => plan.click())
  expect(modes).toEqual(['plan'])
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(document.activeElement === trigger).toBe(true)

  menu = await open(trigger)
  await act(async () => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })))
  expect(document.activeElement?.textContent).toContain('Bypass permissions')
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(document.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('Run controls')
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Permission mode: Ask')
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(document.activeElement === trigger).toBe(true)

  await open(trigger)
  const outside = document.createElement('button')
  document.body.append(outside)
  await act(async () => outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
  // Dismissal must not briefly return to the old face before the browser's
  // pointer default focuses its destination.
  expect(document.activeElement === trigger).toBe(false)
  await act(async () => outside.focus())
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(document.activeElement === outside).toBe(true)
  outside.remove()
})

test('switching between pane menus sends the selection only to its owner', async () => {
  const firstModes: PermissionSetModeMode[] = []
  const secondModes: PermissionSetModeMode[] = []
  const first = await harness.mount(bar(mode => firstModes.push(mode)))
  const second = await harness.mount(bar(mode => secondModes.push(mode)))
  await open(modeFace(first.container))
  const secondTrigger = modeFace(second.container)
  await act(async () => secondTrigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
  await act(async () => { secondTrigger.focus(); secondTrigger.click() })
  await act(async () => { await harness.nextFrame() })
  expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1)
  const mode = document.querySelector<HTMLButtonElement>('[role="menuitem"][aria-label^="Permission mode: "]')!
  await act(async () => mode.click())
  const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Permission mode"]')!
  const plan = menu.querySelector<HTMLButtonElement>('[role="menuitemradio"]')!
  await act(async () => { plan.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); plan.click() })
  expect(firstModes).toEqual([])
  expect(secondModes).toEqual(['plan'])
  expect(document.activeElement === secondTrigger).toBe(true)
})

test('the merged mode list preserves classifier availability and applies a mode before closing', async () => {
  const modes: PermissionSetModeMode[] = []
  const tree = await harness.mount(bar(mode => modes.push(mode), {
    permissionContext: { ...context, permissionClassifierEnabled: false },
  }))
  const trigger = modeFace(tree.container)
  const menu = await open(trigger)
  const choices = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
  expect(choices).toHaveLength(6)
  const auto = choices.find(choice => choice.textContent?.includes('Auto mode'))!
  expect(auto.disabled).toBe(true)
  expect(auto.title).toBe('Auto mode is unavailable for this model or has been disabled in settings.')
  await act(async () => auto.click())
  expect(modes).toEqual([])
  expect(document.querySelector('[role="menu"]') === menu).toBe(true)
  await act(async () => choices.find(choice => choice.textContent?.includes('Accept edits'))!.click())
  expect(modes).toEqual(['acceptEdits'])
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(document.activeElement === trigger).toBe(true)
})


test('toolbar arrows and Tab cross one run face between attachment and the right cluster', async () => {
  let composerFocusRequests = 0
  const tree = await harness.mount(bar(() => {}, {
    contextUsage: { usedTokens: 42_000, contextWindow: 200_000, percentUsed: 21 },
    onFocusComposer: () => { composerFocusRequests++ },
  }))
  const attach = tree.container.querySelector<HTMLButtonElement>('[data-composer-face="attach"]')!
  const run = modeFace(tree.container)
  const usage = tree.container.querySelector<HTMLButtonElement>('[data-composer-face="context"]')!
  const press = async (key: string, shiftKey = false) => {
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', {
      key, shiftKey, bubbles: true, cancelable: true,
    })))
  }
  await act(async () => attach.focus())
  await press('ArrowRight')
  expect(document.activeElement === run).toBe(true)
  expect(run.tabIndex).toBe(0)
  expect(attach.tabIndex).toBe(-1)
  await press('Tab')
  expect(document.activeElement === usage).toBe(true)
  await press('Tab', true)
  expect(document.activeElement === run).toBe(true)
  await press('End')
  expect(document.activeElement === usage).toBe(true)
  await press('ArrowRight')
  expect(document.activeElement === attach).toBe(true)
  await press('ArrowLeft')
  expect(document.activeElement === usage).toBe(true)
  await press('Home')
  expect(document.activeElement === attach).toBe(true)
  await press('Tab', true)
  expect(composerFocusRequests).toBe(1)
  expect(tree.container.querySelectorAll('[data-composer-face]')).toHaveLength(3)
})

test('Escape dismisses an informational dialog before leaving the toolbar', async () => {
  let composerFocusRequests = 0
  const tree = await harness.mount(bar(() => {}, {
    contextUsage: { usedTokens: 42_000, contextWindow: 200_000, percentUsed: 21 },
    onFocusComposer: () => { composerFocusRequests++ },
  }))
  const trigger = tree.container.querySelector<HTMLButtonElement>('[data-composer-face="context"]')!
  await act(async () => { trigger.focus(); trigger.click() })
  await act(async () => { await harness.nextFrame() })
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(document.activeElement === trigger).toBe(true)
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(document.querySelector('[role="dialog"]') === null).toBe(true)
  expect(document.activeElement === trigger).toBe(true)
  expect(composerFocusRequests).toBe(0)
})

test('an actionable context dialog focuses Compact and restores its trigger after activation', async () => {
  let compactions = 0
  const tree = await harness.mount(bar(() => {}, {
    contextUsage: { usedTokens: 42_000, contextWindow: 200_000, percentUsed: 21 },
    onCompact: () => { compactions++ },
  }))
  const trigger = tree.container.querySelector<HTMLButtonElement>('[data-composer-face="context"]')!
  await act(async () => { trigger.focus(); trigger.click() })
  await act(async () => { await harness.nextFrame() })
  const compact = document.querySelector<HTMLButtonElement>('[role="dialog"] button')!
  expect(document.activeElement === compact).toBe(true)
  await act(async () => compact.click())
  expect(compactions).toBe(1)
  expect(document.querySelector('[role="dialog"]') === null).toBe(true)
  expect(document.activeElement === trigger).toBe(true)
})

test('keyboard navigation between informational faces leaves only the current dialog and its focus owner', async () => {
  const tree = await harness.mount(bar(() => {}, {
    contextUsage: { usedTokens: 190_000, contextWindow: 200_000, percentUsed: 95 },
    runControls: {
      cacheExpired: null,
      model: {
        current: null, currentLabel: null, contextWindow: 200_000, selected: null,
        provider: 'openai', providerSwitchLocked: false, options: [],
      },
      effort: { current: null, selected: null, supported: false, options: [] },
      fast: { active: false, supportedByModel: false, available: false, unavailableReason: null },
      autoCompact: { enabled: true, threshold: 180_000, warningThreshold: 160_000 },
    },
  }))
  // Preview/busy panes do not offer Compact, so Usage keeps focus on its face.
  const usage = tree.container.querySelector<HTMLButtonElement>('[data-composer-face="context"]')!
  const warning = tree.container.querySelector<HTMLButtonElement>('[data-composer-face="token-warning"]')!
  const press = async (target: HTMLElement, key: string) => {
    await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', {
      key, bubbles: true, cancelable: true,
    })))
  }
  await act(async () => { usage.focus(); usage.click() })
  await act(async () => { await harness.nextFrame() })
  expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Usage')
  expect(document.activeElement === usage).toBe(true)

  await press(usage, 'ArrowLeft')
  expect(document.activeElement === warning).toBe(true)
  await press(warning, 'ArrowDown')
  await act(async () => { await harness.nextFrame() })
  expect([...document.querySelectorAll('[role="dialog"]')].map(dialog => dialog.getAttribute('aria-label'))).toEqual(['Context'])
  expect(usage.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement === warning).toBe(true)

  await press(warning, 'Escape')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(warning.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement === warning).toBe(true)
})

test('inline account and Welcome menus keep their item focus while yielding to a different owner', async () => {
  const accountTree = await harness.mount(createElement(AccountsPage, {
    snapshot: {
      accounts: [], activeAccountId: null, readyCount: 0, poolCount: 0, initialized: true,
      anthropicAccounts: [], anthropicActiveAccountId: null, anthropicReadyCount: 0,
      anthropicPoolCount: 0, anthropicInitialized: true, anthropicRouteAvailable: false,
      signedOutProfiles: [{
        id: 'former-account', alias: 'Former account', state: 'signed_out',
        credentialGeneration: 1, lifecycleGeneration: 1,
        credentialGenerationState: 'lifecycle_bound', lifecycleState: 'signed_out',
        lifecycleReadStatus: 'valid',
      }],
    },
    lastResult: null, onVerb() {},
  }))
  const accounts = accountTree.container.querySelector<HTMLButtonElement>('[aria-label="Account actions"]')!
  await act(async () => { accounts.focus(); accounts.click() })
  await act(async () => { await harness.nextFrame() })
  expect(document.activeElement?.textContent).toBe('Sign in again')
  expect(accounts.getAttribute('aria-expanded')).toBe('true')

  let foldersOpened = 0
  const welcome = await harness.mount(createElement(WelcomeScreen, {
    accounts: null, recents: [], onOpenRecent() {}, onOpenFolder: () => { foldersOpened++ },
  }))
  const project = welcome.container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!
  await act(async () => project.focus())
  expect(accounts.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement === project).toBe(true)
  await act(async () => project.click())
  await act(async () => { await harness.nextFrame() })
  const folder = welcome.container.querySelector<HTMLButtonElement>('[role="menuitem"]')!
  expect(document.activeElement === folder).toBe(true)
  expect(project.getAttribute('aria-expanded')).toBe('true')
  await act(async () => folder.click())
  expect(foldersOpened).toBe(1)
  expect(project.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement === project).toBe(true)
})

test('a modal above the composer retains its focus and Escape ownership', async () => {
  const tree = await harness.mount(bar(() => {}))
  const trigger = modeFace(tree.container)
  await open(trigger)
  let modalCloses = 0
  const modal = await harness.mount(createElement(TasksDialog, {
    open: true, onClose: () => { modalCloses++ }, snapshot: { items: [] }, hasActiveSession: true,
  }))
  await act(async () => { await harness.nextFrame() })
  const focused = document.activeElement
  expect(modal.container.contains(focused)).toBe(true)
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  await act(async () => focused?.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  })))
  expect(modalCloses).toBe(1)
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  expect(document.activeElement === focused).toBe(true)
  await modal.unmount()
  expect(document.activeElement?.getAttribute('aria-checked')).toBe('true')
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  })))
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement === trigger).toBe(true)
})

test('a default popover consumer still restores its opener when removed unexpectedly', async () => {
  const opener = document.createElement('button')
  document.body.append(opener)
  try {
    opener.focus()
    const menu = await harness.mount(createElement(SessionActionsMenu, {
      items: [{ kind: 'copy-text', label: 'Copy transcript', enabled: true, section: 'transfer' }],
      anchor: { top: 100, bottom: 100, left: 40 }, onAction() {}, onClose() {},
    }))
    await act(async () => { await harness.nextFrame() })
    expect(menu.container.contains(document.activeElement)).toBe(true)
    await menu.unmount()
    expect(document.activeElement === opener).toBe(true)
  } finally {
    opener.remove()
  }
})
