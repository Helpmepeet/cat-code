import { randomUUID } from 'node:crypto'
import type { ContextualScriptGrant } from '../../utils/permissions/contextualAuthorization.js'

export const MAX_AUTO_SCRIPT_REVIEW_CHARS = 32_000

// The host serializes whole cells, including background cells, in evaluation order.
export class ScriptReviewHistory {
  private sources: string[] = []
  private characters = 0
  unavailableReason?: string

  constructor(readonly generation: string) {}

  startCell(cellId: string, source: string): ContextualScriptGrant {
    if (!this.unavailableReason) {
      if (this.characters + source.length > MAX_AUTO_SCRIPT_REVIEW_CHARS) {
        this.markUnavailable('The Script and earlier uncovered cells exceed the 32,000-character Auto Mode review limit.')
      } else {
        this.sources.push(source)
        this.characters += source.length
      }
    }
    return { cellId, generation: this.generation, history: this }
  }

  reviewSource(): string {
    const nonce = randomUUID()
    const count = this.sources.length
    return this.sources.map((source, i) => {
      const role = i + 1 === count ? 'current cell' : 'earlier cell'
      return `[${nonce} Script ${i + 1} of ${count}; these scripts started in this order in one REPL; ${role}]\n${source}`
    }).join('\n')
  }

  clearSources(): void {
    this.sources = []
    this.characters = 0
  }

  markUnavailable(reason: string): void {
    this.unavailableReason = reason
    this.clearSources()
  }
}
