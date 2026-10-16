/** Mounted regressions for the unified composer run controls. */

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import type { ComponentProps, ReactElement } from 'react'

import { ComposerActionsBar } from './ComposerActionsBar.js'
import { createDomTestHarness } from './domTestHarness.js'
import type { DomTestHarness, MountedTree } from './domTestHarness.js'
import type {
  AccountStatus,
  PermissionContextSnapshot,
  RunControlsSnapshot,
} from '../../shared/protocol.js'

let harness: DomTestHarness

beforeAll(async () => {
  harness = await createDomTestHarness()
})

afterEach(async () => {
  await harness.unmountAll()
})

afterAll(async () => {
  await harness.teardown()
})

const GPT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const OPUS_LEVELS = ['low', 'medium', 'high', 'max']

function account(overrides: Partial<AccountStatus> = {}): AccountStatus {
  return {
    id: 'acct-1',
    credentialGeneration: 0,
    alias: 'hiby',
    status: 'healthy',
    statusReason: null,
    availability: 'available',
    availabilityLabel: 'Available',
    isDefault: true,
    hasVaultProfile: true,
    source: 'vault',
    usagePrimary: 10,
    usageWeekly: 20,
    usageLimitReached: false,
    usageResetAt: null,
    lastRefreshIso: null,
    lastError: null,
    planType: null,
    switchable: false,
    ...overrides,
  }
}

/**
 * A Codex-routed session whose picker offers both providers — the shape that
 * exercises grouping, the cross-provider lock, and the two kinds of row (with a
 * ladder, and Haiku's without).
 */
function runControls(over: Partial<RunControlsSnapshot['model']> = {}): RunControlsSnapshot {
  return {
    model: {
      current: 'gpt-5.6-sol',
      currentLabel: 'GPT-5.6 Sol',
      contextWindow: 372_000,
      selected: 'gpt-5.6-sol',
      provider: 'openai',
      providerSwitchLocked: false,
      options: [
        {
          value: null,
          label: 'Default (recommended)',
          provider: 'openai',
          effortOptions: GPT_LEVELS,
        },
        {
          value: 'gpt-5.6-sol',
          label: 'GPT-5.6 Sol',
          provider: 'openai',
          effortOptions: GPT_LEVELS,
        },
        {
          value: 'opus',
          label: 'Opus 5',
          provider: 'anthropic',
          effortOptions: OPUS_LEVELS,
        },
        {
          value: 'haiku',
          label: 'Haiku 4.5',
          provider: 'anthropic',
          effortOptions: [],
        },
      ],
      ...over,
    },
    effort: {
      current: 'high',
      selected: 'high',
      supported: true,
      options: GPT_LEVELS,
    },
    fast: {
      active: false,
      supportedByModel: false,
      available: false,
      unavailableReason: null,
    },
    autoCompact: { enabled: true, threshold: 340_000, warningThreshold: 320_000 },
  }
}

const PERMISSION_CONTEXT: PermissionContextSnapshot = {
  mode: 'default',
  alwaysAllowRules: {},
  alwaysDenyRules: {},
  alwaysAskRules: {},
  ruleMetadata: [],
  managedRulesOnly: false,
  permissionClassifierEnabled: false,
  additionalWorkingDirectories: [],
  isBypassPermissionsModeAvailable: false,
}

type Recorded = { models: (string | null)[]; efforts: string[] }

function bar(
  recorded: Recorded,
  over: Partial<ComponentProps<typeof ComposerActionsBar>> = {},
): ReactElement {
  return (
    <ComposerActionsBar
      attachDisabled={false}
      onAttach={() => {}}
      model="gpt-5.6-sol"
      reasoningEffort="high"
      fastMode={false}
      permissionContext={PERMISSION_CONTEXT}
      onSetMode={() => {}}
      account={null}
      contextUsage={null}
      runControls={runControls()}
      onSetModel={value => recorded.models.push(value)}
      onSetEffort={effort => recorded.efforts.push(effort)}
      {...over}
    />
  )
}

async function mountBar(
  recorded: Recorded,
  over: Partial<ComponentProps<typeof ComposerActionsBar>> = {},
): Promise<MountedTree> {
  return harness.mount(bar(recorded, over))
}

