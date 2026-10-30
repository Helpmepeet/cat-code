import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import type { SessionId } from '../../shared/protocol.js'
import { SessionWorkMarksContext, type SessionWorkMark } from './sessionWorkState.js'
import { TabBar, type TabModel } from './TabBar.js'
import { tabLabel } from './tabBarModel.js'
import type { TabVisualState } from './tabStatus.js'
import { sessionDescriptor as descriptor } from './sessionDescriptorFixture.js'

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
      tab('chat', {}, {
        cwd: '/managed/storage-id', title: null,
        binding: { kind: 'managed', storageRootId: 'root', storageId: 'storage-id' },
      }),
    ],
    'a',
  )
  expect(html).toContain('Alpha')
  // Title-less tab falls back to the cwd basename.
  expect(html).toContain('beta-project')
  expect(html).toContain('New chat')
  expect(html).not.toContain('/managed/storage-id')
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

function tabClassLists(html: string): string[][] {
  return [...html.matchAll(/<div\b[^>]*\brole="tab"[^>]*>/g)]
    .map(match => match[0].match(/class="([^"]*)"/)![1]!.split(' '))
}

test('the active tab is marked selected and joins the content panel instead of an underline', () => {
  const html = render([tab('a'), tab('b')], 'b')
  // Two tabs; the active one is aria-selected true.
  expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
  expect(html).not.toContain('bg-accent')
  expect(html).not.toContain('h-[1.5px]')
  const [inactive, active] = tabClassLists(html)
  expect(active).toContain('bg-[var(--conversation-bg)]')
  expect(active).toContain('shadow-[0_1px_0_var(--conversation-bg)]')
  expect(active).toContain('border-frame-edge')
  expect(active).not.toContain('border-transparent')
  expect(active.some(name => name.startsWith('after:'))).toBe(false)
  expect(inactive).not.toContain('bg-[var(--conversation-bg)]')
})

test('every tab keeps the same top margin, radius and border box so labels do not move', () => {
  for (const html of [render([tab('a'), tab('b')], 'b'), render([tab('a'), tab('b')], null)]) {
    for (const classes of tabClassLists(html)) {
      for (const name of ['mt-1.5', 'rounded-t-lg', 'border', 'border-b-0']) {
        expect(classes).toContain(name)
      }
      expect(classes).not.toContain('border-r')
      expect(classes.some(name => name.startsWith('border-white'))).toBe(false)
    }
  }
})

test('inactive tabs end in a short centred divider, except the one before the active tab', () => {
  const html = render([tab('a'), tab('b'), tab('c'), tab('d')], 'c')
  const [first, beforeActive, active, last] = tabClassLists(html)
  for (const classes of [first, last]) {
    expect(classes).toContain('after:h-[14px]')
    expect(classes).toContain('after:w-px')
    expect(classes).toContain('after:top-1/2')
    expect(classes).toContain('after:bg-frame-seam')
  }
  expect(beforeActive.some(name => name.startsWith('after:'))).toBe(false)
  expect(active.some(name => name.startsWith('after:'))).toBe(false)
})

test('page tabs get the same active treatment and divider as session tabs', () => {
  const model = tab('a')
  const html = renderToStaticMarkup(
    <TabBar
      tabs={[model]}
      navigationTabs={[
        { kind: 'session', model },
        { kind: 'page', page: 'settings' },
        { kind: 'page', page: 'usage' },
      ]}
      selectedTarget={{ kind: 'page', page: 'settings' }}
      activeSessionId="a"
      onSelect={noop}
      onClose={noop}
      onRestart={noop}
      onNewTab={noop}
    />,
  )
  expect(html).not.toContain('bg-accent')
  const [session, settings, usage] = tabClassLists(html)
  expect(session.some(name => name.startsWith('after:'))).toBe(false)
  expect(settings).toContain('bg-[var(--conversation-bg)]')
  expect(settings).toContain('border-frame-edge')
  expect(usage).toContain('after:bg-frame-seam')
  expect(usage).toContain('border-transparent')
})

