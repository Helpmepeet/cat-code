import { randomUUID } from 'node:crypto'
import type { ContextualScriptGrant } from '../../utils/permissions/contextualAuthorization.js'

// The host serializes whole cells, including background cells, in evaluation order.
export class ScriptReviewHistory {
  private sources: string[] = []
  private characters = 0
  marked = false

  constructor(readonly generation: string) {}

  startCell(cellId: string, source: string): ContextualScriptGrant | undefined {
    if (this.marked) return undefined
    if (process.env.CLAUDE_CODE_CONTEXTUAL_SCRIPT_REVIEW !== 'once' ||
        this.characters + source.length > 32_000) {
      // Unrecorded source can affect every later cell in this generation.
      this.mark()
      return undefined
    }
    this.sources.push(source)
    this.characters += source.length
    return { cellId, generation: this.generation, history: this }
  }

  reviewSource(redact: (source: string) => string): string {
    const nonce = randomUUID()
    const count = this.sources.length
    return this.sources.map((source, i) => {
      const role = i + 1 === count ? 'current cell' : 'earlier cell'
      return `[${nonce} Script ${i + 1} of ${count}; these scripts started in this order in one REPL; ${role}]\n${redact(source)}`
    }).join('\n')
  }

  clearSources(): void {
    this.sources = []
    this.characters = 0
  }

  mark(): void {
    this.marked = true
    this.clearSources()
  }
}
