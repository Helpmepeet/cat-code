import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PermissionRequest } from './permissionState.js'
import {
  buildPermissionOptions,
  formatPermissionInput,
  permissionKeysAreLive,
  permissionKickerForTool,
  permissionTitleIsInlineCommand,
  selectPermissionPreview,
  summariseCommandForTitle,
  type PermissionOption,
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
 * Whether `element` is a control the user could be actively typing into: a
 * text input, a textarea, or a contenteditable node. Since 4394086 the
 * mid-turn composer is one of these, so a card mounting mid-word must not
 * steal its focus — the user's next Enter would land on the card (an unread
 * allow) instead of sending. Deliberately narrower than
 * `permissionKeysAreLive`'s selector, which also treats buttons and the card
 * itself as "owning" the keys; here we only care about text entry.
 */
function isEditableElement(element: Element | null): boolean {
  if (element === null) return false
  if (element instanceof HTMLTextAreaElement) return true
  if (element instanceof HTMLInputElement) return true
  return (element as HTMLElement).isContentEditable === true
}

/**
 * One permission card, in the prototype's form: an uppercase kicker over a
 * headline, the thing being approved, and a keyboard-driven SELECT LIST where
 * "don't ask again" is a ROW rather than a separate button
 * (`Permissions.jsx:10-13`).
 *
 * Rows map 1:1 to the S2 §5 payload contract:
 *   Yes                      → allow once (empty selection)
 *   Yes, and don't ask …     → allow + `applySuggestions` (C1 index selection
 *                              into THIS request's engine-minted suggestions;
 *                              a row exists only where the engine minted one)
 *   No, and tell Cat Code …  → deny (the model-visible refusal)
 *
 * `denyOnly` drops both allow rows. An AskUserQuestion whose questions cannot
 * be read falls back to this card, and a bare allow there would run the tool
 * with NO answers — the thing `permissionState.ts`'s `selectVisiblePermission`
 * comment forbids and the keyboard path already refuses
 * (decisions/ASK-USER-QUESTION-ANSWER.md). Mouse and keyboard must agree, which
 * is why both read the SAME `buildPermissionOptions` list.
 *
 * The cursor is owned by App, not by this card: App's keydown handler is the
 * one that moves it, and a card holding its own copy would let a mouse hover
 * and an Enter disagree about which row is highlighted. Only the card the keys
 * act on gets one at all.
 */
