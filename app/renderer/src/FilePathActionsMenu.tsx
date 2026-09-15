/**
 * File path right-click context menu component.
 *
 * Fast Refresh boundary: exports React component only.
 */

import { useRef, useState, Fragment, type ReactNode } from 'react'
import type {
  OpenWorkspaceFileTarget,
  SessionId,
} from '../../shared/protocol.js'
import {
  handleMenuRovingKeyDown,
  usePopoverFocus,
} from './overlayFocus.js'
import { useToast } from './toastContext.js'
import {
  estimateFilePathMenuHeight,
  placeFilePathActionsMenu,
  resolveFilePathActionItems,
  resolveFilePathParts,
  type FilePathActionItem,
  type FilePathActionKind,
  type FilePathActionsAnchor,
  type FilePathParts,
} from './filePathActions.js'
import {
  ActionChevronIcon,
  ActionCopyIcon,
  ActionOpenIcon,
} from './SessionActionIcons.js'

function readViewport(): { width: number; height: number } {
  return typeof window === 'undefined'
    ? { width: 1280, height: 800 }
    : { width: window.innerWidth, height: window.innerHeight }
}

const CLIPBOARD_FAILURE = 'Could not write to the clipboard'

/**
 * The five open rows are one action with five destinations: each names an
 * `openWorkspaceFile` target and the sentence shown when the file does not
 * open. A refused open answers `false` and a broken bridge rejects; both are
 * the same news to the user, so both paths say the same thing.
 */
const OPEN_TARGETS: Partial<
  Record<FilePathActionKind, { target: OpenWorkspaceFileTarget; failure: string }>
> = {
  'open-default': { target: 'default', failure: 'Could not open this file' },
  'open-vscode': {
    target: 'vscode',
    failure: 'Could not open this file in Visual Studio Code',
  },
  'open-zed': { target: 'zed', failure: 'Could not open this file in Zed' },
  'open-cursor': { target: 'cursor', failure: 'Could not open this file in Cursor' },
  'open-finder': { target: 'finder', failure: 'Could not reveal this file' },
}

/**
 * What a copy row puts on the clipboard, and what the toast says once it is
 * there — or null for a row that copies nothing. Unlike the open rows these do
 * not reduce to a table: the flyout HOST acts as its own first child (copy the
 * absolute path), and that path falls back to the raw one when no cwd resolved
 * it, so its sentence has to name whichever was actually copied.
 */
function resolveCopyTarget(
  kind: FilePathActionKind,
  parts: FilePathParts,
): { text: string; success: string } | null {
  switch (kind) {
    case 'copy':
    case 'copy-absolute':
      return {
        text: parts.absolutePath ?? parts.rawPath,
        success: parts.absolutePath
          ? 'Absolute path copied to clipboard'
          : 'Relative path copied to clipboard',
      }
    case 'copy-relative':
      return { text: parts.rawPath, success: 'Relative path copied to clipboard' }
    case 'copy-filename':
      return { text: parts.filename, success: 'Filename copied to clipboard' }
    default:
      return null
  }
}

export function FilePathActionsMenu({
  anchor,
  rawPath,
  cwd,
  sessionId,
  onClose,
}: {
  anchor: FilePathActionsAnchor
  rawPath: string
  cwd?: string | null
  sessionId: SessionId
  onClose: () => void
}): ReactNode {
  const menuRef = useRef<HTMLDivElement>(null)
  const toast = useToast()
  const { restoreTriggerFocus } = usePopoverFocus({
    open: true,
    containerRef: menuRef,
    onEscape: onClose,
  })

  const parts = resolveFilePathParts({ rawPath, cwd })
  const items = resolveFilePathActionItems(parts)
  const placement = placeFilePathActionsMenu(
    anchor,
    readViewport(),
    estimateFilePathMenuHeight(items),
  )

  const handleAction = (kind: FilePathActionKind): void => {
    restoreTriggerFocus()
    onClose()

    const copy = resolveCopyTarget(kind, parts)
    if (copy) {
      const clipboard =
        typeof navigator !== 'undefined' ? navigator.clipboard : undefined
      if (!clipboard) {
        toast(CLIPBOARD_FAILURE, { tone: 'warn' })
        return
      }
      void clipboard
        .writeText(copy.text)
        .then(() => toast(copy.success, { tone: 'success' }))
        .catch(() => toast(CLIPBOARD_FAILURE, { tone: 'warn' }))
      return
    }

    const open = OPEN_TARGETS[kind]
    if (!open) return
    void window.catcode
      ?.openWorkspaceFile(sessionId, parts.rawPath, open.target)
      .then(opened => {
        if (!opened) toast(open.failure, { tone: 'warn' })
      })
      .catch(() => toast(open.failure, { tone: 'warn' }))
  }

  return (
    <>
      <div
        className="fixed inset-0 z-[70]"
        aria-hidden="true"
        onClick={onClose}
        onContextMenu={event => {
          event.preventDefault()
          onClose()
        }}
      />
      <div
        ref={menuRef}
        role="menu"
        aria-label={`File actions for ${parts.filename}`}
        onKeyDown={handleMenuRovingKeyDown}
        className="animate-sa-pop fixed z-[71] w-[200px] rounded-[11px] border border-shell-seam bg-shell-chrome p-1.5 shadow-[var(--elev-menu)]"
        style={
          placement.placeAbove
            ? { bottom: placement.bottom, left: placement.left }
            : { top: placement.top, left: placement.left }
        }
      >
        {items.map((item, index) => (
          <Fragment key={item.kind}>
            {index > 0 ? <div className="my-1 h-px bg-shell-seam" /> : null}
            {item.flyout ? (
              <FilePathFlyoutRow
                item={item}
                flipLeft={placement.flipFlyoutLeft}
                onAction={handleAction}
              />
            ) : (
              <FilePathMenuRow
                item={item}
                onAction={() => handleAction(item.kind)}
              />
            )}
          </Fragment>
        ))}
      </div>
    </>
  )
}

