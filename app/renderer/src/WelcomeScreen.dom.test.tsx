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
  expect(items.map(item => item.textContent?.trim())).toEqual(['main✓', 'feature/login'])
  expect(items[0]?.getAttribute('aria-checked')).toBe('true')
  await act(async () => items[1]?.click())
  expect(chosen).toEqual(['feature/login'])
})

test('a dirty checkout disables other branches and shows its blocker once above the list', async () => {
  let attempts = 0
  const tree = await harness.mount(
    <WelcomeScreen
      variant="session"
      cwd="/work/cat-code"
      branch="main"
      accounts={null}
      onListBranches={async () => ({ ok: true, value: { current: 'main', branches: ['feature/login', 'main'], dirty: true } })}
      onSwitchBranch={async () => { attempts++; return 'Commit or stash local changes before switching branches.' }}
    />,
  )
  await act(async () => tree.container.querySelector<HTMLButtonElement>('[aria-label^="Choose Git branch"]')?.click())
  expect(tree.container.textContent).toContain('Commit or stash local changes before switching.')
  const other = tree.container.querySelector<HTMLButtonElement>('[aria-checked="false"]')!
  expect(other.disabled).toBe(true)
  await act(async () => other.click())
  expect(attempts).toBe(0)
  expect(tree.container.querySelector('[role="menu"]')).not.toBeNull()
  expect(tree.container.textContent).toContain('Commit or stash local changes')
  expect(tree.container.querySelectorAll('.branch-picker-heading').length).toBe(1)
  expect(tree.container.querySelector('.branch-picker-scroll')?.textContent).not.toContain('Commit or stash')
  expect(tree.container.textContent).not.toContain('Switching closes')
  await act(async () => tree.container.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.click())
  expect(tree.container.querySelector('[role="menu"]')).toBeNull()
})

test('a refused switch keeps the real current branch on the trigger', async () => {
  const tree = await harness.mount(
    <WelcomeScreen
      variant="session"
      cwd="/work/cat-code"
      branch="main"
      accounts={null}
      onListBranches={async () => ({ ok: true, value: { current: 'main', branches: ['feature/login', 'main'], dirty: false } })}
      onSwitchBranch={async () => 'A local file would be overwritten by that branch. Move it before switching.'}
    />,
  )
  const trigger = tree.container.querySelector<HTMLButtonElement>('[aria-label^="Choose Git branch"]')!
  await act(async () => trigger.click())
  await act(async () => tree.container.querySelector<HTMLButtonElement>('[aria-checked="false"]')?.click())
  expect(tree.container.querySelector('[role="menu"]')?.textContent).toContain('A local file would be overwritten')
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(tree.container.querySelector('[role="menu"]')?.textContent).toContain('A local file would be overwritten')
  expect(trigger.textContent).toContain('main')
  expect(trigger.textContent).not.toContain('Unavailable')
  expect(trigger.getAttribute('aria-label')).toBe('Choose Git branch. Current branch: main')
  expect(tree.container.querySelector('[aria-checked="true"]')?.textContent).toContain('main')
})

