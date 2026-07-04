import {
  useCallback,
  useEffect,
  useReducer,
  useState,
  type FormEvent,
} from 'react'
import { getBridge } from './bridge.js'
import {
  PermissionPrompt,
  permissionActionForKey,
} from './PermissionPrompt.js'
import {
  buildAllowResponse,
  buildDenyResponse,
  createPermissionState,
  reducePermissionState,
  selectVisiblePermission,
} from './permissionState.js'
import {
  createRawMessageLogState,
  reduceServerFrame,
  selectActiveRawMessageLog,
  type RawMessageSessionLog,
} from './rawMessageLog.js'
import {
  createTranscriptState,
  projectServerFrame,
  selectNestedTranscriptRows,
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
  const [connection, dispatchConnection] = useReducer(
    reduceConnectionState,
    undefined,
    createConnectionState,
  )

  useEffect(() => {
    const bridge = getBridge()
    const unsubscribe = bridge.subscribe(frame => {
      dispatch(frame)
      dispatchPermission({ type: 'frame', frame })
      dispatchConnection(frame)
      dispatchSessionEvent(frame)
    })
    bridge.rendererReady()
    return unsubscribe
  }, [])

  const activeLog = selectActiveRawMessageLog(state)
  const transcriptRows = selectTranscriptRows(transcript, state.activeSessionId)
  // Nested for display only (D2/C4 subagent nesting) — the debug export and
  // any other flat consumer keep reading `transcriptRows` untransformed.
  const nestedTranscriptRows = selectNestedTranscriptRows(
    transcript,
    state.activeSessionId,
  )
  const activeConnection = selectConnection(
    connection,
    state.activeSessionId,
  )

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const text = prompt.trim()
    if (
      !state.activeSessionId ||
      !activeLog.inputEnabled ||
      !activeConnection.inputEnabled ||
      text.length === 0
    ) return

    // This is the existing transport-agnostic app.submit path. Do not send a
    // goalSnapshot unless the renderer actually owns one; if added later, the
    // sidecar's T4 parseThreadGoal validation remains the trust boundary.
    try {
      getBridge().submit(state.activeSessionId, text)
      setPrompt('')
      setTransportError(null)
    } catch (error) {
      setTransportError(errorMessage(error))
    }
  }

  const pendingPermission =
    activeConnection.status === 'ready'
      ? selectVisiblePermission(permissions, state.activeSessionId)
      : null

  const allowPermission = useCallback(() => {
    if (!pendingPermission || !state.activeSessionId) return
    dispatchPermission({
      type: 'submitted',
      sessionId: state.activeSessionId,
      requestId: pendingPermission.requestId,
    })
    const error = sendPermissionResponse(
      getBridge(),
      state.activeSessionId,
      pendingPermission.requestId,
      buildAllowResponse(pendingPermission),
    )
    if (error) {
      dispatchPermission({
        type: 'submissionFailed',
        sessionId: state.activeSessionId,
        requestId: pendingPermission.requestId,
      })
      setTransportError(error)
    } else {
      setTransportError(null)
    }
  }, [pendingPermission, state.activeSessionId])

  const denyPermission = useCallback(() => {
    if (!pendingPermission || !state.activeSessionId) return
    dispatchPermission({
      type: 'submitted',
      sessionId: state.activeSessionId,
      requestId: pendingPermission.requestId,
    })
    const error = sendPermissionResponse(
      getBridge(),
      state.activeSessionId,
      pendingPermission.requestId,
      buildDenyResponse(),
    )
    if (error) {
      dispatchPermission({
        type: 'submissionFailed',
        sessionId: state.activeSessionId,
        requestId: pendingPermission.requestId,
      })
      setTransportError(error)
    } else {
      setTransportError(null)
    }
  }, [pendingPermission, state.activeSessionId])

  useEffect(() => {
    const activeSessionId = state.activeSessionId
    if (!pendingPermission || !activeSessionId) return

    const handleKeyDown = (event: KeyboardEvent) => {
      const action = permissionActionForKey(event)
      if (!action) return

      event.preventDefault()
      if (action === 'allow') {
        allowPermission()
      } else if (action === 'deny') {
        denyPermission()
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
    state.activeSessionId,
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
        sessionId={state.activeSessionId}
      />

      <form className="flex gap-3" onSubmit={submit}>
        <input
          aria-label="Prompt"
          className="min-w-0 flex-1 rounded border border-text-subtle bg-app-bg px-3 py-2 font-mono"
          disabled={
            !state.activeSessionId ||
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
            !state.activeSessionId ||
            !activeLog.inputEnabled ||
            !activeConnection.inputEnabled ||
            prompt.trim().length === 0
          }
          type="submit"
        >
          Send
        </button>
      </form>

      <div aria-label="Permission requests">
        {pendingPermission ? (
          <PermissionPrompt
            onAllow={allowPermission}
            onDeny={denyPermission}
            request={pendingPermission}
          />
        ) : null}
      </div>

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
          <TranscriptView rows={nestedTranscriptRows} />
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
