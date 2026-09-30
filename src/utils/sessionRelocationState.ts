/** Small, Node-compatible storage owner shared by desktop indexing and engine resume.
 * See docs/migration/decisions/CHAT-RELOCATION.md. No engine bootstrap imports.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isSessionBinding, type SessionBinding } from '../../app/shared/sessionBinding.js'

export type SessionLocation = { cwd: string; binding: SessionBinding }
export type RelocationRequest = {
  engineSessionId: string
  appSessionId: string
  source: SessionLocation
  target: SessionLocation
  controls: RelocationControls
  /** Host compensation after destination resume failed before the move committed. */
  rollback?: true
}
export type RelocationControls = {
  mode: 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'auto'
  model?: string | null
  effort?: string
  fastMode?: boolean
  prePlanMode?: 'default' | 'acceptEdits' | 'dontAsk' | 'auto'
}
export type SessionLocationTransition = {
  id: string
  afterFrameId: string | null
  source: SessionLocation
  target: SessionLocation
  movedAt: number
}
export type SessionRelocation = {
  version: 1
  engineSessionId: string
  appSessionId: string
  phase: 'moving' | 'complete'
  original: SessionLocation
  source: SessionLocation
  target: SessionLocation
  controls: RelocationControls
  backup: string
  movedAt: number
  /** A zero-turn conversation uses a fresh engine launch pinned to this id. */
  empty?: true
  /** Ordered history boundaries; absent on records created before repeated moves. */
  transitions?: SessionLocationTransition[]
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function relocationDirectory(): string {
  return join((process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.cat-code')).normalize('NFC'), 'session-relocations')
}
function recordPath(id: string): string {
  if (!UUID.test(id)) throw new Error('Invalid conversation identity')
  return join(relocationDirectory(), `${id}.json`)
}
function isLocation(value: unknown): value is SessionLocation {
  if (!value || typeof value !== 'object') return false
  const v = value as SessionLocation
  return typeof v.cwd === 'string' && isAbsolute(v.cwd) && isSessionBinding(v.binding)
}
function sameLocation(a: SessionLocation, b: SessionLocation): boolean {
  return a.cwd === b.cwd && JSON.stringify(a.binding) === JSON.stringify(b.binding)
}
function isTransition(value: unknown): value is SessionLocationTransition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as SessionLocationTransition
  return UUID.test(v.id) &&
    (v.afterFrameId === null || (typeof v.afterFrameId === 'string' && v.afterFrameId.length > 0 && v.afterFrameId.length <= 256)) &&
    isLocation(v.source) && isLocation(v.target) && !sameLocation(v.source, v.target) &&
    Number.isFinite(v.movedAt)
}
export function isRelocationControls(value: unknown): value is RelocationControls {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (Object.keys(v).some(key => key !== 'mode' && key !== 'model' && key !== 'effort' && key !== 'fastMode' && key !== 'prePlanMode')) return false
  return (v.mode === 'default' || v.mode === 'acceptEdits' || v.mode === 'plan' || v.mode === 'dontAsk' || v.mode === 'auto') &&
    (v.model === undefined || v.model === null || (typeof v.model === 'string' && v.model.length > 0 && v.model.length <= 256)) &&
    (v.effort === undefined || (typeof v.effort === 'string' && v.effort.length > 0 && v.effort.length <= 32)) &&
    (v.fastMode === undefined || typeof v.fastMode === 'boolean') &&
    (v.prePlanMode === undefined || ((v.mode === 'plan') &&
      (v.prePlanMode === 'default' || v.prePlanMode === 'acceptEdits' || v.prePlanMode === 'dontAsk' || v.prePlanMode === 'auto')))
}
export function readSessionRelocation(id: string): SessionRelocation | null {
  // Older transcript fixtures and imported sessions can use non-UUID keys.
  // They have no relocation record; only the move writer requires a UUID.
  if (!UUID.test(id)) return null
  let text: string
  try { text = readFileSync(recordPath(id), 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const v = JSON.parse(text) as SessionRelocation
  if (!v || typeof v !== 'object' || v.version !== 1 || v.engineSessionId !== id || !UUID.test(v.appSessionId) ||
      (v.phase !== 'moving' && v.phase !== 'complete') || !isLocation(v.original) ||
      v.original.binding.kind !== 'managed' || !isLocation(v.source) || !isLocation(v.target) ||
      v.source.cwd === v.target.cwd ||
      (!(v.source.binding.kind === 'managed' && v.target.binding.kind === 'project' && sameLocation(v.source, v.original)) &&
       !(v.source.binding.kind === 'project' && v.target.binding.kind === 'managed' && sameLocation(v.target, v.original))) ||
      !isRelocationControls(v.controls) || (v.empty !== undefined && v.empty !== true) ||
      typeof v.backup !== 'string' || !isAbsolute(v.backup) || !Number.isFinite(v.movedAt) ||
      (v.transitions !== undefined && (!Array.isArray(v.transitions) || v.transitions.length > 4096 ||
        !v.transitions.every(isTransition) ||
        (v.phase === 'complete' && v.transitions.length > 0 && !sameLocation(v.transitions[v.transitions.length - 1]!.target, v.target))))) {
    throw new Error('Conversation move record could not be read')
  }
  return v
}

export function assertSessionNotMoving(id: string): void {
  if (readSessionRelocation(id)?.phase === 'moving') {
    throw new Error('This conversation has an unfinished move. Restore its saved backup before reopening it.')
  }
}

/** Atomic publication and directory fsync keep the stop record ahead of renames. */
export function writeSessionRelocation(record: SessionRelocation): void {
  if (!isRelocationControls(record.controls)) throw new Error('Invalid conversation move controls')
  if (record.transitions !== undefined && (!Array.isArray(record.transitions) || record.transitions.length > 4096 ||
      !record.transitions.every(isTransition) ||
      (record.phase === 'complete' && record.transitions.length > 0 &&
        !sameLocation(record.transitions[record.transitions.length - 1]!.target, record.target)))) {
    throw new Error('Invalid conversation move transitions')
  }
  const dir = relocationDirectory()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temp = join(dir, `${record.engineSessionId}.${randomUUID()}.tmp`)
  const fd = openSync(temp, 'wx', 0o600)
  try { writeFileSync(fd, `${JSON.stringify(record)}\n`); fsyncSync(fd) }
  finally { closeSync(fd) }
  renameSync(temp, recordPath(record.engineSessionId))
  const parent = openSync(dir, 'r')
  try { fsyncSync(parent) } finally { closeSync(parent) }
}