function FilePathFlyoutRow({
  item,
  flipLeft,
  onAction,
}: {
  item: FilePathActionItem
  flipLeft: boolean
  onAction: (kind: FilePathActionKind) => void
}) {
  const [open, setOpen] = useState(false)
  const flyoutRef = useRef<HTMLDivElement>(null)
  if (!item.enabled) return <FilePathMenuRow item={item} onAction={() => {}} />

  const icon = item.kind === 'copy' ? <ActionCopyIcon /> : <ActionOpenIcon />

  const handleClick = (event: React.MouseEvent) => {
    event.stopPropagation()
    onAction(item.kind === 'copy' ? 'copy-absolute' : 'open-default')
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowRight') {
      if (!open) {
        event.preventDefault()
        event.stopPropagation()
        setOpen(true)
        requestAnimationFrame(() => {
          const first = flyoutRef.current?.querySelector<HTMLElement>(
            'button[role="menuitem"]:not([disabled])',
          )
          first?.focus()
        })
      }
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      event.stopPropagation()
      onAction(item.kind === 'copy' ? 'copy-absolute' : 'open-default')
    } else if (event.key === 'ArrowLeft') {
      if (open) {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
      }
    }
  }

  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
      }}
      onKeyDown={handleKeyDown}
    >
      <div
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        tabIndex={0}
        onClick={handleClick}
        className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-text-muted transition-colors hover:bg-white/[0.05] hover:text-text-primary focus-visible:bg-white/[0.05] focus-visible:text-text-primary focus-visible:outline-none"
      >
        <span className="flex shrink-0 text-text-subtle">{icon}</span>
        <span className="flex-1 truncate">{item.label}</span>
        <span className="flex shrink-0 text-text-ghost">
          <ActionChevronIcon />
        </span>
      </div>
      {open ? (
        <div
          ref={flyoutRef}
          role="menu"
          aria-label={item.label}
          onClick={event => event.stopPropagation()}
          onKeyDown={handleMenuRovingKeyDown}
          className={
            'animate-sa-pop absolute -top-[5px] z-[72] w-[180px] rounded-[10px] border border-shell-seam bg-shell-chrome p-1.5 shadow-[var(--elev-menu)] ' +
            (flipLeft ? 'right-full mr-1' : 'left-full ml-1')
          }
        >
          {item.flyout?.map(child => (
            <FilePathMenuRow
              key={child.kind}
              item={child}
              onAction={() => onAction(child.kind)}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function FilePathMenuRow({
  item,
  onAction,
}: {
  item: FilePathActionItem
  onAction: () => void
}) {
  if (!item.enabled) {
    return (
      <div
        role="menuitem"
        aria-disabled="true"
        title={item.reason}
        aria-label={item.reason ? `${item.label}, ${item.reason}` : item.label}
        className="flex cursor-default items-center rounded-md px-2.5 py-1.5 text-[12.5px] text-text-subtle/70"
      >
        <span className="flex-1 truncate">{item.label}</span>
      </div>
    )
  }
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onAction}
      className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-text-muted transition-colors hover:bg-white/[0.05] hover:text-text-primary focus-visible:bg-white/[0.05] focus-visible:text-text-primary focus-visible:outline-none"
    >
      <span className="flex-1 truncate">{item.label}</span>
    </button>
  )
}
