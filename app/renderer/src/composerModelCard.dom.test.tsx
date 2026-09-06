/**
 * The composer's model card, driven for real.
 *
 * `ComposerActionsBar.test.tsx` is a `renderToStaticMarkup` suite and the card's
 * panel only mounts on client open-state, so every fact below was previously
 * unreachable: the card is TWO faces now, and which face you are on is the
 * outcome of a click. Mounted here instead, where the popover can actually be
 * opened and a row can actually be picked.
 *
 * What this protects, in one sentence: picking a model must apply it AND land
 * you on that model's effort ladder, except for a model that has no ladder, where
 * the pick is the whole interaction and the card dismisses.
 */

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import type { ComponentProps, ReactElement } from 'react'

import { ComposerActionsBar } from './ComposerActionsBar.js'
import { createDomTestHarness } from './domTestHarness.js'
import type { DomTestHarness, MountedTree } from './domTestHarness.js'
import type {
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

function menu(tree: MountedTree): HTMLElement | null {
  return tree.container.querySelector<HTMLElement>('[role="menu"]')
}

function rows(tree: MountedTree): HTMLElement[] {
  return Array.from(
    tree.container.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
  )
}

function rowNamed(tree: MountedTree, label: string): HTMLElement | undefined {
  return rows(tree).find(row => row.textContent?.startsWith(label))
}

async function openCard(tree: MountedTree): Promise<void> {
  await click(tree.container.querySelector('[data-composer-face="model"]'))
}

async function press(target: EventTarget, key: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key }))
  })
}

function focused(): Element | null {
  return globalThis.document.activeElement
}

function rungs(tree: MountedTree): HTMLElement[] {
  return rows(tree).filter(row => row.getAttribute('aria-label') !== null)
}

async function openLadder(tree: MountedTree, model = 'Opus 5'): Promise<void> {
  await openCard(tree)
  await click(rowNamed(tree, model))
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

test("picking a model applies it and lands on that model's own effort ladder", async () => {
  const recorded = recorder()
  const tree = await mountBar(recorded)
  await openCard(tree)
  await click(rowNamed(tree, 'Opus 5'))

  expect(recorded.models).toEqual(['opus'])
  const panel = menu(tree)
  expect(panel?.getAttribute('aria-label')).toBe('Reasoning effort')
  // The ladder is the PICKED row's, not the session's: Opus has four levels
  // where the current model has six, and the face is correct in this frame —
  // before the sidecar's re-broadcast could have arrived.
  const rungs = rows(tree).filter(row => row.getAttribute('aria-label') !== null)
  expect(rungs.map(rung => rung.getAttribute('aria-label'))).toEqual([
    'Low',
    'Medium',
    'High',
    'Max',
  ])
  expect(panel?.textContent).toContain('Opus 5')
})

test('the rail fills up to the chosen level, not just at it', async () => {
  const tree = await mountBar(recorder())
  await openCard(tree)
  await click(rowNamed(tree, 'Opus 5'))

  // Session effort is `high`, the third of Opus's four rungs: three bars carry
  // the tone, and exactly one rung is the checked radio. A fill that stopped
  // marking the lower rungs would read as a position marker instead of a level.
  const filled = tree.container.querySelectorAll('span.bg-tone-warn')
  expect(filled).toHaveLength(3)
  const checked = rows(tree).filter(
    row => row.getAttribute('aria-checked') === 'true',
  )
  expect(checked).toHaveLength(1)
  expect(checked[0]?.getAttribute('aria-label')).toBe('High')
})

test('a rung writes the effort verb and leaves the card open to show the change', async () => {
  const recorded = recorder()
  const tree = await mountBar(recorded)
  await openCard(tree)
  await click(rowNamed(tree, 'Opus 5'))
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
  await openCard(tree)
  await click(rowNamed(tree, 'Opus 5'))
  const auto = rows(tree).find(row => row.textContent === 'Auto')
  await click(auto)

  expect(recorded.efforts).toEqual(['auto'])
  expect(auto?.getAttribute('aria-label')).toBeNull()
})

test('a model with no effort levels applies and dismisses, with no second face', async () => {
  const recorded = recorder()
  const tree = await mountBar(recorded)
  await openCard(tree)
  await click(rowNamed(tree, 'Haiku 4.5'))

  expect(recorded.models).toEqual(['haiku'])
  // Haiku takes no effort parameter at all, so there is nothing to advance to.
  expect(menu(tree)).toBeNull()
})

test('the back control returns to the model list', async () => {
  const tree = await mountBar(recorder())
  await openCard(tree)
  await click(rowNamed(tree, 'Opus 5'))
  await click(tree.container.querySelector('[role="menuitem"]'))

  expect(menu(tree)?.getAttribute('aria-label')).toBe('Model')
  expect(rows(tree)).toHaveLength(4)
})

test('reopening the card lands on the model list, never on the last ladder', async () => {
  const tree = await mountBar(recorder())
  await openCard(tree)
  await click(rowNamed(tree, 'Opus 5'))
  await openCard(tree)
  await openCard(tree)

  expect(menu(tree)?.getAttribute('aria-label')).toBe('Model')
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
  expect(focused()?.getAttribute('aria-label')).toBe('Max')
  // A scale has ends: arrowing off the top must not wrap round to the bottom
  // the way the menu's own roving does.
  await press(focused()!, 'ArrowRight')
  expect(focused()).toBe(rail[rail.length - 1]!)
  await press(focused()!, 'Home')
  await press(focused()!, 'ArrowLeft')
  expect(focused()).toBe(rail[0]!)
})

test('Home and End mean the ends of the scale while focus is in the rail', async () => {
  const tree = await mountBar(recorder())
  await openLadder(tree)

  await press(focused()!, 'End')
  expect(focused()?.getAttribute('aria-label')).toBe('Max')
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

test('going back returns focus to the row that was picked', async () => {
  const recorded = recorder()
  const tree = await mountBar(recorded)
  await openLadder(tree)
  // The sidecar's re-broadcast, which is what makes the picked row the checked
  // one. Without it the fixture still names the old selection, and the row this
  // face was opened from would not be the row focus goes back to.
  await act(async () => {
    await tree.render(
      bar(recorded, {
        runControls: { ...runControls({ selected: 'opus' }) },
      }),
    )
  })
  await click(tree.container.querySelector('[role="menuitem"]'))

  // Leaving the face unmounts the focused button; dropping focus on <body>
  // would strand a keyboard user in a menu that is still open.
  expect(focused()?.textContent).toContain('Opus 5')
  expect(focused()?.getAttribute('aria-checked')).toBe('true')
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
  expect(recorded.efforts).toEqual(['max'])
})

test('Escape leaves the ladder first, and only then the card', async () => {
  const tree = await mountBar(recorder())
  await openLadder(tree)

  await press(focused()!, 'Escape')
  // One level at a time, the way a submenu unwinds — stepping into a ladder and
  // changing your mind should not cost the card.
  expect(menu(tree)?.getAttribute('aria-label')).toBe('Model')
  await press(focused() ?? tree.container, 'Escape')
  expect(menu(tree)).toBeNull()
})
