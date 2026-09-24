import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { WelcomeScreen } from './WelcomeScreen.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })

test('the empty-session branch picker reads Git, names the current branch, and switches selection', async () => {
  const chosen: string[] = []
  const tree = await harness.mount(
    <WelcomeScreen
      variant="session"
      cwd="/work/cat-code"
      branch="stale-branch"
      accounts={null}
      onListBranches={async () => ({ ok: true, value: { current: 'main', branches: ['feature/login', 'main'], dirty: false } })}
      onSwitchBranch={async branch => { chosen.push(branch); return null }}
    />,
  )

  const trigger = tree.container.querySelector<HTMLButtonElement>('[aria-label^="Choose Git branch"]')!
  expect(trigger.textContent).toContain('main')
  expect(trigger.textContent).not.toContain('stale-branch')
  await act(async () => trigger.click())
  const items = [...tree.container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
  expect(items.map(item => item.textContent?.trim())).toEqual(['feature/login', 'main✓'])
  expect(items[1]?.getAttribute('aria-checked')).toBe('true')
  await act(async () => items[0]?.click())
  expect(chosen).toEqual(['feature/login'])
})

test('a failed switch leaves the picker open with a reason', async () => {
  const tree = await harness.mount(
    <WelcomeScreen
      variant="session"
      cwd="/work/cat-code"
      branch="main"
      accounts={null}
      onListBranches={async () => ({ ok: true, value: { current: 'main', branches: ['feature/login', 'main'], dirty: true } })}
      onSwitchBranch={async () => 'Commit or stash local changes before switching branches.'}
    />,
  )
  await act(async () => tree.container.querySelector<HTMLButtonElement>('[aria-label^="Choose Git branch"]')?.click())
  expect(tree.container.textContent).toContain('Commit or stash local changes before switching.')
  await act(async () => tree.container.querySelector<HTMLButtonElement>('[role="menuitemradio"]')?.click())
  expect(tree.container.querySelector('[role="menu"]')).not.toBeNull()
  expect(tree.container.textContent).toContain('Commit or stash local changes')
})

test('opening the picker refreshes an externally changed branch before selection', async () => {
  let current = 'main'
  const chosen: string[] = []
  const tree = await harness.mount(
    <WelcomeScreen
      variant="session"
      cwd="/work/cat-code"
      branch="main"
      accounts={null}
      onListBranches={async () => ({ ok: true, value: { current, branches: ['feature/login', 'main'], dirty: false } })}
      onSwitchBranch={async branch => { chosen.push(branch); return null }}
    />,
  )
  const trigger = tree.container.querySelector<HTMLButtonElement>('[aria-label^="Choose Git branch"]')!
  expect(trigger.textContent).toContain('main')
  current = 'feature/login'
  await act(async () => trigger.click())
  expect(trigger.textContent).toContain('feature/login')
  expect(tree.container.querySelector('[aria-checked="true"]')?.textContent).toContain('feature/login')
  expect(tree.container.textContent).toContain('This chat started on main')
  await act(async () => tree.container.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.click())
  expect(chosen).toEqual(['feature/login'])
})
