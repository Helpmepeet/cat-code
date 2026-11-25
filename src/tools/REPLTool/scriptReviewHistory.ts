import { parse } from 'acorn'
import type { ContextualScriptGrant } from '../../utils/permissions/contextualAuthorization.js'
import type { CodeModeCall } from './codeModeDispatch.js'

export type ScriptCellSource = { cell: number; source: string }

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
  private sources: { value: ScriptCellSource; inert: boolean }[] = []
  private receipts: ScriptCellReceipt[] = []
  private current: ScriptCellSource | undefined
  private cell = 0

  constructor(readonly generation: string) {}

  startCell(cellId: string, source: string): ContextualScriptGrant {
    this.current = { cell: ++this.cell, source }
    return { cellId, generation: this.generation, history: this }
  }

  finishCell(
    covered: boolean,
    calls: readonly CodeModeCall[],
    completed: ReadonlySet<string>,
    permissionFailures: ReadonlyMap<CodeModeCall, string>,
  ): void {
    const current = this.current!
    const inert = isInertSource(current.source)
    if (covered) {
      // Prior coverage says nothing about what the interpreter still holds.
      this.sources = this.sources.filter(entry => !entry.inert)
    }
    if (!covered || !inert) this.sources.push({ value: current, inert })
    this.current = undefined
    if (!calls.length) return
    this.receipts.push({
      cell: current.cell,
      children: calls.map(call => ({
        tool: call.name,
        ...(call.line === undefined ? {} : { line: call.line }),
        outcome: completed.has(call.toolUseId) ? 'completed' : permissionFailures.has(call) ? 'refused' : 'unknown',
      })),
    })
  }

  reviewEvidence() {
    return {
      ...this.current!,
      ...(this.sources.length && { earlierSources: this.sources.map(entry => entry.value) }),
      ...(this.receipts.length && { earlierCells: this.receipts.slice() }),
    }
  }
}
