import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { getBridge } from './bridge.js'
import { buildDebugShellStateSnapshot } from './debugStateReport.js'
import { permissionActionForKey } from './PermissionPrompt.js'
import { PermissionQueue } from './PermissionQueue.js'
import { PermissionRulesEditor } from './PermissionRulesEditor.js'
import {
  buildAllowResponse,
  buildDenyResponse,
  createPermissionState,
  reducePermissionState,
  selectPendingPermissionCount,
  selectPermissionContext,
  selectPermissionQueue,
  selectVisiblePermission,
} from './permissionState.js'
import {
  activeAfterLiveChange,
  createShellState,
  reduceShellState,
  selectLiveSessions,
  sessionAtSlot,
  type ShellState,
} from './shellState.js'
import { deriveTabVisualState } from './tabStatus.js'
import { TabBar, tabLabel, type TabModel } from './TabBar.js'
import { Sidebar } from './Sidebar.js'
import { selectSidebarRows } from './sidebarState.js'
import { CommandPalette } from './CommandPalette.js'
import { buildPaletteItems, type PaletteItem } from './commandPaletteModel.js'
import {
  createRawMessageLogState,
  reduceServerFrame,
  selectRawMessageLog,
  type RawMessageSessionLog,
} from './rawMessageLog.js'
import {
  createTranscriptState,
  projectServerFrame,
  selectSlashCommands,
  selectTranscriptRows,
  type TranscriptRow,
  type TranscriptState,
} from './transcriptProjector.js'
import { TranscriptView } from './TranscriptView.js'
import {
  completeSlashDraft,
  filterSlashCommands,
  nextSlashIndex,
  parseSlashDraft,
  SlashCommandPicker,
} from './SlashCommandPicker.js'
import {
  WorkspaceLayout,
  type WorkspacePanelView,
} from './WorkspacePanels.js'
import {
  assignWorkspacePanelSession,
  closeWorkspacePanel,
  createWorkspaceLayout,
  focusOrAssignWorkspaceSession,
  focusWorkspacePanel,
  readWorkspaceLayoutFromStorage,
  reconcileWorkspaceLayout,
  setWorkspaceWidths,
  splitWorkspacePanel,
  workspaceLayoutsEqual,
  writeWorkspaceLayoutToStorage,
  type WorkspaceLayoutState,
  type WorkspaceSplitEdge,
} from './workspaceLayout.js'
import {
  createConnectionState,
  reduceConnectionState,
  selectConnection,
  type ConnectionSnapshot,
} from './connectionState.js'
import type {
  CatCodeBridge,
  PermissionResponseInput,
  PermissionSetModeMode,
  SessionId,
} from '../../shared/protocol.js'
import type {
  HostError,
  HostEvent,
  SessionDescriptor,
} from '../../shared/hostApi.js'

