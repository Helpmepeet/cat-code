/**
 * P4-30 — the shared session-action glyph vocabulary (`SessionActions.jsx:13-30`
 * `SA_IC`), rebuilt as components on the house icon idiom (`Sidebar.tsx:1069+`,
 * `BannerStack.tsx:146+`): a 15px stroke glyph inheriting `currentColor`, so a
 * row's hover/tint classes carry the icon with them.
 *
 * PARITY-LEDGER §17 row "SA_IC action-icon vocabulary" asks for one set shared by
 * the menu, message actions and tab qualifier, which is why this is its own
 * module rather than a local helper. It carries a glyph for every verb the menu
 * actually renders plus the dialog chrome and targeted message actions.
 * The prototype's tag / archive / trash glyphs are deliberately absent: those
 * three verbs are a recorded §0 CUT (`sessionActions.ts:34-38`, no local engine
 * backing), so a glyph for them would be dead code for an unreachable row.
 *
 * `Glyph` itself is exported for the same reason: it is the house stroke grammar,
 * and a surface that redeclares it drifts away from this set silently. Glyphs
 * drawn on that grammar by more than one surface live here too even when they are
 * not menu verbs, which is why {@link ActionWarningIcon} sits alongside the verbs.
 *
 * Components-only module: the renderer's Fast Refresh boundary (CLAUDE.md §3)
 * forbids a non-component export here, so the kind→glyph dispatch is the
 * `SessionActionIcon` component rather than an exported record.
 */
import type { ReactNode } from 'react'
import type { SessionActionKind } from './sessionActions.js'

/**
 * The glyph for a resolved menu verb.
 *
 * The `default` arm is a CLOSED-UNION TRIPWIRE (CLAUDE.md §7), not a fallback:
 * adding a `SessionActionKind` without a glyph here stops compiling. It replaces
 * a bare `return null`, which is exactly how `copy-text` shipped with an empty
 * icon slot and its label sitting a glyph-width left of its sibling. Runtime
 * still degrades to null rather than throwing, for a value that is not in the
 * union at all.
 */
export function SessionActionIcon({
  kind,
}: {
  kind: SessionActionKind
}): ReactNode {
  switch (kind) {
    case 'open':
      return <ActionOpenIcon />
    case 'rename':
      return <ActionRenameIcon />
    case 'metadata':
      return <ActionMetadataIcon />
    case 'copy':
      return <ActionCopyIcon />
    case 'copy-md':
      return <ActionMarkdownIcon />
    case 'copy-text':
      return <ActionFileIcon />
    case 'copy-ids':
      return <ActionHashIcon />
    case 'export':
      return <ActionExportIcon />
    case 'reveal-hidden':
      return <ActionEyeIcon />
    case 'hide-hidden':
      return <ActionEyeOffIcon />
    case 'peer-wake-blocked':
      return <ActionBellOffIcon />
    default: {
      const exhaustive: never = kind
      void exhaustive
      return null
    }
  }
}

export function ActionOpenIcon(): ReactNode {
  return (
    <Glyph>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </Glyph>
  )
}

export function ActionRenameIcon(): ReactNode {
  return (
    <Glyph>
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </Glyph>
  )
}

export function ActionBranchIcon({ size = 15 }: { size?: number }): ReactNode {
  return (
    <Glyph size={size}>
      <path d="M3 12h5" />
      <path d="M8 12 16 5" />
      <path d="M8 12 16 19" />
      <polyline points="11 5 16 5 16 10" />
      <polyline points="11 19 16 19 16 14" />
    </Glyph>
  )
}

export function ActionRewindIcon(): ReactNode {
  return (
    <Glyph>
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </Glyph>
  )
}

export function ActionMetadataIcon(): ReactNode {
  return (
    <Glyph>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </Glyph>
  )
}

export function ActionCopyIcon(): ReactNode {
  return (
    <Glyph>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Glyph>
  )
}