function recorder(): Recorded {
  return { models: [], efforts: [] }
}

async function click(element: Element | null | undefined): Promise<void> {
  expect(element).toBeTruthy()
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

// Each test owns one mounted bar; its actual popup may be portalled to body.
function menu(_tree: MountedTree): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[role="menu"][aria-label="Run controls"], [role="menu"][aria-label="Model"], [role="menu"][aria-label="Permission mode"], [role="menu"][aria-label="Accounts"]',
  )
}

function rows(tree: MountedTree): HTMLElement[] {
  return Array.from(
    menu(tree)?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [],
  )
}

function rowNamed(tree: MountedTree, label: string): HTMLElement | undefined {
  return rows(tree).find(row => row.textContent?.startsWith(label))
}

async function openCard(tree: MountedTree): Promise<void> {
  await openEffort(tree)
  await click(menu(tree)?.querySelector('[role="menuitem"][aria-label^="Model: "]'))
}

async function openEffort(tree: MountedTree): Promise<void> {
  await click(tree.container.querySelector('[data-composer-face="run-controls"]'))
}

async function openAccount(tree: MountedTree): Promise<void> {
  await click(tree.container.querySelector('[data-composer-face="account"]'))
}

async function press(
  target: EventTarget,
  key: string,
  init: KeyboardEventInit = {},
): Promise<void> {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key, ...init }),
    )
  })
}

function focused(): Element | null {
  return globalThis.document.activeElement
}

function rungs(tree: MountedTree): HTMLElement[] {
  return rows(tree).filter(row => row.getAttribute('aria-label') !== null)
}

async function openLadder(tree: MountedTree): Promise<void> {
  await openEffort(tree)
  await harness.nextFrame()
  const selected = menu(tree)?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')
  expect(focused()?.getAttribute('aria-label')).toBe('Model: GPT-5.6 Sol')
  for (let index = 0; index <= rows(tree).length && focused() !== selected; index++) {
    await press(focused()!, 'ArrowDown')
  }
  expect(focused() === selected).toBe(true)
}

test('the card opens on a provider-grouped model list, one row per option', async () => {
  const tree = await mountBar(recorder())
  await openCard(tree)

  const panel = menu(tree)
  expect(panel?.getAttribute('aria-label')).toBe('Model')
  // Grouped, so the provider is said ONCE per group instead of on all four rows.
  expect(panel?.textContent).toContain('OpenAI')
  expect(panel?.textContent).toContain('Anthropic')
  expect(rows(tree)).toHaveLength(4)
  expect(rowNamed(tree, 'Opus 5')).toBeTruthy()
  // The Default row names what it currently resolves to, and only because it is
  // the live selection would it ever be able to.
  expect(rowNamed(tree, 'Default (recommended)')?.textContent).not.toContain(
    'GPT-5.6 Sol',
  )
})

test('picking a model returns main and waits for the authoritative effort snapshot', async () => {
  const recorded = recorder()
  const tree = await mountBar(recorded)
  await openCard(tree)
  await click(rowNamed(tree, 'Opus 5'))
  expect(recorded.models).toEqual(['opus'])
  expect(menu(tree)?.getAttribute('aria-label')).toBe('Run controls')
  expect(rungs(tree)).toHaveLength(6)
  expect(menu(tree)?.querySelector('[aria-label="Model: GPT-5.6 Sol"]')).toBeTruthy()
  await act(async () => tree.render(bar(recorded, {
    runControls: {
      ...runControls({ current: 'opus', currentLabel: 'Opus 5', selected: 'opus', provider: 'anthropic' }),
      effort: { current: 'high', selected: 'high', supported: true, options: OPUS_LEVELS },
    },
  })))
  expect(rungs(tree).map(row => row.getAttribute('aria-label'))).toEqual(['Low', 'Medium', 'High', 'Max'])
  expect(menu(tree)?.querySelector('[aria-label="Model: Opus 5"]')).toBeTruthy()
})

