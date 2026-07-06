/**
 * SlashCommandPicker (P3-7) — composer typeahead over the session's REAL slash
 * command catalog.
 *
 * The catalog is the user-invocable command NAMES the engine already ships on
 * the `system/init` frame's `slash_commands` field (captured per session by the
 * transcript projector, `selectSlashCommands`). NO new wire vocabulary: the
 * names ride an existing outbound frame, populated by the sidecar's real
 * `getCommands(cwd)` catalog (the `commands: []` defect fix).
 *
 * Presentation-only + pure helpers. Selecting a command inserts `/name ` into
 * the composer draft; the user submits it verbatim through the EXISTING
 * `app.submit` path — command PARSING/EXECUTION stays engine-side and the
 * renderer never gains a command-execution capability (SECURITY-MINIMUM T2/§2).
 *
 * The engine's `slash_commands` carries names ONLY (no description / argHint /
 * source badge — those live on the engine-side `Command` objects and are NOT on
 * the wire today). So the picker is WIRED but name-only; the richer prototype
 * metadata would need a read-only catalog-snapshot frame — flagged as an
 * extend-engine decision, NOT shipped here (see the P3-7 report / proposal).
 */

import { useEffect, useRef } from 'react'

/**
 * Extract the in-progress slash query from the composer draft, or `null` when
 * the picker should be closed. Open only while the draft is a SINGLE leading
 * slash-token with no whitespace yet (`/`, `/he`, `/help`) — once the user
 * types a space (`/help `) the command name is complete and we're editing args,
 * so the picker closes and the draft submits verbatim. Returns the text AFTER
 * the slash (possibly empty for a bare `/`).
 */
export function parseSlashDraft(draft: string): string | null {
  const match = /^\/(\S*)$/.exec(draft)
  return match ? match[1] : null
}

/**
 * Filter the catalog names for a query: case-insensitive PREFIX matches first
 * (the intent when typing a command name), then remaining SUBSTRING matches,
 * each group in the catalog's own order (the engine's `slash_commands` order).
 * A bare `/` (empty query) shows the whole catalog. Mirrors the prototype's
 * `SlashCommandPicker` ranking.
 */
export function filterSlashCommands(
  names: readonly string[],
  query: string,
): string[] {
  const q = query.toLowerCase()
  if (q.length === 0) return [...names]
  const prefix: string[] = []
  const substring: string[] = []
  for (const name of names) {
    const lower = name.toLowerCase()
    if (lower.startsWith(q)) prefix.push(name)
    else if (lower.includes(q)) substring.push(name)
  }
  return [...prefix, ...substring]
}

/** Move `activeIndex` within `[0, length)`, wrapping at both ends. */
export function nextSlashIndex(
  activeIndex: number,
  length: number,
  direction: 1 | -1,
): number {
  if (length <= 0) return 0
  return (activeIndex + direction + length) % length
}

/** The completed draft after picking a command: `/name ` (trailing space so the
 * picker closes and the caret sits ready for arguments). */
export function completeSlashDraft(name: string): string {
  return `/${name} `
}

export function SlashCommandPicker({
  open,
  query,
  commands,
  activeIndex,
  onPick,
}: {
  open: boolean
  query: string
  commands: string[]
  activeIndex: number
  onPick: (name: string) => void
}) {
  const listRef = useRef<HTMLUListElement>(null)

  // Keep the active option scrolled into view during keyboard navigation.
  useEffect(() => {
    if (!open) return
    const active = listRef.current?.querySelector('[data-slash-active="true"]')
    if (active) active.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  if (!open || commands.length === 0) return null

  return (
    <div
      className="absolute bottom-full left-0 z-30 mb-2 w-full max-w-md overflow-hidden rounded-lg border border-shell-seam bg-shell-chrome shadow-[0_16px_40px_rgba(0,0,0,0.55)]"
      role="dialog"
      aria-label="Slash commands"
    >
      <div className="flex items-center justify-between border-b border-shell-seam px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="rounded bg-accent/15 px-1.5 font-mono text-[11px] font-semibold text-accent">
            /
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-subtle">
            Commands
          </span>
          {query.length > 0 ? (
            <span className="font-mono text-[11px] text-text-muted">{query}</span>
          ) : null}
        </div>
        <span className="font-mono text-[10px] tabular-nums text-text-subtle">
          {commands.length}
        </span>
      </div>

      <ul
        ref={listRef}
        className="max-h-56 overflow-y-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="listbox"
        aria-label="Slash command matches"
      >
        {commands.map((name, index) => {
          const isActive = index === activeIndex
          return (
            <li key={name} role="option" aria-selected={isActive}>
              <button
                type="button"
                data-slash-active={isActive}
                aria-label={`Insert slash command /${name}`}
                // onMouseDown (not onClick) so selecting a command never blurs
                // the composer input first (which would drop the draft focus).
                onMouseDown={event => {
                  event.preventDefault()
                  onPick(name)
                }}
                className={
                  'flex w-full items-center gap-2 border-l-2 px-3 py-1 text-left transition-colors ' +
                  (isActive
                    ? 'border-accent bg-shell-active'
                    : 'border-transparent hover:bg-shell-hover')
                }
              >
                <span
                  className={
                    'font-mono text-[12.5px] ' +
                    (isActive ? 'text-accent' : 'text-text-primary')
                  }
                >
                  /{name}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
