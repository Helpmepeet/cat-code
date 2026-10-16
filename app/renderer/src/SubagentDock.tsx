import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { AgentFace, AgentTypeLabel, Baton } from './AgentChrome.js'
import { useAgentFaceRegistry } from './agentFace.js'
import { useEntranceLatch, useEntranceOnChange } from './entranceLatch.js'
import { subagentDockLayout, placeSubagentTooltip } from './subagentDockLayout.js'
import { animateDockMorph, animateDockReorder, dockMorphStart, dockRowRects, type DockMorphStart } from './subagentDockMotion.js'
import type { DerivedSubagentDock, SubagentDockRow } from './subagentDockState.js'

type Tip = { agentId: string; mode: 'row' | 'chip'; anchor: HTMLElement; hiding?: boolean }

export function SubagentDock({ state, collapsed, onCollapsedChange, onClearFinished, onOpenWorker, onOpenWorkers, onDetailsVisibleChange }: {
  state: DerivedSubagentDock
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
  onClearFinished: () => void
  onOpenWorker: (row: SubagentDockRow) => void
  onOpenWorkers: () => void
  onDetailsVisibleChange?: (visible: boolean) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const chip = useRef<HTMLButtonElement>(null)
  const tooltip = useRef<HTMLDivElement>(null)
  const pane = useRef<HTMLElement | null>(null)
  const [geometry, setGeometry] = useState({ width: 0, height: 0, transcriptWidth: 900 })
  const [floating, setFloating] = useState(false)
  const [finishedOpen, setFinishedOpen] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(() => typeof window !== 'undefined' && (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false))
  const [morphing, setMorphing] = useState(false)
  const pendingMorph = useRef<{ start: DockMorphStart; opening: boolean } | null>(null)
  const cancelMorph = useRef<(() => void) | null>(null)
  const pendingFocus = useRef<boolean | null>(null)
  const previousRects = useRef(new Map<string, DOMRect>())
  const [tip, setTip] = useState<Tip | null>(null)
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tipId = useId()
  const panelId = useId()
  const finishedId = useId()
  const [announcement, setAnnouncement] = useState('')
  const previousStates = useRef<Map<string, string> | null>(null)
  const rows = [...state.active, ...state.finished]
  const freshResumes = new Set(rows.filter(row => row.state === 'resumed' && previousStates.current !== null && previousStates.current.get(row.agentId) !== `${row.state}:${row.runKey}:${row.resumedAt ?? ''}`).map(row => row.agentId))
  const hasRows = rows.length > 0
  const { flat, fits } = subagentDockLayout(geometry.width, geometry.transcriptWidth)
  const expanded = fits && ((flat && !collapsed) || floating)
  const panelShown = expanded || morphing
  const hasChip = state.chipFaces.length > 0
  const visibleFaces = state.chipFaces.slice(0, Math.max(1, Math.min(6, Math.floor((geometry.width - 74) / 19))))
  const more = state.chipFaces.length - visibleFaces.length
  const tipRow = tip ? rows.find(row => row.agentId === tip.agentId) : null

  const detailsVisible = tip !== null && !!tipRow && !tip.hiding
  useEffect(() => {
    onDetailsVisibleChange?.(detailsVisible)
    return () => onDetailsVisibleChange?.(false)
  }, [detailsVisible, onDetailsVisibleChange])

  useLayoutEffect(() => {
    const parent = root.current?.parentElement
    if (!parent) return
    pane.current = parent
    const measure = () => {
      const box = parent.getBoundingClientRect()
      const columnWidth = Number.parseFloat(getComputedStyle(parent).getPropertyValue('--transcript-width')) || 900
      setGeometry({ width: box.width, height: box.height, transcriptWidth: columnWidth })
      root.current?.style.setProperty('--subagent-dock-height', `${Math.max(0, box.height - 24)}px`)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(parent)
    return () => { observer?.disconnect(); pane.current = null }
  }, [hasRows])

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!media) return
    const change = () => setReducedMotion(media.matches)
    media.addEventListener?.('change', change)
    return () => media.removeEventListener?.('change', change)
  }, [])

  useEffect(() => {
    const next = new Map(rows.map(row => [row.agentId, `${row.state}:${row.runKey}:${row.resumedAt ?? ''}`]))
    const announcements: string[] = []
    if (previousStates.current) {
      for (const row of rows) {
        if (next.get(row.agentId) === previousStates.current.get(row.agentId)) continue
        const word = row.state === 'resumed' ? 'resumed' : row.state === 'failed' ? 'failed' : row.state === 'completed' || row.state === 'stopped' ? 'finished' : null
        if (word) announcements.push(`${row.name || row.task || 'Subagent'} ${word}.`)
      }
    }
    previousStates.current = next
    if (announcements.length) setAnnouncement(announcements.join(' '))
  }, [state])

  const clearTipTimer = () => {
    if (tipTimer.current) clearTimeout(tipTimer.current)
    tipTimer.current = null
  }
  const closeTip = (immediate = false) => {
    clearTipTimer()
    if (immediate || reducedMotion) { setTip(null); return }
    tipTimer.current = setTimeout(() => {
      setTip(current => current ? { ...current, hiding: true } : null)
      tipTimer.current = setTimeout(() => setTip(null), 140)
    }, 100)
  }
  const showTip = (row: SubagentDockRow, anchor: HTMLElement, mode: Tip['mode']) => {
    clearTipTimer()
    if (morphing) return
    if (mode === 'row' && !row.stripLines.some(Boolean)) return
    setTip({ agentId: row.agentId, anchor, mode })
  }
  const changeExpanded = (opening: boolean) => {
    if (morphing) return
    closeTip(true)
    if (opening && !fits) { onOpenWorkers(); return }
    if (!reducedMotion && chip.current) {
      pendingMorph.current = { start: dockMorphStart(chip.current), opening }
      setMorphing(true)
    }
    if (flat) { setFloating(false); onCollapsedChange(!opening) }
    else setFloating(opening)
    if (reducedMotion) pendingFocus.current = opening
  }

  useLayoutEffect(() => {
    const pending = pendingMorph.current
    if (!pending || !root.current || !panel.current || pending.opening !== expanded) return
    pendingMorph.current = null
    cancelMorph.current?.()
    cancelMorph.current = animateDockMorph(root.current, panel.current, pending.start, pending.opening, () => {
      cancelMorph.current = null
      pendingFocus.current = pending.opening
      setMorphing(false)
    })
  })

  useLayoutEffect(() => {
    if (morphing || pendingFocus.current === null) return
    const opening = pendingFocus.current
    pendingFocus.current = null
    if (opening) panel.current?.querySelector<HTMLButtonElement>('[data-dock-row], [data-finished-toggle]')?.focus()
    else chip.current?.focus()
  })

  useLayoutEffect(() => {
    if (!panel.current) return
    const cancel = !reducedMotion && expanded && !morphing ? animateDockReorder(panel.current, previousRects.current) : () => {}
    previousRects.current = dockRowRects(panel.current)
    return cancel
  }, [state, finishedOpen, expanded, morphing, reducedMotion])

  useLayoutEffect(() => {
    const element = tooltip.current
    const parent = pane.current
    const dock = root.current
    if (tip && (!tipRow || !tip.anchor.isConnected || tip.anchor.closest('[inert]') ||
        tip.mode === 'chip' && !state.chipFaces.some(row => row.agentId === tip.agentId))) { setTip(null); return }
    if (!tip || !tipRow || !element || !parent || !dock) return
    const place = () => {
      const anchorBox = tip.anchor.getBoundingClientRect()
      const paneBox = parent.getBoundingClientRect()
      const listBox = panel.current?.querySelector('.subagent-dock-list')?.getBoundingClientRect()
      if (anchorBox.width > 0 && anchorBox.height > 0 && (anchorBox.bottom <= paneBox.top || anchorBox.top >= paneBox.bottom || (tip.mode === 'row' && listBox && listBox.height > 0 && (anchorBox.bottom <= listBox.top || anchorBox.top >= listBox.bottom)))) {
        setTip(null)
        return
      }
      const origin = dock.getBoundingClientRect()
      // Measure the natural border box, not the previous placement's inner size.
      element.style.width = ''
      element.style.height = ''
      element.style.maxHeight = ''
      element.classList.remove('subagent-dock-tip-attached')
      const box = placeSubagentTooltip(paneBox, anchorBox, Math.min(element.offsetWidth || 300, tip.mode === 'row' ? 300 : 260), element.offsetHeight || (tip.mode === 'row' ? 50 : 70), tip.mode === 'row')
      element.classList.toggle('subagent-dock-tip-attached', box.attached)
      tip.anchor.classList.toggle('subagent-dock-row-tipped', box.attached && tip.mode === 'row')
      element.style.left = `${box.left - origin.left}px`
      element.style.top = `${box.top - origin.top}px`
      element.style.width = `${box.width}px`
      element.style.height = box.attached ? `${box.height}px` : ''
      element.style.maxHeight = `${Math.max(0, paneBox.height - 16)}px`
    }
    place()
    panel.current?.addEventListener('scroll', place, true)
    const currentPanel = panel.current
    return () => {
      currentPanel?.removeEventListener('scroll', place, true)
      tip.anchor.classList.remove('subagent-dock-row-tipped')
    }
  }, [tip, tipRow, geometry, finishedOpen, state.chipFaces])

  useEffect(() => {
    if (!hasRows) return
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (tip) closeTip(true)
      else if (floating) changeExpanded(false)
    }
    const outside = (event: MouseEvent) => {
      if (floating && event.target instanceof Node && !root.current?.contains(event.target)) changeExpanded(false)
    }
    document.addEventListener('keydown', key)
    document.addEventListener('mousedown', outside)
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('mousedown', outside) }
  })

  useEffect(() => {
    if (!reducedMotion && hasChip) return
    cancelMorph.current?.()
    cancelMorph.current = null
    pendingMorph.current = null
    setMorphing(false)
  }, [reducedMotion, hasChip])
  useEffect(() => () => { cancelMorph.current?.(); if (tipTimer.current) clearTimeout(tipTimer.current) }, [])

  if (!hasRows) return null
  const chipLabel = `Subagents: ${visibleFaces.map(row => `${row.name || row.task || 'Subagent'}, ${row.state}`).join('; ')}${more > 0 ? `; ${more} more` : ''}`
  return (
    <div ref={root} className={`subagent-dock${flat ? ' subagent-dock-flat' : ''}${reducedMotion ? ' subagent-dock-reduced' : ''}`} data-layout={expanded ? flat ? 'panel' : 'floating' : 'chip'}>
      {hasChip ? <button ref={chip} type="button" className={`subagent-dock-chip${panelShown ? ' subagent-dock-hidden' : ''}`} aria-label={chipLabel} aria-expanded={expanded} aria-controls={fits ? panelId : undefined} aria-hidden={panelShown || undefined} tabIndex={panelShown ? -1 : 0} aria-describedby={tip?.mode === 'chip' ? tipId : undefined} onClick={() => changeExpanded(true)} onFocus={event => { const first = visibleFaces[0]; if (first) showTip(first, event.currentTarget, 'chip') }} onBlur={() => closeTip()} onMouseLeave={() => closeTip()}>
        {visibleFaces.map(row => <span key={row.agentId} className="subagent-dock-chip-slot" onMouseEnter={event => showTip(row, event.currentTarget, 'chip')}><DockFace row={row} /></span>)}
        {more > 0 ? <span className="subagent-dock-more">+{more}</span> : null}
      </button> : null}
      <div ref={panel} id={panelId} role="region" aria-label="Subagents" aria-hidden={!panelShown || undefined} inert={!expanded} className={`subagent-dock-panel${panelShown ? '' : ' subagent-dock-hidden'}${flat ? '' : ' subagent-dock-floating'}`}>
        <div className="subagent-dock-header"><span>SUBAGENTS</span><button type="button" aria-label="Collapse subagents" onClick={() => changeExpanded(false)}>⌃</button></div>
        <div className="subagent-dock-list">
          {[
            ...state.active.map(row => <div key={row.agentId} className="subagent-dock-row-wrapper"><DockRow row={row} arriving={freshResumes.has(row.agentId)} finished={false} reducedMotion={reducedMotion} describedBy={tip?.agentId === row.agentId && tip.mode === 'row' ? tipId : undefined} onOpen={onOpenWorker} onShow={showTip} onHide={closeTip} /></div>),
            ...(state.finished.length ? [<div key="finished-header" className="subagent-dock-finished-header"><button type="button" data-finished-toggle aria-expanded={finishedOpen} aria-controls={state.finished.map(row => `${finishedId}-${row.agentId}`).join(' ')} onClick={() => { closeTip(true); setFinishedOpen(open => !open) }}><span aria-hidden="true">{finishedOpen ? '⌄' : '›'}</span> Finished <span>{state.finished.length}</span></button><button type="button" onClick={onClearFinished}>Clear</button></div>] : []),
            ...state.finished.map(row => <div key={row.agentId} id={`${finishedId}-${row.agentId}`} className={`subagent-dock-row-wrapper subagent-dock-finished-row${finishedOpen ? '' : ' subagent-dock-finished-closed'}`} inert={!finishedOpen} aria-hidden={!finishedOpen || undefined}><DockRow row={row} arriving={false} finished reducedMotion={reducedMotion} describedBy={tip?.agentId === row.agentId && tip.mode === 'row' ? tipId : undefined} onOpen={onOpenWorker} onShow={showTip} onHide={closeTip} /></div>),
          ]}
        </div>
      </div>
      {tip && tipRow ? <div ref={tooltip} id={tipId} role="tooltip" className={`subagent-dock-tip subagent-dock-tip-${tip.mode}${tip.hiding ? ' subagent-dock-tip-hiding' : ''}`} onMouseEnter={() => { clearTipTimer(); setTip(current => current ? { ...current, hiding: false } : null) }} onMouseLeave={() => closeTip()}>
        {tip.mode === 'chip' ? <div className="subagent-dock-tip-who"><span>{tipRow.name || tipRow.task || 'Subagent'}</span><span>{tipRow.state}</span></div> : null}
        <div className="subagent-dock-tip-a">{(tip.mode === 'chip' ? tipRow.chipLines : tipRow.stripLines)[0]}</div>
        <div className="subagent-dock-tip-b">{(tip.mode === 'chip' ? tipRow.chipLines : tipRow.stripLines)[1]}</div>
      </div> : null}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
    </div>
  )
}