for (const interaction of ['focus', 'hover', 'drag'] as const) {
  test(`a shorter model snapshot discards the old effort ${interaction} without losing panel focus`, async () => {
    const recorded = recorder()
    const tree = await mountBar(recorded)
    await openCard(tree)
    await click(rowNamed(tree, 'Opus 5'))
    const ultra = menu(tree)!.querySelector<HTMLButtonElement>('[aria-label="Ultra"]')!
    const rail = ultra.closest<HTMLElement>('.touch-none')!
    if (interaction === 'focus') {
      await act(async () => ultra.focus())
    } else if (interaction === 'hover') {
      await act(async () => ultra.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })))
    } else {
      sizeRail(rail, 240)
      await pointer(rail, 'pointerdown', 226)
    }
    expect(menu(tree)?.textContent).toContain('Ultra')
    await act(async () => tree.render(bar(recorded, {
      runControls: {
        ...runControls({ current: 'opus', currentLabel: 'Opus 5', selected: 'opus', provider: 'anthropic' }),
        effort: { current: 'high', selected: 'high', supported: true, options: OPUS_LEVELS },
      },
    })))
    expect(rungs(tree)).toHaveLength(4)
    expect(menu(tree)?.textContent).toContain('High')
    expect(menu(tree)?.textContent).not.toContain('Ultra')
    expect(focused()?.getAttribute('aria-label')).toBe('Model: Opus 5')
    const newRail = rungs(tree)[0]!.closest<HTMLElement>('.touch-none')!
    await pointer(newRail, 'pointerup', 226)
    expect(recorded.efforts).toEqual([])
  })
}

test('a model change cancels an effort drag even when both models have the same levels', async () => {
  const recorded = recorder()
  const tree = await mountBar(recorded)
  await openLadder(tree)
  const rail = rungs(tree)[0]!.closest<HTMLElement>('.touch-none')!
  sizeRail(rail, 240)
  await pointer(rail, 'pointerdown', 226)
  await act(async () => tree.render(bar(recorded, {
    runControls: runControls({ current: 'gpt-6-sol', currentLabel: 'GPT-6 Sol', selected: 'gpt-6-sol' }),
  })))
  await pointer(rungs(tree)[0]!.closest<HTMLElement>('.touch-none')!, 'pointerup', 226)
  expect(recorded.efforts).toEqual([])
  expect(menu(tree)?.textContent).toContain('High')
})

test('the rail fills up to the chosen level, not just at it', async () => {
  const tree = await mountBar(recorder())
  await openLadder(tree)

  // Session effort is `high`, the third rung: three rungs sit
  // under the fill, and exactly one rung is the checked radio. A fill that stopped
  // marking the lower rungs would read as a position marker instead of a level.
  const filled = rungs(tree).filter(
    rung => rung.getAttribute('data-filled') === 'true',
  )
  expect(filled.map(rung => rung.getAttribute('aria-label'))).toEqual([
    'Low',
    'Medium',
    'High',
  ])
  const checked = rows(tree).filter(
    row => row.getAttribute('aria-checked') === 'true',
  )
  expect(checked).toHaveLength(1)
  expect(checked[0]?.getAttribute('aria-label')).toBe('High')
})

test('a rung writes the effort verb and leaves the card open to show the change', async () => {
  const recorded = recorder()
  const tree = await mountBar(recorded)
  await openLadder(tree)
  const max = rows(tree).find(row => row.getAttribute('aria-label') === 'Max')
  await click(max)

  expect(recorded.efforts).toEqual(['max'])
  // The fill IS the confirmation, so dismissing on select would hide the only
  // feedback this control has.
  expect(menu(tree)).toBeTruthy()
})

test('Auto is a control of its own, not the bottom rung', async () => {
  const recorded = recorder()
  const tree = await mountBar(recorded)
  await openLadder(tree)
  const auto = rows(tree).find(row => row.textContent === 'Auto')
  await click(auto)

  expect(recorded.efforts).toEqual(['auto'])
  expect(auto?.getAttribute('aria-label')).toBeNull()
})

