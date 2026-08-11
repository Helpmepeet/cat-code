import { expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import type { ConnectionSnapshot } from './connectionState.js'
import { WorkspaceLayout, type WorkspacePanelView } from './WorkspacePanels.js'
import type { WorkspaceLayoutState } from './workspaceLayout.js'

const READY: ConnectionSnapshot = { status: 'ready', inputEnabled: true }

test('renders panel, drop edge, and splitter aria labels with session identity and state', () => {
  const alpha = descriptor('session-a', 'Alpha')
  const beta = descriptor('session-b', 'Beta')
  const panels: WorkspacePanelView[] = [
    panel(alpha, <div>Alpha transcript</div>),
    panel(beta, <div>Beta transcript</div>),
  ]
  const layout: WorkspaceLayoutState = {
    panels: [{ sessionId: 'session-a' }, { sessionId: 'session-b' }],
    widths: [55, 45],
    activeIndex: 0,
  }

  const html = renderToStaticMarkup(
    <WorkspaceLayout
      layout={layout}
      panels={panels}
      sessions={[alpha, beta]}
      notice={null}
      onClosePanel={() => {}}
      onFocusPanel={() => {}}
      onSelectSession={() => {}}
      onSplitPanel={() => {}}
      onWidthsChange={() => {}}
    />,
  )

  expect(html).toContain('Workspace layout, 2 panels')
  expect(html).toContain(
    'Panel 1 session Alpha, live, active',
  )
  expect(html).toContain(
    'Drop tab on left edge of panel 1 showing Alpha, live to split',
  )
  expect(html).toContain('role="separator"')
  expect(html).toContain(
    'Resize split between panel 1 session Alpha, live and panel 2 session Beta, live',
  )
  expect(html).not.toContain('host ready')
  expect(html).not.toContain('connection ready')
  expect(html).not.toContain('(session-a)')
  expect(html).not.toContain('(session-b)')
})

test('panel selector exposes duplicate-session prevention affordance', () => {
  const alpha = descriptor('session-a', 'Alpha')
  const beta = descriptor('session-b', 'Beta')
  const html = renderToStaticMarkup(
    <WorkspaceLayout
      layout={{
        panels: [{ sessionId: 'session-a' }, { sessionId: 'session-b' }],
        widths: [50, 50],
        activeIndex: 1,
      }}
      panels={[
        panel(alpha, <div>Alpha transcript</div>),
        panel(beta, <div>Beta transcript</div>),
      ]}
      sessions={[alpha, beta]}
      notice="Alpha is already open in panel 1; focused that panel instead."
      onClosePanel={() => {}}
      onFocusPanel={() => {}}
      onSelectSession={() => {}}
      onSplitPanel={() => {}}
      onWidthsChange={() => {}}
    />,
  )

  expect(html).toContain('Alpha is already open in panel 1')
  expect(html).toContain('Alpha, open in panel 1')
})

test('drop edges do not capture pointer events until a tab drag is active', () => {
  const alpha = descriptor('session-a', 'Alpha')
  const beta = descriptor('session-b', 'Beta')
  const html = renderToStaticMarkup(
    <WorkspaceLayout
      layout={{
        panels: [{ sessionId: 'session-a' }, { sessionId: 'session-b' }],
        widths: [50, 50],
        activeIndex: 0,
      }}
      panels={[
        panel(alpha, <div>Alpha transcript</div>),
        panel(beta, <div>Beta transcript</div>),
      ]}
      sessions={[alpha, beta]}
      notice={null}
      onClosePanel={() => {}}
      onFocusPanel={() => {}}
      onSelectSession={() => {}}
      onSplitPanel={() => {}}
      onWidthsChange={() => {}}
    />,
  )

  // At rest the transparent edge strips must be click-through so they never
  // steal the panel header's close/selector controls or transcript clicks.
  expect(html).toContain('pointer-events-none')
  expect(html).not.toContain('pointer-events-auto')
})

test('panel content wrapper is a bounded flex column so SessionPane can scroll', () => {
  const alpha = descriptor('session-a', 'Alpha')
  const html = renderToStaticMarkup(
    <WorkspaceLayout
      layout={{ panels: [{ sessionId: 'session-a' }], widths: [100], activeIndex: 0 }}
      panels={[panel(alpha, <div>Alpha transcript</div>)]}
      sessions={[alpha]}
      notice={null}
      onClosePanel={() => {}}
      onFocusPanel={() => {}}
      onSelectSession={() => {}}
      onSplitPanel={() => {}}
      onWidthsChange={() => {}}
    />,
  )

  // Class tripwire for the live no-scroll bug behind P4-18c: SessionPane's
  // <main> sizes itself with `flex-1 min-h-0`, which only works when THIS
  // wrapper is a flex column — as a block parent, <main> grows to content
  // height and the transcript scroller can never overflow. jsdom has no
  // layout engine, so this pins the classes; the height chain itself was
  // verified against live computed layout (2026-07-10).
  expect(html).toContain('"flex min-h-0 flex-1 flex-col overflow-hidden"')
})

function descriptor(id: string, title: string): SessionDescriptor {
  return {
    appSessionId: id,
    engineSessionId: `engine-${id}`,
    cwd: `/tmp/${title.toLowerCase()}`,
    title,
    titleUpdatedAt: null,
    status: 'ready',
    restorable: false,
    parked: false,
    createdAt: 1,
    lastAttachedAt: 2,
    lastMessageSentAt: null,
  }
}

function panel(
  descriptor: SessionDescriptor,
  content: ReactNode,
): WorkspacePanelView {
  return {
    sessionId: descriptor.appSessionId,
    descriptor,
    connection: READY,
    content,
  }
}

test('the focused-panel ring is split-only, so one panel is not boxed in accent', () => {
  // "Which panel has focus" has no other candidate when there is one panel, so
  // the ring drew an accent hairline around the whole app for nothing. Same
  // condition PanelHeader already applies to the rest of the per-panel chrome.
  const alpha = descriptor('session-a', 'Alpha')
  const beta = descriptor('session-b', 'Beta')

  const render = (panelViews: WorkspacePanelView[], layout: WorkspaceLayoutState) =>
    renderToStaticMarkup(
      <WorkspaceLayout
        layout={layout}
        panels={panelViews}
        sessions={[alpha, beta]}
        notice={null}
        onClosePanel={() => {}}
        onFocusPanel={() => {}}
        onSelectSession={() => {}}
        onSplitPanel={() => {}}
        onWidthsChange={() => {}}
      />,
    )

  const single = render([panel(alpha, <div>Alpha transcript</div>)], {
    panels: [{ sessionId: 'session-a' }],
    widths: [100],
    activeIndex: 0,
  })
  expect(single).not.toContain('ring-accent/35')

  const split = render(
    [panel(alpha, <div>Alpha transcript</div>), panel(beta, <div>Beta transcript</div>)],
    {
      panels: [{ sessionId: 'session-a' }, { sessionId: 'session-b' }],
      widths: [50, 50],
      activeIndex: 0,
    },
  )
  expect(split).toContain('ring-accent/35')
})
