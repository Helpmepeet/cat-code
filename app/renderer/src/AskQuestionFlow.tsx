/**
 * Renders `AskUserQuestion` on the docked permission rail. The renderer sends
 * option indices and freeform text; the sidecar attaches engine-owned labels.
 *
 * The dock scrolls its panel region, while this card's height ceiling keeps one
 * question from taking the whole region. A split workspace mounts a card per
 * pane, so only the active pane owns the keyboard. Accent marks picked answers;
 * the keyboard highlight and pointer hover use a neutral wash. In single-select,
 * moving the highlight onto an option picks it for Enter.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MAX_QUESTION_ANSWER_CHARS } from '../../shared/limits.js'
import type { AskUserQuestionAnswer } from '../../shared/protocol.js'
import type { AskQuestion } from './askQuestionState.js'
import {
  abandonOtherText,
  buildAskAnswerPayload,
  type DraftAnswer,
} from './askQuestionFlowModel.js'
import { permissionKeysAreLive } from './permissionPromptModel.js'

/**
 * Keys a focused control acts on ITSELF. Footer buttons keep both activation
 * keys, and option rows keep Space for toggling. Enter on an option row belongs
 * to the flow so a mouse pick followed by Enter submits it.
 */
const CONTROL_ACTIVATION_KEYS = new Set([' ', 'Enter'])

/** Controls that own their activation keys inside the card. */
const CARD_CONTROL_SELECTOR = 'a[href], button, input, select, textarea'

/**
 * Whether the flow's shortcuts would fire for `active`. Inside the card they do
 * (the containment rule in the key handler); outside it the shared predicate
 * decides, so the composer keeps the keys it is being typed into. The key chips
 * read this so they never advertise a dead key.
 */
function askKeysLive(card: HTMLElement | null, active: Element | null): boolean {
  if (card !== null && active !== null && card.contains(active)) return true
  return permissionKeysAreLive(active)
}

/**
 * A pick keeps its accent under the pointer. The keyboard highlight is a
 * neutral wash; in single-select, moving it onto an option also picks that
 * option, so Enter sends the highlighted answer.
 */
function rowTone(checked: boolean, active: boolean): string {
  if (checked) {
    return active ? 'bg-accent/[0.14]' : 'bg-accent/10'
  }
  return active
    ? 'bg-text-primary/[0.05] hover:bg-text-primary/[0.05]'
    : 'hover:bg-text-primary/[0.05]'
}

/**
 * A filled accent marker means picked. An empty marker has a neutral border,
 * including on the highlighted row. The shape distinguishes radio from
 * checkbox without relying on color.
 */
function markerClass(
  multiSelect: boolean,
  checked: boolean,
  active: boolean,
): string {
  const shape = multiSelect ? 'rounded-[5px]' : 'rounded-full'
  const tone = checked
    ? 'border-accent bg-accent text-on-fill'
    : active
      ? 'border-text-primary/50 bg-transparent'
      : 'border-text-primary/[0.28] bg-transparent'
  return `mt-px flex h-4 w-4 shrink-0 items-center justify-center border font-mono text-[10px] font-semibold leading-none ${shape} ${tone}`
}

/** A row's digit shortcut brightens on the keyboard highlight. */
function KeyCap({ children, active }: { children: ReactNode; active: boolean }) {
  return (
    <span
      className={`min-w-[10px] shrink-0 text-right font-mono text-[10.5px] leading-[17px] ${active ? 'text-text-muted' : 'text-text-ghost'}`}
    >
      {children}
    </span>
  )
}

