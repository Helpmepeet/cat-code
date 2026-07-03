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
} from './rawMessageLog.js'
import {
  createTranscriptState,
  projectSessionEvent,
} from './transcriptProjector.js'
import { TranscriptView } from './TranscriptView.js'

export function App() {
  const [state, dispatch] = useReducer(
    reduceServerFrame,
    undefined,
    createRawMessageLogState,
  )
  const [transcript, dispatchSessionEvent] = useReducer(
    projectSessionEvent,
    undefined,
    createTranscriptState,
  )
  const [permissions, dispatchPermission] = useReducer(
    reducePermissionState,
    undefined,
    createPermissionState,
  )
  const [prompt, setPrompt] = useState('')

  useEffect(() => {
    const bridge = getBridge()
    const unsubscribe = bridge.subscribe(frame => {
      dispatch(frame)
      dispatchPermission({ type: 'frame', frame })
      // The projector (§5 layer 2) consumes the raw AppSessionEvent stream.
      if (frame.kind === 'event') dispatchSessionEvent(frame.event)
    })
    bridge.rendererReady()
    return unsubscribe
  }, [])

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const text = prompt.trim()
    if (!state.sessionId || !state.inputEnabled || text.length === 0) return

    // This is the existing transport-agnostic app.submit path. Do not send a
    // goalSnapshot unless the renderer actually owns one; if added later, the
    // sidecar's T4 parseThreadGoal validation remains the trust boundary.
    getBridge().submit(state.sessionId, text)
    setPrompt('')
  }

  const pendingPermission = selectVisiblePermission(permissions)

  const allowPermission = useCallback(() => {
    if (!pendingPermission || !state.sessionId) return
    dispatchPermission({
      type: 'decided',
      requestId: pendingPermission.requestId,
    })
    getBridge().respondPermission(
      state.sessionId,
      pendingPermission.requestId,
      buildAllowResponse(pendingPermission),
    )
  }, [pendingPermission, state.sessionId])

  const denyPermission = useCallback(() => {
    if (!pendingPermission || !state.sessionId) return
    dispatchPermission({
      type: 'decided',
      requestId: pendingPermission.requestId,
    })
    getBridge().respondPermission(
      state.sessionId,
      pendingPermission.requestId,
      buildDenyResponse(),
    )
  }, [pendingPermission, state.sessionId])

  useEffect(() => {
    if (!pendingPermission) return

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
          requestId: pendingPermission.requestId,
        })
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [allowPermission, denyPermission, pendingPermission])

  const connectionState = state.sessionId ? 'ready' : 'connecting'
  const partialCount = state.messages.filter(
    message => message.type === 'stream_event',
  ).length

  function copyForLlm(): void {
    const text = `# CatCode debug export

## Transcript (projected)

\`\`\`json
${JSON.stringify(transcript.rows, null, 2)}
\`\`\`

## Raw SDKMessage events

\`\`\`json
${JSON.stringify(state.messages, null, 2)}
\`\`\`
`
    void navigator.clipboard.writeText(text)
  }

  return (
    <main className="h-screen bg-app-bg text-text-primary font-sans p-8 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 text-sm text-text-muted">
        <span>
          {connectionState} · {state.messages.length} messages · {partialCount}{' '}
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

      <form className="flex gap-3" onSubmit={submit}>
        <input
          aria-label="Prompt"
          className="min-w-0 flex-1 rounded border border-text-subtle bg-app-bg px-3 py-2 font-mono"
          disabled={!state.sessionId || !state.inputEnabled}
          onChange={event => setPrompt(event.target.value)}
          placeholder="Send a prompt to the live engine"
          value={prompt}
        />
        <button
          className="rounded bg-accent px-4 py-2 text-app-bg disabled:opacity-50"
          disabled={
            !state.sessionId || !state.inputEnabled || prompt.trim().length === 0
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

      {state.error ? (
        <div className="text-sm text-tone-danger">{state.error}</div>
      ) : null}

      <section className="flex min-h-0 flex-1 flex-col">
        <h1 className="mb-2 text-sm text-text-muted">Transcript (projected)</h1>
        <div className="min-h-0 flex-1 overflow-auto rounded border border-text-subtle p-4">
          <TranscriptView rows={transcript.rows} />
        </div>
      </section>

      <section className="flex min-h-0 flex-1 flex-col">
        <h1 className="mb-2 text-sm text-text-muted">Raw SDKMessage events</h1>
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded border border-text-subtle p-4 font-mono text-xs">
          {JSON.stringify(state.messages, null, 2)}
        </pre>
      </section>
    </main>
  )
}
