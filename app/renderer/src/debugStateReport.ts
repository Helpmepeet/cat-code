import type { DebugRendererSnapshot } from '../../shared/debugState.js'
import type { SessionId } from '../../shared/protocol.js'
import {
  selectPendingPermissionCount,
  type PermissionState,
} from './permissionState.js'
import {
  selectLiveSessions,
  type ShellState,
} from './shellState.js'
import { selectSidebarRows } from './sidebarState.js'
import { deriveTabVisualState } from './tabStatus.js'
import { selectConnection, type ConnectionState } from './connectionState.js'
import { describeSuggestion } from './PermissionPrompt.js'
import { basename } from './pathUtils.js'
import { tabLabel } from './TabBar.js'

export function buildDebugShellStateSnapshot(args: {
  shell: ShellState
  connection: ConnectionState
  permissions: PermissionState
  activeSessionId: SessionId | null
  now?: () => number
}): DebugRendererSnapshot {
  const now = args.now ?? Date.now
  return {
    debugStateVersion: 1,
    rendererStateAt: now(),
    renderer: {
      activeSessionId: args.activeSessionId,
      tabs: selectLiveSessions(args.shell).map(descriptor => {
        const visual = deriveTabVisualState({
          descriptor,
          connection: selectConnection(args.connection, descriptor.appSessionId),
          pendingPermissionCount: selectPendingPermissionCount(
            args.permissions,
            descriptor.appSessionId,
          ),
          isActive: descriptor.appSessionId === args.activeSessionId,
        })
        return {
          appSessionId: descriptor.appSessionId,
          title: tabLabel(descriptor),
          label: visual.label,
          tone: visual.tone,
          restartable: visual.restartable,
          needsAttention: visual.needsAttention,
        }
      }),
      sidebar: selectSidebarRows(args.shell).map(row => ({
        appSessionId: row.descriptor.appSessionId,
        title: tabLabel(row.descriptor),
        subtitle: basename(row.descriptor.cwd),
        kind: row.visual.kind,
        label: row.visual.label,
        tone: row.visual.tone,
        restorable: row.visual.restorable,
      })),
      permissions: Object.fromEntries(
        Object.entries(args.permissions.sessions).map(([sessionId, state]) => [
          sessionId,
          {
            mode: state.context?.mode ?? 'default',
            pending: state.pending.map(request => {
              const suggestions = Array.isArray(
                request.request.permission_suggestions,
              )
                ? request.request.permission_suggestions
                : []
              return {
                requestId: request.requestId,
                toolName: request.request.tool_name,
                toolDisplayName:
                  request.request.display_name ?? request.request.tool_name,
                displayTitle:
                  request.request.title ?? 'Permission required',
                suggestionLabels: suggestions.map(
                  suggestion => `Always allow: ${describeSuggestion(suggestion)}`,
                ),
              }
            }),
          },
        ]),
      ),
    },
  }
}
