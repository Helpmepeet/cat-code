/**
 * What a Bash tool card shows on its header line, and what it reveals when the
 * pointer or keyboard focus lands on it.
 *
 * The header keeps the raw command, which is what the card has always shown and
 * what the operator chose after seeing the alternatives: a wall of cards is read
 * as commands, and a short one (`git status`, `echo hello`) loses information
 * when prose replaces it. The model's own words are the second layer, not the
 * first.
 *
 * Two sources for that second layer, in the engine's order of preference:
 *
 *  1. `description` — the Bash tool's optional field, spec'd as "Clear, concise
 *     description of what this command does in active voice"
 *     (`src/tools/BashTool/BashTool.tsx:230`), which the engine already prefers
 *     for its own summary (`getToolUseSummary`, `:504-516`). Present on 17,721
 *     of 17,726 recorded cat-code Bash calls; every `gpt-*` model writes one,
 *     though a prompt that dictates the exact command suppresses it.
 *  2. A leading `# comment` on the command — the terminal's label
 *     (`src/tools/BashTool/commentLabel.ts`). Recorded rate: zero of 62,858, so
 *     this rung is parity with the terminal rather than a live path.
 *
 * Nothing is revealed when neither exists, or when the label would only repeat
 * the command.
 */

/**
 * Mirror of `extractBashCommentLabel` (`src/tools/BashTool/commentLabel.ts`).
 * Duplicated rather than imported: the renderer is a browser bundle and never
 * imports from `src/`. Any change to the engine's rule belongs here too.
 */
export function extractBashCommentLabel(command: string): string | undefined {
  const nl = command.indexOf('\n')
  const firstLine = (nl === -1 ? command : command.slice(0, nl)).trim()
  if (!firstLine.startsWith('#') || firstLine.startsWith('#!')) return undefined
  return firstLine.replace(/^#+\s*/, '') || undefined
}

export type BashCardText = {
  /** The header line. Always the command, null only when the row carries none. */
  target: string | null
  /**
   * Swapped in over the target on hover or keyboard focus. Null when the model
   * sent nothing, or when it would only repeat what the header already says.
   */
  hover: string | null
}

export function selectBashCardText(
  command: string | null,
  description: string | null,
): BashCardText {
  if (command === null) {
    return { target: description, hover: null }
  }
  const hover = description ?? extractBashCommentLabel(command) ?? null
  return { target: command, hover: hover === command ? null : hover }
}
