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
 * Rows carry the full prototype metadata — name + arg hint + description — from
 * the read-only `slash-catalog.snapshot` (the sidecar projects the engine-side
 * `Command` objects' `description`/`argumentHint`, which the SDK
 * `slash_commands` field flattens away). The composer falls back to the
 * names-only `slash_commands` catalog when the snapshot is absent, rendering the
 * name column alone (`description` empty).
 */

import { useEffect, useRef } from 'react'
import type { SlashCatalogEntry } from '../../shared/protocol.js'
import {
  SLASH_COMMAND_LISTBOX_ID,
  slashCommandOptionId,
} from './composerTypeaheadA11y.js'

/**
 * Extract the in-progress slash query from the composer draft, or `null` when
 * the picker should be closed. Open only while the draft is a SINGLE leading
 * slash-token with no whitespace yet (`/`, `/he`, `/help`) — once the user
 * types a space (`/help `) the command name is complete and we're editing args,
 * so the picker closes and the draft submits verbatim. Returns the text AFTER
 * the slash (possibly empty for a bare `/`).
 */
export function SlashCommandPicker({
  open,
  query,
  commands,
  activeIndex,
  onPick,
}: {
  open: boolean
  query: string
  commands: SlashCatalogEntry[]
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
    <div className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-xl border border-white/10 bg-surface-raised shadow-[0_20px_48px_rgba(0,0,0,0.7),0_0_0_1px_rgb(var(--accent-rgb)/0.06)]">
      <div className="flex items-center justify-between border-b border-shell-seam px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="rounded bg-accent/15 px-1.5 font-mono text-[11px] font-semibold text-accent">
            /
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-ghost">
            Commands
          </span>
          {query.length > 0 ? (
            <span className="font-mono text-[11px] text-text-muted">{query}</span>
          ) : null}
        </div>
        <span className="font-mono text-[10px] tabular-nums text-text-ghost">
          {commands.length}
        </span>
      </div>

      <ul
        ref={listRef}
        id={SLASH_COMMAND_LISTBOX_ID}
        className="max-h-56 overflow-y-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="listbox"
        aria-label="Slash command matches"
      >
        {commands.map((entry, index) => {
          const isActive = index === activeIndex
          return (
            <li
              key={entry.name}
              id={slashCommandOptionId(index)}
              role="option"
              aria-selected={isActive}
            >
              <button
                type="button"
                data-slash-active={isActive}
                aria-label={`Insert slash command /${entry.name}`}
                // onMouseDown (not onClick) so selecting a command never blurs
                // the composer input first (which would drop the draft focus).
                onMouseDown={event => {
                  event.preventDefault()
                  onPick(entry.name)
                }}
                className={
                  'flex w-full items-baseline border-l-2 px-3 py-1 text-left transition-colors ' +
                  (isActive
                    ? 'border-accent bg-accent/[0.07]'
                    : 'border-transparent hover:bg-shell-hover')
                }
              >
                {/* Command name column (fixed width so descriptions align),
                 * monospace, pink when active — with the gray arg hint. */}
                <span
                  className={
                    'min-w-[148px] shrink-0 font-mono text-[12.5px] font-medium tracking-[-0.01em] ' +
                    (isActive ? 'text-accent' : 'text-text-primary')
                  }
                >
                  /{entry.name}
                  {entry.argumentHint ? (
                    <span className="ml-1.5 font-normal text-text-faint">
                      {entry.argumentHint}
                    </span>
                  ) : null}
                </span>
                {/* Separator + description (ellipsized), only when present so a
                 * names-only fallback row renders as the name alone. */}
                {entry.description ? (
                  <>
                    <span className="mr-2.5 shrink-0 text-text-ghost">·</span>
                    <span
                      className={
                        'min-w-0 flex-1 truncate text-[11.5px] ' +
                        (isActive ? 'text-text-muted' : 'text-text-faint')
                      }
                    >
                      {entry.description}
                    </span>
                  </>
                ) : null}
              </button>
            </li>
          )
        })}
      </ul>

      {/* Footer keyboard-hint bar (SlashCommandPicker.jsx:162-186). The shortcuts
       * themselves live in the composer's keydown handler (App.tsx); this is the
       * visual affordance that labels them. */}
      <div className="flex items-center gap-3.5 border-t border-shell-seam px-3 pb-1.5 pt-1">
        {SLASH_FOOTER_HINTS.map(([keyLabel, action]) => (
          <span key={keyLabel} className="flex items-center gap-1">
            <kbd className="rounded border border-shell-seam bg-white/[0.04] px-1.5 font-mono text-[9.5px] leading-relaxed text-text-subtle">
              {keyLabel}
            </kbd>
            <span className="text-[10px] text-text-subtle">{action}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

const SLASH_FOOTER_HINTS: ReadonlyArray<readonly [string, string]> = [
  ['↑↓', 'navigate'],
  ['↵', 'select'],
  ['esc', 'dismiss'],
]