test('a model with no effort levels applies and returns to the main controls', async () => {
  const recorded = recorder()
  const tree = await mountBar(recorded)
  await openCard(tree)
  await click(rowNamed(tree, 'Haiku 4.5'))

  expect(recorded.models).toEqual(['haiku'])
  expect(menu(tree)?.getAttribute('aria-label')).toBe('Run controls')
  await act(async () => tree.render(bar(recorded, {
    runControls: {
      ...runControls({ current: 'haiku', currentLabel: 'Haiku 4.5', selected: 'haiku', provider: 'anthropic' }),
      effort: { current: null, selected: null, supported: false, options: [] },
    },
  })))
  expect(rungs(tree)).toHaveLength(0)
  expect(menu(tree)?.querySelector('[role="switch"]')).toBeNull()
  expect(menu(tree)?.querySelector('[aria-label="Model: Haiku 4.5"]')).toBeTruthy()
})

test('the model back control restores the main model row', async () => {
  const tree = await mountBar(recorder())
  await openCard(tree)
  await click(menu(tree)?.querySelector('[role="menuitem"][aria-label="Back to run controls"]'))
  expect(menu(tree)?.getAttribute('aria-label')).toBe('Run controls')
  expect(focused()?.getAttribute('aria-label')).toBe('Model: GPT-5.6 Sol')
})

test('reopening the controls always lands on main', async () => {
  const tree = await mountBar(recorder())
  await openCard(tree)
  await openEffort(tree)
  await openEffort(tree)
  expect(menu(tree)?.getAttribute('aria-label')).toBe('Run controls')
})

test('a locked cross-provider group is inert and reads as one dimmed block', async () => {
  const recorded = recorder()
  const tree = await mountBar(recorded, {
    runControls: {
      ...runControls({ providerSwitchLocked: true }),
    },
  })
  await openCard(tree)

  const opus = rowNamed(tree, 'Opus 5')
  expect(opus?.hasAttribute('disabled')).toBe(true)
  // The lock is a property of the PROVIDER, so it is stated once, on the group.
  expect(opus?.closest('.opacity-40')).toBeTruthy()
  expect(rowNamed(tree, 'GPT-5.6 Sol')?.closest('.opacity-40')).toBeNull()
  await click(opus)
  expect(recorded.models).toEqual([])
  expect(menu(tree)?.getAttribute('aria-label')).toBe('Model')
})

/* ── keyboard ──────────────────────────────────────────────────────────────
 * The rail is a horizontal control inside a vertical menu, so the two
 * keyboards have to divide the arrows between them: the menu keeps Up/Down
 * (and walks back, Auto, then the rungs), the rail answers Left/Right, and
 * Home/End mean the ends of the SCALE while focus is inside it.
 */

test('arriving on the ladder lands focus on the level already set', async () => {
  const tree = await mountBar(recorder())
  await openLadder(tree)

  // The pick that opened this face unmounted the row that had focus, so
  // without this the whole face would be reachable only by tabbing back in.
  expect(focused()?.getAttribute('aria-label')).toBe('High')
})

test('arriving with no level set lands on Auto, the control that is checked', async () => {
  const tree = await mountBar(recorder(), {
    runControls: {
      ...runControls(),
      effort: { current: null, selected: null, supported: true, options: GPT_LEVELS },
    },
  })
  await openLadder(tree)

  expect(focused()?.textContent).toBe('Auto')
})

test('left and right walk the rail, and stop at its ends', async () => {
  const tree = await mountBar(recorder())
  await openLadder(tree)
  const rail = rungs(tree)

  await press(focused()!, 'ArrowLeft')
  expect(focused()?.getAttribute('aria-label')).toBe('Medium')
  await press(focused()!, 'ArrowRight')
  await press(focused()!, 'ArrowRight')
  expect(focused()?.getAttribute('aria-label')).toBe('Extra high')
  // A scale has ends: arrowing off the top must not wrap round to the bottom
  // the way the menu's own roving does.
  await press(focused()!, 'End')
  await press(focused()!, 'ArrowRight')
  expect(focused() === rail[rail.length - 1]!).toBe(true)
  await press(focused()!, 'Home')
  await press(focused()!, 'ArrowLeft')
  expect(focused() === rail[0]!).toBe(true)
})

