import { useState } from 'react'
import type { PermissionRequest } from './permissionState.js'
import { describeSuggestion } from './permissionPromptModel.js'

/**
 * One permission card. Options map 1:1 to the S2 §5 payload contract:
 *   Allow            → allow once (empty selection)
 *   Always allow …   → allow + `applySuggestions` (C1 index selection into
 *                      THIS request's engine-minted suggestions; shown only
 *                      when the engine actually minted any)
 *   Deny             → deny with the feedback text (the model-visible refusal)
 *
 * `denyOnly` drops both allow paths. An AskUserQuestion whose questions cannot
 * be read falls back to this card, and a bare allow there would run the tool
 * with NO answers — the thing `permissionState.ts`'s `selectVisiblePermission`
 * comment forbids and the keyboard path already refuses
 * (decisions/ASK-USER-QUESTION-ANSWER.md). Mouse and keyboard must agree.
 */
export function PermissionPrompt({
  request,
  submitted,
  denyOnly,
  onAllow,
  onDeny,
}: {
  request: PermissionRequest
  /** True while an answer for this card is in flight. */
  submitted?: boolean
  /** Hide every allow path: this request can only be answered by denying it. */
  denyOnly?: boolean
  onAllow: (applySuggestions: number[]) => void
  onDeny: (message?: string) => void
}) {
  const [denyMessage, setDenyMessage] = useState('')
  const titleId = `permission-title-${request.requestId}`
  const suggestions = Array.isArray(request.request.permission_suggestions)
    ? request.request.permission_suggestions
    : []
  const workerId = request.request.agent_id

  return (
    <section
      aria-labelledby={titleId}
      className="border-l-2 border-accent bg-text-primary/[0.04] px-4 py-3"
      role="alertdialog"
    >
      {workerId ? (
        <div className="mb-2 flex items-center gap-2">
          <span className="rounded bg-violet-400/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.05em] text-violet-300">
            worker
          </span>
          <p className="text-[11px] text-text-subtle">
            Relayed from worker{' '}
            <span className="font-mono text-violet-300">{workerId}</span>
          </p>
        </div>
      ) : null}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-text-primary" id={titleId}>
            {request.request.title ?? 'Permission required'}
          </h2>
          <p className="mt-1 text-xs text-text-muted">
            Allow{' '}
            <span className="font-mono text-accent">
              {request.request.display_name ?? request.request.tool_name}
            </span>
            ?
          </p>
          {request.request.decision_reason ? (
            <p className="mt-1 text-xs text-text-subtle">
              Why: {request.request.decision_reason}
            </p>
          ) : null}
          {request.request.blocked_path ? (
            <p className="mt-1 font-mono text-xs text-text-subtle">
              Path: {request.request.blocked_path}
            </p>
          ) : null}
          {denyOnly ? (
            <p className="mt-1 text-xs text-text-subtle">
              This question could not be read, so it can only be denied. Add a
              note below to say what you wanted.
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            className="rounded border border-text-subtle px-3 py-1.5 text-xs text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
            disabled={submitted}
            onClick={() => onDeny(denyMessage)}
            type="button"
          >
            Deny
          </button>
          {denyOnly ? null : (
            <button
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-app-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
              disabled={submitted}
              onClick={() => onAllow([])}
              type="button"
            >
              Allow
            </button>
          )}
        </div>
      </div>

      <pre className="mt-3 max-h-36 overflow-auto whitespace-pre-wrap rounded border border-text-subtle/50 p-3 font-mono text-xs text-text-muted">
        {JSON.stringify(request.request.input, null, 2)}
      </pre>

      {!denyOnly && suggestions.length > 0 ? (
        <div aria-label="Always allow options" className="mt-2 flex flex-col gap-1">
          {suggestions.map((suggestion, index) => (
            <button
              className="rounded border border-accent/60 px-3 py-1.5 text-left text-xs text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
              disabled={submitted}
              key={index}
              onClick={() => onAllow([index])}
              type="button"
            >
              Always allow:{' '}
              <span className="font-mono">{describeSuggestion(suggestion)}</span>
            </button>
          ))}
        </div>
      ) : null}

      <input
        aria-label="Deny feedback"
        className="mt-2 w-full rounded border border-text-subtle/50 bg-app-bg px-2 py-1.5 font-mono text-xs text-text-primary"
        disabled={submitted}
        onChange={event => setDenyMessage(event.target.value)}
        placeholder="Tell Cat Code what to do differently (sent with Deny)"
        value={denyMessage}
      />

      {/* The generic shortcuts skip this request entirely (`selectVisiblePermission`),
       * so advertising them on a deny-only card would be a dead affordance. */}
      {denyOnly ? null : (
        <p className="mt-2 font-mono text-[11px] text-text-subtle">
          Enter allow · N / ⌫ deny · Esc snooze
        </p>
      )}
    </section>
  )
}