export function PermissionPrompt({
  request,
  submitted,
  denyOnly,
  keyboardTarget,
  cursor,
  pendingCount = 1,
  onCursorChange,
  onAllow,
  onDeny,
  onSnooze,
}: {
  request: PermissionRequest
  /** True while an answer for this card is in flight. */
  submitted?: boolean
  /** Hide every allow path: this request can only be answered by denying it. */
  denyOnly?: boolean
  /**
   * This is the card `selectVisiblePermission` picked AND no dedicated flow owns
   * the keyboard, so the shortcuts act on THIS request. Only such a card takes
   * focus, hosts the keys, advertises them, and shows a cursor.
   */
  keyboardTarget?: boolean
  /** The highlighted row, for the keyboard card only. */
  cursor?: number
  /** How many requests are pending in this session, for the header count. */
  pendingCount?: number
  onCursorChange?: (index: number) => void
  onAllow: (applySuggestions: number[]) => void
  onDeny: (message?: string) => void
  /** Hide this card but keep the request live engine-side (footer, and Esc's
   * old job). Absent on a card whose queue does not offer it. */
  onSnooze?: () => void
}) {
  const toolName = request.request.tool_name
  const preview = selectPermissionPreview(toolName, request.request.input)
  const options = buildPermissionOptions(request.request, denyOnly === true)

  // The command IS the headline for the command families, exactly as the
  // prototype writes it (`Permissions.jsx:465-471`). Real `Bash` input is not
  // the prototype's short mock, so a headline that cannot hold it says so and
  // the body block below carries the whole thing.
  const inlineCommand =
    permissionTitleIsInlineCommand(toolName) && preview?.kind === 'field'
      ? summariseCommandForTitle(preview.value)
      : null

  // Opened by default exactly when nothing could be promoted, so a card never
  // hides the only description of what it is about to allow.
  const [inputShown, setInputShown] = useState(preview === null)
  const titleId = `permission-title-${request.requestId}`
  const workerId = request.request.agent_id

  const sectionRef = useRef<HTMLElement>(null)
  // Optimistic: the effect below is about to focus this card. It corrects itself
  // from the real `activeElement`, and every later focus move re-derives it.
  const [keysLive, setKeysLive] = useState(keyboardTarget === true)

  // Nothing moved focus when a card appeared, so the composer field kept it
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
    if (isEditableElement(previous)) {
      // The user is typing somewhere else (e.g. the mid-turn composer,
      // editable since 4394086). Leave focus alone and report the keys dead
      // through the same predicate the document listener uses, so the hint
      // never advertises keys that will not fire.
      setKeysLive(permissionKeysAreLive(previous))
      return
    }
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

  // A deny-only request is skipped by the shortcuts upstream
  // (`selectVisiblePermission`), so such a card never advertises them even if it
  // were somehow handed the keyboard.
  const hintVisible = keyboardTarget === true && keysLive && !denyOnly
  const activeIndex = keyboardTarget === true ? cursor : undefined

  function pick(option: PermissionOption) {
    if (submitted) return
    if (option.effect === 'deny') {
      onDeny()
      return
    }
    onAllow(option.suggestionIndex === undefined ? [] : [option.suggestionIndex])
  }

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
      {/* Kicker row — glyph + uppercase family word, worker badge, pending count */}
      <div className="flex items-center gap-2">
        <span className="flex text-accent">
          <KickerIcon toolName={toolName} />
        </span>
        <span className="text-[9.5px] font-bold uppercase tracking-[0.1em] text-accent">
          {permissionKickerForTool(toolName)}
        </span>
        {workerId ? (
          <span className="rounded bg-violet-400/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.05em] text-violet-300">
            worker
          </span>
        ) : null}
        {pendingCount > 1 ? (
          <span className="ml-auto font-mono text-[10px] tabular-nums text-text-faint">
            <b className="text-text-muted">{pendingCount}</b> pending
          </span>
        ) : null}
      </div>

      {/* Headline — the command itself where the family allows it */}
      {inlineCommand ? (
        <h2
          className="mt-2 flex flex-wrap items-baseline gap-1.5 text-sm font-semibold text-text-primary"
          id={titleId}
        >
          <span className="shrink-0">Allow</span>
          <span className="min-w-0">
            <code className="break-all rounded bg-accent/10 px-1.5 py-0.5 font-mono text-xs text-accent">
              {inlineCommand.text}
            </code>
            ?
          </span>
        </h2>
      ) : (
        <h2
          className="mt-2 text-sm font-semibold leading-snug text-text-primary"
          id={titleId}
        >
          {request.request.title ??
            `Allow ${request.request.display_name ?? toolName}?`}
        </h2>
      )}

      {workerId ? (
        <p className="mt-1 text-[11px] text-text-subtle">
          Relayed from worker{' '}
          <span className="font-mono text-violet-300">{workerId}</span>. You
          decide.
        </p>
      ) : null}
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
          This question could not be read, so it can only be denied. Say what you
          wanted in the composer.
        </p>
      ) : null}

      {/* The thing being approved. Skipped when the headline already IS the
       * command, and kept when the headline had to shorten it. */}
      {preview && (!inlineCommand || inlineCommand.truncated) ? (
        <PermissionPreviewBlock preview={preview} />
      ) : null}

      {inputShown ? (
        <pre className="mt-3 max-h-36 overflow-auto whitespace-pre-wrap rounded-[9px] border border-white/[0.07] bg-black/30 p-3 font-mono text-xs text-text-muted">
          {formatPermissionInput(request.request.input)}
        </pre>
      ) : null}

      {/* The select list — "don't ask again" is a row here, not a side button */}
      <div aria-label="Response options" className="mt-3 flex flex-col gap-0.5">
        {options.map((option, index) => (
          <OptionRow
            active={index === activeIndex}
            disabled={submitted === true}
            key={option.id}
            number={index + 1}
            onHover={() => onCursorChange?.(index)}
            onPick={() => pick(option)}
            option={option}
          />
        ))}
      </div>

      {/* Footer rail — key hints, and the lanes that are not answers.
       * The hint renders only while the keys actually work: the shortcuts act on
       * one card at a time and stand down whenever focus sits in a control that
       * owns them itself (an option row, the footer's own buttons, the
       * composer). Advertising them in those states is the dead affordance this
       * strip used to be. */}
      <div className="mt-2.5 flex items-center gap-3 border-t border-shell-seam pt-2 font-mono text-[10px] text-text-faint">
        <span>{hintVisible ? '↑↓ · 1–9 · ↵ · esc' : null}</span>
        <button
          aria-expanded={inputShown}
          className="ml-auto bg-transparent font-mono text-[10px] text-text-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          onClick={() => setInputShown(shown => !shown)}
          type="button"
        >
          {inputShown ? 'Hide input' : 'Show input'}
        </button>
        {onSnooze ? (
          <button
            className="bg-transparent font-mono text-[10px] text-text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            onClick={onSnooze}
            type="button"
          >
            Keep pending →
          </button>
        ) : null}
      </div>
    </section>
  )
}

