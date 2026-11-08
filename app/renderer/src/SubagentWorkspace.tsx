import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { SubagentDock } from './SubagentDock.js'
import { SubagentSidePanel } from './SubagentSidePanel.js'
import { ToolInspector } from './ToolInspector.js'
import { FilePane } from './FilePane.js'
import { BrowserPane, BrowserGlobe } from './BrowserPane.js'
import { browserPaneLabel } from './browserPaneState.js'
import { ComputerPane, ComputerScreenIcon } from './ComputerPane.js'
import { ComputerPaneContext } from './computerPaneContext.js'
import { selectComputerStep, selectComputerSteps } from './computerPaneModel.js'
import { ScreenActivityChip } from './ScreenActivityChip.js'
import { reduceScreenActivity, type ScreenKind } from './screenActivityState.js'
import { ToolOutputContext, clampToolOutputWidth, TOOL_OUTPUT_MIN_WIDTH, TOOL_OUTPUT_WIDTH_STEP, writeToolOutputWidth, type OpenToolOutput } from './toolOutputPanel.js'
import { FilePaneContext } from './filePaneContext.js'
import {
  closeFilePane, getFilePaneSession, registerFilePaneFocus, rememberSlotWidth, requestOpenFile, paneTargetLabel,
  hideScreenPane, showSlotOccupant, updateFilePaneSession, useFilePaneSession, type SlotOccupant,
} from './filePaneState.js'
import { findNestedToolUseRow } from './transcriptViewModel.js'
import { canOpenSubagentPanel, selectSubagentPanelBranch, selectSubagentPanelRowForCard } from './subagentPanelState.js'
import { AgentPanelContext } from './transcriptAgentReveal.js'
import { AgentFace } from './AgentChrome.js'
import { useAgentFaceRegistry } from './agentFace.js'
import { ActionFileIcon } from './SessionActionIcons.js'
import type { DerivedSubagentDock, SubagentDockRow } from './subagentDockState.js'
import type { NestedToolUseRow, NestedTranscriptRow } from './transcriptProjector.js'
import './filePane.css'

