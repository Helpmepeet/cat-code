import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { SubagentDock } from './SubagentDock.js'
import { SubagentSidePanel } from './SubagentSidePanel.js'
import { ToolInspector } from './ToolInspector.js'
import { ToolOutputContext, type OpenToolOutput } from './toolOutputPanel.js'
import { findNestedToolUseRow } from './transcriptViewModel.js'
import { canOpenSubagentPanel, selectSubagentPanelBranch, selectSubagentPanelRowForCard } from './subagentPanelState.js'
import { AgentPanelContext } from './transcriptAgentReveal.js'
import type { DerivedSubagentDock, SubagentDockRow } from './subagentDockState.js'
import type { NestedToolUseRow, NestedTranscriptRow } from './transcriptProjector.js'

export function SubagentWorkspace({ dock, collapsed, onCollapsedChange, onClearFinished, onDetailsVisibleChange, onFallback, onOpenWorkers, onLoadMissingHistory, rows, outputRows = rows, cwd, children }: {
  dock: DerivedSubagentDock
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
  onClearFinished: () => void
  onDetailsVisibleChange: (visible: boolean) => void
  onFallback: (row: SubagentDockRow) => void
  onOpenWorkers: () => void
  onLoadMissingHistory?: () => void
  rows: NestedTranscriptRow[]
  /** What the parent transcript paints, which can include the hidden tier. */
  outputRows?: NestedTranscriptRow[]
  cwd: string | null
  children: ReactNode
}) {
  const [selected, setSelected] = useState<SubagentDockRow | null>(null)
  const parent = useRef<HTMLDivElement>(null)
  const workers = [...dock.active, ...dock.finished]
  const observed = selected ? workers.find(row => row.agentId === selected.agentId) : undefined
  // A resume keeps the panel open; its earlier runs stay above the new steps.
  const candidate = observed ?? selected
  const worker = candidate && canOpenSubagentPanel(candidate, rows) ? candidate : null
  const branch = selectSubagentPanelBranch(rows, worker?.toolUseId ?? null, worker?.runToolUseIds)
  const slot = useRef<HTMLDivElement>(null)

  // The full-output panel shares this slot. It keeps only the row's id: the row
  // is re-derived from the live rows each render, so a late tool_result updates
  // the panel and a vanished row closes it rather than pinning the open-time
  // snapshot (F1). `request` re-keys the panel when a card asks again.
  const [output, setOutput] = useState<{ id: string; fileIndex: number; request: number } | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const outputRow = output ? findNestedToolUseRow(outputRows, output.id) : null
  useLayoutEffect(() => {
    if (output && !outputRow) setOutput(null)
  }, [output, outputRow])
  const openOutput = useCallback<OpenToolOutput>((row, fileIndex = 0) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setOutput(current => ({ id: row.id, fileIndex, request: (current?.request ?? 0) + 1 }))
  }, [])
  const closeOutput = () => {
    setOutput(null)
    setSelected(null)
    const target = opener.current
    opener.current = null
    requestAnimationFrame(() => { if (target?.isConnected) target.focus({ preventScroll: true }) })
  }
  const backToWorker = () => {
    setOutput(null)
    opener.current = null
    requestAnimationFrame(() => slot.current?.querySelector<HTMLButtonElement>('.subagent-side-close')?.focus({ preventScroll: true }))
  }

  useLayoutEffect(() => {
    if (!selected) return
    if (!worker) {
      setSelected(null)
      onFallback(observed ?? selected)
    } else if (observed && observed !== selected) {
      // Finished retention can evict the row while its transcript is still open.
      setSelected(observed)
    }
  }, [selected, observed, worker, onFallback])

  const open = (row: SubagentDockRow) => {
    setOutput(null)
    if (!canOpenSubagentPanel(row, rows)) { setSelected(null); onFallback(row); return }
    setSelected(row)
    if (!rows.some(candidate =>
      candidate.kind === 'tool-use' && candidate.toolUseId === row.toolUseId ||
      candidate.kind === 'orphaned-agent' && candidate.missingToolUseId === row.toolUseId)) onLoadMissingHistory?.()
  }
  const openCardRef = useRef((_card: NestedToolUseRow) => {})
  openCardRef.current = card => open(selectSubagentPanelRowForCard(card, workers))
  // Stable, so streaming dock updates do not re-render every Agent card.
  const openCard = useCallback((card: NestedToolUseRow) => openCardRef.current(card), [])
  return <ToolOutputContext.Provider value={openOutput}><div className="subagent-workspace">
    <div className="subagent-workspace-layout">
      <div ref={parent} className="subagent-parent">
        <SubagentDock state={dock} collapsed={collapsed} hidden={worker !== null} onCollapsedChange={onCollapsedChange}
          onClearFinished={onClearFinished} onDetailsVisibleChange={onDetailsVisibleChange}
          onOpenWorker={open} onOpenWorkers={onOpenWorkers} />
        <AgentPanelContext.Provider value={openCard}>{children}</AgentPanelContext.Provider>
      </div>
      {/* Kept mounted under an open output panel, so Back returns to the same
        * scroll position rather than a fresh one. */}
      {worker ? <div ref={slot} className="subagent-side-slot" hidden={outputRow !== null}><SubagentSidePanel key={worker.agentId} worker={worker}
        workers={workers.some(row => row.agentId === worker.agentId) ? workers : [...workers, worker]}
        {...branch} cwd={cwd} onSwitch={open} onClose={() => {
          setSelected(null)
          requestAnimationFrame(() => {
            const dock = parent.current
            const row = [...dock?.querySelectorAll<HTMLButtonElement>('[data-dock-row]') ?? []]
              .find(element => element.dataset.dockRow === worker.agentId && !element.closest('[inert]'))
            const target = row ?? dock?.querySelector<HTMLButtonElement>('.subagent-dock-chip:not([aria-hidden="true"]), [data-finished-toggle]')
            target?.focus({ preventScroll: true })
          })
        }} /></div> : null}
      {output && outputRow ? <ToolInspector key={`${output.id}:${output.request}`} row={outputRow} cwd={cwd}
        initialFileIndex={output.fileIndex} onClose={closeOutput}
        back={worker ? { label: worker.name || worker.task, onBack: backToWorker } : null} /> : null}
    </div>
  </div></ToolOutputContext.Provider>
}
