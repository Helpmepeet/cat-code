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

  expect(html).toContain('Workspace layout — 2 panels')
  expect(html).toContain(
    'Panel 1 session Alpha (session-a) — host ready, connection ready, active',
  )
  expect(html).toContain(
    'Drop tab on left edge of panel 1 showing Alpha (session-a) — host ready, connection ready to split',
  )
  expect(html).toContain('role="separator"')
  expect(html).toContain(
    'Resize split between panel 1 session Alpha (session-a) — host ready, connection ready and panel 2 session Beta (session-b) — host ready, connection ready',
  )
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
  expect(html).toContain('Alpha — open in panel 1')
})

function descriptor(id: string, title: string): SessionDescriptor {
  return {
    appSessionId: id,
    engineSessionId: `engine-${id}`,
    cwd: `/tmp/${title.toLowerCase()}`,
    title,
    status: 'ready',
    restorable: false,
    createdAt: 1,
    lastAttachedAt: 2,
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
