/**
 * AskQuestionFlow — P4-20 (adapts the prototype's `Permissions.jsx`
 * `AskQuestionFlow`, the `ln` alias). Renders a live `AskUserQuestion` tool call
 * as an interactive answer flow on the permission rail: 1–4 questions
 * (single-question, or a stepper), single- and multi-select, the built-in
 * "Other…" freeform answer, per-option preview, a footer rail, and a dedicated
 * keyboard handler. Submit round-trips through `answerQuestions`
 * (decisions/ASK-USER-QUESTION-ANSWER.md); the renderer authors ONLY option
 * INDICES + the freeform text — the sidecar re-attaches the engine's own labels.
 *
 * Accent: the whole flow reads in the app's pink accent, which IS the
 * prototype's `ASK_ACCENT` (`#f472b6` == `theme.css --accent`), so every accent
 * shade is a static `accent` utility — no interpolated colour classes (the
 * Tailwind v4 dynamic-class trap).
 */

import { useEffect, useRef, useState } from 'react'
import { MAX_QUESTION_ANSWER_CHARS } from '../../shared/limits.js'
import type { AskUserQuestionAnswer } from '../../shared/protocol.js'
import type { AskQuestion } from './askQuestionState.js'
import {
  abandonOtherText,
  buildAskAnswerPayload,
  type DraftAnswer,
} from './askQuestionFlowModel.js'

/** One question's in-progress answer: engine-option indices + freeform text. */

