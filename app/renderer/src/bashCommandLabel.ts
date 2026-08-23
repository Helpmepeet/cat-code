/**
 * What a Bash tool card says on its header line, and what it therefore has to
 * expose in its body.
 *
 * The prototype's own bash card is summary-first (`Messages.jsx:416,470`
 * `msg.toolSummary || msg.command`); the permission prompt is the one place it
 * inverts to command-first (`:505,516`), because there the user is approving
 * what will execute. This module is the summary-first half only.
 *
 * Two sources, in the engine's own order of preference:
 *
 *  1. `description` — the Bash tool's optional field, spec'd as "Clear, concise
 *     description of what this command does in active voice"
 *     (`src/tools/BashTool/BashTool.tsx:230`). The engine already prefers it
 *     over the command for its own summary (`getToolUseSummary`, `:504-516`).
 *     Present on 17,721 of 17,726 recorded cat-code Bash calls; every `gpt-*`
 *     model writes one without exception.
 *  2. A leading `# comment` on the command — the terminal's label
 *     (`src/tools/BashTool/commentLabel.ts`, used by its tool-use render and
 *     its collapsed-group hint). Recorded rate across both transcript trees:
 *     zero of 62,858. Kept so the app reads the same command the terminal does
 *     if that ever changes, not because it fires today.
 *
 * When neither exists the card falls back to the raw command, which is what it
 * has always shown.
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
  /** The header line. Null only when the row carries no command at all. */
  label: string | null
  /**
   * The raw command, for the body — null when the label already IS the command,
   * so a card that gained nothing from a label does not print it twice. The
   * body is the only place it survives: the inspector deliberately stopped
   * surfacing raw input for a resolved call (`ToolInspector.tsx` header,
   * 2026-08-13), and the header truncates to one line.
   */
  commandLead: string | null
}

export function selectBashCardText(
  command: string | null,
  description: string | null,
): BashCardText {
  if (command === null) {
    return { label: description, commandLead: null }
  }
  const label = description ?? extractBashCommentLabel(command) ?? command
  return { label, commandLead: label === command ? null : command }
}
