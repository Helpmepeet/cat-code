/**
 * File path right-click context menu model and placement logic.
 *
 * Fast Refresh boundary: pure functions and types only, no React components.
 */

import { createContext } from 'react'
import type { SessionId } from '../../shared/protocol.js'
import { basename } from './pathUtils.js'

export type FilePathMenuContextValue = {
  cwd: string | null
  openFilePathMenu: (
    anchor: FilePathActionsAnchor,
    rawPath: string,
    sessionId: SessionId,
  ) => void
}

export const FilePathMenuContext =
  createContext<FilePathMenuContextValue | null>(null)

export type FilePathActionKind =
  | 'copy'
  | 'copy-absolute'
  | 'copy-relative'
  | 'copy-filename'
  | 'open'
  | 'open-default'
  | 'open-vscode'
  | 'open-zed'
  | 'open-cursor'
  | 'open-finder'

export type FilePathActionItem = {
  kind: FilePathActionKind
  label: string
  enabled: boolean
  reason?: string
  flyout?: FilePathActionItem[]
}

export type FilePathParts = {
  rawPath: string
  cleanPath: string
  absolutePath: string | null
  filename: string
  lineSuffix: string | null
}

export type FilePathActionsAnchor =
  | { type: 'pointer'; x: number; y: number }
  | { type: 'rect'; rect: { top: number; bottom: number; left: number; right: number } }

export type FilePathActionsPlacement = {
  top?: number
  bottom?: number
  left?: number
  placeAbove: boolean
  flipFlyoutLeft: boolean
}

const LINE_SUFFIX_PATTERN = /:\d+(?::\d+)?$/
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/
const ABSOLUTE_URL_LIKE_PATTERN = /^[A-Za-z][A-Za-z\d+.-]*:\/\//

function isAbsoluteUrlLike(path: string): boolean {
  return (
    !WINDOWS_ABSOLUTE_PATH_PATTERN.test(path) &&
    ABSOLUTE_URL_LIKE_PATTERN.test(path)
  )
}

export function stripLineSuffix(path: string): string {
  return isAbsoluteUrlLike(path) ? path : path.replace(LINE_SUFFIX_PATTERN, '')
}

export function extractLineSuffix(path: string): string | null {
  if (isAbsoluteUrlLike(path)) return null
  const match = path.match(LINE_SUFFIX_PATTERN)
  return match ? match[0] : null
}

export function resolveFilePathParts({
  rawPath,
  cwd,
}: {
  rawPath: string
  cwd?: string | null
}): FilePathParts {
  const lineSuffix = extractLineSuffix(rawPath)
  const cleanPath = stripLineSuffix(rawPath)
  const filename = basename(cleanPath) || cleanPath

  let absolutePath: string | null = null
  if (
    cleanPath.startsWith('/') ||
    WINDOWS_ABSOLUTE_PATH_PATTERN.test(cleanPath) ||
    isAbsoluteUrlLike(cleanPath)
  ) {
    absolutePath = rawPath
  } else if (cwd && cwd.trim().length > 0) {
    const baseAbs = resolvePathFromCwd(cwd, cleanPath)
    absolutePath = lineSuffix ? `${baseAbs}${lineSuffix}` : baseAbs
  }

  return {
    rawPath,
    cleanPath,
    absolutePath,
    filename,
    lineSuffix,
  }
}

function resolvePathFromCwd(cwd: string, relativePath: string): string {
  const windows = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.includes('\\')
  const separator = windows ? '\\' : '/'
  const normalizedCwd = cwd.replace(/[/\\]+$/, '')
  const prefix = windows
    ? normalizedCwd.slice(0, 2)
    : normalizedCwd.startsWith('/') ? '/' : ''
  const parts = normalizedCwd
    .slice(prefix.length)
    .split(/[/\\]+/)
    .filter(Boolean)

  for (const part of relativePath.split(/[/\\]+/)) {
    if (part.length === 0 || part === '.') continue
    if (part === '..') {
      if (parts.length > 0) parts.pop()
      continue
    }
    parts.push(part)
  }

  return windows
    ? `${prefix}${separator}${parts.join(separator)}`
    : `${prefix}${parts.join(separator)}`
}

export function resolveFilePathActionItems(
  parts: FilePathParts,
  platform: string = typeof navigator !== 'undefined' ? navigator.userAgent : '',
): FilePathActionItem[] {
  const isMac = /mac|darwin/i.test(platform)
  const finderLabel = isMac ? 'Reveal in Finder' : 'Show in file manager'

  return [
    {
      kind: 'copy',
      label: 'Copy',
      enabled: true,
      flyout: [
        {
          kind: 'copy-absolute',
          label: 'Absolute path',
          enabled: parts.absolutePath != null,
          reason: parts.absolutePath == null ? 'Workspace path unavailable' : undefined,
        },
        {
          kind: 'copy-relative',
          label: 'Relative path',
          enabled: true,
        },
        {
          kind: 'copy-filename',
          label: 'Filename',
          enabled: true,
        },
      ],
    },
    {
      kind: 'open',
      label: 'Open in',
      enabled: true,
      flyout: [
        {
          kind: 'open-default',
          label: 'Default application',
          enabled: true,
        },
        {
          kind: 'open-vscode',
          label: 'Visual Studio Code',
          enabled: true,
        },
        {
          kind: 'open-zed',
          label: 'Zed',
          enabled: true,
        },
        {
          kind: 'open-cursor',
          label: 'Cursor',
          enabled: true,
        },
        {
          kind: 'open-finder',
          label: finderLabel,
          enabled: true,
        },
      ],
    },
  ]
}

export const FILE_PATH_MENU_WIDTH = 200
export const FILE_PATH_FLYOUT_WIDTH = 190
export const FILE_PATH_MENU_GAP = 6
export const FILE_PATH_MENU_ROW_HEIGHT = 30
export const FILE_PATH_PANEL_CHROME_HEIGHT = 14

export function estimateFilePathMenuHeight(items: readonly FilePathActionItem[]): number {
  return FILE_PATH_PANEL_CHROME_HEIGHT + items.length * FILE_PATH_MENU_ROW_HEIGHT
}

export function placeFilePathActionsMenu(
  anchor: FilePathActionsAnchor,
  viewport: { width: number; height: number },
  panelHeight: number,
): FilePathActionsPlacement {
  const anchorBox =
    anchor.type === 'pointer'
      ? { top: anchor.y, bottom: anchor.y, left: anchor.x, right: anchor.x }
      : anchor.rect

  const maxLeft = Math.max(8, viewport.width - FILE_PATH_MENU_WIDTH - 8)
  const left = Math.min(Math.max(8, anchorBox.left), maxLeft)

  const spaceBelow = viewport.height - anchorBox.bottom - FILE_PATH_MENU_GAP
  const spaceAbove = anchorBox.top - FILE_PATH_MENU_GAP
  const placeAbove = spaceBelow < panelHeight && spaceAbove > spaceBelow

  const flipFlyoutLeft = left + FILE_PATH_MENU_WIDTH + FILE_PATH_FLYOUT_WIDTH + 16 > viewport.width

  if (placeAbove) {
    return {
      placeAbove: true,
      bottom: viewport.height - anchorBox.top + FILE_PATH_MENU_GAP,
      left,
      flipFlyoutLeft,
    }
  }
  return {
    placeAbove: false,
    top: anchorBox.bottom + FILE_PATH_MENU_GAP,
    left,
    flipFlyoutLeft,
  }
}
