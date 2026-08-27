/**
 * File path right-click context menu component.
 *
 * Fast Refresh boundary: exports React component only.
 */

import { useRef, useState, Fragment, type ReactNode } from 'react'
import type { SessionId } from '../../shared/protocol.js'
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

    const clipboard =
      typeof navigator !== 'undefined' ? navigator.clipboard : undefined

    switch (kind) {
      case 'copy':
      case 'copy-absolute': {
        const textToCopy = parts.absolutePath ?? parts.rawPath
        if (!clipboard) {
          toast('Could not write to the clipboard', { tone: 'warn' })
          return
        }
        void clipboard
          .writeText(textToCopy)
          .then(() =>
            toast(
              parts.absolutePath
                ? 'Absolute path copied to clipboard'
                : 'Relative path copied to clipboard',
              { tone: 'success' },
            ),
          )
          .catch(() => toast('Could not write to the clipboard', { tone: 'warn' }))
        return
      }

      case 'copy-relative': {
        if (!clipboard) {
          toast('Could not write to the clipboard', { tone: 'warn' })
          return
        }
        void clipboard
          .writeText(parts.rawPath)
          .then(() => toast('Relative path copied to clipboard', { tone: 'success' }))
          .catch(() => toast('Could not write to the clipboard', { tone: 'warn' }))
        return
      }

      case 'copy-filename': {
        if (!clipboard) {
          toast('Could not write to the clipboard', { tone: 'warn' })
          return
        }
        void clipboard
          .writeText(parts.filename)
          .then(() => toast('Filename copied to clipboard', { tone: 'success' }))
          .catch(() => toast('Could not write to the clipboard', { tone: 'warn' }))
        return
      }

      case 'open-default': {
        void window.catcode
          ?.openWorkspaceFile(sessionId, parts.cleanPath, 'default')
          .then(opened => {
            if (!opened) toast('Could not open this file', { tone: 'warn' })
          })
          .catch(() => toast('Could not open this file', { tone: 'warn' }))
        return
      }

      case 'open-vscode': {
        void window.catcode
          ?.openWorkspaceFile(sessionId, parts.cleanPath, 'vscode')
          .then(opened => {
            if (!opened) toast('Could not open this file in Visual Studio Code', { tone: 'warn' })
          })
          .catch(() => toast('Could not open this file in Visual Studio Code', { tone: 'warn' }))
        return
      }

      case 'open-zed': {
        void window.catcode
          ?.openWorkspaceFile(sessionId, parts.cleanPath, 'zed')
          .then(opened => {
            if (!opened) toast('Could not open this file in Zed', { tone: 'warn' })
          })
          .catch(() => toast('Could not open this file in Zed', { tone: 'warn' }))
        return
      }

      case 'open-cursor': {
        void window.catcode
          ?.openWorkspaceFile(sessionId, parts.cleanPath, 'cursor')
          .then(opened => {
            if (!opened) toast('Could not open this file in Cursor', { tone: 'warn' })
          })
          .catch(() => toast('Could not open this file in Cursor', { tone: 'warn' }))
        return
      }

      case 'open-finder': {
        void window.catcode
          ?.openWorkspaceFile(sessionId, parts.cleanPath, 'finder')
          .then(opened => {
            if (!opened) toast('Could not reveal this file', { tone: 'warn' })
          })
          .catch(() => toast('Could not reveal this file', { tone: 'warn' }))
        return
      }

      default:
        return
    }
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
