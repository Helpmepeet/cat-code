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
    forked: false,
    titleUpdatedAt: null,
    status: 'ready',
    restorable: false,
    parked: false,
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

test('forked tabs show the split glyph before the title and qualify the accessible name', () => {
  const html = render(
    [tab('fork', {}, { title: 'Renderer notes', forked: true })],
    'fork',
  )
  expect(html).toContain('width="14" height="14"')
  expect(html).toContain('stroke-width="1.9"')
  expect(html).toContain('<path d="M3 12h5"></path>')
  expect(html.indexOf('M3 12h5')).toBeLessThan(
    html.indexOf('>Renderer notes</span>'),
  )
  expect(html).toContain(
    'aria-label="Session Renderer notes, ready, forked session"',
  )
  expect(html).toContain('title="/tmp/fork (forked session)')
  expect(html).not.toContain('(fork)')
})

test('ordinary tabs have no fork split glyph or fork identity qualifier', () => {
  const html = render([tab('ordinary', {}, { title: 'Ordinary session' })], 'ordinary')
  expect(html).not.toContain('<path d="M3 12h5"></path>')
  expect(html).not.toContain('forked session')
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

test('no status word is printed on a tab, whatever the status', () => {
  const html = render(
    [
      tab('a', { label: 'ready', tone: 'live' }),
      tab('b', { label: 'disconnected', tone: 'dead', restartable: true }),
    ],
    'a',
  )
  // The tone dot is the whole visual signal; the word survives only inside the
  // tab's accessible name.
  expect(html).not.toContain('>disconnected<')
  expect(html).not.toContain('>ready<')
  expect(html).toContain('bg-tone-danger')
  expect(html).toContain('aria-label="Session b, disconnected"')
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

test('no tab carries Orchestrator-mode chrome', () => {
  // The mode switch was removed from the tab: a tab names a session, and the
  // mode belongs to the surfaces that own it (the empty-state reflect and the
  // footer strip), not to every tab in the bar.
  const html = render([tab('a'), tab('b')], 'a')
  expect(html).not.toContain('Orchestrator')
  expect(html).not.toContain('aria-pressed=')
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

test('a previewed tab shows its title alone, never the word preview', () => {
  // A bar of previewed tabs used to read as PREVIEW PREVIEW PREVIEW: the status
  // word out-shouted the session names it was only qualifying.
  const html = render(
    [tab('a', { label: 'preview', tone: 'busy' }, { title: 'say hi' })],
    null,
  )

  expect(html).toContain('say hi')
  expect(html).not.toContain('>preview<')
  // The title carries the tab, at the subtle token rather than the ghost one.
  expect(html).toContain('text-text-subtle')
})

test('the hidden close button reserves no width until the tab is hovered', () => {
  // `opacity-0` alone does not free layout: the invisible × used to hold 18px on
  // every tab, narrowing the very title it was hidden to protect.
  const html = render([tab('a')], 'a')

  expect(html).toContain('w-0')
  expect(html).toContain('group-hover:w-[18px]')
  expect(html).toContain('focus-visible:w-[18px]') // still keyboard-reachable
})

test('tabs grow into spare bar width but never shrink below the crowded case', () => {
  const html = render([tab('a'), tab('b')], 'a')

  expect(html).toContain('grow')
  expect(html).toContain('shrink-0') // crowded behaviour unchanged: scroll, not squeeze
  expect(html).toContain('max-w-[176px]')
})

test('the bar is the window drag region and every control opts out of it', () => {
  // With `titleBarStyle: 'hiddenInset'` there is no OS strip left to drag the
  // window by, so the bar carries `drag`. The failure this guards is invisible
  // headlessly and total in the app: a control that forgets `no-drag` cannot be
  // clicked at all, because the OS takes the press as a window move.
  const html = renderToStaticMarkup(
    <TabBar
      tabs={[tab('a')]}
      activeSessionId="a"
      onSelect={noop}
      onClose={noop}
      onRestart={noop}
      onNewTab={noop}
      onAddPanel={noop}
      canAddPanel
    />,
  )

  expect(html).toContain('[-webkit-app-region:drag]')
  // One region declared, then cleared on the tab, the new-session button and
  // the split cluster.
  expect(html.match(/\[-webkit-app-region:no-drag\]/g)).toHaveLength(3)
})

test('the bar reserves the well the traffic lights are drawn into', () => {
  // 84 = the 12px `trafficLightPosition` inset in `main.ts` + 52px of buttons +
  // clearance. The lights paint above the page, so anything here is covered.
  const html = render([tab('a')], 'a')

  expect(html).toContain('w-[84px]')
  expect(html.indexOf('w-[84px]')).toBeLessThan(html.indexOf('role="tab"'))
})