test('Home and End mean the ends of the scale while focus is in the rail', async () => {
  const tree = await mountBar(recorder())
  await openLadder(tree)

  await press(focused()!, 'End')
  expect(focused()?.getAttribute('aria-label')).toBe('Ultra')
  await press(focused()!, 'Home')
  expect(focused()?.getAttribute('aria-label')).toBe('Low')
})

test('up and down still walk the whole face, rail included', async () => {
  const tree = await mountBar(recorder())
  await openLadder(tree)

  // The menu's own roving is untouched, so the back control and Auto stay
  // reachable from the rail without a pointer.
  await press(focused()!, 'ArrowUp')
  expect(focused()?.getAttribute('aria-label')).toBe('Medium')
  await press(focused()!, 'ArrowUp')
  await press(focused()!, 'ArrowUp')
  expect(focused()?.textContent).toBe('Auto')
  await press(focused()!, 'ArrowUp')
  expect(focused()?.getAttribute('role')).toBe('menuitem')
})

test('Escape unwinds Model to main and restores its owning row', async () => {
  const tree = await mountBar(recorder())
  await openCard(tree)
  await press(focused()!, 'Escape')
  expect(menu(tree)?.getAttribute('aria-label')).toBe('Run controls')
  expect(focused()?.getAttribute('aria-label')).toBe('Model: GPT-5.6 Sol')
  await press(focused()!, 'Escape')
  expect(menu(tree)).toBeNull()
  expect(focused() === tree.container.querySelector('[data-composer-face="run-controls"]')).toBe(true)
})

test('a rung is activated by the keyboard, not by arrowing onto it', async () => {
  const recorded = recorder()
  const tree = await mountBar(recorded)
  await openLadder(tree)

  await press(focused()!, 'ArrowRight')
  // Moving focus must not write: arrow keys survey the scale, Enter picks. A
  // rail that set effort per keypress would fire a verb per rung crossed.
  expect(recorded.efforts).toEqual([])
  await click(focused())
  expect(recorded.efforts).toEqual(['xhigh'])
})

test('clicking the already-selected rung keeps the run controls open', async () => {
  const tree = await mountBar(recorder())
  await openLadder(tree)

  await click(menu(tree)?.querySelector('[aria-label="High"]'))

  expect(menu(tree)?.getAttribute('aria-label')).toBe('Run controls')
})

test('Escape from the main effort rail closes and restores the trigger', async () => {
  const tree = await mountBar(recorder())
  await openLadder(tree)
  await press(focused()!, 'Escape')
  expect(menu(tree)).toBeNull()
  expect(focused() === tree.container.querySelector('[data-composer-face="run-controls"]')).toBe(true)
})

test('Shift+Tab from a picker row returns focus to the composer', async () => {
  const composer = document.createElement('button')
  const tree = await mountBar(recorder(), {
    onFocusComposer: () => composer.focus(),
  })
  tree.container.prepend(composer)

  await openEffort(tree)
  await harness.nextFrame()
  await press(focused()!, 'Tab', { shiftKey: true })
  await harness.nextFrame()

  expect(menu(tree)).toBeNull()
  expect(focused() === composer).toBe(true)
})

test('opening the model picker focuses the selected model row', async () => {
  const tree = await mountBar(recorder())
  await openCard(tree)
  await harness.nextFrame()

  const selected = menu(tree)?.querySelector(
    '[role="menuitemradio"][aria-checked="true"]',
  ) ?? null
  expect(selected?.textContent).toContain('GPT-5.6 Sol')
  expect(focused() === selected).toBe(true)
})

test('vertical roving reaches the selected effort instead of treating it as Auto', async () => {
  const tree = await mountBar(recorder(), {
    reasoningEffort: 'max',
    runControls: {
      ...runControls(),
      effort: {
        current: 'max',
        selected: 'max',
        supported: true,
        options: GPT_LEVELS,
      },
    },
  })
  await openLadder(tree)

  const selected = menu(tree)?.querySelector(
    '[role="menuitemradio"][aria-checked="true"]',
  ) ?? null
  expect(selected?.getAttribute('aria-label')).toBe('Max')
  expect(focused() === selected).toBe(true)
})

