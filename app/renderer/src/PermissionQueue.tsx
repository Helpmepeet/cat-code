import { PermissionPrompt } from './PermissionPrompt.js'
import type { LiveWorkerItem } from '../../shared/protocol.js'
import {
  isAskUserQuestionRequest,
  type PermissionQueueItem,
} from './permissionState.js'

/**
 * The pending-permission queue (P2-4, adapts the prototype's
 * `Permissions.jsx` PermissionQueue). Reality per S2 §1–§2: the queue is the
 * set of `permission.requested` minus `permission.resolved`, arrival-ordered,
 * with NO timeout. Every card stays until the engine resolves it. Esc is the
 * prototype's REFUSE (`Permissions.jsx:13`); the hide-for-later lane is the
 * card's "Keep pending", which snoozes locally and leaves the request live
 * engine-side. `permission.resolved` removes the card no matter WHO answered —
 * this window, another surface, or an abort mass-deny.
 */
export function PermissionQueue({
  items,
  workers = [],
  keyboardTargetRequestId = null,
  onAllow,
  onDeny,
  onRestore,
  onSnooze,
}: {
  items: PermissionQueueItem[]
  /** This session's engine-sourced workers, for relayed-card identity only. */
  workers?: readonly LiveWorkerItem[]
  /**
   * The request the shortcuts act on, or null when no card owns the keyboard
   * here (a background pane, or a dedicated flow holding the keys). That card
   * takes focus, shows a cursor, and registers the keydown listener; stacked
   * cards mean it must be THAT card, not the last rendered.
   */
  keyboardTargetRequestId?: string | null
  onAllow: (requestId: string, applySuggestions: number[]) => void
  onDeny: (requestId: string, message?: string) => void
  onRestore: (requestId: string) => void
  onSnooze?: (requestId: string) => void
}) {
  if (items.length === 0) return null

  const active = items.filter(item => !item.dismissed)
  const snoozed = items.filter(item => item.dismissed)

  // What "pending" means on this header: requests in this queue that still need
  // an answer, INCLUDING the snoozed ones, which are listed right below and are
  // still live engine-side. `items.length` counted the already-submitted ones
  // too, so a card could read "2 pending" with one of them answered and merely
  // awaiting its `permission.resolved`. Deliberately not
  // `selectPendingPermissionCount`, which measures the whole session (including
  // the plan and question surfaces that own their own cards) and drives the
  // tab badge.
  const awaitingAnswer = items.filter(item => !item.submitted).length

  return (
    <div aria-label="Permission requests" className="flex flex-col gap-2">
      {active.map((item, index) => {
        const isKeyboardTarget =
          item.request.requestId === keyboardTargetRequestId
        return (
          <PermissionPrompt
            // An AskUserQuestion only reaches this generic queue when its
            // questions could not be read, so there is nothing to answer and an
            // allow would run the tool with empty answers. Deny is the only
            // honest control, and it is already the only one the keyboard offers
            // for these requests.
            denyOnly={isAskUserQuestionRequest(item.request)}
            key={item.request.requestId}
            keyboardTarget={isKeyboardTarget}
            onAllow={applySuggestions =>
              onAllow(item.request.requestId, applySuggestions)
            }
            onDeny={message => onDeny(item.request.requestId, message)}
            onSnooze={
              onSnooze ? () => onSnooze(item.request.requestId) : undefined
            }
            // The prototype puts the count on the ONE head card
            // (`Permissions.jsx:452-456`). Stacking is this app's deviation, and
            // repeating "2 pending" beside each of two visible cards is an
            // artefact of it rather than anything the prototype asks for.
            // `undefined` says "no count here", rather than leaning on `1`
            // happening to fall under the card's own render threshold.
            pendingCount={index === 0 ? awaitingAnswer : undefined}
            request={item.request}
            submitted={item.submitted}
            workers={workers}
          />
        )
      })}

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