function DockFace({ row }: { row: SubagentDockRow }) {
  const face = useAgentFaceRegistry().faceFor(row.agentId, row.name)
  return <span className="subagent-dock-face" data-dock-face={row.agentId} aria-hidden="true"><AgentFace axes={face.axes} fill={face.fill} size={15} /><span className={`subagent-dock-badge subagent-dock-badge-${row.state}`} /></span>
}

function DockRow({ row, arriving, finished, reducedMotion, describedBy, onOpen, onShow, onHide }: {
  row: SubagentDockRow; arriving: boolean; finished: boolean; reducedMotion: boolean; describedBy?: string
  onOpen: (row: SubagentDockRow) => void
  onShow: (row: SubagentDockRow, anchor: HTMLElement, mode: Tip['mode']) => void
  onHide: () => void
}) {
  const arrivalKey = `${row.runKey}:${row.resumedAt ?? ''}`
  const arrival = useEntranceLatch(arriving && !reducedMotion ? new Set([arrivalKey]) : new Set<string>(), 1850)
  const arrivingNow = arrival.active.has(arrivalKey) && !reducedMotion
  const badge = useEntranceOnChange(row.state, !reducedMotion, 'subagent-dock-state-change')
  return <button type="button" ref={arrival.refFor(arrivalKey, 'subagent-dock-arrival')} onAnimationEnd={event => arrival.onAnimationEnd(arrivalKey, event)} data-dock-row={row.agentId} className={`subagent-dock-row${finished ? ' subagent-dock-row-finished' : ''}${arrivingNow ? ' subagent-dock-arrival' : ''}${row.settling ? ' subagent-dock-settling' : ''}`} aria-label={`${row.name || row.task || 'Subagent'}, ${row.state}`} aria-describedby={describedBy} onClick={() => onOpen(row)} onFocus={event => onShow(row, event.currentTarget, 'row')} onBlur={onHide} onMouseEnter={event => onShow(row, event.currentTarget, 'row')} onMouseLeave={onHide}>
    <span ref={badge.ref} onAnimationEnd={badge.onAnimationEnd} className={badge.active ? 'subagent-dock-state-change' : undefined}><DockFace row={row} /></span>
    <span className="subagent-dock-row-main"><span className="subagent-dock-line-a"><span className="subagent-dock-name">{row.name || row.task || 'Subagent'}</span>{row.stateWord && row.state !== 'running' && row.state !== 'background' ? <span className={`subagent-dock-detail subagent-dock-word subagent-dock-word-${row.state}`}>{row.stateWord}</span> : null}{row.state === 'waiting' ? <span className="subagent-dock-detail"><Baton owner="assistant" /></span> : row.rowModel ? <span className="subagent-dock-detail subagent-dock-model">{row.rowModel}</span> : null}</span><span className="subagent-dock-line-b subagent-dock-detail"><span className="subagent-dock-task">{row.name ? row.task : ''}</span><AgentTypeLabel role={row.type} /></span></span>
  </button>
}
