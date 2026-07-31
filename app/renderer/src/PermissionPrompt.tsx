import { useEffect, useRef, useState } from 'react'
import type { PermissionRequest } from './permissionState.js'
import {
  describeSuggestion,
  formatPermissionInput,
  permissionKeysAreLive,
  selectPermissionPreview,
  type PermissionPreview,
  type PermissionPreviewLine,
} from './permissionPromptModel.js'

/**
 * Exact prototype `PQDiff` line grammar (`Permissions.jsx:139-143`): the add /
 * remove washes are rgba(34,197,94,0.1) / rgba(239,68,68,0.1) over #86efac /
 * #fca5a5 bodies, context in #52525b. Literal hexes, not the green-500/red-500
 * utilities, because Tailwind v4's oklch palette drifted those. Static classes
 * only (the interpolated-arbitrary-value trap silently produces no CSS).
 *
 * The transcript's post-execution diff carries the same values
 * (`TranscriptView.tsx` `DIFF_ROW_CLASS`) because the prototype uses one
 * grammar in both places. They are not shared through a module: these rows have
 * no line-number gutter and are built from a snippet, not from hunks, so
 * nothing but the three class strings would be common.
 */
const PREVIEW_LINE_CLASS: Record<PermissionPreviewLine['kind'], string> = {
  add: 'bg-[#22c55e]/10 text-[#86efac]',
  del: 'bg-[#ef4444]/10 text-[#fca5a5]',
  ctx: 'text-text-faint',
}

const PREVIEW_LINE_SIGN: Record<PermissionPreviewLine['kind'], string> = {
  add: '+ ',
  del: '− ',
  ctx: '  ',
}

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
 *
 * The body shows the thing being approved, not the request that carries it: a
 * command, a path, a URL, a file's new content, an edit's before and after.
 * `selectPermissionPreview` decides which, per family, and returns null when it
 * cannot say honestly — the raw input is one click away either way, and starts
 * open on a card that has no preview. It used to be the ONLY body: every card,
 * for every tool, rendered `JSON.stringify(input)`.
 */
