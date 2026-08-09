import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PermissionRequest } from './permissionState.js'
import {
  buildPermissionOptions,
  formatPermissionInput,
  permissionKeyIntent,
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
 * is why they read one list: `buildPermissionOptions` is called exactly once in
 * this app, here, and both the rows below and the keydown listener consume that
 * single array.
 *
 * The cursor and the keyboard both live here for the same reason. They were
 * App-level, which took two copies of the option list to keep in step and made
 * a hover over a row re-render the whole shell. `keyboardTarget` is the entire
 * contract with App: exactly one card is ever given it, so exactly one listener
 * exists and only that card shows a cursor.
 */
export function PermissionPrompt({
  request,
  submitted,
  denyOnly,
  keyboardTarget,
  pendingCount,
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
   * focus, hosts the keys, advertises them, shows a cursor, and registers the
   * listener below.
   */
  keyboardTarget?: boolean
  /** Requests still awaiting an answer in this queue, for the header count.
   * Absent on every card but the head one, which is the only one that carries
   * it (`Permissions.jsx:452-456`). */
  pendingCount?: number
  onAllow: (applySuggestions: number[]) => void
  onDeny: (message?: string) => void
  /** Hide this card but keep the request live engine-side (footer, and Esc's
   * old job). Absent on a card whose queue does not offer it. */
  onSnooze?: () => void
}) {
  const toolName = request.request.tool_name
  // Both fields are optional on the wire AND may arrive empty
  // (`sdk-types.snapshot.d.ts` `title?: string`, `agent_id?: string`). An
  // outbound engine frame has no inbound allowlist, so display degrades:
  // `''` means absent. Untreated, `title: ''` beat the derived headline with
  // `??` (nullish, not falsy) and rendered a blank <h2>, and `agent_id: ''`
  // made the kicker say relayed while the badge, the verb and the relay line
  // all said otherwise.
  const engineTitle = request.request.title || undefined
  const workerId = request.request.agent_id || undefined
  const relayed = workerId !== undefined
  // Memoised because this card re-renders on every App render (once per
  // streamed frame during a turn) as well as on hover and every disclosure
  // toggle, and an `Edit` preview runs `diffLines` over the whole change.
  // Both inputs are stable for the life of a request.
  const preview = useMemo(
    () => selectPermissionPreview(toolName, request.request.input),
    [toolName, request.request.input],
  )
  const options = useMemo(
    () => buildPermissionOptions(request.request, denyOnly === true),
    [request.request, denyOnly],
  )

  // The command IS the headline for the command families, exactly as the
  // prototype writes it (`Permissions.jsx:465-471`). Real `Bash` input is not
  // the prototype's short mock, so a headline that cannot hold it says so and
  // the body block below carries the whole thing.
  //
  // An engine-supplied title outranks it. The desktop producer never sets one
  // (`src/app-runtime/appRuntimeCanUseTool.ts:64-73`), but this branch used to
  // ignore `title` outright, which made "a supplied title wins" true for every
  // family EXCEPT the two this card is mostly about.
  const summary =
    engineTitle === undefined &&
    permissionTitleIsInlineCommand(toolName) &&
    preview?.kind === 'field'
      ? summariseCommandForTitle(preview.value)
      : null
  // A summariser that found no non-blank line has no headline to offer, so the
  // card falls back to naming the tool rather than printing an empty chip.
  const inlineCommand = summary && summary.text.length > 0 ? summary : null

  // Opened by default exactly when nothing could be promoted, so a card never
  // hides the only description of what it is about to allow.
  const [inputShown, setInputShown] = useState(preview === null)
  const titleId = `permission-title-${request.requestId}`

  // The highlighted row. Card-local, and it can be: the keys that move it are
  // this card's own listener below, so there is exactly one copy and a hover
  // cannot disagree with an Enter. It lived in App while the listener did, which
  // made every hover re-render the entire shell (tabs, sidebar, transcript,
  // composer) to move a border one row.
  const [cursor, setCursor] = useState(0)

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
  function pickAt(index: number) {
    const option = options[index]
    if (!option || submitted) return
    if (option.effect === 'deny') {
      onDeny()
      return
    }
    onAllow(option.suggestionIndex === undefined ? [] : [option.suggestionIndex])
  }

  /**
   * The select list's keyboard, owned by the ONE card the shortcuts act on.
   *
   * It lives here rather than in App for the same reason the cursor does: the
   * two must not be able to disagree. Every guard App applied survives the move,
   * and two of them get stronger by becoming structural:
   *  - a dedicated flow (AskQuestionFlow / PlanPanel) holding the keyboard makes
   *    `keyboardTargetRequestId` null, so this listener is never registered
   *    alongside theirs and one Enter cannot resolve two requests;
   *  - a background pane's card is never the target either, so a split
   *    workspace still answers only the active session;
   *  - the card is mounted only under the chat view, so navigating away now
   *    UNMOUNTS the listener instead of leaving it attached over an invisible
   *    request, which App had to exclude with an explicit `activeView` test.
   *
   * Still `document`, not `window`, keeping the propagation order the siblings'
   * listeners were reasoned against (target → document → window).
   */
  useEffect(() => {
    if (!keyboardTarget) return
    function onKeyDown(event: KeyboardEvent) {
      // Never hijack a key the focused element already acts on: every button on
      // this card, and the composer. The one exemption is the card itself, which
      // HOSTS the keys rather than owning them (`permissionKeysAreLive`).
      if (!permissionKeysAreLive(event.target)) return
      // The cursor and shortcut hint are both painted from this state. A click on
      // non-focusable page chrome can leave document focus permissive while the
      // card still shows neither; never let that hidden cursor confirm a row.
      if (!keysLive) return
      // In flight: the answer is already sent and the rows are disabled, so the
      // keyboard must not fire a second one before the resolve lands.
      if (submitted) return
      const intent = permissionKeyIntent(event)
      if (!intent) return
      const count = options.length
      if (count === 0) return
      // Auto-repeat may walk the list, but must never answer: holding Enter or
      // Escape would fire a decision per repeat tick.
      if (event.repeat && intent.kind !== 'move') return
      // A digit past the end of the list is not this card's key, so it must not
      // be swallowed from whatever else might want it.
      if (intent.kind === 'pick' && intent.index >= count) return

      event.preventDefault()
      switch (intent.kind) {
        case 'move':
          setCursor(c => (c + intent.delta + count) % count)
          return
        case 'pick':
          setCursor(intent.index)
          pickAt(intent.index)
          return
        case 'confirm':
          // Clamped: a list that shrank under a held cursor must still resolve a
          // row that exists.
          pickAt(Math.min(cursor, count - 1))
          return
        case 'deny':
          // Escape and n/⌫ refuse without touching the cursor: the deny row is
          // the one row two keys reach directly.
          onDeny()
          return
        default: {
          const exhaustive: never = intent
          void exhaustive
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  })

  const hintVisible = keyboardTarget === true && keysLive && !denyOnly
  // Gated on `keysLive` for the SAME reason the hint is: while focus sits in the
  // composer the shortcuts do not fire, and a highlighted row wearing an `↵`
  // chip states that Enter confirms it. That is the dead affordance P4-43
  // removed from the hint strip, one element over.
  const activeIndex =
    keyboardTarget === true && keysLive
      ? Math.min(cursor, options.length - 1)
      : undefined

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
          <KickerIcon relayed={relayed} toolName={toolName} />
        </span>
        <span className="text-[9.5px] font-bold uppercase tracking-[0.1em] text-accent">
          {permissionKickerForTool(toolName, relayed)}
        </span>
        {relayed ? (
          <span className="rounded bg-violet-400/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.05em] text-violet-300">
            worker
          </span>
        ) : null}
        {pendingCount !== undefined && pendingCount > 1 ? (
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
          {/* The prototype's own verb for a relayed request
           * (`Permissions.jsx:467`): what is being approved is another agent's
           * command, and this card is where you decide it. */}
          <span className="shrink-0">{relayed ? 'Run' : 'Allow'}</span>
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
          {engineTitle ??
            `${relayed ? 'Run' : 'Allow'} ${request.request.display_name ?? toolName}?`}
        </h2>
      )}

      {relayed ? (
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
      {/* `role` is load-bearing, not decoration: an `aria-label` on a bare div
       * is not exposed at all, so the group had no accessible name. */}
      <div
        aria-label="Response options"
        className="mt-3 flex flex-col gap-0.5"
        role="group"
      >
        {options.map((option, index) => (
          <OptionRow
            active={index === activeIndex}
            disabled={submitted === true}
            key={option.id}
            number={index + 1}
            // Gated on the same condition as the highlight. Ungated, a pointer
            // crossing the rows on its way to the footer moved a cursor NOTHING
            // was painting, and the row it landed on became the one Enter
            // confirmed the moment the keys woke up — an always-allow the user
            // never saw selected. The invariant: the highlighted row is always
            // the last row the user was shown as highlighted.
            onHover={() => {
              if (keyboardTarget === true && keysLive) setCursor(index)
            }}
            onPick={() => pickAt(index)}
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
      // The cursor is otherwise conveyed only by colour, so a screen reader got
      // no signal about which row Enter would confirm.
      aria-current={active ? true : undefined}
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
function KickerIcon({
  relayed,
  toolName,
}: {
  relayed: boolean
  toolName: string
}): ReactNode {
  // Fed the SAME predicate as the kicker word. Told only the tool name, it kept
  // drawing the family glyph under a "Worker request" caption, so a relayed
  // WebFetch read as a globe labelled WORKER REQUEST.
  switch (permissionKickerForTool(toolName, relayed)) {
    case 'Worker request':
      // The prototype's worker glyph (`Permissions.jsx:41`): a branch, the same
      // vocabulary the orchestrator surfaces use for a delegated agent.
      return (
        <Glyph>
          <line x1="6" y1="3" x2="6" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </Glyph>
      )
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