/**
 * One selectable row (`Permissions.jsx:150-167`): a numbered marker that IS the
 * shortcut, the option text with its engine-authored scope chip, and the key
 * chip on the right — `esc` on the refuse row, `↵` on whichever row the cursor
 * is holding.
 */
function OptionRow({
  active,
  disabled,
  number,
  onHover,
  onPick,
  option,
}: {
  active: boolean
  disabled: boolean
  number: number
  onHover: () => void
  onPick: () => void
  option: PermissionOption
}) {
  const refuse = option.effect === 'deny'
  return (
    <button
      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
        active
          ? 'border border-accent/45 bg-accent/10'
          : 'border border-transparent'
      }`}
      disabled={disabled}
      onClick={onPick}
      onMouseEnter={onHover}
      type="button"
    >
      <span
        className={`flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded font-mono text-[9px] font-semibold ${
          active
            ? 'bg-accent text-app-bg'
            : 'bg-text-primary/[0.06] text-text-subtle'
        }`}
      >
        {number}
      </span>
      <span
        className={`min-w-0 flex-1 text-xs leading-snug ${
          refuse ? 'text-text-muted' : 'text-text-primary'
        }`}
      >
        {option.pre}
        {option.code ? (
          <code className="rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[11px] text-accent">
            {option.code}
          </code>
        ) : null}
        {option.post}
      </span>
      {option.esc ? (
        <span className="shrink-0 rounded border border-text-ghost px-1 font-mono text-[9.5px] leading-[14px] text-text-faint">
          esc
        </span>
      ) : active ? (
        <span className="shrink-0 rounded border border-accent/50 bg-accent/[0.08] px-1 font-mono text-[9.5px] leading-[14px] text-accent">
          ↵
        </span>
      ) : null}
    </button>
  )
}

/**
 * The kicker glyph for a tool family, on the house icon idiom
 * (`SessionActionIcons.tsx`): a 15px stroke glyph inheriting `currentColor`, so
 * the accent on the kicker row carries it. The prototype's per-variant icon set
 * (`Permissions.jsx:32-46`) reduced to the families the preview switch knows;
 * everything else takes the shield its fallback uses.
 */
function KickerIcon({ toolName }: { toolName: string }): ReactNode {
  switch (permissionKickerForTool(toolName)) {
    case 'Filesystem':
      return (
        <Glyph>
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </Glyph>
      )
    case 'Web access':
      return (
        <Glyph>
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </Glyph>
      )
    case 'Skill':
      return (
        <Glyph>
          <path d="M12 3l1.9 6.1L20 11l-6.1 1.9L12 19l-1.9-6.1L4 11l6.1-1.9z" />
        </Glyph>
      )
    default:
      return (
        <Glyph>
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </Glyph>
      )
  }
}

function Glyph({ children }: { children: ReactNode }): ReactNode {
  return (
    <svg
      aria-hidden
      fill="none"
      height="13"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.9"
      viewBox="0 0 24 24"
      width="13"
    >
      {children}
    </svg>
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
