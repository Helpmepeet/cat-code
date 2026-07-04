import {
  useCallback,
  useEffect,
  useReducer,
  useState,
  type FormEvent,
} from 'react'
import { getBridge } from './bridge.js'
import { permissionActionForKey } from './PermissionPrompt.js'
import { PermissionQueue } from './PermissionQueue.js'
import { PermissionRulesEditor } from './PermissionRulesEditor.js'
import {
  buildAllowResponse,
  buildDenyResponse,
  createPermissionState,
  reducePermissionState,
  selectPermissionContext,
  selectPermissionQueue,
  selectVisiblePermission,
} from './permissionState.js'
import {
  createRawMessageLogState,
  reduceServerFrame,
  selectRawMessageLog,
  type RawMessageSessionLog,
} from './rawMessageLog.js'
import {
  createTranscriptState,
  projectServerFrame,
  selectTranscriptRows,
  type TranscriptRow,
} from './transcriptProjector.js'
import { TranscriptView } from './TranscriptView.js'
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
  const [prompt, setPrompt] = useState('')
  const [transportError, setTransportError] = useState<string | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<SessionId | null>(null)
  const [connection, dispatchConnection] = useReducer(
    reduceConnectionState,
    undefined,
    createConnectionState,
  )

  useEffect(() => {
    const bridge = getBridge()
    const unsubscribe = bridge.subscribe(frame => {
      // Active selection is renderer-owned UI state. A background frame can
      // create/update its addressed slice, but never steals focus.
      setActiveSessionId(current => current ?? frame.sessionId)
      dispatch(frame)
      dispatchPermission({ type: 'frame', frame })
      dispatchConnection(frame)
      dispatchSessionEvent(frame)
    })
    bridge.rendererReady()
    return unsubscribe
  }, [])

  const activeLog = selectRawMessageLog(state, activeSessionId)
  const transcriptRows = selectTranscriptRows(transcript, activeSessionId)
  const activeConnection = selectConnection(connection, activeSessionId)

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const text = prompt.trim()
    if (
      !activeSessionId ||
      !activeLog.inputEnabled ||
      !activeConnection.inputEnabled ||
      text.length === 0
    ) return

    // This is the existing transport-agnostic app.submit path. Do not send a
    // goalSnapshot unless the renderer actually owns one; if added later, the
    // sidecar's T4 parseThreadGoal validation remains the trust boundary.
    try {
      getBridge().submit(activeSessionId, text)
      setPrompt('')
      setTransportError(null)
    } catch (error) {
      setTransportError(errorMessage(error))
    }
  }

  const permissionQueue =
    activeConnection.status === 'ready'
      ? selectPermissionQueue(permissions, activeSessionId)
      : []
  const permissionContext = selectPermissionContext(
    permissions,
    activeSessionId,
  )
  // The card the keyboard shortcuts act on: first un-answered, un-snoozed.
  const pendingPermission =
    activeConnection.status === 'ready'
      ? selectVisiblePermission(permissions, activeSessionId)
      : null

  const respondToPermission = useCallback(
    (requestId: string, response: PermissionResponseInput) => {
      const sessionId = activeSessionId
      if (!sessionId) return
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
    [activeSessionId],
  )

  const allowPermission = useCallback(
    (requestId: string, applySuggestions: number[] = []) => {
      const item = permissionQueue.find(
        candidate => candidate.request.requestId === requestId,
      )
      if (!item) return
      respondToPermission(
        requestId,
        buildAllowResponse(item.request, applySuggestions),
      )
    },
    [permissionQueue, respondToPermission],
  )

  const denyPermission = useCallback(
    (requestId: string, message?: string) => {
      respondToPermission(requestId, buildDenyResponse(message))
    },
    [respondToPermission],
  )

  const restorePermission = useCallback(
    (requestId: string) => {
      if (!activeSessionId) return
      dispatchPermission({
        type: 'restored',
        sessionId: activeSessionId,
        requestId,
      })
    },
    [activeSessionId],
  )

  const setPermissionMode = useCallback(
    (mode: PermissionSetModeMode) => {
      if (!activeSessionId) return
      // C2 — session-scoped mode switch; the sidecar validates the mode and
      // answers with a fresh permission.context snapshot (the ack).
      try {
        getBridge().setPermissionMode(activeSessionId, mode)
        setTransportError(null)
      } catch (error) {
        setTransportError(errorMessage(error))
      }
    },
    [activeSessionId],
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

  const partialCount = activeLog.messages.filter(
    message => message.type === 'stream_event',
  ).length

  function copyForLlm(): void {
    const text = buildDebugExport(transcriptRows, activeLog)
    void navigator.clipboard.writeText(text)
  }

  return (
    <main className="h-screen bg-app-bg text-text-primary font-sans p-8 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 text-sm text-text-muted">
        <span>
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
        <input
          aria-label="Prompt"
          className="min-w-0 flex-1 rounded border border-text-subtle bg-app-bg px-3 py-2 font-mono"
          disabled={
            !activeSessionId ||
            !activeLog.inputEnabled ||
            !activeConnection.inputEnabled
          }
          onChange={event => setPrompt(event.target.value)}
          placeholder="Send a prompt to the live engine"
          value={prompt}
        />
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
