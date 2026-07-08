import { useState } from 'react'
import type { PermissionUpdate } from '@cat-code/engine/sdk'
import type { PermissionRequest } from './permissionState.js'

export type PermissionKeyboardAction = 'allow' | 'deny' | 'dismiss'

type KeyLike = {
  key: string
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
}

export function permissionActionForKey(
  event: KeyLike,
): PermissionKeyboardAction | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null
  if (event.key === 'Enter') return 'allow'
  if (event.key.toLowerCase() === 'n' || event.key === 'Backspace') return 'deny'
  if (event.key === 'Escape') return 'dismiss'
  return null
}

/**
 * Display an ENGINE-minted permission suggestion. This renders the engine's
 * own rule content verbatim (`Tool` / `Tool(content)` — the engine's own
 * serialization idiom); nothing here derives or invents scope. The
 * prototype's client-side `ruleImplication` guesser is deliberately CUT
 * (S2 §7 — rendering a guessed rule that differs from what would be
 * persisted is a correctness bug).
 */
export function describeSuggestion(update: PermissionUpdate): string {
  switch (update.type) {
    case 'addRules':
    case 'replaceRules':
    case 'removeRules': {
      const rules = update.rules
        .map(rule =>
          rule.ruleContent
            ? `${rule.toolName}(${rule.ruleContent})`
            : rule.toolName,
        )
        .join(', ')
      return `${update.behavior} ${rules} · ${update.destination}`
    }
    case 'setMode':
      return `mode → ${update.mode} · ${update.destination}`
    case 'addDirectories':
    case 'removeDirectories':
      return `${update.type === 'addDirectories' ? 'allow' : 'remove'} directory ${update.directories.join(', ')} · ${update.destination}`
    default: {
      // Compile-time exhaustiveness tripwire (P2-0 idiom, see
      // transcriptProjector.ts): if PermissionUpdate grows a variant, this
      // assignment errors until it gets an explicit case above.
      const _exhaustive: never = update
      return `unknown permission update · ${JSON.stringify(_exhaustive)}`
    }
  }
}

/**
 * One permission card. Options map 1:1 to the S2 §5 payload contract:
 *   Allow            → allow once (empty selection)
 *   Always allow …   → allow + `applySuggestions` (C1 index selection into
 *                      THIS request's engine-minted suggestions; shown only
 *                      when the engine actually minted any)
 *   Deny             → deny with the feedback text (the model-visible refusal)
 */
export function PermissionPrompt({
  request,
  submitted,
  onAllow,
  onDeny,
}: {
  request: PermissionRequest
  /** True while an answer for this card is in flight. */
  submitted?: boolean
  onAllow: (applySuggestions: number[]) => void
  onDeny: (message?: string) => void
}) {
  const [denyMessage, setDenyMessage] = useState('')
  const titleId = `permission-title-${request.requestId}`
  const suggestions = Array.isArray(request.request.permission_suggestions)
    ? request.request.permission_suggestions
    : []

  return (
    <section
      aria-labelledby={titleId}
      className="border-l-2 border-accent bg-text-primary/[0.04] px-4 py-3"
      role="alertdialog"
    >
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
          <button
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-app-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
            disabled={submitted}
            onClick={() => onAllow([])}
            type="button"
          >
            Allow
          </button>
        </div>
      </div>

      <pre className="mt-3 max-h-36 overflow-auto whitespace-pre-wrap rounded border border-text-subtle/50 p-3 font-mono text-xs text-text-muted">
        {JSON.stringify(request.request.input, null, 2)}
      </pre>

      {suggestions.length > 0 ? (
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

      <p className="mt-2 font-mono text-[11px] text-text-subtle">
        Enter allow · N / ⌫ deny · Esc snooze
      </p>
    </section>
  )
}