export function App() {
  const [state, dispatch] = useReducer(
    reduceServerFrame,
    undefined,
    createRawMessageLogState,
  )
  const [transcript, dispatchSessionEvent] = useReducer(
    projectServerFrame,
    undefined,
    createTranscriptState,
  )
  const [permissions, dispatchPermission] = useReducer(
    reducePermissionState,
    undefined,
    createPermissionState,
  )
  const [promptDrafts, setPromptDrafts] = useState<PromptDraftState>({})
  const [transportError, setTransportError] = useState<string | null>(null)
  const [shellError, setShellError] = useState<string | null>(null)
  const [layoutNotice, setLayoutNotice] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [activeSessionId, setActiveSessionId] = useState<SessionId | null>(null)
  const [hostSnapshotReady, setHostSnapshotReady] = useState(false)
  const [workspaceLayout, setWorkspaceLayoutState] =
    useState<WorkspaceLayoutState>(
      () =>
        readWorkspaceLayoutFromStorage(getWorkspaceStorage()) ??
        createWorkspaceLayout(null),
    )
  const [connection, dispatchConnection] = useReducer(
    reduceConnectionState,
    undefined,
    createConnectionState,
  )
  // The app-level session roster — a projection of the host control plane's
  // HostEvent stream (REGISTRY §6.1), not a poll loop. Seeded once from
  // listSessions() below, then kept live off subscribeHost.
  const [shell, dispatchShell] = useReducer(
    reduceShell,
    undefined,
    createShellState,
  )
  // Mirror the roster so the host-event handler (subscribed once) can read the
  // live order without re-subscribing — used to compute the neighbour tab when
  // the active tab is removed.
  const shellRef = useRef(shell)
  shellRef.current = shell
  // Ids a live `session-removed` dropped before the initial snapshot folded in —
  // so the baseline hydrate never resurrects a row the host already reaped (F3).
  const removedIdsRef = useRef<Set<SessionId>>(new Set())

  useEffect(() => {
    const bridge = getBridge()
    const unsubscribe = bridge.subscribe(frame => {
      // Active selection is renderer-owned UI state. A background frame can
      // create/update its addressed slice, but never steals focus from another
      // LIVE tab. Two cases DO take the pane: nothing is active yet, or the
      // frame belongs to a session that has no host row (a frame leading its own
      // session-added) while the current active session ALSO has no row —
      // whichever session is actually streaming is the one worth showing. Once
      // both sessions have rows, focus only moves by user action.
      setActiveSessionId(current => {
        if (current === null) return frame.sessionId
        if (current === frame.sessionId) return current
        const roster = shellRef.current.byId
        const currentHasRow = Boolean(roster[current])
        const frameHasRow = Boolean(roster[frame.sessionId])
        if (!currentHasRow && !frameHasRow) return frame.sessionId
        return current
      })
      dispatch(frame)
      dispatchPermission({ type: 'frame', frame })
      dispatchConnection(frame)
      dispatchSessionEvent(frame)
    })
    bridge.rendererReady()
    return unsubscribe
  }, [])

  // Host control plane: hydrate the roster once, then stay live off the event
  // stream. Switching tabs never unsubscribes anything (the P2 frame stream and
  // the P3-4 stores are keyed by sessionId and stay resident); this projection
  // is purely additive UI state layered over them.
  //
  // Active-selection follows the roster ONLY on the two events that change which
  // tabs exist, never on the reducer snapshot: this way a frame-driven active
  // session (one whose ready frame led its session-added, or the headless probe
  // that emits no host event) is never clobbered by a stale roster.
  useEffect(() => {
    const bridge = getBridge()
    let cancelled = false
    // Subscribe-before-snapshot (F3): install the live stream FIRST so no
    // session-added/status/removed can slip through the gap between the snapshot
    // read and the subscription. The snapshot is then folded as a BASELINE that
    // never clobbers a newer live event already applied (reduceShell hydrate).
    const unsubscribe = bridge.subscribeHost(event => {
      // A new/restored tab appears in the bar but does NOT steal the pane — a
      // spawning session has nothing to show; it becomes active when it starts
      // streaming (the frame path above), when the user clicks it, or via the
      // "nothing active" fallback below. Focus corrections (moving OFF a
      // now-non-live active tab) run in the post-commit effect below, which
      // reads the RECONCILED roster — reading shellRef here would see the
      // pre-event state (the reducer commits on the next render).
      if (event.type === 'session-removed') {
        removedIdsRef.current.add(event.appSessionId)
      }
      dispatchShell({ type: 'event', event })
    })
    void bridge
      .listSessions()
      .then(sessions => {
        if (!cancelled) {
          dispatchShell({
            type: 'hydrate',
            sessions,
            removed: removedIdsRef.current,
          })
        }
      })
      .catch(() => {
        /* a failed initial list degrades to a live-only roster */
      })
      .finally(() => {
        if (!cancelled) setHostSnapshotReady(true)
      })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  // Focus correction (F1) — runs AFTER the roster commits, so it sees the
  // reconciled live-tab set. Two cases, both against the LIVE projection (the
  // TabBar's view), so a closed→restorable active session (which left the bar
  // but stayed in the roster) is handled just like a removal:
  //  1. the active session is no longer a LIVE tab → move focus to the first
  //     remaining live tab, or null (empty shell);
  //  2. nothing is active but live tabs exist (e.g. relaunch with only
  //     restorable rows that just went live) → show the first live tab.
  // A frame arriving for any session still wins the pane first (it sets active
  // before this runs). Restorable-only rows never auto-focus — they're the
  // Sidebar's restore-offer, not tabs.
  useEffect(() => {
    const liveOrder = selectLiveSessions(shell).map(
      descriptor => descriptor.appSessionId,
    )
    setActiveSessionId(current => {
      if (current !== null) return activeAfterLiveChange(current, liveOrder)
      return liveOrder[0] ?? null
    })
  }, [shell])

  const activeConnection = selectConnection(connection, activeSessionId)

  // Build one tab model per live session, fusing the host descriptor with the
  // per-session connection view + pending-permission count (the background
  // attention badge). Every tab is computed from its OWN sessionId slice, so a
  // background tab's status/badge is correct without it being active.
  const tabs: TabModel[] = useMemo(
    () =>
      selectLiveSessions(shell).map(descriptor => ({
        descriptor,
        visual: deriveTabVisualState({
          descriptor,
          connection: selectConnection(connection, descriptor.appSessionId),
          pendingPermissionCount: selectPendingPermissionCount(
            permissions,
            descriptor.appSessionId,
          ),
          isActive: descriptor.appSessionId === activeSessionId,
        }),
      })),
    [shell, connection, permissions, activeSessionId],
  )
  const liveSessionIds = useMemo(
    () => tabs.map(tab => tab.descriptor.appSessionId),
    [tabs],
  )
  const liveSessionKey = liveSessionIds.join('\u0000')
  const tabDescriptorsById = useMemo(
    () =>
      new Map(
        tabs.map(tab => [tab.descriptor.appSessionId, tab.descriptor] as const),
      ),
    [tabs],
  )

  // The Sidebar's own projection of the SAME roster (live ∪ restorable),
  // ordered by recency — not a second data source, and not a poll loop: it
  // reads the HostEvent-driven `shell` state the TabBar reads (App seeded it
  // once from listSessions, then keeps it live off subscribeHost).
  const sidebarRows = useMemo(() => selectSidebarRows(shell), [shell])

  useEffect(() => {
    if (!hostSnapshotReady && liveSessionIds.length === 0) return
    setWorkspaceLayoutState(current => {
      const next = reconcileWorkspaceLayout(
        current,
        liveSessionIds,
        activeSessionId,
      )
      return workspaceLayoutsEqual(current, next) ? current : next
    })
  }, [activeSessionId, hostSnapshotReady, liveSessionIds, liveSessionKey])

  useEffect(() => {
    if (!hostSnapshotReady) return
    writeWorkspaceLayoutToStorage(getWorkspaceStorage(), workspaceLayout)
  }, [hostSnapshotReady, workspaceLayout])

  const newSession = useCallback(async () => {
    const bridge = getBridge()
    try {
      // HC1 — the renderer never authors a path: pick → one-time token → create.
      const token = await bridge.pickDirectory(activeSessionId)
      if (!token) return // cancelled
      const result = await bridge.createSession({ cwdToken: token })
      if (result.ok) {
        setActiveSessionId(result.value.appSessionId)
        setShellError(null)
      } else {
        setShellError(hostErrorMessage(result.error))
      }
    } catch (error) {
      setShellError(errorMessage(error))
    }
  }, [activeSessionId])

  useEffect(() => {
    if (!import.meta.env.DEV) return
    const bridge = getBridge()
    if (!bridge.reportDebugShellState) return
    const timer = window.setTimeout(() => {
      bridge.reportDebugShellState?.(
        buildDebugShellStateSnapshot({
          shell,
          connection,
          permissions,
          activeSessionId,
        }),
      )
    }, 250)
    return () => window.clearTimeout(timer)
  }, [shell, connection, permissions, activeSessionId])

  const selectTab = useCallback((sessionId: SessionId) => {
    // Pure UI focus — never touches the frame stream or the P3-4 stores, so no
    // in-flight streaming into a background session is lost on switch.
    const result = focusOrAssignWorkspaceSession(workspaceLayout, sessionId)
    setWorkspaceLayoutState(result.state)
    setLayoutNotice(null)
    setActiveSessionId(sessionId)
  }, [workspaceLayout])

  const focusWorkspacePanelSession = useCallback(
    (index: number, sessionId: SessionId) => {
      setWorkspaceLayoutState(current => focusWorkspacePanel(current, index))
      setActiveSessionId(sessionId)
    },
    [],
  )

  const selectWorkspacePanelSession = useCallback(
    (index: number, sessionId: SessionId) => {
      const result = assignWorkspacePanelSession(
        workspaceLayout,
        index,
        sessionId,
      )
      setWorkspaceLayoutState(result.state)
      setActiveSessionId(
        result.state.panels[result.focusedIndex]?.sessionId ?? sessionId,
      )
      setLayoutNotice(
        result.blocked === 'duplicate'
          ? `${sessionDisplayName(sessionId, tabDescriptorsById)} is already open in panel ${result.focusedIndex + 1}; focused that panel instead.`
          : null,
      )
    },
    [tabDescriptorsById, workspaceLayout],
  )

  const splitWorkspacePanelWithSession = useCallback(
    (index: number, edge: WorkspaceSplitEdge, sessionId: SessionId) => {
      const result = splitWorkspacePanel(workspaceLayout, index, edge, sessionId)
      setWorkspaceLayoutState(result.state)
      setActiveSessionId(
        result.state.panels[result.focusedIndex]?.sessionId ?? sessionId,
      )
      setLayoutNotice(
        result.blocked === 'duplicate'
          ? `${sessionDisplayName(sessionId, tabDescriptorsById)} is already open in panel ${result.focusedIndex + 1}; focused that panel instead.`
          : result.blocked === 'max-panels'
            ? 'Workspace layout supports up to three panels.'
            : null,
      )
    },
    [tabDescriptorsById, workspaceLayout],
  )

  const closeWorkspacePanelAt = useCallback(
    (index: number) => {
      const next = closeWorkspacePanel(workspaceLayout, index)
      setWorkspaceLayoutState(next)
      setActiveSessionId(
        next.panels[next.activeIndex]?.sessionId ?? activeSessionId,
      )
      setLayoutNotice(null)
    },
    [activeSessionId, workspaceLayout],
  )

  const updateWorkspaceWidths = useCallback((widths: number[]) => {
    setWorkspaceLayoutState(current => setWorkspaceWidths(current, widths))
  }, [])

  const closeTab = useCallback(async (sessionId: SessionId) => {
    // Non-destructive: closeSession keeps the registry row and emits
    // session-status(exited, restorable) — NOT session-removed (the row stays in
    // the live∪restorable roster). The tab leaves the TabBar because that clean
    // -close descriptor revokes tab membership in the shell reducer (a CRASH —
    // restorable + disconnected — would keep it); the row then surfaces in the
    // Sidebar as a restorable restore-offer. No optimistic local delete — the
    // projection follows the HostEvent.
    const bridge = getBridge()
    try {
      const result = await bridge.closeSession(sessionId)
      if (!result.ok) setShellError(hostErrorMessage(result.error))
      else setShellError(null)
    } catch (error) {
      setShellError(errorMessage(error))
    }
  }, [])

  const restartTab = useCallback((sessionId: SessionId) => {
    // The dead-tab affordance: re-spawn over the existing CH_RESTART channel.
    try {
      getBridge().restart(sessionId)
      setShellError(null)
    } catch (error) {
      setShellError(errorMessage(error))
    }
  }, [])

  const restoreSession = useCallback(async (sessionId: SessionId) => {
    // The Sidebar restore-offer (REGISTRY §4.4): re-spawn the engine for a
    // restorable row via the HC3 host method. The row becomes a live tab off
    // the resulting session-added/status HostEvents (not an optimistic local
    // add); the resumed session's transcript replays into the pane as
    // replay:true event frames (F1 seed + F2 replay — RESTORE-HISTORY.md).
    const bridge = getBridge()
    try {
      const result = await bridge.restoreSession(sessionId)
      if (result.ok) {
        setActiveSessionId(result.value.appSessionId)
        setShellError(null)
      } else {
        setShellError(hostErrorMessage(result.error))
      }
    } catch (error) {
      setShellError(errorMessage(error))
    }
  }, [])

  function submitSession(
    sessionId: SessionId,
    event: FormEvent<HTMLFormElement>,
  ): void {
    event.preventDefault()
    const sessionLog = selectRawMessageLog(state, sessionId)
    const sessionConnection = selectConnection(connection, sessionId)
    const sessionPrompt = selectPromptDraft(promptDrafts, sessionId)
    const text = sessionPrompt.trim()
    if (
      !sessionLog.inputEnabled ||
      !sessionConnection.inputEnabled ||
      text.length === 0
    ) return

    // This is the existing transport-agnostic app.submit path. Do not send a
    // goalSnapshot unless the renderer actually owns one; if added later, the
    // sidecar's T4 parseThreadGoal validation remains the trust boundary.
    try {
      getBridge().submit(sessionId, text)
      setPromptDrafts(drafts => reducePromptDrafts(drafts, sessionId, ''))
      setTransportError(null)
    } catch (error) {
      setTransportError(errorMessage(error))
    }
  }

  const setSessionPrompt = useCallback((sessionId: SessionId, value: string) => {
    setPromptDrafts(drafts => reducePromptDrafts(drafts, sessionId, value))
  }, [])

  const permissionQueue =
    activeConnection.status === 'ready'
      ? selectPermissionQueue(permissions, activeSessionId)
      : []
  // The card the keyboard shortcuts act on: first un-answered, un-snoozed.
  const pendingPermission =
    activeConnection.status === 'ready'
      ? selectVisiblePermission(permissions, activeSessionId)
      : null

  const respondToPermission = useCallback(
    (
      sessionId: SessionId,
      requestId: string,
      response: PermissionResponseInput,
    ) => {
      dispatchPermission({ type: 'submitted', sessionId, requestId })
      const error = sendPermissionResponse(
        getBridge(),
        sessionId,
        requestId,
        response,
      )
      if (error) {
        dispatchPermission({ type: 'submissionFailed', sessionId, requestId })
        setTransportError(error)
      } else {
        setTransportError(null)
      }
    },
    [],
  )

  const allowPermission = useCallback(
    (requestId: string, applySuggestions: number[] = []) => {
      const sessionId = activeSessionId
      if (!sessionId) return
      const item = permissionQueue.find(
        candidate => candidate.request.requestId === requestId,
      )
      if (!item) return
      respondToPermission(
        sessionId,
        requestId,
        buildAllowResponse(item.request, applySuggestions),
      )
    },
    [activeSessionId, permissionQueue, respondToPermission],
  )

  const denyPermission = useCallback(
    (requestId: string, message?: string) => {
      if (!activeSessionId) return
      respondToPermission(activeSessionId, requestId, buildDenyResponse(message))
    },
	    [activeSessionId, respondToPermission],
  )

  useEffect(() => {
    if (!pendingPermission || !activeSessionId) return

    const handleKeyDown = (event: KeyboardEvent) => {
      // Never hijack keys while the user is typing (e.g. deny feedback).
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
      ) {
        return
      }
      const action = permissionActionForKey(event)
      if (!action) return

      event.preventDefault()
      if (action === 'allow') {
        allowPermission(pendingPermission.requestId, [])
      } else if (action === 'deny') {
        denyPermission(pendingPermission.requestId)
      } else {
        dispatchPermission({
          type: 'dismissed',
          sessionId: activeSessionId,
          requestId: pendingPermission.requestId,
        })
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [
    allowPermission,
    denyPermission,
    pendingPermission,
    activeSessionId,
  ])

  // Shell keyboard: keyboard-first tab switching + create/close, matching the
  // prototype's chords (⌘T new · ⌘W close · ⌘1..9 jump-to-tab). Only fires on a
  // meta/ctrl chord, so it never collides with the plain-key permission
  // shortcuts above (permissionActionForKey ignores modified keys).
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      if (event.key === 'k' || event.key === 'K') {
        // ⌘K toggles the command palette. Palette-internal keys (↑↓/↵/Esc) are
        // handled on its own focused input, so this only owns the open chord.
        event.preventDefault()
        setPaletteOpen(open => !open)
        return
      }
      if (event.key === 't' || event.key === 'T') {
        event.preventDefault()
        void newSession()
        return
      }
      if (event.key === 'w' || event.key === 'W') {
        if (!activeSessionId) return
        event.preventDefault()
        void closeTab(activeSessionId)
        return
      }
      if (event.key >= '1' && event.key <= '9') {
        const target = sessionAtSlot(shell, Number(event.key))
        if (!target) return
        event.preventDefault()
        selectTab(target)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [shell, activeSessionId, newSession, closeTab, selectTab])

  function copyForLlm(sessionId: SessionId): void {
    const text = buildDebugExport(
      selectTranscriptRows(transcript, sessionId),
      selectRawMessageLog(state, sessionId),
    )
    void navigator.clipboard.writeText(text)
  }

  const workspacePanels: WorkspacePanelView[] = workspaceLayout.panels
    .map(panel => {
	      const sessionId = panel.sessionId
	      const sessionLog = selectRawMessageLog(state, sessionId)
	      const sessionConnection = selectConnection(connection, sessionId)
	      const sessionPermissionQueue =
	        sessionConnection.status === 'ready'
	          ? selectPermissionQueue(permissions, sessionId)
	          : []
	      const descriptor = tabDescriptorsById.get(sessionId)
	      const panelPartialCount = sessionLog.messages.filter(
	        message => message.type === 'stream_event',
	      ).length
	      return {
	        sessionId,
	        descriptor,
	        connection: sessionConnection,
	        content: (
	          <SessionPane
	            activeConnection={sessionConnection}
	            activeDescriptor={descriptor}
	            activeLog={sessionLog}
	            activeSessionId={sessionId}
	            allowPermission={(requestId, applySuggestions = []) => {
	              const item = sessionPermissionQueue.find(
	                candidate => candidate.request.requestId === requestId,
	              )
	              if (!item) return
	              respondToPermission(
	                sessionId,
	                requestId,
	                buildAllowResponse(item.request, applySuggestions),
	              )
	            }}
	            copyForLlm={() => copyForLlm(sessionId)}
	            denyPermission={(requestId, message) =>
	              respondToPermission(
	                sessionId,
	                requestId,
	                buildDenyResponse(message),
	              )
	            }
	            partialCount={panelPartialCount}
	            permissionContext={selectPermissionContext(permissions, sessionId)}
	            permissionQueue={sessionPermissionQueue}
	            prompt={selectPromptDraft(promptDrafts, sessionId)}
	            restorePermission={requestId => {
	              dispatchPermission({
	                type: 'restored',
	                sessionId,
	                requestId,
	              })
	            }}
	            setPermissionMode={mode => {
	              try {
	                getBridge().setPermissionMode(sessionId, mode)
	                setTransportError(null)
	              } catch (error) {
	                setTransportError(errorMessage(error))
	              }
	            }}
	            setPrompt={value => setSessionPrompt(sessionId, value)}
	            submit={event => submitSession(sessionId, event)}
	            transcript={transcript}
	            transportError={transportError}
	          />
	        ),
	      }
	    })
	    .filter(panel => panel.descriptor)

  // The ⌘K palette inventory — every entry is a real action wired to an existing
  // App handler (no mocked rows). Actions needing an active session / open panel
  // are omitted when unavailable, and the session rows ARE the search corpus
  // (the same live ∪ restorable roster the Sidebar renders). Built only while the
  // palette is open: the palette owns its own query state, so App re-renders come
  // only from streaming frames / composer keystrokes — rebuilding the inventory
  // (and its closures) on those while the palette is closed is pure waste.
  const paletteItems = paletteOpen
    ? buildPaletteItems({
        rows: sidebarRows,
        activeSessionId,
        hasPanels: workspacePanels.length > 0,
        handlers: {
          newSession: () => void newSession(),
          closeActiveSession: () => {
            if (activeSessionId) void closeTab(activeSessionId)
          },
          restartActiveSession: () => {
            if (activeSessionId) restartTab(activeSessionId)
          },
          copyActiveTranscript: () => {
            if (activeSessionId) copyForLlm(activeSessionId)
          },
          closeCurrentPanel: () =>
            closeWorkspacePanelAt(workspaceLayout.activeIndex),
          selectLiveSession: selectTab,
          restoreSession,
        },
      })
    : EMPTY_PALETTE_ITEMS

  return (
    <div className="flex h-screen bg-app-bg font-sans text-text-primary">
      {/* Sidebar rail (P3-5b): the full roster (live ∪ restorable) + the
       * restore-offer, alongside the TabBar's live-only view. */}
      <Sidebar
        rows={sidebarRows}
        activeSessionId={activeSessionId}
        onSelectLive={selectTab}
        onRestore={restoreSession}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <TabBar
          tabs={tabs}
          activeSessionId={activeSessionId}
          onSelect={selectTab}
          onClose={closeTab}
          onRestart={restartTab}
          onNewTab={newSession}
        />

        {shellError ? (
          <div className="border-b border-shell-seam bg-shell-chrome px-6 py-1.5 text-xs text-tone-danger">
            {shellError}
          </div>
        ) : null}

        {/* The workspace panels are renderer-owned layout over the P3-4
         * session-keyed stores. Each panel reads its own session slice, so visible
         * background sessions keep rendering without becoming the active tab. */}
	        {workspacePanels.length === 0 || !activeSessionId ? (
          <EmptyShell onNewTab={newSession} />
        ) : (
	          <WorkspaceLayout
	            layout={workspaceLayout}
	            panels={workspacePanels}
	            sessions={tabs.map(tab => tab.descriptor)}
	            notice={layoutNotice}
	            onClosePanel={closeWorkspacePanelAt}
	            onFocusPanel={focusWorkspacePanelSession}
	            onSelectSession={selectWorkspacePanelSession}
	            onSplitPanel={splitWorkspacePanelWithSession}
	            onWidthsChange={updateWorkspaceWidths}
          />
        )}
      </div>

      {/* ⌘K command palette (P3-7): a fixed overlay above the whole shell. */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        items={paletteItems}
      />
    </div>
  )
}

/** The shell with no live sessions — invites creating the first one (HC1). */
function EmptyShell({ onNewTab }: { onNewTab: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 text-center">
      <p className="text-sm text-text-muted">No sessions open.</p>
      <button
        className="rounded bg-accent px-4 py-2 text-sm text-app-bg"
        onClick={onNewTab}
        type="button"
      >
        New session
      </button>
      <p className="text-xs text-text-subtle">or press ⌘T</p>
    </div>
  )
}

/**
 * One session pane — the P2 transcript spine + prompt + permission surfaces.
 * App supplies one instance per visible workspace panel, scoped to that panel's
 * session id; switching focus never tears down a background session's state.
 */
export function SessionPane({
  activeConnection,
  activeDescriptor,
  activeLog,
  activeSessionId,
  allowPermission,
  copyForLlm,
  denyPermission,
  partialCount,
  permissionContext,
  permissionQueue,
  prompt,
  restorePermission,
  setPermissionMode,
  setPrompt,
  submit,
  transcript,
  transportError,
}: SessionPaneProps) {
  // SlashCommandPicker (P3-7): typeahead over THIS session's real slash catalog
  // (the `slash_commands` the sidecar's `getCommands(cwd)` produced, captured
  // from the init frame). Picking inserts `/name ` into the draft; the user
  // submits it verbatim through the existing app.submit — no command-execution
  // capability is added to the renderer.
  const [slashActiveIndex, setSlashActiveIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const slashCommands = selectSlashCommands(transcript, activeSessionId)
  const slashQuery = parseSlashDraft(prompt)
  const slashMatches =
    slashQuery === null ? [] : filterSlashCommands(slashCommands, slashQuery)
  const slashOpen =
    !slashDismissed && slashQuery !== null && slashMatches.length > 0
  const slashIndex =
    slashMatches.length === 0
      ? 0
      : Math.min(slashActiveIndex, slashMatches.length - 1)

  // Reset selection (and re-open after an Escape) whenever the query text
  // changes — i.e. the user typed. Keyed on the query so an Escape (which does
  // not change the draft) leaves the picker dismissed until they type again.
  useEffect(() => {
    setSlashActiveIndex(0)
    setSlashDismissed(false)
  }, [slashQuery])

  const pickSlashCommand = (name: string): void => {
    setPrompt(completeSlashDraft(name))
    setSlashDismissed(false)
    setSlashActiveIndex(0)
  }

  const onComposerKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement>,
  ): void => {
    if (!slashOpen) return
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setSlashActiveIndex(index =>
          nextSlashIndex(index, slashMatches.length, 1),
        )
        break
      case 'ArrowUp':
        event.preventDefault()
        setSlashActiveIndex(index =>
          nextSlashIndex(index, slashMatches.length, -1),
        )
        break
      case 'Enter':
      case 'Tab':
        // Enter completes the command instead of submitting the form; Tab is the
        // usual typeahead-accept key. Both keep the draft in the composer so the
        // user can add arguments before submitting.
        event.preventDefault()
        pickSlashCommand(slashMatches[slashIndex])
        break
      case 'Escape':
        event.preventDefault()
        setSlashDismissed(true)
        break
      default:
        break
    }
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-8">
      <div className="flex items-center justify-between gap-3 text-sm text-text-muted">
        <span>
          {activeDescriptor ? (
            <span className="mr-2 font-mono text-xs text-text-subtle">
              {activeDescriptor.cwd}
            </span>
          ) : null}
          {activeConnection.status} · {activeLog.messages.length} messages · {partialCount}{' '}
          partial frames
        </span>
        <button
          className="rounded border border-text-subtle px-3 py-1 text-xs text-text-primary"
          onClick={copyForLlm}
          type="button"
        >
          Copy for LLM
        </button>
      </div>

      <ConnectionRecovery
        connection={activeConnection}
        sessionId={activeSessionId}
      />

      <form className="flex gap-3" onSubmit={submit}>
        <div className="relative min-w-0 flex-1">
          <SlashCommandPicker
            open={slashOpen}
            query={slashQuery ?? ''}
            commands={slashMatches}
            activeIndex={slashIndex}
            onPick={pickSlashCommand}
          />
          <input
            aria-label="Prompt"
            className="w-full rounded border border-text-subtle bg-app-bg px-3 py-2 font-mono"
            disabled={
              !activeSessionId ||
              !activeLog.inputEnabled ||
              !activeConnection.inputEnabled
            }
            onChange={event => setPrompt(event.target.value)}
            onKeyDown={onComposerKeyDown}
            placeholder="Send a prompt to the live engine"
            value={prompt}
          />
        </div>
        <button
          className="rounded bg-accent px-4 py-2 text-app-bg disabled:opacity-50"
          disabled={
            !activeSessionId ||
            !activeLog.inputEnabled ||
            !activeConnection.inputEnabled ||
            prompt.trim().length === 0
          }
          type="submit"
        >
          Send
        </button>
      </form>

      <PermissionQueue
        items={permissionQueue}
        onAllow={allowPermission}
        onDeny={denyPermission}
        onRestore={restorePermission}
      />

      <details className="rounded border border-text-subtle/50 px-3 py-2">
        <summary className="cursor-pointer text-sm text-text-muted">
          Permissions
          {permissionContext ? (
            <span className="ml-2 font-mono text-xs text-accent">
              {permissionContext.mode}
            </span>
          ) : null}
        </summary>
        <div className="mt-2">
          <PermissionRulesEditor
            context={permissionContext}
            onSetMode={setPermissionMode}
          />
        </div>
      </details>

      {activeLog.error ? (
        <div className="text-sm text-tone-danger">{activeLog.error}</div>
      ) : null}

      {transportError ? (
        <div className="text-sm text-tone-danger">{transportError}</div>
      ) : null}

      {activeLog.truncated ? (
        <div className="text-sm text-tone-warning">
          Raw message history was truncated to the renderer retention budget.
        </div>
      ) : null}

      <section className="flex min-h-0 flex-1 flex-col">
        <h1 className="mb-2 text-sm text-text-muted">Transcript (projected)</h1>
        <div className="min-h-0 flex-1 overflow-auto rounded border border-text-subtle p-4">
          <TranscriptView
            activeSessionId={activeSessionId}
            state={transcript}
          />
        </div>
      </section>

      <section className="flex min-h-0 flex-1 flex-col">
        <h1 className="mb-2 text-sm text-text-muted">Raw SDKMessage events</h1>
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded border border-text-subtle p-4 font-mono text-xs">
          {JSON.stringify(activeLog.messages, null, 2)}
        </pre>
      </section>
    </main>
  )
}

export function ConnectionRecovery({
  connection,
  sessionId,
}: {
  connection: ConnectionSnapshot
  sessionId: SessionId | null
}) {
  const [restartError, setRestartError] = useState<string | null>(null)
  if (
    !sessionId ||
    connection.status === 'connecting' ||
    connection.status === 'ready'
  ) {
    return null
  }

  return (
    <div className="flex items-center gap-3 text-sm text-tone-danger">
      <span>Session {connection.status}.</span>
      <button
        className="rounded border border-tone-danger px-3 py-1 text-xs"
        onClick={() => {
          try {
            getBridge().restart(sessionId)
            setRestartError(null)
          } catch (error) {
            setRestartError(errorMessage(error))
          }
        }}
        type="button"
      >
        Restart
      </button>
      {restartError ? <span>{restartError}</span> : null}
    </div>
  )
}

export function sendPermissionResponse(
  bridge: Pick<CatCodeBridge, 'respondPermission'>,
  sessionId: SessionId,
  requestId: string,
  response: PermissionResponseInput,
): string | null {
  try {
    bridge.respondPermission(sessionId, requestId, response)
    return null
  } catch (error) {
    return errorMessage(error)
  }
}

/** Stable empty inventory for the closed palette — a fresh `[]` each render would
 * bust the palette's `useMemo(filter)` identity check for no reason. */
const EMPTY_PALETTE_ITEMS: PaletteItem[] = []

export type PromptDraftState = Record<SessionId, string>

export function selectPromptDraft(
  drafts: PromptDraftState,
  sessionId: SessionId | null,
): string {
  if (!sessionId) return ''
  return drafts[sessionId] ?? ''
}

export function reducePromptDrafts(
  drafts: PromptDraftState,
  sessionId: SessionId | null,
  value: string,
): PromptDraftState {
  if (!sessionId) return drafts
  if (value.length === 0) {
    if (!(sessionId in drafts)) return drafts
    const next = { ...drafts }
    delete next[sessionId]
    return next
  }
  if (drafts[sessionId] === value) return drafts
  return { ...drafts, [sessionId]: value }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function getWorkspaceStorage(): Pick<Storage, 'getItem' | 'removeItem' | 'setItem'> | null {
  if (typeof window === 'undefined') return null
  return window.localStorage
}

function sessionDisplayName(
  sessionId: SessionId,
  descriptors: ReadonlyMap<SessionId, SessionDescriptor>,
): string {
  const descriptor = descriptors.get(sessionId)
  return descriptor ? tabLabel(descriptor) : sessionId
}

function hostErrorMessage(error: HostError): string {
  return `${error.code}: ${error.message}`
}

/**
 * Local reducer that folds the two shell inputs — the one-shot `listSessions()`
 * hydrate and the live `HostEvent` stream — into the roster projection. Keeping
 * the pure roster fold (`reduceShellState`) separate lets the state module stay
 * event-only and unit-testable without React.
 */
type ShellAction =
  | {
      type: 'hydrate'
      sessions: readonly SessionDescriptor[]
      /** Ids a live `session-removed` already dropped — never resurrect them. */
      removed: ReadonlySet<SessionId>
    }
  | { type: 'event'; event: HostEvent }

function reduceShell(state: ShellState, action: ShellAction): ShellState {
  if (action.type === 'hydrate') {
    // The snapshot is a BASELINE, folded AFTER the live subscription is already
    // installed (F3 subscribe-before-snapshot). It fills gaps only and never
    // clobbers a fresher live event that already landed:
    //  - an id a live `session-removed` already dropped is skipped (no
    //    resurrection from the stale snapshot);
    //  - an id already present keeps whichever descriptor is NEWER by
    //    `lastAttachedAt` (a live status that superseded the snapshot wins; a
    //    snapshot row never rolls a live update backwards);
    //  - a genuinely new id (only in the snapshot) is added.
    let next = state
    for (const session of action.sessions) {
      const id = session.appSessionId
      if (action.removed.has(id)) continue
      const existing = next.byId[id]
      if (existing && existing.lastAttachedAt >= session.lastAttachedAt) {
        continue // live descriptor is at least as fresh — don't roll back
      }
      next = reduceShellState(next, { type: 'session-added', session })
    }
    return next
  }
  return reduceShellState(state, action.event)
}

type SessionPaneProps = {
  activeConnection: ConnectionSnapshot
  activeDescriptor: SessionDescriptor | undefined
  activeLog: RawMessageSessionLog
  activeSessionId: SessionId | null
  allowPermission: (requestId: string, applySuggestions?: number[]) => void
  copyForLlm: () => void
  denyPermission: (requestId: string, message?: string) => void
  partialCount: number
  permissionContext: ReturnType<typeof selectPermissionContext>
  permissionQueue: ReturnType<typeof selectPermissionQueue>
  prompt: string
  restorePermission: (requestId: string) => void
  setPermissionMode: (mode: PermissionSetModeMode) => void
  setPrompt: (value: string) => void
  submit: (event: FormEvent<HTMLFormElement>) => void
  transcript: TranscriptState
  transportError: string | null
}

export function buildDebugExport(
  transcriptRows: TranscriptRow[],
  rawLog: RawMessageSessionLog,
): string {
  return `# CatCode debug export

> ⚠️ [!WARNING]
> **POTENTIALLY SENSITIVE:** The raw transcript and debug clipboard output may contain
> sensitive file contents, command inputs/outputs, or credential material that passed
> the outbound key-name secret guard. Handle this export with care.

## Transcript (projected)

\`\`\`json
${JSON.stringify(transcriptRows, null, 2)}
\`\`\`

## Raw SDKMessage events

Raw retention: ${rawLog.truncated ? 'TRUNCATED' : 'complete'} (${rawLog.retainedBytes} UTF-8 JSON bytes retained)

\`\`\`json
${JSON.stringify(rawLog.messages, null, 2)}
\`\`\`
`
}
