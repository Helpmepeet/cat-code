import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import type { SessionId } from '../../shared/protocol.js'
import type { ConnectionSnapshot } from './connectionState.js'
import { tabLabel } from './TabBar.js'
import {
  MAX_WORKSPACE_PANELS,
  resizeWorkspaceDivider,
  type WorkspaceLayoutState,
  type WorkspaceSplitEdge,
} from './workspaceLayout.js'

export type WorkspacePanelView = {
  sessionId: SessionId
  descriptor: SessionDescriptor | undefined
  connection: ConnectionSnapshot
  content: ReactNode
}

export function WorkspaceLayout({
  layout,
  panels,
  sessions,
  notice,
  onClosePanel,
  onFocusPanel,
  onSelectSession,
  onSplitPanel,
  onWidthsChange,
}: {
  layout: WorkspaceLayoutState
  panels: WorkspacePanelView[]
  sessions: SessionDescriptor[]
  notice: string | null
  onClosePanel: (index: number) => void
  onFocusPanel: (index: number, sessionId: SessionId) => void
  onSelectSession: (index: number, sessionId: SessionId) => void
  onSplitPanel: (
    index: number,
    edge: WorkspaceSplitEdge,
    sessionId: SessionId,
  ) => void
  onWidthsChange: (widths: number[]) => void
}) {
  const [resize, setResize] = useState<{
    index: number
    startX: number
    startWidths: number[]
  } | null>(null)
  const [dropTarget, setDropTarget] = useState<{
    index: number
    edge: WorkspaceSplitEdge
  } | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!resize) return
    const onMove = (event: globalThis.MouseEvent) => {
      const width = containerRef.current?.getBoundingClientRect().width ?? 1
      const delta = ((event.clientX - resize.startX) / width) * 100
      onWidthsChange(
        resizeWorkspaceDivider(
          { ...layout, widths: resize.startWidths },
          resize.index,
          delta,
        ).widths,
      )
    }
    const onUp = () => setResize(null)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [layout, onWidthsChange, resize])

  const splitFromDrop = (
    event: DragEvent<HTMLElement>,
    index: number,
    edge: WorkspaceSplitEdge,
  ) => {
    event.preventDefault()
    const sessionId = event.dataTransfer.getData('text/sessionId')
    if (sessionId) onSplitPanel(index, edge, sessionId)
    setDropTarget(null)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {notice ? (
        <div className="border-b border-shell-seam bg-shell-chrome px-6 py-1.5 text-xs text-tone-warn">
          {notice}
        </div>
      ) : null}
      <div
        ref={containerRef}
        className={
          'flex min-h-0 flex-1 overflow-hidden ' +
          (resize ? 'cursor-col-resize select-none' : '')
        }
        aria-label={`Workspace layout — ${panels.length} panel${panels.length === 1 ? '' : 's'}`}
      >
        {panels.map((panel, index) => {
          const width = layout.widths[index] ?? 100 / panels.length
          const active = index === layout.activeIndex
          const next = panels[index + 1]
          return (
            <Fragment key={`${index}:${panel.sessionId}`}>
              <div
                className="flex min-w-0 shrink-0 flex-col overflow-hidden"
                style={{ flexBasis: `${width}%` }}
              >
                <section
                  className={
                    'relative flex min-h-0 flex-1 flex-col overflow-hidden ' +
                    (active
                      ? 'bg-app-bg ring-1 ring-inset ring-accent/35'
                      : 'bg-app-bg')
                  }
                  aria-label={panelAriaLabel(panel, index, active)}
                  onMouseDown={() => onFocusPanel(index, panel.sessionId)}
                >
                  {panels.length > 1 ? (
                    <PanelHeader
                      active={active}
                      index={index}
                      panel={panel}
                      panels={panels}
                      sessions={sessions}
                      onClosePanel={onClosePanel}
                      onFocusPanel={onFocusPanel}
                      onSelectSession={onSelectSession}
                    />
                  ) : null}

                  <DropEdge
                    active={sameDropTarget(dropTarget, index, 'left')}
                    disabled={panels.length >= MAX_WORKSPACE_PANELS}
                    edge="left"
                    index={index}
                    panel={panel}
                    onDragLeave={() => setDropTarget(null)}
                    onDragOver={event => {
                      event.preventDefault()
                      event.dataTransfer.dropEffect = 'copy'
                      setDropTarget({ index, edge: 'left' })
                    }}
                    onDrop={event => splitFromDrop(event, index, 'left')}
                  />
                  <DropEdge
                    active={sameDropTarget(dropTarget, index, 'right')}
                    disabled={panels.length >= MAX_WORKSPACE_PANELS}
                    edge="right"
                    index={index}
                    panel={panel}
                    onDragLeave={() => setDropTarget(null)}
                    onDragOver={event => {
                      event.preventDefault()
                      event.dataTransfer.dropEffect = 'copy'
                      setDropTarget({ index, edge: 'right' })
                    }}
                    onDrop={event => splitFromDrop(event, index, 'right')}
                  />

                  <div className="min-h-0 flex-1 overflow-hidden">
                    {panel.content}
                  </div>
                </section>
              </div>

              {next ? (
                <Divider
                  index={index}
                  left={panel}
                  right={next}
                  resizing={resize?.index === index}
                  onKeyDown={event => {
                    if (
                      event.key !== 'ArrowLeft' &&
                      event.key !== 'ArrowRight'
                    ) {
                      return
                    }
                    event.preventDefault()
                    const delta = event.key === 'ArrowLeft' ? -5 : 5
                    onWidthsChange(
                      resizeWorkspaceDivider(layout, index, delta).widths,
                    )
                  }}
                  onMouseDown={event => {
                    event.preventDefault()
                    setResize({
                      index,
                      startX: event.clientX,
                      startWidths: [...layout.widths],
                    })
                  }}
                />
              ) : null}
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}

function PanelHeader({
  active,
  index,
  panel,
  panels,
  sessions,
  onClosePanel,
  onFocusPanel,
  onSelectSession,
}: {
  active: boolean
  index: number
  panel: WorkspacePanelView
  panels: WorkspacePanelView[]
  sessions: SessionDescriptor[]
  onClosePanel: (index: number) => void
  onFocusPanel: (index: number, sessionId: SessionId) => void
  onSelectSession: (index: number, sessionId: SessionId) => void
}) {
  return (
    <div
      className="flex h-9 shrink-0 items-center gap-2 border-b border-shell-seam bg-shell-chrome px-3"
      onClick={() => onFocusPanel(index, panel.sessionId)}
    >
      <span
        className={
          'h-1.5 w-1.5 shrink-0 rounded-full ' +
          (active ? 'bg-accent' : 'bg-text-subtle/40')
        }
        aria-hidden="true"
      />
      <select
        className="min-w-0 flex-1 truncate rounded border border-shell-seam bg-app-bg px-2 py-1 text-xs text-text-primary"
        value={panel.sessionId}
        aria-label={`Panel ${index + 1} session selector; current ${sessionIdentity(panel)} — ${sessionState(panel)}`}
        onChange={event => onSelectSession(index, event.target.value)}
      >
        {sessions.map(session => {
          const openIndex = panels.findIndex(
            candidate => candidate.sessionId === session.appSessionId,
          )
          const duplicate = openIndex >= 0 && openIndex !== index
          return (
            <option
              key={session.appSessionId}
              value={session.appSessionId}
              disabled={duplicate}
            >
              {tabLabel(session)}
              {duplicate ? ` — open in panel ${openIndex + 1}` : ''}
            </option>
          )
        })}
      </select>
      <button
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-sm leading-none text-text-subtle transition-colors hover:bg-white/10 hover:text-text-primary"
        aria-label={`Close panel ${index + 1} showing ${sessionIdentity(panel)} — ${sessionState(panel)}`}
        title="Close panel"
        type="button"
        onClick={event => {
          event.stopPropagation()
          onClosePanel(index)
        }}
      >
        ×
      </button>
    </div>
  )
}

function DropEdge({
  active,
  disabled,
  edge,
  index,
  panel,
  onDragLeave,
  onDragOver,
  onDrop,
}: {
  active: boolean
  disabled: boolean
  edge: WorkspaceSplitEdge
  index: number
  panel: WorkspacePanelView
  onDragLeave: () => void
  onDragOver: (event: DragEvent<HTMLDivElement>) => void
  onDrop: (event: DragEvent<HTMLDivElement>) => void
}) {
  return (
    <div
      className={
        'absolute inset-y-0 z-20 w-8 transition-colors ' +
        (edge === 'left' ? 'left-0' : 'right-0') +
        ' ' +
        (active && !disabled ? 'bg-accent/20' : 'bg-transparent')
      }
      aria-label={`Drop tab on ${edge} edge of panel ${index + 1} showing ${sessionIdentity(panel)} — ${sessionState(panel)} to split`}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={event => {
        onDrop(event)
      }}
    />
  )
}

function Divider({
  index,
  left,
  right,
  resizing,
  onKeyDown,
  onMouseDown,
}: {
  index: number
  left: WorkspacePanelView
  right: WorkspacePanelView
  resizing: boolean
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
  onMouseDown: (event: MouseEvent<HTMLDivElement>) => void
}) {
  return (
    <div
      className={
        'relative z-30 w-1 shrink-0 cursor-col-resize outline-none transition-colors focus:bg-accent/70 ' +
        (resizing ? 'bg-accent/70' : 'bg-shell-seam hover:bg-accent/45')
      }
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize split between panel ${index + 1} session ${sessionIdentity(left)} — ${sessionState(left)} and panel ${index + 2} session ${sessionIdentity(right)} — ${sessionState(right)}`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseDown={onMouseDown}
    />
  )
}

function sameDropTarget(
  target: { index: number; edge: WorkspaceSplitEdge } | null,
  index: number,
  edge: WorkspaceSplitEdge,
): boolean {
  return target?.index === index && target.edge === edge
}

function panelAriaLabel(
  panel: WorkspacePanelView,
  index: number,
  active: boolean,
): string {
  return `Panel ${index + 1} session ${sessionIdentity(panel)} — ${sessionState(panel)}, ${active ? 'active' : 'inactive'}`
}

function sessionIdentity(panel: WorkspacePanelView): string {
  return panel.descriptor
    ? `${tabLabel(panel.descriptor)} (${panel.sessionId})`
    : panel.sessionId
}

function sessionState(panel: WorkspacePanelView): string {
  const host = panel.descriptor?.status ?? 'missing'
  return `host ${host}, connection ${panel.connection.status}`
}