test('a branch list that fails to load shows Unavailable on the trigger and the reason in the menu', async () => {
  const rejected = await harness.mount(
    <WelcomeScreen
      variant="session"
      cwd="/work/cat-code"
      branch="main"
      accounts={null}
      onListBranches={async () => { throw new Error('boom') }}
      onSwitchBranch={async () => null}
    />,
  )
  const rejectedTrigger = rejected.container.querySelector<HTMLButtonElement>('[aria-label^="Choose Git branch"]')!
  await act(async () => rejectedTrigger.click())
  expect(rejectedTrigger.textContent).toContain('Unavailable')
  expect(rejected.container.querySelector('[role="menu"]')?.textContent).toContain('Could not read branches for this project.')

  const refused = await harness.mount(
    <WelcomeScreen
      variant="session"
      cwd="/work/cat-code"
      branch="main"
      accounts={null}
      onListBranches={async () => ({ ok: false, error: { code: 'invalid_cwd', message: 'Not a Git repository.' } })}
      onSwitchBranch={async () => null}
    />,
  )
  const refusedTrigger = refused.container.querySelector<HTMLButtonElement>('[aria-label^="Choose Git branch"]')!
  await act(async () => refusedTrigger.click())
  expect(refusedTrigger.textContent).toContain('Unavailable')
  expect(refused.container.querySelector('[role="menu"]')?.textContent).toContain('Not a Git repository.')
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

test('the branch menu escapes the welcome scroller and flips above near the window edge', async () => {
  const tree = await harness.mount(
    <WelcomeScreen
      variant="session"
      cwd="/work/cat-code"
      branch="main"
      accounts={null}
      onListBranches={async () => ({ ok: true, value: { current: 'main', branches: ['feature/login', 'main'], dirty: false } })}
      onSwitchBranch={async () => null}
    />,
  )
  const trigger = tree.container.querySelector<HTMLButtonElement>('[aria-label^="Choose Git branch"]')!
  let anchorTop = window.innerHeight - 90
  let triggerRight = 430
  trigger.getBoundingClientRect = () => ({
    x: 350, y: anchorTop, left: 350, right: triggerRight,
    top: anchorTop, bottom: anchorTop + 30,
    width: triggerRight - 350, height: 30, toJSON: () => ({}),
  })
  trigger.parentElement!.getBoundingClientRect = trigger.getBoundingClientRect
  await act(async () => trigger.click())
  const menu = tree.container.querySelector<HTMLElement>('[role="menu"]')!
  expect(menu.classList.contains('fixed')).toBe(true)
  expect(Number.parseFloat(menu.style.getPropertyValue('--branch-menu-top'))).toBeLessThan(anchorTop)
  expect(Number.parseFloat(menu.style.getPropertyValue('--branch-menu-height'))).toBeGreaterThan(0)
  const left = menu.style.getPropertyValue('--branch-menu-left')
  triggerRight = 600
  anchorTop = 70
  await act(async () => { document.dispatchEvent(new Event('scroll')) })
  expect(menu.style.getPropertyValue('--branch-menu-top')).toBe('106px')
  expect(Number.parseFloat(menu.style.getPropertyValue('--branch-menu-height'))).toBe(320)
  expect(menu.style.getPropertyValue('--branch-menu-left')).toBe(left)
})

test('known branch survives first read, focus refresh and menu close without another read', async () => {
  let finish: ((value: { ok: true; value: { current: string; branches: string[]; dirty: boolean } }) => void) | undefined
  let calls = 0
  const list = () => {
    calls++
    return new Promise<{ ok: true; value: { current: string; branches: string[]; dirty: boolean } }>(resolve => { finish = resolve })
  }
  const tree = await harness.mount(<WelcomeScreen variant="session" cwd="/work/repo" branch="main" accounts={null} onListBranches={list} onSwitchBranch={async () => null} />)
  const trigger = tree.container.querySelector<HTMLButtonElement>('[aria-label^="Choose Git branch"]')!
  expect(trigger.textContent).toContain('main')
  await act(async () => finish?.({ ok: true, value: { current: 'feature/login', branches: ['main', 'feature/login'], dirty: false } }))
  await act(async () => trigger.click())
  expect(trigger.textContent).toContain('feature/login')
  await act(async () => finish?.({ ok: true, value: { current: 'feature/login', branches: ['main', 'feature/login'], dirty: false } }))
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(trigger.textContent).not.toContain('Checking')
  expect(trigger.textContent).toContain('feature/login')
  const beforeClose = calls
  await act(async () => trigger.click())
  expect(calls).toBe(beforeClose)
})

test('many branches filter with keyboard selection and keep recency order after current', async () => {
  const chosen: string[] = []
  const names = ['recent', 'main', ...Array.from({ length: 9 }, (_, i) => `older-${i}`)]
  const tree = await harness.mount(<WelcomeScreen variant="session" cwd="/work/repo" branch="main" accounts={null} onListBranches={async () => ({ ok: true, value: { current: 'main', branches: names, dirty: false } })} onSwitchBranch={async name => { chosen.push(name); return null }} />)
  await act(async () => tree.container.querySelector<HTMLButtonElement>('[aria-label^="Choose Git branch"]')!.click())
  const input = tree.container.querySelector<HTMLInputElement>('input[aria-label="Filter branches"]')!
  expect(document.activeElement === input).toBe(true)
  expect([...tree.container.querySelectorAll('[role="menuitemradio"]')].slice(0, 3).map(row => row.textContent)).toEqual(['main✓', 'recent', 'older-0'])
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'recent')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(tree.container.querySelectorAll('[role="menuitemradio"]').length).toBe(1)
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  expect((document.activeElement as HTMLElement)?.textContent).toBe('recent')
  await act(async () => {
    input.focus()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  expect(chosen).toEqual(['recent'])
})

test('named live-chat blockers focus that chat and worktree occupancy disables only its branch', async () => {
  const focused: string[] = []
  const tree = await harness.mount(<WelcomeScreen variant="session" cwd="/work/repo" branch="main" accounts={null} onListBranches={async () => ({ ok: true, value: { current: 'main', branches: ['held', 'main', 'free'], dirty: false, occupied: { held: 'branchlab-wt' }, otherChats: [{ appSessionId: 'other', title: 'Fix login flow' }] } })} onSwitchBranch={async () => null} onFocusBranchChat={id => focused.push(id)} />)
  await act(async () => tree.container.querySelector<HTMLButtonElement>('[aria-label^="Choose Git branch"]')!.click())
  expect(tree.container.querySelector('.branch-picker-heading')?.textContent).toBe('Close Fix login flow to switch.')
  expect([...tree.container.querySelectorAll<HTMLButtonElement>('[aria-checked="false"]')].every(row => row.disabled)).toBe(true)
  await act(async () => tree.container.querySelector<HTMLButtonElement>('.branch-picker-chat-link')!.click())
  expect(focused).toEqual(['other'])
  const occupied = await harness.mount(<WelcomeScreen variant="session" cwd="/work/repo" branch="main" accounts={null} onListBranches={async () => ({ ok: true, value: { current: 'main', branches: ['held', 'main', 'free'], dirty: false, occupied: { held: 'branchlab-wt' } } })} onSwitchBranch={async () => null} />)
  await act(async () => occupied.container.querySelector<HTMLButtonElement>('[aria-label^="Choose Git branch"]')!.click())
  const rows = [...occupied.container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
  expect(rows.find(row => row.textContent?.startsWith('held'))?.disabled).toBe(true)
  expect(rows.find(row => row.textContent === 'free')?.disabled).toBe(false)
  expect(occupied.container.querySelector('.branch-picker-occupant')?.textContent).toBe('branchlab-wt')
})

test('switch handoff shows the target dimmed, and detached HEAD shows its commit', async () => {
  let finish: ((message: string | null) => void) | undefined
  const tree = await harness.mount(<WelcomeScreen variant="session" cwd="/work/repo" branch="main" accounts={null} onListBranches={async () => ({ ok: true, value: { current: 'main', branches: ['main', 'feature/login'], dirty: false } })} onSwitchBranch={() => new Promise(resolve => { finish = resolve })} />)
  const trigger = tree.container.querySelector<HTMLButtonElement>('[aria-label^="Choose Git branch"]')!
  await act(async () => trigger.click())
  await act(async () => tree.container.querySelector<HTMLButtonElement>('[aria-checked="false"]')!.click())
  expect(trigger.textContent).toContain('feature/login')
  expect(trigger.disabled).toBe(true)
  expect(trigger.querySelector('.opacity-50')).not.toBeNull()
  await act(async () => finish?.('Try again.'))
  expect(trigger.textContent).toContain('main')
  const detached = await harness.mount(<WelcomeScreen variant="session" cwd="/work/repo" branch={null} accounts={null} onListBranches={async () => ({ ok: true, value: { current: null, branches: ['main'], dirty: false, detached: 'abcdef1' } })} onSwitchBranch={async () => null} />)
  expect(detached.container.querySelector('[aria-label^="Choose Git branch"]')?.textContent).toContain('abcdef1')
})