test('the bar has no bottom border or clip, so the active tab can cover the panel edge', () => {
  const html = render([tab('a')], 'a')
  const bar = html.match(/<div\b[^>]*role="tablist"[^>]*>/)![0]
  const classes = bar.match(/class="([^"]*)"/)![1]!.split(' ')
  expect(classes).toContain('bg-shell-chrome')
  expect(classes).not.toContain('overflow-hidden')
  expect(classes.some(name => name.startsWith('border'))).toBe(false)
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
  // Connection state draws no mark, matching the sidebar row; the word survives
  // only inside the tab's accessible name.
  expect(html).not.toContain('>disconnected<')
  expect(html).not.toContain('>ready<')
  expect(html).not.toContain('rounded-full')
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

test('a tab shows the same work mark as its sidebar row, named in its label', () => {
  const marks = new Map<SessionId, SessionWorkMark>([
    ['a' as SessionId, 'needs-you'],
    ['b' as SessionId, 'working'],
  ])
  const html = renderToStaticMarkup(
    <SessionWorkMarksContext.Provider value={marks}>
      <TabBar
        tabs={[tab('a'), tab('b'), tab('c')]}
        activeSessionId="c"
        onSelect={noop}
        onClose={noop}
        onRestart={noop}
        onNewTab={noop}
      />
    </SessionWorkMarksContext.Provider>,
  )
  expect(html).toContain('<span class="text-[11px] font-bold leading-[17px] text-accent">?</span>')
  expect(html).toContain('motion-safe:animate-spin')
  expect(html).toContain('aria-label="Session a, ready, waiting for you"')
  expect(html).toContain('aria-label="Session b, ready, working"')
  expect(html).toContain('aria-label="Session c, ready"')
})

test('an unopened peer tab colours its title and says so, beside its work mark', () => {
  const marks = new Map<SessionId, SessionWorkMark>([['b' as SessionId, 'working']])
  const html = renderToStaticMarkup(
    <SessionWorkMarksContext.Provider value={marks}>
      <TabBar
        tabs={[tab('a'), { ...tab('b'), unopened: true }]}
        activeSessionId="a"
        onSelect={noop}
        onClose={noop}
        onRestart={noop}
        onNewTab={noop}
      />
    </SessionWorkMarksContext.Provider>,
  )
  expect(html).toContain('aria-label="Session b, ready, not opened yet, working"')
  expect(html).toContain('motion-safe:animate-spin')
  expect(html.match(/truncate text-xs transition-colors text-accent/g)).toHaveLength(1)
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

test('no tab carries worker chrome', () => {
  // A tab names a session. Worker surfaces belong to the session body, not to
  // every tab in the bar.
  const html = render([tab('a'), tab('b')], 'a')
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
  expect(tabLabel(descriptor('a', {
    cwd: '/managed/storage-id',
    title: null,
    binding: { kind: 'managed', storageRootId: 'root', storageId: 'id' },
  }))).toBe('New chat')
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

test('session and page tabs share width equally and reserve close-button space', () => {
  const model = tab('a', {}, { title: 'A long session title beside a short page label' })
  const html = renderToStaticMarkup(
    <TabBar
      tabs={[model]}
      navigationTabs={[{ kind: 'session', model }, { kind: 'page', page: 'settings' }]}
      activeSessionId="a"
      onSelect={noop}
      onClose={noop}
      onRestart={noop}
      onNewTab={noop}
    />,
  )
  const tabClasses = [...html.matchAll(/<div\b[^>]*\brole="tab"[^>]*>/g)]
    .map(match => match[0].match(/class="([^"]*)"/)![1]!.split(' '))
  expect(tabClasses).toHaveLength(2)
  for (const classes of tabClasses) {
    expect(classes).toContain('flex-1')
    expect(classes).toContain('min-w-[90px]')
    expect(classes).toContain('max-w-[256px]')
    expect(classes).not.toContain('shrink-0')
  }
  const closeClasses = [...html.matchAll(/<button\b[^>]*aria-label="Close [^"]*"[^>]*>/g)]
    .map(match => match[0].match(/class="([^"]*)"/)![1]!.split(' '))
  expect(closeClasses).toHaveLength(2)
  for (const classes of closeClasses) {
    expect(classes).toContain('w-[18px]')
    expect(classes).toContain('opacity-0')
    expect(classes).toContain('group-hover:opacity-100')
    expect(classes).toContain('focus-visible:opacity-100')
    expect(classes).not.toContain('w-0')
    expect(classes).not.toContain('group-hover:w-[18px]')
    expect(classes).not.toContain('focus-visible:w-[18px]')
  }
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
    />,
  )

  expect(html).toContain('[-webkit-app-region:drag]')
  // One region declared, then cleared on the tab and the new-session button.
  expect(html.match(/\[-webkit-app-region:no-drag\]/g)).toHaveLength(2)
})

test('the bar reserves the well the traffic lights are drawn into', () => {
  // 84 = the 12px `trafficLightPosition` inset in `main.ts` + 52px of buttons +
  // clearance. The lights paint above the page, so anything here is covered.
  const html = render([tab('a')], 'a')

  expect(html).toContain('w-[84px]')
  expect(html.indexOf('w-[84px]')).toBeLessThan(html.indexOf('role="tab"'))
})

test('a fullscreen window gets no well, because macOS has hidden the lights', () => {
  // The live subscription is `windowChrome.dom.test.ts`; this is the seam
  // between it and the bar.
  const html = renderToStaticMarkup(
    <TabBar
      tabs={[tab('a')]}
      activeSessionId="a"
      onSelect={noop}
      onClose={noop}
      onRestart={noop}
      onNewTab={noop}
      fullscreenMedia={{
        matches: true,
        addEventListener: noop,
        removeEventListener: noop,
      }}
    />,
  )

  expect(html).not.toContain('w-[84px]')
  expect(html).toContain('<div class="w-0 shrink-0" aria-hidden="true">')
})