export function PermissionPrompt({
  request,
  submitted,
  denyOnly,
  keyboardTarget,
  onAllow,
  onDeny,
}: {
  request: PermissionRequest
  /** True while an answer for this card is in flight. */
  submitted?: boolean
  /** Hide every allow path: this request can only be answered by denying it. */
  denyOnly?: boolean
  /**
   * This is the card `selectVisiblePermission` picked AND no dedicated flow owns
   * the keyboard, so the four shortcuts act on THIS request. Only such a card
   * takes focus, hosts the keys, and advertises them.
   */
  keyboardTarget?: boolean
  onAllow: (applySuggestions: number[]) => void
  onDeny: (message?: string) => void
}) {
  const [denyMessage, setDenyMessage] = useState('')
  const preview = selectPermissionPreview(
    request.request.tool_name,
    request.request.input,
  )
  // Opened by default exactly when nothing could be promoted, so a card never
  // hides the only description of what it is about to allow.
  const [inputShown, setInputShown] = useState(preview === null)
  const titleId = `permission-title-${request.requestId}`
  const suggestions = Array.isArray(request.request.permission_suggestions)
    ? request.request.permission_suggestions
    : []
  const workerId = request.request.agent_id

  const sectionRef = useRef<HTMLElement>(null)
  // Optimistic: the effect below is about to focus this card. It corrects itself
  // from the real `activeElement`, and every later focus move re-derives it.
  const [keysLive, setKeysLive] = useState(keyboardTarget === true)

  // Nothing moved focus when a card appeared, so the composer textarea kept it
  // and every advertised key was swallowed by the focused-control guard. Take
  // the keyboard the way the app's other keyboard-owning card already does
  // (`PlanPanel.tsx:99-110`): focus after the commit that produced the card, and
  // hand focus back on the way out.
  useEffect(() => {
    if (!keyboardTarget) {
      setKeysLive(false)
      return
    }
    const node = sectionRef.current
    if (!node) return
    const previous = document.activeElement
    const timer = setTimeout(() => {
      node.focus()
      setKeysLive(document.activeElement === node)
    }, 0)
    return () => {
      clearTimeout(timer)
      // Only if this card still holds the keyboard: never yank focus away from
      // wherever the user moved it in the meantime.
      if (document.activeElement === node && previous instanceof HTMLElement) {
        previous.focus()
      }
    }
  }, [keyboardTarget])

  const hintVisible = keyboardTarget === true && keysLive && !denyOnly

  return (
    <section
      aria-labelledby={titleId}
      className="border-l-2 border-accent bg-text-primary/[0.04] px-4 py-3 focus:outline-none"
      // Literal because JSX needs a literal attribute name; the reader is
      // `PERMISSION_KEY_HOST_ATTR` in `permissionPromptModel.ts`.
      data-permission-key-host={keyboardTarget ? '' : undefined}
      onBlur={event => setKeysLive(permissionKeysAreLive(event.relatedTarget))}
      onFocus={event => setKeysLive(permissionKeysAreLive(event.target))}
      ref={sectionRef}
      role="alertdialog"
      tabIndex={keyboardTarget ? -1 : undefined}
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

      {preview ? <PermissionPreviewBlock preview={preview} /> : null}

      <div className="mt-2">
        <button
          aria-expanded={inputShown}
          className="rounded border border-text-subtle/50 px-2 py-1 font-mono text-[11px] text-text-muted hover:bg-white/[0.04] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          onClick={() => setInputShown(shown => !shown)}
          type="button"
        >
          {inputShown ? 'Hide input' : 'Show input'}
        </button>
        {inputShown ? (
          <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap rounded border border-text-subtle/50 p-3 font-mono text-xs text-text-muted">
            {formatPermissionInput(request.request.input)}
          </pre>
        ) : null}
      </div>

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

      {/* Shown exactly while the keys work. The generic shortcuts skip a
       * deny-only request entirely (`selectVisiblePermission`), they act on one
       * card at a time, and they stand down whenever focus sits in a control
       * that owns them itself — the deny field above, every button on this card,
       * the composer. Advertising them in any of those states is the dead
       * affordance this strip used to be. */}
      {hintVisible ? (
        <p className="mt-2 font-mono text-[11px] text-text-subtle">
          Enter allow · N / ⌫ deny · Esc snooze
        </p>
      ) : null}
    </section>
  )
}

/**
 * The thing being approved, in the prototype's two preview forms: the labelled
 * payload block (`Permissions.jsx:550-559`) for a promoted field, and the
 * file-header-over-body block (`:544-548`) for a write or an edit.
 *
 * Everything here is a text node. This is model-authored tool input arriving
 * from the wire, so a URL is never a link, a path is never a control, and no
 * branch ever sets inner HTML.
 */
function PermissionPreviewBlock({ preview }: { preview: PermissionPreview }) {
  if (preview.kind === 'field') {
    return (
      <div className="mt-3 rounded-[9px] border border-white/[0.07] bg-black/30 px-[11px] py-[9px]">
        <div className="mb-1 text-[9.5px] font-bold uppercase tracking-[0.08em] text-text-faint">
          {preview.label}
        </div>
        <code className="block max-h-36 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-accent">
          {preview.value}
        </code>
      </div>
    )
  }

  return (
    <div className="mt-3 overflow-hidden rounded-[9px] border border-white/[0.07]">
      <div className="truncate border-b border-white/[0.05] bg-black/30 px-[11px] py-[5px] font-mono text-[11px] text-text-muted">
        {preview.path}
      </div>
      {preview.kind === 'content' ? (
        <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words bg-black/30 px-[11px] py-[9px] font-mono text-[11.5px] leading-[1.55] text-text-muted">
          {preview.body}
        </pre>
      ) : (
        <div className="max-h-28 overflow-auto bg-black/30 font-mono text-[11.5px] leading-[1.55]">
          {preview.lines.map((line, index) => (
            <div
              className={`whitespace-pre px-[11px] ${PREVIEW_LINE_CLASS[line.kind]}`}
              key={index}
            >
              {PREVIEW_LINE_SIGN[line.kind]}
              {line.text}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