test('the main face keeps the full effort scale and its separate Auto control', async () => {
  const tree = await mountBar(recorder())
  await openEffort(tree)

  expect(menu(tree)?.getAttribute('aria-label')).toBe('Run controls')
  expect(rungs(tree).map(rung => rung.getAttribute('aria-label'))).toEqual([
    'Low',
    'Medium',
    'High',
    'Extra high',
    'Max',
    'Ultra',
  ])
  expect(rows(tree).find(row => row.textContent === 'Auto')).toBeTruthy()
})

test('the effort slider flow tracks filled levels and skips the lowest and Auto', async () => {
  const tree = await mountBar(recorder())
  await openEffort(tree)

  const flowBand = () => menu(tree)?.querySelector('.effort-flow-light-band')
  expect(flowBand()).toBeTruthy()

  await act(async () => {
    await tree.render(
      bar(recorder(), {
        reasoningEffort: 'low',
        runControls: {
          ...runControls(),
          effort: { current: 'low', selected: 'low', supported: true, options: GPT_LEVELS },
        },
      }),
    )
  })
  expect(flowBand()).toBeNull()

  await act(async () => {
    await tree.render(
      bar(recorder(), {
        reasoningEffort: null,
        runControls: {
          ...runControls(),
          effort: { current: 'high', selected: null, supported: true, options: GPT_LEVELS },
        },
      }),
    )
  })
  expect(flowBand()).toBeNull()
})

test('the effort slider flow pass gets shorter at a higher level', async () => {
  const tree = await mountBar(recorder())
  await openEffort(tree)

  const duration = () => {
    const rail = menu(tree)?.querySelector('.effort-flow-clip')?.parentElement
    return Number.parseFloat(rail?.style.getPropertyValue('--effort-flow-duration') ?? '')
  }
  const highDuration = duration()
  await act(async () => {
    await tree.render(
      bar(recorder(), {
        reasoningEffort: 'medium',
        runControls: {
          ...runControls(),
          effort: { current: 'medium', selected: 'medium', supported: true, options: GPT_LEVELS },
        },
      }),
    )
  })
  expect(duration()).toBeGreaterThan(highDuration)
})

test('the main effort rail stays open on changes and re-picks', async () => {
  const recorded = recorder()
  const tree = await mountBar(recorded)
  await openEffort(tree)

  await click(menu(tree)?.querySelector('[aria-label="Max"]'))
  expect(recorded.efforts).toEqual(['max'])
  expect(menu(tree)).toBeTruthy()

  await click(menu(tree)?.querySelector('[aria-label="High"]'))
  expect(recorded.efforts).toEqual(['max', 'high'])
  expect(menu(tree)).toBeTruthy()
})

/** Give the rail a real width so pointer positions map to rungs. */
function sizeRail(rail: HTMLElement, width: number): void {
  rail.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: width, bottom: 28, width, height: 28, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
}

async function pointer(target: Element, type: string, clientX: number): Promise<void> {
  await act(async () => {
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX }),
    )
  })
}

test('dragging along the slider commits once, at the rung it is released on', async () => {
  const recorded = recorder()
  const tree = await mountBar(recorded)
  await openLadder(tree)
  const rail = rungs(tree)[0]!.closest<HTMLElement>('.touch-none')!
  // 240px wide: the ticks run from 14px to 226px, six rungs in total.
  sizeRail(rail, 240)

  await pointer(rail, 'pointerdown', 14)
  await pointer(rail, 'pointermove', 85)
  await pointer(rail, 'pointermove', 226)
  // While held, the fill follows the pointer but nothing has been written.
  expect(recorded.efforts).toEqual([])
  expect(
    rungs(tree).filter(rung => rung.getAttribute('data-filled') === 'true'),
  ).toHaveLength(6)
  await pointer(rail, 'pointerup', 226)

  expect(recorded.efforts).toEqual(['ultra'])
})

test('a drag that returns to the current level writes nothing and keeps the card', async () => {
  const recorded = recorder()
  const tree = await mountBar(recorded)
  await openLadder(tree)
  const rail = rungs(tree)[0]!.closest<HTMLElement>('.touch-none')!
  sizeRail(rail, 240)

  // `high` is the third rung, near 99px.
  await pointer(rail, 'pointerdown', 99)
  await pointer(rail, 'pointermove', 14)
  await pointer(rail, 'pointermove', 99)
  await pointer(rail, 'pointerup', 99)

  expect(recorded.efforts).toEqual([])
  expect(menu(tree)).toBeTruthy()
})

