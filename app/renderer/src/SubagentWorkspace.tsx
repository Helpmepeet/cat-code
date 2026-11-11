import { useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { SubagentDock, type DockView } from './SubagentDock.js'
import { SubagentSidePanel } from './SubagentSidePanel.js'
import { ToolInspector } from './ToolInspector.js'
import { FilePane } from './FilePane.js'
import { BrowserPane } from './BrowserPane.js'
import { browserPaneLabel } from './browserPaneState.js'
import { ComputerPane } from './ComputerPane.js'
import { ComputerPaneContext } from './computerPaneContext.js'
import { selectComputerStep, selectComputerSteps, selectCurrentComputerStepId } from './computerPaneModel.js'
import { reduceScreenActivity, type ScreenKind } from './screenActivityState.js'
import { ToolOutputContext, clampToolOutputWidth, TOOL_OUTPUT_MIN_WIDTH, TOOL_OUTPUT_WIDTH_STEP, writeToolOutputWidth, type OpenToolOutput } from './toolOutputPanel.js'
import { FilePaneContext } from './filePaneContext.js'
import {
  closeFilePane, getFilePaneSession, registerFilePaneFocus, rememberSlotWidth, requestOpenFile, paneTargetLabel,
  hideScreenPane, hideSidePane, showSlotOccupant, updateFilePaneSession, useFilePaneFields, useSidePaneNavigation, type SlotOccupant,
} from './filePaneState.js'
import { findNestedToolUseRow } from './transcriptViewModel.js'
import { canOpenSubagentPanel, selectSubagentPanelBranch, selectSubagentPanelRowForCard } from './subagentPanelState.js'
import { AgentPanelContext } from './transcriptAgentReveal.js'
import { SidePaneNavigationContext } from './sidePaneNavigationContext.js'
import { SidePaneShellContext } from './sidePaneShellContext.js'
import { paneFileIndex } from './transcriptPaneFiles.js'
import { useToast } from './toastContext.js'
import { localhostPreviewHostPort } from '../../shared/filePreview.js'
import type { DerivedSubagentDock, SubagentDockRow } from './subagentDockState.js'
import type { NestedToolUseRow, NestedTranscriptRow } from './transcriptProjector.js'
import './filePane.css'

const WORKSPACE_FIELDS = ['open', 'opened', 'file', 'scroll', 'lineTarget', 'visible', 'worker', 'output', 'browser', 'computer', 'screenActivity', 'width'] as const

export function SubagentWorkspace({ appSessionId, onFocusComposer, onStop, stopped = false, dock, collapsed, onCollapsedChange, onClearFinished, onDetailsVisibleChange, onFallback, onOpenWorkers, onLoadMissingHistory, rows, outputRows = rows, running = false, runKey = null, cwd, children }: {
  appSessionId?: string
  onFocusComposer?: () => void
  onStop?: () => void
  stopped?: boolean
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
  const shellHost = useContext(SidePaneShellContext)
  const toast = useToast()
  const localId = useId()
  const sessionId = appSessionId ?? `workspace:${localId}`
  const state = useFilePaneFields(sessionId, WORKSPACE_FIELDS)
  const navigationFailed = useCallback((message: string) => toast(message, { tone: 'warn' }), [toast])
  const navigation = useSidePaneNavigation(sessionId, navigationFailed)
  const files = useMemo(() => paneFileIndex({ rows: [], cwd, opened: state.opened }), [cwd, state.opened])
  const computerSteps = useMemo(() => selectComputerSteps(outputRows), [outputRows])
  const computerStep = selectComputerStep(computerSteps, state.computer?.selectedId ?? null)
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
  const selectedComputerStepId = state.visible === 'computer' ? computerStep?.id ?? null : null
  const computerContext = useMemo(() => ({
    openStep: openComputer,
    selectedStepId: selectedComputerStepId,
  }), [openComputer, selectedComputerStepId])
  const hideScreen = (kind: ScreenKind) => {
    hideScreenPane(sessionId, kind)
    requestAnimationFrame(() => {
      const chip = [...parent.current?.querySelectorAll<HTMLButtonElement>(`[data-dock-view="${kind}"]`) ?? []]
        .find(element => !element.closest('[inert]'))
      if (chip) chip.focus({ preventScroll: true })
      else focusComposer.current?.()
    })
  }
  const selected = state.worker
  const output = state.output
  const parent = useRef<HTMLDivElement>(null)
  const slot = useRef<HTMLDivElement>(null)
  const workspace = useRef<HTMLDivElement>(null)
  const [layoutWidth, setLayoutWidth] = useState(0)
  const portalled = !!shellHost && layoutWidth >= (state.open ? 1000 : 840)
  const portalledRef = useRef(portalled)
  portalledRef.current = portalled
  useLayoutEffect(() => {
    const element = workspace.current
    if (!element) return
    const measure = () => {
      const width = element.clientWidth + (portalledRef.current ? slot.current?.getBoundingClientRect().width ?? 0 : 0)
      setLayoutWidth(width)
      slot.current?.style.setProperty('--side-pane-layout-width', `${width}px`)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(element)
    return () => observer?.disconnect()
  }, [shellHost, portalled])
  const workers = useMemo(() => [...dock.active, ...dock.finished], [dock.active, dock.finished])
  const observed = selected ? workers.find(row => row.agentId === selected.agentId) : undefined
  const retained = useRef<{ selection: SubagentDockRow; row: SubagentDockRow } | null>(null)
  const candidate = observed ?? (retained.current?.selection === selected ? retained.current.row : selected)
  const worker = candidate && canOpenSubagentPanel(candidate, rows) ? candidate : null
  const branch = useMemo(() => selectSubagentPanelBranch(rows, worker?.toolUseId ?? null, worker?.runToolUseIds), [rows, worker?.toolUseId, worker?.runToolUseIds])
  const panelWorkers = useMemo(() => worker && !workers.some(row => row.agentId === worker.agentId) ? [...workers, worker] : workers, [workers, worker])
  const opener = useRef<HTMLElement | null>(null)
  const outputRow = useMemo(() => output ? findNestedToolUseRow(outputRows, output.id) : null, [outputRows, output?.id])
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
  }, [state.width, portalled])
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
  const closeOutput = useCallback(() => {
    hideSidePane(sessionId)
    const target = opener.current
    opener.current = null
    requestAnimationFrame(() => { if (target?.isConnected) target.focus({ preventScroll: true }) })
  }, [sessionId])
  const open = useCallback((row: SubagentDockRow) => {
    if (!canOpenSubagentPanel(row, rows)) { onFallback(row); return }
    updateFilePaneSession(sessionId, { worker: row })
    showSlotOccupant(sessionId, 'worker')
    if (!rows.some(candidate =>
      candidate.kind === 'tool-use' && candidate.toolUseId === row.toolUseId ||
      candidate.kind === 'orphaned-agent' && candidate.missingToolUseId === row.toolUseId)) onLoadMissingHistory?.()
  }, [sessionId, rows, onFallback, onLoadMissingHistory])
  const openCardRef = useRef((_card: NestedToolUseRow) => {})
  openCardRef.current = card => open(selectSubagentPanelRowForCard(card, workers))
  const openCard = useCallback((card: NestedToolUseRow) => openCardRef.current(card), [])
  const closeWorker = useCallback(() => {
    hideSidePane(sessionId)
    requestAnimationFrame(() => {
      const dock = parent.current
      const row = [...dock?.querySelectorAll<HTMLButtonElement>('[data-dock-row]') ?? []]
        .find(element => element.dataset.dockRow === worker?.agentId && !element.closest('[inert]'))
      const target = row ?? [...dock?.querySelectorAll<HTMLButtonElement>('.subagent-dock-chip:not([aria-hidden="true"]) [data-dock-agent]') ?? []]
        .find(element => element.dataset.dockAgent === worker?.agentId) ?? dock?.querySelector<HTMLButtonElement>('.subagent-dock-chip:not([aria-hidden="true"]) button, [data-finished-toggle]')
      if (target) target.focus({ preventScroll: true })
      else focusComposer.current?.()
    })
  }, [sessionId, worker?.agentId])
  // Switching the slot changes visibility, not the retained bodies or their
  // search/scroll state. Keep expensive transcripts and documents out of that commit.
  const workerPanel = useMemo(() => worker ? <SubagentSidePanel key={worker.agentId} worker={worker}
    workers={panelWorkers} {...branch} cwd={cwd} onSwitch={open} onClose={closeWorker} /> : null,
  [worker, panelWorkers, branch, cwd, open, closeWorker])
  const outputPanel = useMemo(() => output && outputRow ? <ToolInspector key={`${output.id}:${output.request}`} row={outputRow} cwd={cwd}
    embedded initialFileIndex={output.fileIndex} onClose={closeOutput} /> : null, [output, outputRow, cwd, closeOutput])
  const filePanel = useMemo(() => state.open ? <FilePane appSessionId={sessionId} cwd={cwd} onFocusComposer={onFocusComposer} /> : null,
    [state.open, sessionId, cwd, onFocusComposer])
  const occupants: Array<{ kind: SlotOccupant; label: string }> = [
    ...(state.open ? [{ kind: 'file' as const, label: state.file ? paneTargetLabel(state.file.path) : 'File' }] : []),
    ...(state.browser ? [{ kind: 'browser' as const, label: browserPaneLabel(state.browser) }] : []),
    ...(computerSteps.length ? [{ kind: 'computer' as const, label: 'Computer' }] : []),
    ...(worker ? [{ kind: 'worker' as const, label: worker.name || worker.task }] : []),
    ...(outputRow ? [{ kind: 'output' as const, label: 'Full output' }] : []),
  ]
  const toggleView = (kind: SlotOccupant) => {
    if (state.visible === kind) hideSidePane(sessionId)
    else showSlotOccupant(sessionId, kind)
  }
  const toggleWorker = (row: SubagentDockRow) => {
    if (state.visible === 'worker' && worker?.agentId === row.agentId) closeWorker()
    else open(row)
  }
  const openFile = (path: string) => {
    void requestOpenFile(sessionId, path, { focus: 'viewer' }).then(result => {
      if (!result.ok) toast(result.message, { tone: 'warn' })
    })
  }
  const currentComputerStep = running ? computerSteps.find(step => step.status === 'pending' && step.id === selectCurrentComputerStepId(rows)) : null
  const views: DockView[] = [
    ...(state.browser ? [{ kind: 'browser' as const, label: 'Browser', detail: state.browser.title || browserPaneLabel(state.browser) }] : []),
    ...(computerSteps.length ? [{ kind: 'computer' as const, label: 'Computer',
      detail: running ? currentComputerStep ? 'Using your Mac' : 'Between steps' : `${computerSteps.length} steps${computerSteps.some(step => step.status === 'error') ? ` · ${computerSteps.filter(step => step.status === 'error').length} failed` : ''}`,
      running: !!currentComputerStep }] : []),
    ...(outputRow ? [{ kind: 'output' as const, label: 'Full output', detail: typeof outputRow.input.command === 'string' ? outputRow.input.command : outputRow.toolName }] : []),
  ]
  const openedFiles = [...state.opened.keys()].reverse().flatMap(key => {
    const entry = files.find(file => file.key === key)
    return entry ? [{
    path: entry.path, name: entry.filename, parent: entry.parent,
    ...(state.file?.path === entry.path ? { renderKind: state.file.kind === 'text' && /\.(?:csv|tsv)$/i.test(entry.path) &&
      state.scroll.table?.mode !== 'source' && state.lineTarget === null ? 'table' as const : state.file.kind } : {}),
    }] : []
  })
  if (state.file?.kind === 'localhost') {
    const url = new URL(state.file.path)
    openedFiles.push({ path: state.file.path, name: localhostPreviewHostPort(state.file.path) ?? url.host,
      parent: `${url.pathname}${url.search}${url.hash}`, renderKind: 'localhost' })
  }
  const resize = (width: number) => {
    const clamped = clampToolOutputWidth(width, layoutWidth || null)
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
  const sidePane = occupants.length ? <div ref={slot} className="subagent-shared-slot" hidden={state.visible === null}>
          <div className="subagent-shared-resize" role="separator" aria-orientation="vertical" aria-label="Resize side panel"
            aria-valuenow={state.width ?? 560} aria-valuemin={TOOL_OUTPUT_MIN_WIDTH} tabIndex={0} data-dragging={dragging || undefined}
            onPointerDown={event => {
              if (event.button !== 0 || drag.current) return
              event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
              const width = slot.current?.getBoundingClientRect().width || state.width || 560
              drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, width, layoutWidth: layoutWidth || null }
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
          {workerPanel ? <div className="subagent-slot-content" hidden={state.visible !== 'worker'}>{workerPanel}</div> : null}
          {outputPanel ? <div className="subagent-slot-content" hidden={state.visible !== 'output'}>{outputPanel}</div> : null}
          {filePanel ? <div className="subagent-slot-content" hidden={state.visible !== 'file'}>{filePanel}</div> : null}
          {state.browser ? <div className="subagent-slot-content" hidden={state.visible !== 'browser'}><BrowserPane state={state.browser} active={state.visible === 'browser'} onHide={() => hideScreen('browser')} /></div> : null}
          {computerSteps.length ? <div className="subagent-slot-content" hidden={state.visible !== 'computer'}><ComputerPane steps={computerSteps}
            selectedId={state.computer?.selectedId ?? null} onSelect={openComputer} onClose={() => hideScreen('computer')} active={state.visible === 'computer'}
            running={running} stopped={stopped} currentStepId={selectCurrentComputerStepId(rows)} onStop={computerSteps.some(step => step.nested) ? undefined : onStop} /></div> : null}
        </div> : null
  return <FilePaneContext.Provider value={appSessionId ? requestOpenFile : null}><ToolOutputContext.Provider value={openOutput}><ComputerPaneContext.Provider value={computerContext}><SidePaneNavigationContext.Provider value={navigation}>
    <div ref={workspace} className="subagent-workspace" data-external-pane={portalled || undefined} data-resizing={dragging || undefined}>
      <div className="subagent-workspace-layout" data-file-open={!portalled && state.open && state.visible !== null || undefined}>
        <div ref={parent} className="subagent-parent">
          <SubagentDock state={dock} collapsed={collapsed} onCollapsedChange={onCollapsedChange}
            onClearFinished={onClearFinished} onDetailsVisibleChange={onDetailsVisibleChange}
            onOpenWorker={toggleWorker} onOpenWorkers={onOpenWorkers}
            views={views} files={openedFiles}
            selectedKind={state.visible} selectedFile={state.file?.path ?? null} selectedWorker={worker?.agentId ?? null}
            onOpenView={toggleView} onOpenFile={openFile}
            onToggleFile={() => state.open ? toggleView('file') : openedFiles[0] && openFile(openedFiles[0].path)} />
          <AgentPanelContext.Provider value={openCard}>{children}</AgentPanelContext.Provider>
        </div>
        {portalled ? createPortal(sidePane, shellHost!) : sidePane}
      </div>
    </div>
  </SidePaneNavigationContext.Provider></ComputerPaneContext.Provider></ToolOutputContext.Provider></FilePaneContext.Provider>
}
