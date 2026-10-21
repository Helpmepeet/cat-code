/**
 * Renders `AskUserQuestion` on the docked permission rail. The renderer sends
 * option indices, selected-option notes and freeform text; the sidecar attaches
 * engine-owned labels.
 *
 * The dock scrolls its panel region, while this card's height ceiling keeps one
 * question from taking the whole region. A split workspace mounts a card per
 * pane, so only the active pane owns the keyboard. Accent marks picked answers;
 * the keyboard highlight uses a neutral wash. Hovering the single-select Other
 * row previews it as a provisional choice. Arrow and digit shortcuts pick their
 * destination; focus alone does not.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MAX_QUESTION_ANSWER_CHARS } from '../../shared/limits.js'
import type { AskUserQuestionAnswer } from '../../shared/protocol.js'
import type { AskQuestion } from './askQuestionState.js'
import {
  abandonOtherText,
  buildAskAnswerPayload,
  buildAskChatMessage,
  hasAskAnswer,
  type AskQuestionDraft,
  type DraftAnswer,
} from './askQuestionFlowModel.js'
import { permissionKeysAreLive } from './permissionPromptModel.js'
import { isModalOverlayOpen, useModalOverlayOpen } from './overlayFocus.js'

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
 * A pick or provisional Other choice gets the accent. The keyboard highlight
 * is a neutral wash. Arrow and digit shortcuts synchronize a single-select
 * pick with that highlight; Tab focus alone leaves the answer unchanged.
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
 * A filled accent marker means picked or provisionally on Other. An empty
 * marker has a neutral border, including on the highlighted row. The shape
 * distinguishes radio from checkbox without relying on color.
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
  return `ask-option-marker flex h-4 w-4 shrink-0 items-center justify-center border font-mono text-[10px] font-semibold leading-none ${shape} ${tone}`
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
  draft: savedDraft,
  onDraftChange,
  submitted,
  isActivePane,
  pendingCount,
  onAnswer,
  onCancel,
  onChat,
}: {
  questions: AskQuestion[]
  requestId: string
  /** Session-owned progress survives a pane unmount. Omit for local state. */
  draft?: AskQuestionDraft
  onDraftChange?: (draft: AskQuestionDraft) => void
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
  onChat?: (message: string) => void
}) {
  const [localDraft, setLocalDraft] = useState<AskQuestionDraft>(() => savedDraft ?? {
    questionIndex: 0,
    answers: questions.map(() => ({ optionIndices: [], other: '' })),
  })
  const flowDraft = savedDraft ?? localDraft
  const flowDraftRef = useRef(flowDraft)
  flowDraftRef.current = flowDraft
  const qi = flowDraft.questionIndex
  const answers = flowDraft.answers
  const [cursor, setCursor] = useState(0)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [otherActive, setOtherActive] = useState(false)
  const [noteIndex, setNoteIndex] = useState<number | null>(null)
  const noteInputRef = useRef<HTMLInputElement>(null)
  const otherInputRef = useRef<HTMLInputElement>(null)
  const isComposingRef = useRef(false)
  const cardRef = useRef<HTMLElement>(null)
  const restoreTargetRef = useRef<HTMLElement | null>(null)
  const modalOpen = useModalOverlayOpen()
  // Optimistic, like the sibling card's: the mount effect below is about to take
  // the keyboard, and it corrects this from the real `activeElement`. Every
  // later focus move re-derives it through the section's own focus handlers.
  const [keysLive, setKeysLive] = useState(isActivePane)

  const q = questions[qi]
  const optionCount = q ? q.options.length : 0
  const freeText = optionCount === 0
  const otherIndex = optionCount // the "Other…" row sits after the options
  const rowCount = optionCount + 1
  const draft = answers[qi] ?? { optionIndices: [], other: '' }
  const otherText = draft.other
  /** The freeform row is an ANSWER once it carries text, so it shows as one. */
  const otherFilled = draft.other.trim().length > 0
  // Hovering or opening Other previews it as the single-select choice. Keep the
  // previous draft until text replaces it, so leaving restores the old option.
  const otherPending =
    !q?.multiSelect && !otherFilled && (otherActive || hoverIndex === otherIndex)
  // Counts the freeform row too, or the line reads "2 selected" under three
  // rows drawn as chosen.
  const selectedCount = draft.optionIndices.length + (otherFilled ? 1 : 0)
  const canAdvance = (freeText || !otherPending) && hasAskAnswer(draft)
  const isLast = qi >= questions.length - 1

  // Reset per-question transient UI when the step changes (committed answers in
  // `answers` persist, including option-specific notes and freeform text).
  useEffect(() => {
    const saved = answers[qi]
    setCursor(saved?.optionIndices[0] ?? (saved?.other.trim() ? optionCount : 0))
    setHoverIndex(null)
    setOtherActive(false)
    setNoteIndex(null)
    isComposingRef.current = false
    const active = document.activeElement
    if (
      isActivePane &&
      !isModalOverlayOpen() &&
      (cardRef.current?.contains(active) || active === document.body)
    ) {
      if (freeText) otherInputRef.current?.focus()
      else cardRef.current?.focus()
    }
  }, [qi])

  useEffect(() => {
    if (otherActive) otherInputRef.current?.focus()
    else isComposingRef.current = false
  }, [otherActive])

  useEffect(() => {
    if (noteIndex !== null) noteInputRef.current?.focus()
  }, [noteIndex])

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
    if (!isActivePane || modalOpen) {
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
    if (
      isModalOverlayOpen() ||
      (previous instanceof Element && previous.closest('[aria-modal="true"]'))
    ) {
      setKeysLive(false)
      return
    }
    if (previous instanceof HTMLElement && previous !== node && !node.contains(previous)) {
      restoreTargetRef.current = previous
    }
    let took = false
    const timer = setTimeout(() => {
      if (isModalOverlayOpen()) return
      const field = node.querySelector<HTMLInputElement>('[data-ask-free-text]')
      if (field) field.focus()
      else node.focus()
      took = document.activeElement === node || node.contains(document.activeElement)
      setKeysLive(took)
    }, 0)
    return () => {
      clearTimeout(timer)
      const restoreTarget = restoreTargetRef.current
      if (!took || !restoreTarget?.isConnected || isModalOverlayOpen()) return
      // `document.activeElement === node` is FALSE on the real unmount path:
      // React runs passive cleanup after the host node is detached, and
      // detaching the focused node resets `activeElement` to <body>. Checking
      // only that never restored anything, which is why answering a question
      // left the keyboard on <body>. Restore when we still hold focus, or when
      // it fell to the body because our node went away.
      const active = document.activeElement
      if (active === node || node.contains(active) || active === null || active === document.body) {
        restoreTarget.focus()
      }
    }
  }, [isActivePane, modalOpen])

  function updateFlowDraft(edit: (current: AskQuestionDraft) => AskQuestionDraft) {
    const next = edit(flowDraftRef.current)
    // The ref keeps batched picks ordered before a controlled parent re-renders.
    flowDraftRef.current = next
    if (savedDraft === undefined) setLocalDraft(next)
    onDraftChange?.(next)
  }

  /**
   * Every draft edit derives from the PREVIOUS draft, never from the `draft`
   * this render closed over. Two toggles that land in one React task (a
   * double-click, a key repeat, a test dispatching both in a tick) both read
   * the same stale closure otherwise, and the second overwrites the first —
   * a multi-select silently keeping only the last option touched.
   */
  function updateDraft(edit: (current: DraftAnswer) => DraftAnswer) {
    updateFlowDraft(current => ({
      ...current,
      answers: current.answers.map((value, i) =>
        i === current.questionIndex ? edit(value) : value,
      ),
    }))
  }

  function toggleOption(index: number) {
    if (!q) return
    if (q.multiSelect) {
      updateDraft(current => ({
        ...current,
        optionIndices: current.optionIndices.includes(index)
          ? current.optionIndices.filter(i => i !== index)
          : [...current.optionIndices, index],
        other: current.other,
      }))
    } else {
      // Single-select: one option supersedes any freeform text.
      updateDraft(current => ({ ...current, optionIndices: [index], other: '' }))
      setOtherActive(false)
    }
    setNoteIndex(null)
  }

  function focusCursor(next: number) {
    const target =
      next < optionCount
        ? cardRef.current?.querySelectorAll<HTMLButtonElement>(
            'button[data-ask-option]',
          )[next]
        : cardRef.current?.querySelector<HTMLButtonElement>(
            'button[data-ask-other]',
          )
    target?.focus()
  }

  function moveCursor(next: number) {
    setCursor(next)
    if (q && !q.multiSelect && next < optionCount) {
      updateDraft(current => ({ ...current, optionIndices: [next], other: '' }))
      setOtherActive(false)
    }
    // Space is native button activation when a row has focus. Keep that focus
    // on the highlighted row so Space never clicks the previous option.
    focusCursor(next)
  }

  function setOtherText(value: string) {
    // Single-select: typing a freeform answer clears the option pick; multi keeps it.
    updateDraft(current => ({
      ...current,
      optionIndices: q?.multiSelect ? current.optionIndices : [],
      other: value,
    }))
  }

  function advance() {
    if (freeText && !otherText.trim()) return
    if (
      !freeText &&
      (cursor === otherIndex || otherPending) &&
      !otherActive &&
      !otherText.trim()
    ) {
      setOtherActive(true)
      return
    }
    let nextAnswers = flowDraftRef.current.answers
    if (!canAdvance) {
      // A single-select cursor is an implicit default for one-Enter submission.
      // Multi-select must stay explicit or Enter would end the step after one
      // choice and make its remaining options unreachable.
      if (!q || q.multiSelect || otherActive || cursor >= optionCount) return
      const selected = { ...draft, optionIndices: [cursor], other: '' }
      nextAnswers = nextAnswers.map((value, i) => (i === qi ? selected : value))
    }
    if (!isLast) {
      updateFlowDraft(() => ({ questionIndex: qi + 1, answers: nextAnswers }))
      return
    }
    // Clickable headers can reach the last step before earlier ones are filled.
    const unanswered = nextAnswers.findIndex(answer => !hasAskAnswer(answer))
    if (unanswered !== -1) {
      updateFlowDraft(() => ({ questionIndex: unanswered, answers: nextAnswers }))
      return
    }
    // Build the wire payload: option INDICES + trimmed freeform per question. The
    // sidecar re-attaches the engine's own labels and joins them (outputSchema).
    onAnswer(buildAskAnswerPayload(nextAnswers))
  }

  function goToQuestion(index: number) {
    if (submitted || index === qi) return
    updateFlowDraft(current => ({ ...current, questionIndex: index }))
  }

  function openNote(index: number) {
    if (!draft.optionIndices.includes(index) || submitted) return
    setNoteIndex(index)
    setOtherActive(false)
    setCursor(index)
    updateDraft(current => ({
      ...current,
      notes: { ...current.notes, [index]: current.notes?.[index] ?? '' },
    }))
    if (noteIndex === index) noteInputRef.current?.focus()
  }

  useEffect(() => {
    // A split workspace mounts one flow PER visible pane, so an ungated window
    // listener would let a single Escape deny every pending request at once.
    // Keyboard belongs to the active pane only, matching App's own permission
    // keydown, which acts solely on the activeSessionId's request.
    if (!isActivePane || modalOpen) return
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        isComposingRef.current ||
        isModalOverlayOpen() ||
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
      // activation keys, and option rows keep Space. Enter on an option row or
      // Other is claimed by the flow so it submits or opens the freeform field
      // without triggering the button's native click.
      if (inCard && CONTROL_ACTIVATION_KEYS.has(event.key)) {
        const control = element.closest(CARD_CONTROL_SELECTOR)
        const optionRow = element.closest('[data-ask-option]')
        const flowClaimsRowEnter =
          event.key === 'Enter' &&
          (optionRow !== null || control?.matches('[data-ask-other]') === true)
        if (
          control !== null &&
          control !== otherInputRef.current &&
          control !== noteInputRef.current &&
          !flowClaimsRowEnter
        ) {
          return
        }
      }
      // In flight: the answer is already sent (buttons are disabled too) — the
      // keyboard must not fire a second advance/submit before the resolve lands.
      if (submitted) return
      const key = event.key
      const target = event.target as HTMLElement | null
      const inNote = target === noteInputRef.current
      const inOurInput = (otherActive || freeText) && target === otherInputRef.current

      if (inNote) {
        if (key === 'Escape' || key === 'Enter') {
          event.preventDefault()
          isComposingRef.current = false
          cardRef.current?.focus()
        }
        return
      }

      if (inOurInput) {
        // Typing into the freeform field: Enter advances, Escape leaves the field.
        if (key === 'Escape') {
          event.preventDefault()
          if (freeText) {
            onCancel()
            return
          }
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
      if (element?.closest('input, textarea, [contenteditable="true"]')) return

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
      if (key === 'ArrowLeft' && qi > 0) {
        event.preventDefault()
        goToQuestion(qi - 1)
        return
      }
      if (freeText) return
      if (key === 'n' && !event.ctrlKey) {
        if (draft.optionIndices.includes(cursor)) {
          event.preventDefault()
          openNote(cursor)
        }
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
          focusCursor(index)
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
  const keysAdvertised = isActivePane && keysLive && !modalOpen

  return (
    <section
      aria-labelledby={titleId}
      className="overflow-hidden rounded-xl border border-white/[0.08] bg-[light-dark(#ffffff,#141416)] focus:outline-none"
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
      <div className="max-h-[60vh] overflow-y-auto px-3.5 pb-2 pt-2.5">
      {/* Header, step progress, and queued count share one line. */}
      <div className="flex min-h-[15px] items-center gap-2">
        <span className="flex text-accent">
          <QuestionGlyph />
        </span>
        {questions.length > 1 ? (
          <div aria-label="Questions" className="ask-question-steps">
            {questions.map((question, index) => (
              <button
                aria-current={index === qi ? 'step' : undefined}
                className={`ask-question-step ${index === qi ? 'text-accent' : hasAskAnswer(answers[index]) ? 'text-text-muted' : 'text-text-faint'}`}
                data-ask-step={index}
                disabled={submitted}
                key={index}
                onClick={() => goToQuestion(index)}
                type="button"
              >
                {question.header || 'Question'}
              </button>
            ))}
          </div>
        ) : (
          <span className="text-[10px] font-bold uppercase leading-[15px] tracking-[0.1em] text-accent">
            {q.header || 'Question'}
          </span>
        )}
        {showPending ? (
          <span className="ml-auto flex items-center gap-2.5 font-mono text-[10.5px] tabular-nums text-text-faint">
            <span>
              <b className="font-medium text-text-muted">{pendingCount}</b> pending
            </span>
          </span>
        ) : null}
      </div>

      <h2
        className="mt-1 text-sm font-semibold leading-[18px] text-text-primary"
        id={titleId}
      >
        {q.question}
      </h2>

      {/* Multi-select is the surprising case, so it is the only one that says
       * anything (§7): a single-select list needs no instruction. The line
       * doubles as the running confirmation that a pick registered, which is
       * the second channel the checkboxes alone did not give the operator. */}
      {q.multiSelect && !freeText ? (
        <p className="mt-0.5 text-xs leading-4 text-text-subtle">
          {selectedCount > 0
            ? `${selectedCount} selected`
            : 'Pick as many as you like'}
        </p>
      ) : null}

      {/* Options — label + description, radio/checkbox marker, preview badge */}
      {freeText ? (
        <input
          aria-label="Your answer"
          className="ask-question-input ask-question-free-text"
          data-ask-free-text
          disabled={submitted}
          maxLength={MAX_QUESTION_ANSWER_CHARS}
          onChange={event => setOtherText(event.target.value)}
          onCompositionStart={() => { isComposingRef.current = true }}
          onCompositionEnd={() => { isComposingRef.current = false }}
          onBlur={() => { isComposingRef.current = false }}
          ref={otherInputRef}
          value={otherText}
        />
      ) : <div
        aria-labelledby={q.multiSelect ? undefined : titleId}
        className="-mx-2 mt-1.5 flex flex-col gap-px"
        role={q.multiSelect ? undefined : 'radiogroup'}
      >
        {q.options.map((option, i) => {
          const active = cursor === i && !otherActive
          const checked = !otherPending && draft.optionIndices.includes(i)
          const showNote = checked && (noteIndex === i || draft.notes?.[i] !== undefined)
          return (
            <div className={`ask-option-wrap ${showNote ? 'ask-option-with-note' : ''} ${keysAdvertised && i < 9 ? 'ask-option-with-key' : ''}`} key={i}>
            <button
              aria-checked={checked}
              className={`ask-option-choice flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default ${rowTone(checked, active)}`}
              data-ask-active={active ? 'true' : undefined}
              data-ask-option
              disabled={submitted}
              onClick={() => toggleOption(i)}
              role={q.multiSelect ? 'checkbox' : 'radio'}
              // Focus moves the highlight. Arrow and digit shortcuts pick;
              // simply tabbing into the group does not choose an answer.
              onFocus={() => {
                setCursor(i)
                setOtherActive(false)
                setHoverIndex(null)
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
              <span className="ask-option-text min-w-0 flex-1">
                <span className="ask-option-label text-[13px] font-medium leading-[17px] text-text-primary">
                  {option.label}
                </span>
                {option.description ? (
                  <span className="ask-option-description text-xs leading-4 text-text-subtle">
                    {option.description}
                  </span>
                ) : null}
              </span>
              {option.preview ? (
                <span className="mt-[1.5px] shrink-0 rounded bg-tone-info/10 px-1.5 text-[10px] font-semibold leading-[14px] text-tone-info">
                  preview
                </span>
              ) : null}
              {checked && !showNote ? <span aria-hidden className="ask-option-note-space" /> : null}
              {keysAdvertised && i < 9 ? (
                <KeyCap active={active}>{i + 1}</KeyCap>
              ) : null}
            </button>
            {checked && !showNote ? (
              <button
                aria-label={`Add a note to ${option.label}`}
                className={`ask-option-note-button ${keysAdvertised && i < 9 ? 'ask-option-note-keyed' : ''}`}
                disabled={submitted}
                onClick={() => openNote(i)}
                type="button"
              >note</button>
            ) : null}
            {showNote ? (
              <div className={`ask-option-note ${rowTone(checked, active)}`}>
                <input
                  aria-label={`Note for ${option.label}`}
                  className="ask-question-input"
                  disabled={submitted}
                  maxLength={MAX_QUESTION_ANSWER_CHARS}
                  onChange={event => {
                    const value = event.target.value
                    updateDraft(current => ({
                      ...current,
                      notes: { ...current.notes, [i]: value },
                    }))
                  }}
                  onFocus={() => {
                    setCursor(i)
                    setNoteIndex(i)
                    setOtherActive(false)
                    setHoverIndex(null)
                  }}
                  onBlur={() => { isComposingRef.current = false }}
                  onCompositionStart={() => { isComposingRef.current = true }}
                  onCompositionEnd={() => { isComposingRef.current = false }}
                  ref={noteIndex === i ? noteInputRef : undefined}
                  value={draft.notes?.[i] ?? ''}
                />
              </div>
            ) : null}
            </div>
          )
        })}

        {/* Built-in "Other…" freeform row — always appended by this UI */}
        <div
          className={`flex items-center gap-2.5 rounded-lg px-2 py-1 ${rowTone(
            otherFilled || otherPending,
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
              otherFilled || otherPending,
              cursor === otherIndex,
            )}
            data-ask-marker
          >
            {otherFilled || otherPending ? '✓' : ''}
          </span>
          {otherActive ? (
            <input
              aria-label="Other answer"
              className="-my-[3px] min-w-0 flex-1 rounded-md border border-white/10 bg-black/30 px-2 py-0.5 text-[13px] leading-[17px] text-text-primary outline-none placeholder:text-text-subtle"
              disabled={submitted}
              onBlur={() => {
                isComposingRef.current = false
                if (!otherText.trim()) setOtherActive(false)
              }}
              onCompositionStart={() => { isComposingRef.current = true }}
              onCompositionEnd={() => { isComposingRef.current = false }}
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
              data-ask-other
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
      </div>}

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
      <div className="ask-question-footer mt-1.5 flex items-center gap-1.5">
        {qi > 0 ? (
          <button className="ask-question-ghost" disabled={submitted} onClick={() => goToQuestion(qi - 1)} type="button">
            Back
            {keysAdvertised ? <span className="ask-question-key">←</span> : null}
          </button>
        ) : null}
        <button
          className="ask-question-ghost"
          disabled={submitted}
          onClick={() => onChat?.(buildAskChatMessage(questions, flowDraftRef.current.answers))}
          type="button"
        >Chat about this</button>
        <span className="flex-1" />
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