export function SubagentWorkspace({ appSessionId, onFocusComposer, dock, collapsed, onCollapsedChange, onClearFinished, onDetailsVisibleChange, onFallback, onOpenWorkers, onLoadMissingHistory, rows, outputRows = rows, running = false, runKey = null, cwd, children }: {
  appSessionId?: string
  onFocusComposer?: () => void
  dock: DerivedSubagentDock
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
  onClearFinished: () => void
  onDetailsVisibleChange: (visible: boolean) => void
  onFallback: (row: SubagentDockRow) => void
  onOpenWorkers: () => void
  onLoadMissingHistory?: () => void
  rows: NestedTranscriptRow[]
  outputRows?: NestedTranscriptRow[]
  running?: boolean
  runKey?: string | null
  cwd: string | null
  children: ReactNode
}) {
  const faces = useAgentFaceRegistry()
  const localId = useId()
  const sessionId = appSessionId ?? `workspace:${localId}`
  const state = useFilePaneSession(sessionId)
  const computerSteps = useMemo(() => selectComputerSteps(outputRows), [outputRows])
  const computerStep = selectComputerStep(computerSteps, state.computer?.selectedId ?? null)
  const latestComputerStep = selectComputerStep(computerSteps, null)
  const latestComputerId = computerSteps.at(-1)?.id ?? null
  const browserSequence = state.browser ? state.browser.agentUseSequence ?? 0 : null
  useLayoutEffect(() => {
    const current = getFilePaneSession(sessionId)
    const activity = reduceScreenActivity(current.screenActivity, { runKey, running, computerId: latestComputerId, browserSequence })
    updateFilePaneSession(sessionId, {
      screenActivity: activity.state,
      computer: latestComputerId ? current.computer ?? { selectedId: null } : null,
    })
    if (activity.reveal && current.visible === null) showSlotOccupant(sessionId, activity.reveal)
  }, [sessionId, latestComputerId, browserSequence, runKey, running])
  const openComputer = useCallback((selectedId: string | null) => {
    updateFilePaneSession(sessionId, { computer: { selectedId } })
    showSlotOccupant(sessionId, 'computer')
  }, [sessionId])
  const computerContext = useMemo(() => ({
    openStep: openComputer,
    selectedStepId: state.visible === 'computer' ? computerStep?.id ?? null : null,
  }), [openComputer, state.visible, computerStep?.id])
  const hideScreen = (kind: ScreenKind) => {
    hideScreenPane(sessionId, kind)
    requestAnimationFrame(() => {
      const chip = parent.current?.querySelector<HTMLButtonElement>(`[data-screen-kind="${kind}"] button`)
      if (chip) chip.focus({ preventScroll: true })
      else focusComposer.current?.()
    })
  }
  const selected = state.worker
  const output = state.output
  const parent = useRef<HTMLDivElement>(null)
  const slot = useRef<HTMLDivElement>(null)
  const workspace = useRef<HTMLDivElement>(null)
  const workers = [...dock.active, ...dock.finished]
  const observed = selected ? workers.find(row => row.agentId === selected.agentId) : undefined
  const retained = useRef<{ selection: SubagentDockRow; row: SubagentDockRow } | null>(null)
  const candidate = observed ?? (retained.current?.selection === selected ? retained.current.row : selected)
  const worker = candidate && canOpenSubagentPanel(candidate, rows) ? candidate : null
  const branch = selectSubagentPanelBranch(rows, worker?.toolUseId ?? null, worker?.runToolUseIds)
  const opener = useRef<HTMLElement | null>(null)
  const outputRow = output ? findNestedToolUseRow(outputRows, output.id) : null
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; width: number; layoutWidth: number | null } | null>(null)
  const dragFrame = useRef<number | null>(null)
  const focusComposer = useRef(onFocusComposer)
  focusComposer.current = onFocusComposer
  useLayoutEffect(() => registerFilePaneFocus(sessionId, () => focusComposer.current?.()), [sessionId])
  useLayoutEffect(() => {
    if (output && !outputRow) updateFilePaneSession(sessionId, { output: null })
  }, [sessionId, output, outputRow])
  useLayoutEffect(() => {
    // Dock rows are presentation snapshots, not new shared-slot selections.
    retained.current = selected && candidate ? { selection: selected, row: candidate } : null
  }, [selected, candidate])
  useLayoutEffect(() => {
    if (!selected) return
    if (!worker) {
      updateFilePaneSession(sessionId, { worker: null })
      onFallback(candidate ?? selected)
    }
  }, [sessionId, selected, candidate, worker, onFallback])
  useLayoutEffect(() => {
    if (state.width !== null) slot.current?.style.setProperty('--shared-slot-width', `${state.width}px`)
  }, [state.width])
  useLayoutEffect(() => () => {
    if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current)
    dragFrame.current = null
    drag.current = null
  }, [sessionId])
  const openOutput = useCallback<OpenToolOutput>((row, fileIndex = 0) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const current = getFilePaneSession(sessionId)
    updateFilePaneSession(sessionId, { output: { id: row.id, fileIndex, request: (current.output?.request ?? 0) + 1 } })
    showSlotOccupant(sessionId, 'output')
  }, [sessionId])
  const closeOutput = () => {
    updateFilePaneSession(sessionId, { output: null })
    const target = opener.current
    opener.current = null
    requestAnimationFrame(() => { if (target?.isConnected) target.focus({ preventScroll: true }) })
  }
  const open = (row: SubagentDockRow) => {
    if (!canOpenSubagentPanel(row, rows)) { onFallback(row); return }
    updateFilePaneSession(sessionId, { worker: row })
    showSlotOccupant(sessionId, 'worker')
    if (!rows.some(candidate =>
      candidate.kind === 'tool-use' && candidate.toolUseId === row.toolUseId ||
      candidate.kind === 'orphaned-agent' && candidate.missingToolUseId === row.toolUseId)) onLoadMissingHistory?.()
  }
  const openCardRef = useRef((_card: NestedToolUseRow) => {})
  openCardRef.current = card => open(selectSubagentPanelRowForCard(card, workers))
  const openCard = useCallback((card: NestedToolUseRow) => openCardRef.current(card), [])
  const closeWorker = () => {
    updateFilePaneSession(sessionId, { worker: null })
    requestAnimationFrame(() => {
      const dock = parent.current
      const row = [...dock?.querySelectorAll<HTMLButtonElement>('[data-dock-row]') ?? []]
        .find(element => element.dataset.dockRow === worker?.agentId && !element.closest('[inert]'))
      const target = row ?? dock?.querySelector<HTMLButtonElement>('.subagent-dock-chip:not([aria-hidden="true"]), [data-finished-toggle]')
      target?.focus({ preventScroll: true })
    })
  }
  const occupants: Array<{ kind: SlotOccupant; label: string }> = [
    ...(state.open ? [{ kind: 'file' as const, label: state.file ? paneTargetLabel(state.file.path) : 'File' }] : []),
    ...(state.browser ? [{ kind: 'browser' as const, label: browserPaneLabel(state.browser) }] : []),
    ...(computerSteps.length ? [{ kind: 'computer' as const, label: 'Computer' }] : []),
    ...(worker ? [{ kind: 'worker' as const, label: worker.name || worker.task }] : []),
    ...(outputRow ? [{ kind: 'output' as const, label: 'Full output' }] : []),
  ]
  const resize = (width: number) => {
    const clamped = clampToolOutputWidth(width, workspace.current?.clientWidth || null)
    slot.current?.style.setProperty('--shared-slot-width', `${clamped}px`)
    slot.current?.querySelector('[role="separator"]')?.setAttribute('aria-valuenow', String(clamped))
    rememberSlotWidth(sessionId, clamped)
    if (!state.open && outputRow) writeToolOutputWidth(clamped)
  }
  const finishDrag = (event: { pointerId: number }) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current)
    dragFrame.current = null
    drag.current = null
    // Persist once, including a final pointer move that has not painted yet.
    resize(current.width)
    setDragging(false)
  }
  return <FilePaneContext.Provider value={appSessionId ? requestOpenFile : null}><ToolOutputContext.Provider value={openOutput}><ComputerPaneContext.Provider value={computerContext}>
    <div ref={workspace} className="subagent-workspace" data-resizing={dragging || undefined}>
      <div className="subagent-workspace-layout" data-file-open={state.open && state.visible !== null || undefined}>
        <div ref={parent} className="subagent-parent">
          {(computerSteps.length > 0 && state.visible !== 'computer' || state.browser && state.visible !== 'browser') ? <div className="screen-activity-chips">
            {computerSteps.length > 0 && state.visible !== 'computer' ? <span data-screen-kind="computer"><ScreenActivityChip kind="computer" label="Computer"
              imageUrl={latestComputerStep?.image ? `data:${latestComputerStep.image.mediaType};base64,${latestComputerStep.image.data}` : null}
              running={running && computerSteps.some(step => step.status === 'pending')} onClick={() => openComputer(null)} /></span> : null}
            {state.browser && state.visible !== 'browser' ? <span data-screen-kind="browser"><ScreenActivityChip kind="browser" label={browserPaneLabel(state.browser)}
              imageUrl={state.browser.still} running={running && state.browser.controller === 'agent' && state.screenActivity.latest === 'browser'}
              onClick={() => showSlotOccupant(sessionId, 'browser')} /></span> : null}
          </div> : null}
          <SubagentDock state={dock} collapsed={collapsed} hidden={worker !== null && state.visible === 'worker'} onCollapsedChange={onCollapsedChange}
            onClearFinished={onClearFinished} onDetailsVisibleChange={onDetailsVisibleChange}
            onOpenWorker={open} onOpenWorkers={onOpenWorkers} />
          <AgentPanelContext.Provider value={openCard}>{children}</AgentPanelContext.Provider>
        </div>
        {occupants.length ? <div ref={slot} className="subagent-shared-slot" hidden={state.visible === null}>
          <div className="subagent-shared-resize" role="separator" aria-orientation="vertical" aria-label="Resize side panel"
            aria-valuenow={state.width ?? 560} aria-valuemin={TOOL_OUTPUT_MIN_WIDTH} tabIndex={0} data-dragging={dragging || undefined}
            onPointerDown={event => {
              if (event.button !== 0 || drag.current) return
              event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
              const width = slot.current?.getBoundingClientRect().width || state.width || 560
              drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, width, layoutWidth: workspace.current?.clientWidth || null }
              setDragging(true)
            }} onPointerMove={event => {
              const current = drag.current
              if (!current || current.pointerId !== event.pointerId) return
              current.width = clampToolOutputWidth(current.startWidth + current.startX - event.clientX, current.layoutWidth)
              if (dragFrame.current !== null) return
              const handle = event.currentTarget
              dragFrame.current = requestAnimationFrame(() => {
                dragFrame.current = null
                if (!drag.current) return
                slot.current?.style.setProperty('--shared-slot-width', `${drag.current.width}px`)
                handle.setAttribute('aria-valuenow', String(drag.current.width))
              })
            }}
            onPointerUp={finishDrag} onPointerCancel={finishDrag} onLostPointerCapture={finishDrag}
            onDoubleClick={() => resize(state.open ? 620 : outputRow ? 560 : 480)}
            onKeyDown={event => {
              if (event.key === 'ArrowLeft') resize((state.width ?? 560) + TOOL_OUTPUT_WIDTH_STEP)
              else if (event.key === 'ArrowRight') resize((state.width ?? 560) - TOOL_OUTPUT_WIDTH_STEP)
              else if (event.key === 'Escape') {
                if (state.visible === 'file') { closeFilePane(sessionId); onFocusComposer?.() }
                else if (state.visible === 'output') closeOutput()
                else if (state.visible === 'browser' || state.visible === 'computer') hideScreen(state.visible)
                else closeWorker()
              } else return
              event.preventDefault()
            }} />
          {occupants.length > 1 ? <nav className="subagent-slot-strip" role="tablist" aria-label="Side panels">
            {occupants.map(occupant => <button key={occupant.kind} type="button" className="subagent-slot-tab" role="tab"
              aria-label={occupant.label} aria-selected={state.visible === occupant.kind} tabIndex={state.visible === occupant.kind ? 0 : -1}
              onClick={() => showSlotOccupant(sessionId, occupant.kind)} onKeyDown={event => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                event.preventDefault()
                const index = occupants.findIndex(item => item.kind === occupant.kind)
                const next = occupants[(index + (event.key === 'ArrowRight' ? 1 : occupants.length - 1)) % occupants.length]!
                showSlotOccupant(sessionId, next.kind)
                const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                tabs?.[occupants.findIndex(item => item.kind === next.kind)]?.focus()
              }}>{occupant.kind === 'file' ? <ActionFileIcon /> : occupant.kind === 'browser' ? <BrowserGlobe /> : occupant.kind === 'computer' ? <ComputerScreenIcon /> : occupant.kind === 'worker' && worker ?
                <AgentFace axes={faces.faceFor(worker.agentId, worker.name).axes} fill={faces.faceFor(worker.agentId, worker.name).fill} size={13} /> : <span aria-hidden>▤</span>}<span>{occupant.label}</span></button>)}
          </nav> : null}
          {worker ? <div className="subagent-slot-content" hidden={state.visible !== 'worker'}><SubagentSidePanel key={worker.agentId} worker={worker}
            workers={workers.some(row => row.agentId === worker.agentId) ? workers : [...workers, worker]}
            {...branch} cwd={cwd} onSwitch={open} onClose={closeWorker} /></div> : null}
          {output && outputRow ? <div className="subagent-slot-content" hidden={state.visible !== 'output'}><ToolInspector key={`${output.id}:${output.request}`} row={outputRow} cwd={cwd}
            embedded initialFileIndex={output.fileIndex} onClose={closeOutput} /></div> : null}
          {state.open ? <div className="subagent-slot-content" hidden={state.visible !== 'file'}><FilePane appSessionId={sessionId} cwd={cwd} onFocusComposer={onFocusComposer} /></div> : null}
          {state.browser ? <div className="subagent-slot-content" hidden={state.visible !== 'browser'}><BrowserPane state={state.browser} active={state.visible === 'browser'} onHide={() => hideScreen('browser')} /></div> : null}
          {computerSteps.length ? <div className="subagent-slot-content" hidden={state.visible !== 'computer'}><ComputerPane steps={computerSteps}
            selectedId={state.computer?.selectedId ?? null} onSelect={openComputer} onClose={() => hideScreen('computer')} active={state.visible === 'computer'}
            running={running && computerSteps.some(step => step.status === 'pending')} /></div> : null}
        </div> : null}
      </div>
    </div>
  </ComputerPaneContext.Provider></ToolOutputContext.Provider></FilePaneContext.Provider>
}
