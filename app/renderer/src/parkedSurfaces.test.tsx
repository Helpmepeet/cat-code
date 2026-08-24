/**
 * IDLE-PARK §1b — the four descriptor-derived surfaces, checked TOGETHER.
 *
 * §1a fixed the three chat-view surfaces that read the renderer's own
 * connection snapshot (banner, tab, composer). These four never see that
 * snapshot: they are descriptor-derived by design, so they kept calling an
 * intentional reclaim `crashed` long after the ruling that said it must not
 * read as a failure. The fix gives the descriptor a `parked` bit and routes
 * every one of them through the single shared vocabulary.
 *
 * They are tested in ONE file on purpose. Each has its own suite already, and
 * each passed while collectively getting this wrong — the defect was that no
 * test asked whether they AGREE. §1b's own evidence was the debug export
 * disagreeing with itself (`sidebar[]` said crashed while `tabs[]` said idle
 * for the same session), which is exactly what a per-surface test cannot see.
 */

import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import { buildPaletteItems } from './commandPaletteModel.js'
import { createConnectionState } from './connectionState.js'
import { buildDebugShellStateSnapshot } from './debugStateReport.js'
import { createPermissionState } from './permissionState.js'
import { SessionsPage } from './SessionsPage.js'
import { createShellState, reduceShellState } from './shellState.js'
import { deriveMergedRowVisual } from './sidebarState.js'
import { selectMergedSessionRows } from './sessionsCatalogState.js'

const APP_ID = '00000000-0000-4000-8000-0000000000aa'

/** The descriptor a parked session produces: byte-identical to a crash apart
 * from the one bit (`host.descriptorFromRow`). */
function parkedDescriptor(over: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    appSessionId: APP_ID,
    engineSessionId: 'engine-a',
    cwd: '/tmp/work',
    title: 'Work',
    forked: false,
    titleUpdatedAt: null,
    status: 'disconnected',
    restorable: true,
    parked: true,
    createdAt: 1,
    lastAttachedAt: 2,
    lastMessageSentAt: null,
    ...over,
  }
}

/** The palette's session row for one descriptor. */
function paletteSessionRow(descriptor: SessionDescriptor) {
  return buildPaletteItems({
    rows: [descriptor],
    activeSessionId: null,
    hasPanels: false,
    handlers: {
      restoreSession: () => {},
      selectLiveSession: () => {},
    } as never,
  }).find(item => item.kind === 'session')
}

/** The Sessions page's real markup for one descriptor's merged row. */
function sessionsPageHtml(descriptor: SessionDescriptor): string {
  const [row] = selectMergedSessionRows([descriptor], null)
  return renderToStaticMarkup(
    <SessionsPage
      rows={row ? [row] : []}
      activeCwd={descriptor.cwd}
      catalogLoaded
      truncated={false}
      onOpenRow={() => {}}
      onNewSession={() => {}}
    />,
  )
}

/** The real debug export's sidebar rows for one descriptor. */
function debugSidebarLabels(descriptor: SessionDescriptor): string[] {
  let shell = createShellState()
  shell = reduceShellState(shell, { type: 'session-added', session: descriptor })
  const snapshot = buildDebugShellStateSnapshot({
    shell,
    connection: createConnectionState(),
    permissions: createPermissionState(),
    activeSessionId: descriptor.appSessionId,
    now: () => 0,
  })
  return snapshot.renderer.sidebar.map(entry => entry.label)
}

test('no surface calls a parked session crashed', () => {
  const parked = parkedDescriptor()

  // 1. The Sessions page, rendered — not its vocabulary by proxy. Asserting the
  //    shared selector here would have passed with the production argument
  //    removed, which is the whole failure mode this file exists to catch.
  const page = sessionsPageHtml(parked)
  expect(page).toContain('idle')
  expect(page).not.toContain('crashed')

  // 2. The ⌘K palette row — its label AND its assistive-tech description, which
  //    §1b called out separately because the aria-label said "crashed,
  //    restorable" even where the visible chip had been fixed.
  const row = paletteSessionRow(parked)
  expect(row?.state).toBe('idle')
  expect(row?.ariaLabel).not.toContain('crashed')

  // 3. The sidebar row (the rail paints a dot, so this one is assistive-tech
  //    only — and therefore the one nobody would have noticed).
  const [merged] = selectMergedSessionRows([parked], null)
  expect(merged?.parked).toBe(true)
  const visual = deriveMergedRowVisual(merged!)
  expect(visual.label).toBe('idle')
  expect(JSON.stringify(visual)).not.toContain('crashed')

  // 4. The debug export — §1b's own evidence, where `sidebar[]` said crashed
  //    while `tabs[]` said idle for the same session.
  expect(debugSidebarLabels(parked)).toEqual(['idle'])
})

test('a real crash still says crashed on every one of them', () => {
  // The whole risk of a shared bit is that it silences the honest case too.
  const crashed = parkedDescriptor({ parked: false })

  expect(sessionsPageHtml(crashed)).toContain('crashed')
  expect(paletteSessionRow(crashed)?.state).toBe('crashed')
  const [merged] = selectMergedSessionRows([crashed], null)
  expect(deriveMergedRowVisual(merged!).label).toBe('crashed')
  expect(debugSidebarLabels(crashed)).toEqual(['crashed'])
})

test('a park that can never come back is not dressed up as resting', () => {
  // §1c: parked before its first turn ⇒ no transcript ⇒ restore and restart
  // both fail. Every surface must keep saying so.
  const stranded = parkedDescriptor({ restorable: false, engineSessionId: null })

  expect(sessionsPageHtml(stranded)).not.toContain('idle')
  expect(paletteSessionRow(stranded)?.state).not.toBe('idle')
  expect(debugSidebarLabels(stranded)).not.toEqual(['idle'])
})
