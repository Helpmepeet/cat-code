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
import { selectShellDescriptors } from './sidebarState.js'
import { sessionStatusVisual } from './sessionStatusVisual.js'
import { deriveTabVisualState } from './tabStatus.js'
import { selectConnection, type ConnectionState } from './connectionState.js'
import { describeSuggestion } from './permissionPromptModel.js'
import { basename } from './pathUtils.js'
import { tabLabel } from './tabBarModel.js'

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
      sidebar: selectShellDescriptors(args.shell).map(descriptor => {
        // F9: the roster selector no longer carries a per-row visual; derive the
        // sidebar chip from the shared `sessionStatusVisual` (audit §I.2).
        const { label, tone } = sessionStatusVisual(
          descriptor.status,
          descriptor.restorable,
          true,
          descriptor.parked,
        )
        return {
          appSessionId: descriptor.appSessionId,
          title: tabLabel(descriptor),
          subtitle: basename(descriptor.cwd),
          kind: descriptor.restorable ? ('restorable' as const) : ('live' as const),
          label,
          tone,
          restorable: descriptor.restorable,
        }
      }),
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
