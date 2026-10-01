import { useLayoutEffect, useRef, useState } from 'react'
import type { WorkspaceMoveDisplay } from '../../shared/hostApi.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'

/** Ignore malformed or future display variants without touching transcript state. */
export function readWorkspaceMoveDisplay(value: unknown): WorkspaceMoveDisplay | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  const string = (item: unknown, max: number): item is string => typeof item === 'string' && item.length > 0 && item.length <= max
  if (!string(v.id, 128) || (typeof v.phase !== 'string' || !['moving', 'arrived', 'failed', 'stopped'].includes(v.phase)) ||
      !v.target || typeof v.target !== 'object') return null
  const target = v.target as Record<string, unknown>
  if ((typeof target.kind !== 'string' || !['project', 'chat'].includes(target.kind)) || !string(target.name, 256) ||
      (target.kind === 'project' ? !string(target.path, 4096) : target.path !== null) ||
      (target.displayPath !== undefined && !string(target.displayPath, 4096)) ||
      (v.transitionId !== undefined && !string(v.transitionId, 256)) ||
      (v.afterFrameId !== undefined && v.afterFrameId !== null && !string(v.afterFrameId, 256)) ||
      (v.toolUseId !== undefined && !string(v.toolUseId, 256)) ||
      (v.replacedNotice !== undefined && !string(v.replacedNotice, 512)) ||
      (v.agentJump !== undefined && v.agentJump !== true)) return null
  return value as WorkspaceMoveDisplay
}

const filteredRows = new WeakMap<NestedTranscriptRow[], NestedTranscriptRow[]>()
/** Hide workspace plumbing before grouping, including any nested tool cards. */
export function withoutWorkspaceTools(rows: NestedTranscriptRow[]): NestedTranscriptRow[] {
  const cached = filteredRows.get(rows)
  if (cached) return cached
  const result: NestedTranscriptRow[] = []
  for (const row of rows) {
    if (row.kind === 'tool-use' && (row.toolName === 'ListWorkspaces' || row.toolName === 'JumpWorkspace')) continue
    const children = withoutWorkspaceTools(row.children)
    result.push(children === row.children ? row : { ...row, children })
  }
  const unchanged = result.length === rows.length && result.every((row, index) => row === rows[index])
  const value = unchanged ? rows : result
  filteredRows.set(rows, value)
  return value
}

/** A live seam retains its acceptance anchor through replay and settlement. */
export function useWorkspaceMoveView(
  move: WorkspaceMoveDisplay | null,
  rows: readonly NestedTranscriptRow[],
  live: boolean,
) {
  const previous = useRef(move)
  const committed = useRef(false)
  const armed = useRef<string | null>(null)
  const played = useRef(new Set<string>())
  const anchor = useRef<{ id: string; frameId: string | null } | null>(null)
  const [arriving, setArriving] = useState<string | null>(null)
  const arrivalElement = useRef<{ id: string; element: HTMLElement } | null>(null)
  if (move && anchor.current?.id !== move.id) {
    const tool = move.toolUseId ? rows.find(row => row.kind === 'tool-use' && row.toolUseId === move.toolUseId)
      : move.agentJump ? [...rows].reverse().find(row => row.kind === 'tool-use' && row.toolName === 'JumpWorkspace') : undefined
    anchor.current = {
      id: move.id,
      frameId: move.afterFrameId !== undefined ? move.afterFrameId : tool?.frameId ?? rows.at(-1)?.frameId ?? null,
    }
  }
  useLayoutEffect(() => {
    if (committed.current && live && move?.phase === 'moving' &&
        (previous.current?.id !== move.id || previous.current.phase !== 'moving')) armed.current = move.id
    if (live && move?.phase === 'arrived' && armed.current === move.id && !played.current.has(move.id)) {
      armed.current = null
      played.current.add(move.id)
      if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) setArriving(move.id)
    }
    previous.current = move
    committed.current = true
  }, [move, live])
  useLayoutEffect(() => {
    if (!arriving) return
    const timeout = setTimeout(() => setArriving(null), 1800)
    return () => clearTimeout(timeout)
  }, [arriving])
  const claimArrival = (element: HTMLElement) => {
    if (!arriving) return
    const claimed = arrivalElement.current
    if (claimed?.id === arriving && claimed.element !== element) {
      setArriving(null)
      return
    }
    arrivalElement.current = { id: arriving, element }
  }
  return { anchorFrameId: anchor.current?.frameId ?? null, arriving: move?.id === arriving, claimArrival }
}

/** The host names the terminal notice it replaces; uncertain notices stay visible. */
export function withoutReplacedMoveNotice(rows: NestedTranscriptRow[], move: WorkspaceMoveDisplay | null): NestedTranscriptRow[] {
  if (!move?.replacedNotice) return rows
  let index = -1
  for (let at = rows.length - 1; at >= 0; at--) {
    const row = rows[at]!
    if (row.kind === 'system-notice' && row.noticeType === 'local_command_output' && row.content === move.replacedNotice) { index = at; break }
  }
  return index < 0 ? rows : rows.filter((_, at) => at !== index)
}