export function AskQuestionFlow({
  questions,
  requestId,
  submitted,
  isActivePane,
  pendingCount,
  onAnswer,
  onCancel,
}: {
  questions: AskQuestion[]
  requestId: string
  /** True while an answer for this request is in flight (double-submit guard). */
  submitted?: boolean
  /**
   * True only for the pane the operator is focused on. The keyboard handler is
   * a window listener, so in a split workspace only the active pane's flow may
   * own it — otherwise one keypress resolves every mounted flow at once.
   */
  isActivePane: boolean
  /**
   * How many requests are waiting in total, this question included. The kicker
   * shows it only past one, so answering never looks like the last thing left
   * when a permission card is queued behind it (`Permissions.jsx:451-456`).
   */
  pendingCount?: number
  onAnswer: (answers: AskUserQuestionAnswer[]) => void
  onCancel: () => void
}) {
  const [qi, setQi] = useState(0)
  const [answers, setAnswers] = useState<DraftAnswer[]>(() =>
    questions.map(() => ({ optionIndices: [], other: '' })),
  )
  const [cursor, setCursor] = useState(0)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [otherActive, setOtherActive] = useState(false)
  const otherInputRef = useRef<HTMLInputElement>(null)
  const cardRef = useRef<HTMLElement>(null)
  // Optimistic, like the sibling card's: the mount effect below is about to take
  // the keyboard, and it corrects this from the real `activeElement`. Every
  // later focus move re-derives it through the section's own focus handlers.
  const [keysLive, setKeysLive] = useState(isActivePane)

  const q = questions[qi]
  const optionCount = q ? q.options.length : 0
  const otherIndex = optionCount // the "Other…" row sits after the options
  const rowCount = optionCount + 1
  const draft = answers[qi] ?? { optionIndices: [], other: '' }
  const otherText = draft.other
  /** The freeform row is an ANSWER once it carries text, so it shows as one. */
  const otherFilled = draft.other.trim().length > 0
  // Counts the freeform row too, or the line reads "2 selected" under three
  // rows drawn as chosen.
  const selectedCount = draft.optionIndices.length + (otherFilled ? 1 : 0)
  const canAdvance =
    draft.optionIndices.length > 0 || otherText.trim().length > 0
  const isLast = qi >= questions.length - 1

  // Reset per-question transient UI when the step changes (committed answers in
  // `answers` persist — the flow only advances forward, like the prototype).
  useEffect(() => {
    setCursor(0)
    setHoverIndex(null)
    setOtherActive(false)
  }, [qi])

  useEffect(() => {
    if (otherActive) otherInputRef.current?.focus()
  }, [otherActive])

  // The height ceiling below made this a keyboard-driven list inside a scroll
  // container, so the cursor can now leave the viewport: ↑↓ past the visible
  // rows moved an invisible highlight, and Enter then resolved a row the user
  // could not see. Same one-liner the app's other four such lists use
  // (`CommandPalette.tsx:69-74`, `SlashCommandPicker`, `MentionPicker`,
  // `TasksDialog`).
  useEffect(() => {
    const active = cardRef.current?.querySelector('[data-ask-active="true"]')
    if (active) active.scrollIntoView({ block: 'nearest' })
  }, [cursor, otherActive, qi])

  // Take the keyboard on mount, the way the app's other keyboard-owning cards
  // already do (`PermissionPrompt.tsx`, `PlanPanel.tsx` via `useModalFocus`).
  // Without this the composer keeps focus and `permissionKeysAreLive` reports
  // the compact key chips dead.
  useEffect(() => {
    if (!isActivePane) {
      setKeysLive(false)
      return
    }
    const node = cardRef.current
    if (!node) return
    const previous = document.activeElement
    // A modal owns the screen: this card is docked BEHIND its scrim, so taking
    // the keyboard here would let digits and Enter answer a question the user
    // cannot see while they are looking at the dialog (`PlanPanel` sets both
    // attributes, `overlayFocus.ts` arbitrates the stack this effect is not on).
    if (previous instanceof Element && previous.closest('[aria-modal="true"]')) {
      setKeysLive(false)
      return
    }
    let took = false
    const timer = setTimeout(() => {
      node.focus()
      took = document.activeElement === node
      setKeysLive(took)
    }, 0)
    return () => {
      clearTimeout(timer)
      if (!took || !(previous instanceof HTMLElement)) return
      // `document.activeElement === node` is FALSE on the real unmount path:
      // React runs passive cleanup after the host node is detached, and
      // detaching the focused node resets `activeElement` to <body>. Checking
      // only that never restored anything, which is why answering a question
      // left the keyboard on <body>. Restore when we still hold focus, or when
      // it fell to the body because our node went away.
      const active = document.activeElement
      if (active === node || active === null || active === document.body) {
        previous.focus()
      }
    }
  }, [isActivePane])

  /**
   * Every draft edit derives from the PREVIOUS draft, never from the `draft`
   * this render closed over. Two toggles that land in one React task (a
   * double-click, a key repeat, a test dispatching both in a tick) both read
   * the same stale closure otherwise, and the second overwrites the first —
   * a multi-select silently keeping only the last option touched.
   */
  function updateDraft(edit: (current: DraftAnswer) => DraftAnswer) {
    setAnswers(prev => prev.map((value, i) => (i === qi ? edit(value) : value)))
  }

  function toggleOption(index: number) {
    if (!q) return
    if (q.multiSelect) {
      updateDraft(current => ({
        optionIndices: current.optionIndices.includes(index)
          ? current.optionIndices.filter(i => i !== index)
          : [...current.optionIndices, index],
        other: current.other,
      }))
    } else {
      // Single-select: one option supersedes any freeform text.
      updateDraft(() => ({ optionIndices: [index], other: '' }))
      setOtherActive(false)
    }
  }

  function moveCursor(next: number) {
    setCursor(next)
    if (q && !q.multiSelect && next < optionCount) {
      updateDraft(() => ({ optionIndices: [next], other: '' }))
      setOtherActive(false)
    }
  }

  function setOtherText(value: string) {
    // Single-select: typing a freeform answer clears the option pick; multi keeps it.
    updateDraft(current => ({
      optionIndices: q?.multiSelect ? current.optionIndices : [],
      other: value,
    }))
  }

  function advance() {
    if (cursor === otherIndex && !otherActive && !otherText.trim()) {
      setOtherActive(true)
      return
    }
    let nextAnswers = answers
    if (!canAdvance) {
      // A single-select cursor is an implicit default for one-Enter submission.
      // Multi-select must stay explicit or Enter would end the step after one
      // choice and make its remaining options unreachable.
      if (!q || q.multiSelect || otherActive || cursor >= optionCount) return
      const selected = { optionIndices: [cursor], other: '' }
      nextAnswers = answers.map((value, i) => (i === qi ? selected : value))
    }
    if (!isLast) {
      setAnswers(nextAnswers)
      setQi(qi + 1)
      return
    }
    // Build the wire payload: option INDICES + trimmed freeform per question. The
    // sidecar re-attaches the engine's own labels and joins them (outputSchema).
    onAnswer(buildAskAnswerPayload(nextAnswers))
  }

  useEffect(() => {
    // A split workspace mounts one flow PER visible pane, so an ungated window
    // listener would let a single Escape deny every pending request at once.
    // Keyboard belongs to the active pane only, matching App's own permission
    // keydown, which acts solely on the activeSessionId's request.
    if (!isActivePane) return
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.metaKey ||
        event.altKey
      ) {
        return
      }
      // Inside our own card the CARD owns the keyboard; outside it, defer to the
      // shared predicate so the composer keeps the keys it is being typed into.
      //
      // Not `PermissionPrompt`'s `data-permission-key-host` marker, because the
      // two cards want opposite things and the marker cannot express this one.
      // `permissionKeysAreLive` resolves the NEAREST owner, and every option row
      // here is a `<button>` — an owner — so the marker on the `<section>` is
      // never even read once focus lands on a row. On the permission card that
      // is correct: Enter on its focused Deny button must deny. Here the rows
      // are TOGGLES, so a click used to leave the row focused and kill all
      // shortcuts — arrows, digits, space, Escape — and the same guard ran ahead of
      // the freeform branch, so Enter and Escape inside "Other…" were
      // unreachable too.
      //
      // A containment test rather than marking each control: it cannot drift
      // when a control is added, and it states the actual rule.
      const element = event.target instanceof Element ? event.target : null
      const inCard =
        element !== null && cardRef.current?.contains(element) === true
      if (!inCard && !permissionKeysAreLive(event.target)) return

      // Containment claims the NAVIGATION keys. Footer controls keep their own
      // activation keys, and option rows keep Space. Enter on an option row is
      // deliberately claimed by the flow: clicking an answer and pressing Enter
      // submits it instead of toggling it off.
      if (inCard && CONTROL_ACTIVATION_KEYS.has(event.key)) {
        const control = element.closest(CARD_CONTROL_SELECTOR)
        const optionRow = element.closest('[data-ask-option]')
        const flowClaimsOptionEnter =
          event.key === 'Enter' && optionRow !== null
        if (
          control !== null &&
          control !== otherInputRef.current &&
          !flowClaimsOptionEnter
        ) {
          return
        }
      }
      // In flight: the answer is already sent (buttons are disabled too) — the
      // keyboard must not fire a second advance/submit before the resolve lands.
      if (submitted) return
      const key = event.key
      const target = event.target as HTMLElement | null
      const inOurInput = otherActive && target === otherInputRef.current

      if (inOurInput) {
        // Typing into the freeform field: Enter advances, Escape leaves the field.
        if (key === 'Escape') {
          event.preventDefault()
          setOtherActive(false)
          updateDraft(abandonOtherText)
          // Leaving the field unmounts the focused input, which drops focus to
          // <body>. Take it back so the card keeps keyboard ownership.
          cardRef.current?.focus()
          return
        }
        if (key === 'Enter') {
          event.preventDefault()
          advance()
        }
        return // let the input handle the rest
      }

      // Never hijack keys typed into an unrelated field (e.g. the composer).
      if (key === 'Escape') {
        event.preventDefault()
        onCancel()
        return
      }
      if (key === 'Enter') {
        event.preventDefault()
        advance()
        return
      }
      if (key === ' ' && q?.multiSelect && cursor < optionCount) {
        event.preventDefault()
        toggleOption(cursor)
        return
      }
      if (/^[1-9]$/.test(key)) {
        const index = Number(key) - 1
        if (index < optionCount) {
          event.preventDefault()
          setCursor(index)
          toggleOption(index)
        } else if (index === otherIndex) {
          event.preventDefault()
          setCursor(otherIndex)
          setOtherActive(true)
        }
        return
      }
      // "Other…" also answers to its own letter: past 8 options its row number is
      // two digits, which no single keypress can reach (and which the row's own
      // marker cannot show).
      if (key === 'o' || key === 'O') {
        event.preventDefault()
        setCursor(otherIndex)
        setOtherActive(true)
        return
      }
      if (key === 'ArrowDown' || key === 'j' || (event.ctrlKey && key === 'n')) {
        event.preventDefault()
        moveCursor((cursor + 1) % rowCount)
        return
      }
      if (key === 'ArrowUp' || key === 'k' || (event.ctrlKey && key === 'p')) {
        event.preventDefault()
        moveCursor((cursor - 1 + rowCount) % rowCount)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  if (!q) return null
  const previewIndex = hoverIndex ?? cursor
  const focusedPreview =
    previewIndex < optionCount ? q.options[previewIndex]?.preview ?? null : null
  const titleId = `ask-question-${requestId}`
  const tabStop = draft.optionIndices[0] ?? (cursor < optionCount ? cursor : 0)
  const showPending = pendingCount !== undefined && pendingCount > 1
  // The sibling card's honesty rule (P4-43, PARITY-LEDGER §7): never advertise
  // a key that will not fire. An inactive pane registers no listener, and a card
  // behind a modal deliberately does not take focus.
  const keysAdvertised = isActivePane && keysLive

  return (
    <section
      aria-labelledby={titleId}
      className="overflow-hidden rounded-xl border border-white/[0.08] bg-[light-dark(#ffffff,#141416)] shadow-[var(--elev-popover),0_0_0_1px_var(--card-ring)] focus:outline-none"
      // Focus events bubble, so these fire for the card AND every control in
      // it — which is exactly the containment rule the key handler applies.
      onBlur={event =>
        setKeysLive(
          askKeysLive(cardRef.current, event.relatedTarget as Element | null),
        )
      }
      onFocus={() => setKeysLive(true)}
      ref={cardRef}
      role="group"
      tabIndex={isActivePane ? -1 : undefined}
    >
      {/* Body scrolls under a ceiling, the way the prototype bounds the same
       * growth (`maxHeight: calc(100vh - 150px)` + `overflowY: auto`). It no
       * longer protects the composer; it keeps one card from taking the whole
       * dock away from a permission card queued behind it. Sized
       * to the viewport rather than to the dock on purpose, so that in a window
       * with room the card sits at its natural height and the dock's own
       * scroller never engages. */}
      <div className="max-h-[60vh] overflow-y-auto px-4 pb-2.5 pt-3">
      {/* Header, step progress, and queued count share one line. */}
      <div className="flex h-[15px] items-center gap-2">
        <span className="flex text-accent">
          <QuestionGlyph />
        </span>
        <span className="text-[10px] font-bold uppercase leading-[15px] tracking-[0.1em] text-accent">
          {q.header || 'Question'}
        </span>
        {questions.length > 1 || showPending ? (
          <span className="ml-auto flex items-center gap-2.5 font-mono text-[10.5px] tabular-nums text-text-faint">
            {questions.length > 1 ? (
              <span className="flex items-center gap-1">
                {questions.map((_, i) => (
                  <span
                    aria-hidden
                    className={`h-1.5 w-1.5 rounded-full ${
                      i === qi
                        ? 'bg-accent'
                        : answers[i] &&
                            (answers[i]!.optionIndices.length > 0 ||
                              answers[i]!.other.trim().length > 0)
                          ? 'bg-accent/40'
                          : 'bg-text-primary/15'
                    }`}
                    key={i}
                  />
                ))}
                <span className="ml-[3px]">{qi + 1}/{questions.length}</span>
              </span>
            ) : null}
            {questions.length > 1 && showPending ? (
              <span className="h-2.5 w-px bg-shell-seam" />
            ) : null}
            {showPending ? (
              <span>
                <b className="font-medium text-text-muted">{pendingCount}</b> pending
              </span>
            ) : null}
          </span>
        ) : null}
      </div>

      <h2
        className="mt-1.5 text-[15px] font-semibold leading-5 text-text-primary"
        id={titleId}
      >
        {q.question}
      </h2>

      {/* Multi-select is the surprising case, so it is the only one that says
       * anything (§7): a single-select list needs no instruction. The line
       * doubles as the running confirmation that a pick registered, which is
       * the second channel the checkboxes alone did not give the operator. */}
      {q.multiSelect ? (
        <p className="mt-0.5 text-xs leading-4 text-text-subtle">
          {selectedCount > 0
            ? `${selectedCount} selected`
            : 'Pick as many as you like'}
        </p>
      ) : null}

      {/* Options — label + description, radio/checkbox marker, preview badge */}
      <div
        aria-labelledby={q.multiSelect ? undefined : titleId}
        className="-mx-2 mt-2 flex flex-col gap-0.5"
        role={q.multiSelect ? undefined : 'radiogroup'}
      >
        {q.options.map((option, i) => {
          const active = cursor === i && !otherActive
          const checked = draft.optionIndices.includes(i)
          return (
            <button
              aria-checked={checked}
              className={`flex w-full cursor-pointer items-start gap-2.5 rounded-lg px-2 py-[5px] text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default ${rowTone(checked, active)}`}
              data-ask-active={active ? 'true' : undefined}
              data-ask-option
              disabled={submitted}
              key={i}
              onClick={() => toggleOption(i)}
              role={q.multiSelect ? 'checkbox' : 'radio'}
              // Focus is keyboard intent; in single-select it also picks the
              // focused option so its highlight matches what Enter will send.
              onFocus={() => {
                moveCursor(i)
              }}
              onMouseEnter={() => setHoverIndex(i)}
              onMouseLeave={() => setHoverIndex(null)}
              tabIndex={q.multiSelect ? undefined : i === tabStop ? 0 : -1}
              type="button"
            >
              <span
                className={markerClass(q.multiSelect, checked, active)}
                data-ask-marker
              >
                {checked ? '✓' : ''}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium leading-[17px] text-text-primary">
                  {option.label}
                </span>
                {option.description ? (
                  <span className="mt-px block text-xs leading-4 text-text-subtle">
                    {option.description}
                  </span>
                ) : null}
              </span>
              {option.preview ? (
                <span className="mt-[1.5px] shrink-0 rounded bg-tone-info/10 px-1.5 text-[10px] font-semibold leading-[14px] text-tone-info">
                  preview
                </span>
              ) : null}
              {keysAdvertised && i < 9 ? (
                <KeyCap active={active}>{i + 1}</KeyCap>
              ) : null}
            </button>
          )
        })}

        {/* Built-in "Other…" freeform row — always appended by this UI */}
        <div
          className={`flex items-start gap-2.5 rounded-lg px-2 py-[5px] ${rowTone(
            otherFilled,
            cursor === otherIndex,
          )}`}
          data-ask-active={cursor === otherIndex ? 'true' : undefined}
          onFocus={() => setCursor(otherIndex)}
          onMouseEnter={() => setHoverIndex(otherIndex)}
          onMouseLeave={() => setHoverIndex(null)}
        >
          <span
            className={markerClass(
              q.multiSelect,
              otherFilled,
              cursor === otherIndex,
            )}
            data-ask-marker
          >
            {otherFilled ? '✓' : ''}
          </span>
          {otherActive ? (
            <input
              aria-label="Other answer"
              className="-my-[3px] min-w-0 flex-1 rounded-md border border-white/10 bg-black/30 px-2 py-0.5 text-[13px] leading-[17px] text-text-primary outline-none placeholder:text-text-subtle"
              disabled={submitted}
              onBlur={() => {
                if (!otherText.trim()) setOtherActive(false)
              }}
              // UX only — the sidecar's schema stays the trust boundary (T6).
              // Keeps an honest paste from being rejected at the seam.
              maxLength={MAX_QUESTION_ANSWER_CHARS}
              onChange={event => setOtherText(event.target.value)}
              placeholder="Type your own answer…"
              ref={otherInputRef}
              value={otherText}
            />
          ) : (
            <button
              className="flex-1 cursor-pointer bg-transparent text-left text-[13px] leading-[17px] text-text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default"
              disabled={submitted}
              onClick={() => setOtherActive(true)}
              type="button"
            >
              {otherText.trim() ? otherText : 'Other…'}
            </button>
          )}
          {/* Past eight options, the Other shortcut is its letter rather than
           * an unreachable two-digit number. */}
          {keysAdvertised ? (
            <KeyCap active={cursor === otherIndex}>
              {otherIndex < 9 ? otherIndex + 1 : 'o'}
            </KeyCap>
          ) : null}
        </div>
      </div>

      {/* Preview follows hover, then the keyboard highlight. */}
      {focusedPreview ? (
        <div className="mt-1.5 rounded-[9px] border border-white/[0.07] bg-black/30 px-[11px] py-[7px]">
          <div className="mb-1 text-[9.5px] font-bold uppercase tracking-[0.08em] text-text-faint">
            Preview
          </div>
          <pre className="m-0 whitespace-pre-wrap font-mono text-[11px] leading-[1.55] text-text-muted">
            {focusedPreview}
          </pre>
        </div>
      ) : null}

      {/* Footer actions end with the primary action. */}
      <div className="mt-2 flex items-center justify-end gap-1.5 border-t border-shell-seam pt-2">
        <button
          className="inline-flex items-center gap-1.5 rounded-md bg-transparent px-2 py-1 text-xs leading-4 text-text-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
          disabled={submitted}
          onClick={onCancel}
          type="button"
        >
          Cancel
          {keysAdvertised ? (
            <span className="rounded border border-text-ghost px-1 font-mono text-[9.5px] leading-[14px] text-text-faint">
              esc
            </span>
          ) : null}
        </button>
        <button
          className="inline-flex items-center gap-[7px] rounded-md bg-accent px-3 py-1 text-xs font-semibold leading-4 text-on-fill focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:bg-text-primary/[0.06] disabled:text-text-faint"
          disabled={!canAdvance || submitted}
          onClick={advance}
          type="button"
        >
          {isLast ? 'Submit' : 'Next question'}
          {keysAdvertised ? (
            <span className={`rounded border px-1 font-mono text-[9.5px] leading-[14px] ${canAdvance && !submitted ? 'border-on-fill/35' : 'border-text-primary/15'}`}>
              ↵
            </span>
          ) : null}
        </button>
      </div>
      </div>

    </section>
  )
}

/**
 * The prototype's `question` glyph (`Permissions.jsx:39`) at the sibling
 * permission card's kicker size and stroke, so the two cards' kicker rows read
 * as one family.
 */
function QuestionGlyph() {
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
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}
