import { useEffect, useRef, useState } from 'react'
import {
  handleMenuRovingKeyDown,
  useModalFocus,
  usePopoverFocus,
} from './overlayFocus.js'
import { toneClasses } from './tone.js'
import {
  PLAN_APPROVE_OPTIONS,
  parsePlanSteps,
  type PlanApprovalMode,
  type PlanApprovalOption,
  type PlanReview,
} from './planState.js'

/**
 * PlanBar/PlanPanel — P4-11 (adapts the prototype's `PlanPanel.jsx`, read-only
 * design reference, zero ported code). Real "plan" = a pending `ExitPlanMode`
 * permission request (`planState.ts` `selectPlanReview`); both surfaces
 * render ONLY while that review is pending and disappear the instant it
 * resolves — there is no persistent post-approval drawer or live execution
 * checklist here (PARITY-LEDGER.md §24 flags those GUI-invented; no engine
 * per-step state exists to back them).
 */

const PlanIcon = (
  <svg
    aria-hidden="true"
    fill="none"
    height="14"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="2"
    viewBox="0 0 24 24"
    width="14"
  >
    <path d="M9 11l3 3L22 4" />
    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
  </svg>
)

/** The reopen affordance above the composer — SOURCE-BACKED shell (visible
 * only while a plan review is pending; reuses P2-4's permission-mode read). */
