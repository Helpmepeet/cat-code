import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import { TabBar, type TabModel } from './TabBar.js'
import { tabLabel } from './tabBarModel.js'
import type { TabVisualState } from './tabStatus.js'

function descriptor(
  id: string,
  overrides: Partial<SessionDescriptor> = {},
): SessionDescriptor {
  return {
    appSessionId: id,
    engineSessionId: `engine-${id}`,
    cwd: `/tmp/${id}`,
    title: null,
    titleUpdatedAt: null,
    status: 'ready',
    restorable: false,
    createdAt: 0,
    lastAttachedAt: 0,
    lastMessageSentAt: null,
    ...overrides,
  }
}

function tab(
  id: string,
  visual: Partial<TabVisualState> = {},
  descriptorOverrides: Partial<SessionDescriptor> = {},
): TabModel {
  return {
    descriptor: descriptor(id, descriptorOverrides),
    visual: {
      label: 'ready',
      tone: 'live',
      restartable: false,
      needsAttention: false,
      ...visual,
    },
  }
}

const noop = () => {}

function render(tabs: TabModel[], activeSessionId: string | null): string {
  return renderToStaticMarkup(
    <TabBar
      tabs={tabs}
      activeSessionId={activeSessionId}
      onSelect={noop}
      onClose={noop}
      onRestart={noop}
      onNewTab={noop}
    />,
  )
}

test('renders the tablist chrome and a new-session affordance', () => {
  const html = render([tab('a')], 'a')
  expect(html).toContain('role="tablist"')
  expect(html).toContain('aria-label="New session"')
  expect(html).toContain('⌘T')
})

test('renders one tab per session with its label', () => {
  const html = render(
    [
      tab('a', {}, { title: 'Alpha' }),
      tab('b', {}, { cwd: '/tmp/beta-project' }),
    ],
    'a',
  )
  expect(html).toContain('Alpha')
  // Title-less tab falls back to the cwd basename.
  expect(html).toContain('beta-project')
})

test('the active tab is marked selected and carries the accent underline', () => {
  const html = render([tab('a'), tab('b')], 'b')
  // Two tabs; the active one is aria-selected true.
  expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
  expect(html).toContain('bg-accent')
})

test('roving tabindex: only the active tab is in the tab order', () => {
  const html = render([tab('a'), tab('b'), tab('c')], 'b')
  // Exactly one tab is tabbable (tabindex 0); the rest are reachable only via
  // arrow keys (tabindex -1). This is the ARIA tablist contract S2 restored.
  const order = [...html.matchAll(/role="tab"[^>]*?tabindex="(-?\d)"/g)].map(
    match => match[1],
  )
  expect(order).toEqual(['-1', '0', '-1'])
})

test('roving tabindex falls back to the first tab when nothing is active', () => {
  const html = render([tab('a'), tab('b')], null)
  // With no active tab, the first tab stays keyboard-reachable so the tablist
  // is never a focus dead-end.
  const order = [...html.matchAll(/role="tab"[^>]*?tabindex="(-?\d)"/g)].map(
    match => match[1],
  )
  expect(order).toEqual(['0', '-1'])
})

test('a non-nominal status shows its chip; a plain ready tab does not', () => {
  const html = render(
    [
      tab('a', { label: 'ready', tone: 'live' }),
      tab('b', { label: 'exited', tone: 'dead', restartable: true }),
    ],
    'a',
  )
  expect(html).toContain('exited')
  // The healthy active tab shows the quiet dot, not a "ready" text chip.
  expect(html).not.toContain('>ready<')
})

test('a restartable (dead) tab renders the restart affordance', () => {
  const html = render(
    [tab('a', { label: 'exited', tone: 'dead', restartable: true })],
    'a',
  )
  expect(html).toContain('restart')
  expect(html).toContain('aria-label="Restart session')
})

test('a background permission raises a visible attention badge on the tab', () => {
  const html = render(
    [tab('a', { needsAttention: true }, { title: 'busy-bg' })],
    'other',
  )
  expect(html).toContain('Permission request waiting')
  expect(html).toContain('animate-ping')
})

test('every tab exposes a close affordance', () => {
  const html = render([tab('a'), tab('b')], 'a')
  expect(html.match(/aria-label="Close session/g)).toHaveLength(2)
})

test('the active tab exposes a session-actions ⋯ only when wired', () => {
  // P4-6b: the ⋯ overflow (host for the MetadataInspector) renders on the active
  // tab exactly once, and only when App wires `onOpenActions`.
  const wired = renderToStaticMarkup(
    <TabBar
      tabs={[tab('a'), tab('b')]}
      activeSessionId="a"
      onSelect={noop}
      onClose={noop}
      onRestart={noop}
      onNewTab={noop}
      onOpenActions={noop}
    />,
  )
  expect(wired.match(/aria-label="Session actions for/g)).toHaveLength(1)
  expect(wired).toContain('title="Session actions"')
})

test('no session-actions ⋯ renders when the TabBar is not wired for it', () => {
  // The default `render` helper omits `onOpenActions` — the affordance is absent,
  // keeping the additive prop from leaking into unrelated tabs.
  const html = render([tab('a'), tab('b')], 'a')
  expect(html).not.toContain('Session actions for')
})

test('the first nine tabs advertise a ⌘<n> jump hint', () => {
  const html = render([tab('a'), tab('b')], 'a')
  expect(html).toContain('⌘1')
  expect(html).toContain('⌘2')
})

test('tabLabel prefers title, falls back to cwd basename, then a default', () => {
  expect(tabLabel(descriptor('a', { title: 'My Session' }))).toBe('My Session')
  expect(tabLabel(descriptor('a', { cwd: '/home/user/proj' }))).toBe('proj')
  expect(tabLabel(descriptor('a', { cwd: '/', title: null }))).toBe(
    'New session',
  )
})
