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

export function PermissionPrompt({
  request,
  onAllow,
  onDeny,
}: {
  request: PermissionRequest
  onAllow: () => void
  onDeny: () => void
}) {
  const titleId = `permission-title-${request.requestId}`

  return (
    <section
      aria-labelledby={titleId}
      className="border-l-2 border-accent bg-text-primary/[0.04] px-4 py-3"
      role="alertdialog"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2
            className="text-sm font-medium text-text-primary"
            id={titleId}
          >
            Permission required
          </h2>
          <p className="mt-1 text-xs text-text-muted">
            Allow <span className="font-mono text-accent">{request.request.tool_name}</span>?
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            className="rounded border border-text-subtle px-3 py-1.5 text-xs text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            onClick={onDeny}
            type="button"
          >
            Deny
          </button>
          <button
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-app-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            onClick={onAllow}
            type="button"
          >
            Allow
          </button>
        </div>
      </div>

      <pre className="mt-3 max-h-36 overflow-auto whitespace-pre-wrap rounded border border-text-subtle/50 p-3 font-mono text-xs text-text-muted">
        {JSON.stringify(request.request.input, null, 2)}
      </pre>

      <p className="mt-2 font-mono text-[11px] text-text-subtle">
        Enter allow · N / ⌫ deny · Esc dismiss
      </p>
    </section>
  )
}