export function AskQuestionFlow({
  questions,
  requestId,
  submitted,
  isActivePane,
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
  onAnswer: (answers: AskUserQuestionAnswer[]) => void
  onCancel: () => void
}) {
  const [qi, setQi] = useState(0)
  const [answers, setAnswers] = useState<DraftAnswer[]>(() =>
    questions.map(() => ({ optionIndices: [], other: '' })),
  )
  const [cursor, setCursor] = useState(0)
  const [otherActive, setOtherActive] = useState(false)
  const otherInputRef = useRef<HTMLInputElement>(null)

  const q = questions[qi]
  const optionCount = q ? q.options.length : 0
  const otherIndex = optionCount // the "Other…" row sits after the options
  const rowCount = optionCount + 1
  const draft = answers[qi] ?? { optionIndices: [], other: '' }
  const otherText = draft.other
  const canAdvance =
    draft.optionIndices.length > 0 || otherText.trim().length > 0
  const isLast = qi >= questions.length - 1

  // Reset per-question transient UI when the step changes (committed answers in
  // `answers` persist — the flow only advances forward, like the prototype).
  useEffect(() => {
    setCursor(0)
    setOtherActive(false)
  }, [qi])

  useEffect(() => {
    if (otherActive) otherInputRef.current?.focus()
  }, [otherActive])

  function setDraft(next: DraftAnswer) {
    setAnswers(prev => prev.map((value, i) => (i === qi ? next : value)))
  }

  function toggleOption(index: number) {
    if (!q) return
    if (q.multiSelect) {
      const has = draft.optionIndices.includes(index)
      setDraft({
        optionIndices: has
          ? draft.optionIndices.filter(i => i !== index)
          : [...draft.optionIndices, index],
        other: draft.other,
      })
    } else {
      // Single-select: one option supersedes any freeform text.
      setDraft({ optionIndices: [index], other: '' })
      setOtherActive(false)
    }
  }

  function setOtherText(value: string) {
    // Single-select: typing a freeform answer clears the option pick; multi keeps it.
    setDraft({
      optionIndices: q?.multiSelect ? draft.optionIndices : [],
      other: value,
    })
  }

  function advance() {
    if (!canAdvance) return
    if (!isLast) {
      setQi(qi + 1)
      return
    }
    // Build the wire payload: option INDICES + trimmed freeform per question. The
    // sidecar re-attaches the engine's own labels and joins them (outputSchema).
    onAnswer(buildAskAnswerPayload(answers))
  }

  useEffect(() => {
    // A split workspace mounts one flow PER visible pane, so an ungated window
    // listener would let a single Escape deny every pending request at once.
    // Keyboard belongs to the active pane only, matching App's own permission
    // keydown, which acts solely on the activeSessionId's request.
    if (!isActivePane) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.repeat || event.metaKey || event.altKey) return
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
          setDraft(abandonOtherText(draft))
          return
        }
        if (key === 'Enter') {
          event.preventDefault()
          advance()
        }
        return // let the input handle the rest
      }

      // Never hijack keys typed into an unrelated field (e.g. the composer).
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return

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
        setCursor(c => (c + 1) % rowCount)
        return
      }
      if (key === 'ArrowUp' || key === 'k' || (event.ctrlKey && key === 'p')) {
        event.preventDefault()
        setCursor(c => (c - 1 + rowCount) % rowCount)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  if (!q) return null
  const focusedPreview =
    cursor < optionCount ? q.options[cursor]?.preview ?? null : null
  const titleId = `ask-question-${requestId}`

  return (
    <section
      aria-labelledby={titleId}
      className="border-l-2 border-accent bg-text-primary/[0.04] px-4 py-3"
      role="group"
    >
      {/* Header chip + multi-select badge + multi-question stepper */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-accent">
          {q.header || 'Question'}
        </span>
        {q.multiSelect ? (
          <span className="rounded bg-text-primary/5 px-1.5 py-0.5 text-[9px] font-semibold text-text-muted">
            multi-select
          </span>
        ) : null}
        {questions.length > 1 ? (
          <span className="ml-auto flex items-center gap-1">
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
            <span className="ml-1 font-mono text-[10px] text-text-faint">
              {qi + 1}/{questions.length}
            </span>
          </span>
        ) : null}
      </div>

      <h2
        className="mt-2 text-sm font-semibold leading-snug text-text-primary"
        id={titleId}
      >
        {q.question}
      </h2>

      {/* Options — label + description, radio/checkbox marker, preview badge */}
      <div className="mt-2 flex flex-col gap-1">
        {q.options.map((option, i) => {
          const active = cursor === i && !otherActive
          const checked = draft.optionIndices.includes(i)
          return (
            <button
              className={`flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                active
                  ? 'border border-accent/45 bg-accent/10'
                  : checked
                    ? 'border border-accent/25 bg-accent/5'
                    : 'border border-transparent'
              }`}
              disabled={submitted}
              key={i}
              onClick={() => toggleOption(i)}
              onMouseEnter={() => {
                setCursor(i)
                setOtherActive(false)
              }}
              type="button"
            >
              <span
                className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center font-mono text-[9px] font-semibold ${
                  q.multiSelect ? 'rounded' : 'rounded-full'
                } ${
                  checked
                    ? 'bg-accent text-app-bg'
                    : active
                      ? 'bg-accent/50 text-app-bg'
                      : 'bg-text-primary/[0.06] text-text-subtle'
                }`}
              >
                {checked ? '✓' : i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium leading-snug text-text-primary">
                  {option.label}
                </span>
                {option.description ? (
                  <span className="mt-0.5 block text-[11px] leading-snug text-text-subtle">
                    {option.description}
                  </span>
                ) : null}
              </span>
              {option.preview ? (
                <span className="mt-0.5 shrink-0 rounded bg-tone-info/10 px-1.5 text-[9px] font-semibold text-tone-info">
                  preview
                </span>
              ) : null}
            </button>
          )
        })}

        {/* Built-in "Other…" freeform row — always appended by this UI */}
        <div
          className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 ${
            cursor === otherIndex
              ? 'border border-accent/45 bg-accent/10'
              : 'border border-transparent'
          }`}
          onMouseEnter={() => setCursor(otherIndex)}
        >
          <span
            className={`flex h-4 w-4 shrink-0 items-center justify-center font-mono text-[9px] font-semibold ${
              q.multiSelect ? 'rounded' : 'rounded-full'
            } ${
              cursor === otherIndex
                ? 'bg-accent/50 text-app-bg'
                : 'bg-text-primary/[0.06] text-text-subtle'
            }`}
          >
            {/* The row number IS the shortcut, so it may only claim a key that
             * exists: past 8 options the marker shows the letter key instead of
             * an unreachable two-digit number. */}
            {otherIndex < 9 ? otherIndex + 1 : 'o'}
          </span>
          {otherActive ? (
            <input
              aria-label="Other answer"
              className="min-w-0 flex-1 bg-transparent text-xs text-text-primary outline-none placeholder:text-text-subtle"
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
              className="flex-1 bg-transparent text-left text-xs text-text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              disabled={submitted}
              onClick={() => setOtherActive(true)}
              type="button"
            >
              {otherText.trim() ? otherText : 'Other…'}
            </button>
          )}
        </div>
      </div>

      {/* Preview pane — appears when the focused option carries one */}
      {focusedPreview ? (
        <div className="mt-2 rounded-lg border border-tone-info/20 bg-black/30 px-3 py-2">
          <div className="mb-1 text-[9px] font-bold uppercase tracking-wider text-tone-info">
            Preview
          </div>
          <pre className="m-0 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-text-muted">
            {focusedPreview}
          </pre>
        </div>
      ) : null}

      {/* Footer rail — advance/submit + key hints + cancel */}
      <div className="mt-3 flex items-center gap-3 border-t border-shell-seam pt-2.5">
        <button
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1 text-xs font-semibold text-app-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:bg-text-primary/[0.06] disabled:text-text-faint"
          disabled={!canAdvance || submitted}
          onClick={advance}
          type="button"
        >
          {isLast ? 'Submit' : 'Next question'}
          <span className="rounded border border-app-bg/35 px-1 font-mono text-[9px] leading-none">
            ↵
          </span>
        </button>
        <span className="font-mono text-[10px] text-text-faint">
          {q.multiSelect
            ? '1–9 / space toggle · ↑↓ move'
            : '1–9 pick · ↑↓ move'}
        </span>
        <button
          className="ml-auto inline-flex items-center gap-1.5 bg-transparent text-[11px] text-text-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
          disabled={submitted}
          onClick={onCancel}
          type="button"
        >
          Cancel
          <span className="rounded border border-text-ghost px-1 font-mono text-[9px] leading-none text-text-faint">
            esc
          </span>
        </button>
      </div>
    </section>
  )
}
