import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PendingRoute } from './projectRoutingController.js'

export type RouteRecord = PendingRoute & { outcome: 'unsent' | 'unknown' | 'accepted' }
export interface ProjectRoutingStore {
  load(): RouteRecord[]
  save(records: RouteRecord[]): void
}

/** Private full-payload journal, separate from diagnostic exports. Publish before
 * handing a message to transport; a crash across that handoff is unknown. */
export class FileProjectRoutingStore implements ProjectRoutingStore {
  constructor(private readonly path: string) {}
  load(): RouteRecord[] {
    if (!existsSync(this.path)) return []
    const document = JSON.parse(readFileSync(this.path, 'utf8'))
    if (document.version !== 1 || !Array.isArray(document.records) || document.records.some((row: RouteRecord) =>
      !row || typeof row.sessionId !== 'string' || typeof row.submitId !== 'string' ||
      typeof row.sourceCwd !== 'string' || typeof row.routingText !== 'string' ||
      row.message?.type !== 'app.submit' || row.message.options?.submitId !== row.submitId ||
      !['unsent', 'unknown', 'accepted'].includes(row.outcome))) {
      throw new Error('Unreadable pending message record')
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