export function PlanBar({
  review,
  onOpen,
}: {
  review: PlanReview | null
  onOpen: () => void
}) {
  if (!review) return null
  const t = toneClasses('info')
  const steps = parsePlanSteps(review.data.plan)

  return (
    <div
      aria-label="Plan mode"
      className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${t.softBorder} ${t.softBg}`}
    >
      <span className={`flex shrink-0 ${t.text}`}>{PlanIcon}</span>
      <div className="min-w-0 flex-1">
        <div className={`text-[12px] font-semibold ${t.text}`}>Plan mode</div>
        <div className="mt-0.5 truncate text-[11px] text-text-subtle">
          {steps.length > 0
            ? `${steps.length}-step plan ready for review`
            : 'Plan ready for review'}
        </div>
      </div>
      <button
        className={`shrink-0 rounded-md border px-2.5 py-1 text-[11px] font-semibold transition-colors ${t.text} ${t.softBorder} ${t.hoverTint}`}
        onClick={onOpen}
        type="button"
      >
        View plan
      </button>
    </div>
  )
}

export function PlanPanel({
  review,
  open,
  onClose,
  onApprove,
  onRevise,
}: {
  review: PlanReview | null
  open: boolean
  onClose: () => void
  /** Composes the boundary's real plan-exit idiom: `setPermissionMode(mode)`
   * then a C1 allow on the request (decisions/PERMISSION-BOUNDARY.md §3). */
  onApprove: (mode: PlanApprovalMode) => void
  /** Denies the request with feedback — the real "keep planning" outcome
   * (mode stays `plan`; the TUI's own "No" + feedback path). */
  onRevise: (message: string) => void
}) {
  const [showApprove, setShowApprove] = useState(false)
  const [revising, setRevising] = useState(false)
  const [revisionText, setRevisionText] = useState('')
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setShowApprove(false)
    setRevising(false)
    setRevisionText('')
  }, [open])

  useModalFocus({
    open,
    containerRef: cardRef,
    onEscape: onClose,
    escapeEnabled: !showApprove && !revising,
    initialFocus: 'container',
  })

  if (!open || !review) return null

  const t = toneClasses('info')
  const steps = parsePlanSteps(review.data.plan)

  function pickApprove(option: PlanApprovalOption) {
    setShowApprove(false)
    onApprove(option.mode)
  }

  function sendRevision() {
    const trimmed = revisionText.trim()
    if (!trimmed) return
    onRevise(trimmed)
    setRevising(false)
    setRevisionText('')
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        aria-label="Plan"
        className={`flex max-h-[82vh] w-[520px] max-w-[92vw] flex-col overflow-hidden rounded-xl border bg-surface-panel shadow-2xl ${t.softBorder}`}
        onClick={event => event.stopPropagation()}
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
      >
        <div className="shrink-0 border-b border-shell-seam px-4 py-3">
          <div className="flex items-center gap-2">
            <span className={t.text}>{PlanIcon}</span>
            <span className="text-sm font-semibold text-text-primary">Plan</span>
            <span
              className={`rounded-[5px] border px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-[0.06em] ${t.softBg} ${t.softBorder} ${t.text}`}
            >
              planning
            </span>
            <button
              aria-label="Close plan panel"
              className="ml-auto text-text-subtle transition-colors hover:text-text-primary"
              onClick={onClose}
              title="Close (Esc)"
              type="button"
            >
              ×
            </button>
          </div>
          {review.data.planFilePath ? (
            <code className="mt-2 block truncate font-mono text-[11px] text-tone-good">
              {review.data.planFilePath}
            </code>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <div className="mb-1.5 text-[9.5px] font-bold uppercase tracking-wide text-text-subtle">
            {steps.length > 0
              ? `${steps.length} step${steps.length === 1 ? '' : 's'}`
              : 'Plan'}
          </div>
          {steps.length > 0 ? (
            <ol className="flex flex-col gap-1">
              {steps.map((step, index) => (
                <li
                  className="flex gap-2 rounded-md px-2 py-1 text-[12.5px] text-text-muted"
                  // Real markdown lines are order-stable within one render of
                  // one immutable review; index keys are safe here.
                  key={index}
                >
                  <span className="shrink-0 font-mono text-text-subtle">
                    {index + 1}.
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          ) : (
            <pre className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-text-muted">
              {review.data.plan ?? '(empty plan)'}
            </pre>
          )}

          {review.data.allowedPrompts.length > 0 ? (
            <div className="mt-4 border-t border-shell-seam pt-3">
              <div className="mb-1 text-[9px] font-bold uppercase tracking-wide text-text-subtle">
                Tools this plan expects to use
              </div>
              {/* Honesty: `allowedPrompts` are the tools the plan LISTS, not an
               * auto-grant. The engine's `addRules` path is Ant-gated and the
               * security baseline forbids renderer-authored rules, so approving
               * here does NOT pre-authorize them — each still prompts per use
               * (deviation flagged: PARITY-LEDGER.md §24). */}
              <div className="mb-1.5 text-[10px] text-text-subtle/70">
                Listed for context. Each is still confirmed when it runs.
              </div>
              <div className="flex flex-wrap gap-1.5">
                {review.data.allowedPrompts.map((prompt, index) => (
                  <span
                    className="inline-flex items-center gap-1.5 rounded-md border border-shell-seam bg-shell-hover px-2 py-1 text-[11px] text-text-muted"
                    key={index}
                  >
                    <span className="font-mono text-[9.5px] text-tone-warn">
                      {prompt.tool}
                    </span>
                    {prompt.prompt}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <div className="shrink-0 border-t border-shell-seam bg-shell-chrome px-3.5 py-2.5">
          {revising ? (
            <div>
              <textarea
                autoFocus
                className="w-full resize-none rounded-md border border-shell-seam bg-app-bg px-2.5 py-2 text-[12px] text-text-primary outline-none"
                onChange={event => setRevisionText(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    sendRevision()
                  }
                  if (event.key === 'Escape') {
                    setRevising(false)
                    setRevisionText('')
                  }
                }}
                placeholder="Tell the agent what to change in the plan…"
                rows={2}
                value={revisionText}
              />
              <div className="mt-2 flex items-center gap-2">
                <button
                  className="rounded-md bg-accent px-3 py-1.5 text-[11.5px] font-semibold text-app-bg disabled:opacity-40"
                  disabled={revisionText.trim().length === 0}
                  onClick={sendRevision}
                  type="button"
                >
                  Send revision
                </button>
                <button
                  className="text-[11px] text-text-subtle"
                  onClick={() => {
                    setRevising(false)
                    setRevisionText('')
                  }}
                  type="button"
                >
                  Cancel
                </button>
                <span className="ml-auto font-mono text-[10px] text-text-subtle">
                  ⌘↵ send · esc cancel
                </span>
              </div>
            </div>
          ) : (
            <div className="relative flex items-center gap-2">
              {showApprove ? (
                <ApproveMenu onClose={() => setShowApprove(false)} onPick={pickApprove} />
              ) : null}
              <button
                className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-1.5 text-[12px] font-semibold text-app-bg"
                onClick={() => setShowApprove(current => !current)}
                onMouseDown={event => event.stopPropagation()}
                type="button"
              >
                Approve plan
                <span className="text-[9px] transition-transform">
                  {showApprove ? '▴' : '▾'}
                </span>
              </button>
              <button
                className="rounded-md border border-shell-seam px-3 py-1.5 text-[12px] text-text-muted"
                onClick={() => setRevising(true)}
                type="button"
              >
                Revise…
              </button>
              <span className="ml-auto font-mono text-[10px] text-text-subtle">
                read-only until you approve
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ApproveMenu({
  onPick,
  onClose,
}: {
  onPick: (option: PlanApprovalOption) => void
  onClose: () => void
}) {
  const [cursor, setCursor] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const { restoreTriggerFocus } = usePopoverFocus({
    open: true,
    containerRef: ref,
    onEscape: onClose,
  })

  useEffect(() => {
    function onDocMouseDown(event: MouseEvent) {
      if (ref.current && event.target instanceof Node && !ref.current.contains(event.target)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
    }
  }, [onClose])

  return (
    <div
      aria-label="Plan approval mode"
      className="absolute bottom-full left-0 z-10 mb-1.5 w-[270px] rounded-lg border border-shell-seam bg-surface-raised p-1 shadow-2xl"
      ref={ref}
      role="menu"
      onKeyDown={event => {
        if (/^[1-2]$/.test(event.key)) {
          event.preventDefault()
          restoreTriggerFocus()
          onPick(PLAN_APPROVE_OPTIONS[Number(event.key) - 1])
          return
        }
        handleMenuRovingKeyDown(event)
      }}
    >
      {PLAN_APPROVE_OPTIONS.map((option, index) => (
        <button
          className={`flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left ${
            cursor === index
              ? 'border-accent/45 bg-accent/10'
              : 'border-transparent hover:bg-white/[0.04]'
          }`}
          key={option.mode}
          onClick={() => {
            restoreTriggerFocus()
            onPick(option)
          }}
          onFocus={() => setCursor(index)}
          onMouseEnter={() => setCursor(index)}
          role="menuitem"
          type="button"
        >
          <span
            className={`mt-0.5 flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded font-mono text-[9px] font-bold ${
              cursor === index ? 'bg-accent text-app-bg' : 'bg-white/[0.06] text-text-subtle'
            }`}
          >
            {index + 1}
          </span>
          <span className="min-w-0">
            <span className="block text-[12px] font-medium text-text-primary">
              {option.label}
            </span>
            <span className="block text-[10.5px] text-text-subtle">{option.description}</span>
          </span>
        </button>
      ))}
    </div>
  )
}
