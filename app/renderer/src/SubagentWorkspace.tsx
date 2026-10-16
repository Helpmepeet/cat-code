import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { SubagentDock } from './SubagentDock.js'
import { SubagentSidePanel } from './SubagentSidePanel.js'
import { canOpenSubagentPanel, selectSubagentPanelBranch } from './subagentPanelState.js'
import type { DerivedSubagentDock, SubagentDockRow } from './subagentDockState.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'

export function SubagentWorkspace({ dock, collapsed, onCollapsedChange, onClearFinished, onDetailsVisibleChange, onFallback, onOpenWorkers, onLoadMissingHistory, rows, cwd, children }: {
  dock: DerivedSubagentDock
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
  onClearFinished: () => void
  onDetailsVisibleChange: (visible: boolean) => void
  onFallback: (row: SubagentDockRow) => void
  onOpenWorkers: () => void
  onLoadMissingHistory?: () => void
  rows: NestedTranscriptRow[]
  cwd: string | null
  children: ReactNode
}) {
  const [selected, setSelected] = useState<SubagentDockRow | null>(null)
  const parent = useRef<HTMLDivElement>(null)
  const workers = [...dock.active, ...dock.finished]
  const observed = selected ? workers.find(row => row.agentId === selected.agentId) : undefined
  const changedRun = selected !== null && observed !== undefined && observed.runKey !== selected.runKey
  const candidate = changedRun ? null : observed ?? selected
  const worker = candidate && canOpenSubagentPanel(candidate, rows) ? candidate : null
  const branch = selectSubagentPanelBranch(rows, worker?.toolUseId ?? null)

  useLayoutEffect(() => {
    if (!selected) return
    if (changedRun || !worker) {
      setSelected(null)
      onFallback(observed ?? selected)
    } else if (observed && observed !== selected) {
      // Finished retention can evict the row while its transcript is still open.
      setSelected(observed)
    }
  }, [selected, observed, changedRun, worker, onFallback])

  const open = (row: SubagentDockRow) => {
    if (!canOpenSubagentPanel(row, rows)) { setSelected(null); onFallback(row); return }
    setSelected(row)
    if (!rows.some(candidate =>
      candidate.kind === 'tool-use' && candidate.toolUseId === row.toolUseId ||
      candidate.kind === 'orphaned-agent' && candidate.missingToolUseId === row.toolUseId)) onLoadMissingHistory?.()
  }
  return <div className="subagent-workspace">
    <div ref={parent} className="subagent-parent">
      <SubagentDock state={dock} collapsed={collapsed} hidden={worker !== null} onCollapsedChange={onCollapsedChange}
        onClearFinished={onClearFinished} onDetailsVisibleChange={onDetailsVisibleChange}
        onOpenWorker={open} onOpenWorkers={onOpenWorkers} />
      {children}
    </div>
    {worker ? <SubagentSidePanel key={`${worker.agentId}:${worker.runKey}`} worker={worker}
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
      }} /> : null}
  </div>
}
