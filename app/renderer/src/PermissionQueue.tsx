import { PermissionPrompt } from './PermissionPrompt.js'
import {
  isAskUserQuestionRequest,
  type PermissionQueueItem,
} from './permissionState.js'

/**
 * The pending-permission queue (P2-4, adapts the prototype's
 * `Permissions.jsx` PermissionQueue). Reality per S2 §1–§2: the queue is the
 * set of `permission.requested` minus `permission.resolved`, arrival-ordered,
 * with NO timeout. Every card stays until the engine resolves it; Esc only
 * snoozes a card locally (it remains pending engine-side and can be
 * re-opened). `permission.resolved` removes the card no matter WHO answered —
 * this window, another surface, or an abort mass-deny.
 */
export function PermissionQueue({
  items,
  keyboardTargetRequestId = null,
  onAllow,
  onDeny,
  onRestore,
}: {
  items: PermissionQueueItem[]
  /**
   * The request App's keydown handler acts on, or null when no card owns the
   * keyboard here (a background pane, or a dedicated flow holding the keys).
   * Stacked cards mean the focus must land on THAT card, not the last rendered.
   */
  keyboardTargetRequestId?: string | null
  onAllow: (requestId: string, applySuggestions: number[]) => void
  onDeny: (requestId: string, message?: string) => void
  onRestore: (requestId: string) => void
}) {
  if (items.length === 0) return null

  const active = items.filter(item => !item.dismissed)
  const snoozed = items.filter(item => item.dismissed)

  return (
    <div aria-label="Permission requests" className="flex flex-col gap-2">
      {items.length > 1 ? (
        <p className="text-xs text-text-muted">
          {items.length} permission requests pending
        </p>
      ) : null}

      {active.map(item => (
        <PermissionPrompt
          // An AskUserQuestion only reaches this generic queue when its questions
          // could not be read, so there is nothing to answer and an allow would
          // run the tool with empty answers. Deny is the only honest control, and
          // it is already the only one the keyboard offers for these requests.
          denyOnly={isAskUserQuestionRequest(item.request)}
          key={item.request.requestId}
          keyboardTarget={item.request.requestId === keyboardTargetRequestId}
          onAllow={applySuggestions =>
            onAllow(item.request.requestId, applySuggestions)
          }
          onDeny={message => onDeny(item.request.requestId, message)}
          request={item.request}
          submitted={item.submitted}
        />
      ))}

      {snoozed.map(item => (
        <div
          className="flex items-center justify-between gap-3 rounded border border-text-subtle/50 px-3 py-2 text-xs text-text-muted"
          key={item.request.requestId}
        >
          <span>
            Snoozed:{' '}
            <span className="font-mono">{item.request.request.tool_name}</span>{' '}
            (still pending)
          </span>
          <button
            className="rounded border border-text-subtle px-2 py-1 text-xs text-text-primary"
            onClick={() => onRestore(item.request.requestId)}
            type="button"
          >
            Answer
          </button>
        </div>
      ))}
    </div>
  )
}
