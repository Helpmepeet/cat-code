import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SidecarClientMessage } from '../shared/protocol.js'
import type { ProjectRouteSnapshot } from '../shared/projectRouting.js'

type RoutedSubmit = Extract<SidecarClientMessage, { type: 'app.submit' }> & {
  options?: NonNullable<Extract<SidecarClientMessage, { type: 'app.submit' }>['options']> & {
    submitId?: string
  }
}

/** Legacy classifier fields remain readable so saved input can be recovered. */
export type RouteRecord = {
  sessionId: string
  submitId: string
  message: RoutedSubmit
  routingText: string
  sourceCwd: string
  phase: ProjectRouteSnapshot['phase'] | 'checking' | 'ask' | 'moving'
  decision: { kind: 'auto' | 'ask'; cwd: string; name: string; explicit: boolean } | null
  messageText: string | null
  outcome: 'unsent' | 'unknown' | 'accepted'
}
export interface ProjectRoutingStore {
  load(): RouteRecord[]
  loadForRecovery?(): RouteRecord[]
  save(records: RouteRecord[]): void
}

/** Private full-payload journal, separate from diagnostic exports. Publish before
 * handing a message to transport; a crash across that handoff is unknown. */
export class FileProjectRoutingStore implements ProjectRoutingStore {
  constructor(private readonly path: string) {}
  load(): RouteRecord[] {
    return this.read(true)
  }
  loadForRecovery(): RouteRecord[] {
    return this.read(false)
  }
  private read(allowMissing: boolean): RouteRecord[] {
    let bytes: string
    try { bytes = readFileSync(this.path, 'utf8') } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const document = JSON.parse(bytes)
    if (!document || document.version !== 1 || !Array.isArray(document.records) || document.records.some((row: RouteRecord) =>
      !row || typeof row.sessionId !== 'string' || typeof row.submitId !== 'string' ||
      typeof row.sourceCwd !== 'string' || typeof row.routingText !== 'string' ||
      row.message?.type !== 'app.submit' || row.message.options?.submitId !== row.submitId ||
      typeof row.message.requestId !== 'string' ||
      !(typeof row.message.prompt === 'string' || Array.isArray(row.message.prompt)) ||
      !['checking', 'ask', 'moving', 'unsent', 'uncertain', 'recovery', 'failed'].includes(row.phase) ||
      !(row.decision === null || (typeof row.decision === 'object' &&
        typeof row.decision.cwd === 'string' && typeof row.decision.name === 'string' &&
        typeof row.decision.explicit === 'boolean' && ['auto', 'ask'].includes(row.decision.kind))) ||
      !['unsent', 'unknown', 'accepted'].includes(row.outcome))) {
      throw new Error('Unreadable pending message record')
    }
    const sessions = new Set<string>()
    for (const row of document.records as RouteRecord[]) {
      if (sessions.has(row.sessionId)) throw new Error('Duplicate pending message record')
      sessions.add(row.sessionId)
    }
    return document.records
  }
  save(records: RouteRecord[]): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(fd, JSON.stringify({ version: 1, records }))
      fsyncSync(fd)
    } finally { closeSync(fd) }
    renameSync(temporary, this.path)
    const directory = openSync(dirname(this.path), 'r')
    try { fsyncSync(directory) } finally { closeSync(directory) }
  }
}
