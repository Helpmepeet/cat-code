/**
 * P4-30 — the shared session-action glyph vocabulary (`SessionActions.jsx:13-30`
 * `SA_IC`), rebuilt as components on the house icon idiom (`Sidebar.tsx:1069+`,
 * `BannerStack.tsx:146+`): a 15px stroke glyph inheriting `currentColor`, so a
 * row's hover/tint classes carry the icon with them.
 *
 * PARITY-LEDGER §17 row "SA_IC action-icon vocabulary" asks for one set shared by
 * the menu AND the dialogs, which is why this is its own module rather than a
 * local helper in either. It carries a glyph for every verb the menu actually
 * renders plus the dialog chrome (close / warn / file / markdown / chevron).
 * The prototype's tag / archive / trash glyphs are deliberately absent: those
 * three verbs are a recorded §0 CUT (`sessionActions.ts:33-37`, no local engine
 * backing), so a glyph for them would be dead code for an unreachable row.
 *
 * Components-only module: the renderer's Fast Refresh boundary (CLAUDE.md §3)
 * forbids a non-component export here, so the kind→glyph dispatch is the
 * `SessionActionIcon` component rather than an exported record.
 */
import type { ReactNode } from 'react'
import type { SessionActionKind } from './sessionActions.js'

/** The glyph for a resolved menu verb. Unknown kinds render nothing, never throw. */
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
    case 'branch':
      return <ActionBranchIcon />
    case 'rewind':
      return <ActionRewindIcon />
    case 'metadata':
      return <ActionMetadataIcon />
    case 'copy':
      return <ActionCopyIcon />
    case 'copy-md':
      return <ActionMarkdownIcon />
    case 'export':
      return <ActionExportIcon />
    default:
      return null
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

export function ActionBranchIcon(): ReactNode {
  return (
    <Glyph>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <line x1="6" y1="9" x2="6" y2="15" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <polyline points="15 12 18 15 21 12" />
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

export function ActionWarnIcon(): ReactNode {
  return (
    <Glyph>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
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

export function ActionCloseIcon(): ReactNode {
  return (
    <Glyph>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </Glyph>
  )
}

/** The one stroke/size grammar every glyph above shares (`SessionActions.jsx:12`). */
function Glyph({
  children,
  strokeWidth = '1.9',
}: {
  children: ReactNode
  strokeWidth?: string
}): ReactNode {
  return (
    <svg
      width="15"
      height="15"
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
