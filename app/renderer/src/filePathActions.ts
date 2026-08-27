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

export function stripLineSuffix(path: string): string {
  return path.replace(/[?#].*$/, '').replace(/:\d+(?::\d+)?$/, '')
}

export function extractLineSuffix(path: string): string | null {
  const match = path.match(/:\d+(?::\d+)?$/)
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
  if (cleanPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(cleanPath)) {
    absolutePath = rawPath
  } else if (cwd && cwd.trim().length > 0) {
    const trimmedCwd = cwd.replace(/[/\\]+$/, '')
    const separator = trimmedCwd.includes('\\') ? '\\' : '/'
    const normalizedClean = cleanPath.replace(/^[./\\]+/, '')
    const baseAbs = `${trimmedCwd}${separator}${normalizedClean}`
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
