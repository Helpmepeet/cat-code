import { randomUUID } from 'node:crypto'
import { parse } from 'acorn'
import type { ContextualScriptGrant } from '../../utils/permissions/contextualAuthorization.js'
import type { CodeModeCall } from './codeModeDispatch.js'

export const MAX_AUTO_SCRIPT_REVIEW_CHARS = 32_000

export type ScriptCellReceipt = {
  cell: number
  children: { tool: string; line?: number; outcome: 'completed' | 'refused' | 'unknown' }[]
}

function isInertSource(source: string): boolean {
  try {
    return parse(source, { ecmaVersion: 'latest', allowAwaitOutsideFunction: true }).body.every(node =>
      node.type === 'EmptyStatement' || (node.type === 'ExpressionStatement' && node.directive !== undefined))
  } catch {
    return false
  }
}

// The host serializes whole cells, including background cells, in evaluation order.
export class ScriptReviewHistory {
  private sources: { cell: number; source: string; characters: number; stateful?: true }[] = []
  private receipts: { value: ScriptCellReceipt; characters: number }[] = []
  private sourceCharacters = 0
  private receiptCharacters = 0
  private cell = 0
  private earlierCellsOmitted = false
  unavailableReason?: string

  constructor(readonly generation: string) {}

  startCell(cellId: string, source: string): ContextualScriptGrant {
    if (!this.unavailableReason) {
      const characters = Math.max(1, source.length)
      if (this.sourceCharacters + characters > MAX_AUTO_SCRIPT_REVIEW_CHARS) {
        this.unavailableReason = 'The current Script and retained cell source exceed the 32,000-character Auto Mode review limit.'
        this.sources = []
        this.receipts = []
      } else {
        this.sources.push({ cell: ++this.cell, source, characters })
        this.sourceCharacters += characters
        this.fitReceipts()
      }
    }
    return { cellId, generation: this.generation, history: this }
  }

  finishCell(
    covered: boolean,
    calls: readonly CodeModeCall[],
    completed: ReadonlySet<string>,
    permissionFailures: ReadonlyMap<CodeModeCall, string>,
  ): void {
    if (this.unavailableReason) return
    if (covered) {
      // Prior coverage says nothing about what the interpreter still holds.
      this.sources = this.sources.filter(entry => {
        if (entry.stateful) return true
        if (!isInertSource(entry.source)) {
          entry.stateful = true
          return true
        }
        this.sourceCharacters -= entry.characters
        return false
      })
    }
    if (!calls.length) return
    const value: ScriptCellReceipt = {
      cell: this.cell,
      children: calls.map(call => ({
        tool: call.name,
        ...(call.line === undefined ? {} : { line: call.line }),
        outcome: completed.has(call.toolUseId) ? 'completed' : permissionFailures.has(call) ? 'refused' : 'unknown',
      })),
    }
    const characters = JSON.stringify(value).length + 1
    this.receipts.push({ value, characters })
    this.receiptCharacters += characters
    this.fitReceipts()
  }

  reviewEvidence(): { source: string; earlierCells?: ScriptCellReceipt[]; earlierCellsOmitted?: true } {
    const nonce = randomUUID()
    const count = this.sources.length
    const source = this.sources.map((entry, i) => {
      const role = i + 1 === count ? 'current cell' : 'earlier cell'
      return `[${nonce} Script ${i + 1} of ${count}; notebook cell ${entry.cell}; ${role}]\n${entry.source}`
    }).join('\n')
    return {
      source,
      ...(this.receipts.length && { earlierCells: this.receipts.map(receipt => receipt.value) }),
      ...(this.earlierCellsOmitted && { earlierCellsOmitted: true }),
    }
  }

  private fitReceipts(): void {
    while (this.sourceCharacters + this.receiptCharacters > MAX_AUTO_SCRIPT_REVIEW_CHARS) {
      const oldest = this.receipts.shift()!
      this.receiptCharacters -= oldest.characters
      this.earlierCellsOmitted = true
    }
  }
}