test('opening the account picker focuses the active account row', async () => {
  const active = account({ id: 'acct-active', alias: 'active' })
  const tree = await mountBar(recorder(), {
    account: active,
    accounts: [
      active,
      account({
        id: 'acct-next',
        alias: 'next',
        isDefault: false,
        switchable: true,
      }),
    ],
    onSwitchAccount: () => {},
  })
  await openAccount(tree)
  await harness.nextFrame()

  const selected = menu(tree)?.querySelector(
    '[role="menuitem"][aria-current="true"]',
  ) ?? null
  expect(selected?.textContent).toContain('active')
  expect(focused() === selected).toBe(true)
})

test('the main fast switch participates in roving and writes without closing', async () => {
  const fast: boolean[] = []
  const tree = await mountBar(recorder(), {
    runControls: {
      ...runControls(),
      fast: { active: false, supportedByModel: true, available: true, unavailableReason: null },
    },
    onSetFast: value => fast.push(value),
  })
  await openEffort(tree)
  expect(focused()?.getAttribute('aria-label')).toBe('Model: GPT-5.6 Sol')
  const toggle = menu(tree)?.querySelector<HTMLElement>('[role="switch"][aria-label="Fast mode"]')
  expect(toggle?.getAttribute('aria-checked')).toBe('false')
  const visited = new Set<Element | null>()
  for (let index = 0; index < 12; index++) {
    visited.add(focused())
    await press(focused()!, 'ArrowDown')
  }
  expect(visited.has(toggle ?? null)).toBe(true)
  await click(toggle)
  expect(fast).toEqual([true])
  expect(menu(tree)?.getAttribute('aria-label')).toBe('Run controls')
})

test('unavailable fast remains a disabled switch with the actual reason on its row', async () => {
  const fast: boolean[] = []
  const tree = await mountBar(recorder(), {
    runControls: {
      ...runControls(),
      fast: {
        active: false,
        supportedByModel: true,
        available: false,
        unavailableReason: 'Fast mode requires a paid subscription',
      },
    },
    onSetFast: value => fast.push(value),
  })
  await openEffort(tree)
  const toggle = menu(tree)?.querySelector('[role="switch"][aria-label="Fast mode"]')
  expect(toggle?.hasAttribute('disabled')).toBe(true)
  expect(toggle?.closest('[title]')?.getAttribute('title')).toBe('Fast mode requires a paid subscription')
  await click(toggle)
  expect(fast).toEqual([])
})

test('an active but unavailable fast switch can still be turned off', async () => {
  const fast: boolean[] = []
  const tree = await mountBar(recorder(), {
    runControls: {
      ...runControls(),
      fast: {
        active: true, supportedByModel: true, available: false,
        unavailableReason: 'Fast mode requires a paid subscription',
      },
    },
    onSetFast: value => fast.push(value),
  })
  await openEffort(tree)
  const toggle = menu(tree)?.querySelector('[role="switch"][aria-label="Fast mode"]')
  expect(toggle?.getAttribute('aria-checked')).toBe('true')
  expect(toggle?.hasAttribute('disabled')).toBe(false)
  await click(toggle)
  expect(fast).toEqual([false])
})

test('losing the live control seam closes an open subface and leaves only retained values', async () => {
  const recorded = recorder()
  const tree = await mountBar(recorded)
  await openCard(tree)
  await act(async () => tree.render(bar(recorded, {
    runControls: null,
    permissionContext: null,
    readOnlyRunControls: runControls(),
    permissionModeReadOnly: 'auto',
  })))
  expect(menu(tree)).toBeNull()
  expect(tree.container.querySelector('[data-composer-face="run-controls"]')).toBeNull()
  expect(tree.container.querySelector('.composer-run-face')?.getAttribute('aria-label')).toContain('Model: GPT-5.6 Sol')
  expect(recorded.models).toEqual([])
})