export function ActionExportIcon(): ReactNode {
  return (
    <Glyph>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </Glyph>
  )
}

export function ActionMarkdownIcon(): ReactNode {
  return (
    <Glyph strokeWidth="1.7">
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M6 15V9l3 3 3-3v6" />
      <path d="M17 9v4" />
      <polyline points="15 12 17 14 19 12" />
    </Glyph>
  )
}

export function ActionFileIcon(): ReactNode {
  return (
    <Glyph>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </Glyph>
  )
}

/** The identifier glyph, for the row that copies a session's two ids. */
export function ActionHashIcon(): ReactNode {
  return (
    <Glyph>
      <line x1="4" y1="9" x2="20" y2="9" />
      <line x1="4" y1="15" x2="20" y2="15" />
      <line x1="10" y1="3" x2="8" y2="21" />
      <line x1="16" y1="3" x2="14" y2="21" />
    </Glyph>
  )
}

/**
 * P4-36 — the transcript-mode reveal pair (`Chat.jsx:1208-1211`): the open eye
 * for "show the hidden tier", the struck-through eye for "hide it again". The
 * geometry is the prototype's, redrawn on the house `Glyph` grammar so it
 * inherits the row's hover tint like every other action icon.
 */
export function ActionEyeIcon(): ReactNode {
  return (
    <Glyph>
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </Glyph>
  )
}

export function ActionEyeOffIcon(): ReactNode {
  return (
    <Glyph>
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <path d="M1 1l22 22" />
      <path d="M4.06 8A18.5 18.5 0 0 0 2 12s3 8 10 8a9.12 9.12 0 0 0 5.94-2.06" />
    </Glyph>
  )
}

/**
 * PEER-SESSIONS §6 — the struck-through bell for "don't let peers reopen".
 * The bell is the thing that would wake this session; the slash is the standing
 * refusal. Its stroke runs at the eye-off slash's 45°, so the two negated glyphs
 * in this menu strike the same way, but NOT on the eye's exact coordinates:
 * `M1 1l22 22` is how `SessionActionsMenu.test.tsx` tells eye from eye-off in
 * static markup, and a second glyph carrying it would make that check answer
 * true for any menu containing this row.
 */
export function ActionBellOffIcon(): ReactNode {
  return (
    <Glyph>
      <path d="M8.6 3.6A6 6 0 0 1 18 8c0 2.4.5 4.2 1.2 5.5" />
      <path d="M6 8a6 6 0 0 1 .1-1.2M6 8c0 5-2 6-2 6h12.5" />
      <path d="M10.3 20a2 2 0 0 0 3.4 0" />
      <path d="M2.5 2.5l19 19" />
    </Glyph>
  )
}

export function ActionChevronIcon(): ReactNode {
  return (
    <Glyph>
      <polyline points="9 18 15 12 9 6" />
    </Glyph>
  )
}

/** The tick a checked toggle row draws in its trailing slot. */
export function ActionCheckIcon(): ReactNode {
  return (
    <Glyph>
      <polyline points="20 6 9 17 4 12" />
    </Glyph>
  )
}

export function ActionCloseIcon(): ReactNode {
  return (
    <Glyph>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </Glyph>
  )
}

/**
 * The warning triangle the banner stack, the composer's auto-compact chip and the
 * destructive settings dialog all draw. `size` is required because those surfaces
 * ask for it at four different sizes and a default would hide the disagreement
 * behind a call site that looks like it accepted one.
 */
export function ActionWarningIcon({ size }: { size: number }): ReactNode {
  return (
    <Glyph size={size} strokeWidth="2">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </Glyph>
  )
}

/**
 * The one stroke/size grammar every glyph above shares (`SessionActions.jsx:12`),
 * and the permission prompt's kicker glyph with them.
 */
export function Glyph({
  children,
  strokeWidth = '1.9',
  size = 15,
}: {
  children: ReactNode
  strokeWidth?: string
  size?: number
}): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}
