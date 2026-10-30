import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PendingQuestion, QuestionReplyBatch, QuestionDismiss } from '../../shared/nonblockingQuestions.js'
import { MAX_NONBLOCKING_QUESTION_TEXT_CHARS } from '../../shared/nonblockingQuestions.js'
import { OptionPreviews, QuestionGlyph } from './AskQuestionFlow.js'
import { buildAskAnswerPayload, hasAskAnswer, type DraftAnswer } from './askQuestionFlowModel.js'
import { useModalOverlayOpen } from './overlayFocus.js'
import { restoreQuestionDraft, retainQuestionDraft, type DockDraft } from './pendingQuestionDrafts.js'
import './pendingQuestionDock.css'

const keyOf = (q: { toolUseId: string; questionIndex: number }) => JSON.stringify([q.toolUseId, q.questionIndex])
const empty = (): DraftAnswer => ({ optionIndices: [], other: '' })
export function PendingQuestionDock({ sessionId, draftScopeId, questions, isActivePane, suspended = false, onReply, onDismiss, onClosed }: {
  sessionId: string
  draftScopeId?: string
  questions: PendingQuestion[]
  isActivePane: boolean
  /** Permissions stay blocking below this card, without flushing its drafts. */
  suspended?: boolean
  onReply: (batch: QuestionReplyBatch) => Promise<void>
  onDismiss: (request: QuestionDismiss) => Promise<void>
  onClosed?: () => void
}) {
  const scope = draftScopeId ? `${sessionId}:${draftScopeId}` : sessionId
  const [state, setState] = useState<DockDraft>(() => restoreQuestionDraft(scope))
  const stateRef = useRef(state)
  stateRef.current = state
  const questionsRef = useRef(questions)
  questionsRef.current = questions
  const card = useRef<HTMLElement>(null)
  const pendingRow = useRef<HTMLButtonElement>(null)
  const seenRows = useRef(new Set<string>())
  const previousCount = useRef(0)
  const outgoing = useRef<HTMLElement | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lockUntil = useRef(0)
  const reactivationUntil = useRef(0)
  const openedHere = useRef(false)
  const closing = useRef<QuestionReplyBatch | null>(null)
  const [sending, setSending] = useState(false)
  const dismissed = useRef(new Set<string>(state.dismissIntents ?? []))
  const dismissing = useRef(false)
  const composing = useRef(false)
  const windowActive = useRef(true)
  const wheel = useRef({ sum: 0, until: 0 })
  const [cursor, setCursor] = useState(-1)
  const [otherActive, setOtherActive] = useState(false)
  const [noteIndex, setNoteIndex] = useState<number | null>(null)
  const [previewHover, setPreviewHover] = useState<number | null>(null)
  const [slide, setSlide] = useState<'next' | 'prev' | null>(null)
  const modalOpen = useModalOverlayOpen()
  const enabled = isActivePane && !suspended && !modalOpen
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const current = questions.find(q => keyOf(q) === state.current) ?? questions[0]
  const currentKey = current ? keyOf(current) : ''
  const draft = state.answers[currentKey] ?? empty()
  const at = questions.findIndex(q => keyOf(q) === currentKey)
  const editable = enabled && !sending && !dismissing.current

  function commit(next: DockDraft) {
    stateRef.current = next
    retainQuestionDraft(scope, next)
    setState(next)
  }
  function cancelAdvance() { if (timer.current !== null) clearTimeout(timer.current); timer.current = null }
  function update(answer: DraftAnswer) {
    if (!editable || performance.now() < lockUntil.current) return
    dismissed.current.delete(currentKey)
    commit({ ...stateRef.current, answers: { ...stateRef.current.answers, [currentKey]: answer }, dismissIntents: [...dismissed.current] })
  }
  function close() {
    if (!windowActive.current || !enabledRef.current || !stateRef.current.open) return
    cancelAdvance()
    const latest = stateRef.current
    if (closing.current) {
      commit({ ...latest, open: false, current: null })
      openedHere.current = false
      composing.current = false
      onClosed?.()
      return
    }
    const replies = questionsRef.current.flatMap(q => {
      if (dismissed.current.has(keyOf(q))) return []
      const answer = latest.answers[keyOf(q)]
      return hasAskAnswer(answer) ? [{ toolUseId: q.toolUseId, questionIndex: q.questionIndex, answer: buildAskAnswerPayload([answer!])[0]! }] : []
    })
    commit({ ...latest, open: false, current: null })
    openedHere.current = false
    composing.current = false
    setOtherActive(false)
    setNoteIndex(null)
    setPreviewHover(null)
    if (replies.length) {
      const batch = { requestId: crypto.randomUUID(), replies }
      closing.current = batch
      setSending(true)
      void Promise.resolve().then(() => onReply(batch)).then(() => { closing.current = null; setSending(false) }, error => {
        console.error('Question reply failed', { requestId: batch.requestId, questions: batch.replies.map(({ toolUseId, questionIndex }) => ({ toolUseId, questionIndex })), error })
        closing.current = null
        setSending(false)
      })
    }
    onClosed?.()
  }
  function open() {
    if (!enabled || questions.length === 0) return
    openedHere.current = true
    commit({ ...stateRef.current, open: true, current: keyOf(questions[0]!) })
    setCursor(-1)
    setOtherActive(false)
    setNoteIndex(null)
    setPreviewHover(null)
    composing.current = false
  }
  function go(delta: number, auto = false) {
    cancelAdvance()
    const all = questionsRef.current
    if (!all.length) return
    const position = Math.max(0, all.findIndex(q => keyOf(q) === stateRef.current.current))
    let next = (position + delta + all.length) % all.length
    if (auto) {
      const unanswered = Array.from({ length: all.length }, (_, offset) => (position + 1 + offset) % all.length).find(index => !hasAskAnswer(stateRef.current.answers[keyOf(all[index]!)]))
      if (unanswered === undefined) { close(); return }
      next = unanswered
      lockUntil.current = performance.now() + 350
    }
    if (!auto && all.length < 2) return
    const q = all[next]!
    const oldBody = card.current?.querySelector<HTMLElement>('.nq-body:not(.nq-out)')
    outgoing.current?.remove()
    if (oldBody) {
      const clone = oldBody.cloneNode(true) as HTMLElement
      clone.inert = true
      clone.setAttribute('aria-hidden', 'true')
      clone.classList.remove('nq-in-next', 'nq-in-prev')
      clone.classList.add('nq-out', delta > 0 ? 'nq-out-next' : 'nq-out-prev')
      clone.scrollTop = oldBody.scrollTop
      outgoing.current = clone
    }
    commit({ ...stateRef.current, current: keyOf(q) })
    setCursor(auto ? -1 : stateRef.current.answers[keyOf(q)]?.optionIndices[0] ?? 0)
    setOtherActive(false)
    setNoteIndex(null)
    setPreviewHover(null)
    composing.current = false
    setSlide(delta > 0 ? 'next' : 'prev')
    openedHere.current = true
  }
  function settle() {
    if (!editable || performance.now() < lockUntil.current) return
    cancelAdvance()
    if (!hasAskAnswer(stateRef.current.answers[currentKey])) return
    if (dismissed.current.has(currentKey)) update(stateRef.current.answers[currentKey]!)
    timer.current = setTimeout(() => { timer.current = null; if (stateRef.current.open && enabled) go(1, true) }, 140)
  }
  function choose(index: number) {
    if (!current || !editable || performance.now() < lockUntil.current) return
    const old = stateRef.current.answers[currentKey] ?? empty()
    const picked = old.optionIndices.includes(index)
    update({ ...old, optionIndices: current.multiSelect ? picked ? old.optionIndices.filter(i => i !== index) : [...old.optionIndices, index] : picked ? [] : [index], ...(!current.multiSelect ? { other: '' } : {}) })
    setCursor(index)
    setPreviewHover(null)
    setOtherActive(false)
    setNoteIndex(null)
    if (!current.multiSelect && !picked) settle()
    else cancelAdvance()
  }
  function note(index: number) {
    if (!editable || performance.now() < lockUntil.current) return
    cancelAdvance()
    const old = stateRef.current.answers[currentKey] ?? empty()
    update({ ...old, optionIndices: current!.multiSelect ? [...new Set([...old.optionIndices, index])] : [index], notes: { ...old.notes, [index]: old.notes?.[index] ?? '' }, ...(!current!.multiSelect ? { other: '' } : {}) })
    setCursor(index)
    setNoteIndex(index)
    setPreviewHover(null)
    setOtherActive(false)
  }
  function dismiss() {
    if (!editable || !current || performance.now() < lockUntil.current) return
    cancelAdvance()
    const target = current
    dismissing.current = true
    dismissed.current.add(keyOf(target))
    commit({ ...stateRef.current, dismissIntents: [...dismissed.current] })
    const order = questionsRef.current
    const position = order.findIndex(q => keyOf(q) === keyOf(target))
    void Promise.resolve().then(() => onDismiss({ requestId: crypto.randomUUID(), toolUseId: target.toolUseId, questionIndex: target.questionIndex })).then(() => {
      dismissing.current = false
      dismissed.current.add(keyOf(target))
      const all = questionsRef.current.filter(q => keyOf(q) !== keyOf(target))
      const remaining = new Set(all.map(keyOf))
      const next = [...order.slice(position + 1), ...order.slice(0, position), ...all].find(q =>
        remaining.has(keyOf(q)) && !hasAskAnswer(stateRef.current.answers[keyOf(q)]))
      if (!next) { close(); return }
      commit({ ...stateRef.current, current: keyOf(next) })
      setCursor(-1)
      setOtherActive(false)
      setNoteIndex(null)
      setPreviewHover(null)
      lockUntil.current = performance.now() + 350
    }, error => {
      dismissing.current = false
      setState({ ...stateRef.current })
      console.error('Question dismissal failed', { toolUseId: target.toolUseId, questionIndex: target.questionIndex, error })
    })
  }

  useEffect(() => () => cancelAdvance(), [])
  useEffect(() => {
    if (!enabled) { cancelAdvance(); openedHere.current = false }
    else if (stateRef.current.open && !openedHere.current) {
      lockUntil.current = performance.now() + 350
      reactivationUntil.current = lockUntil.current
      setCursor(-1)
    }
  }, [enabled])
  useEffect(() => {
    if (!questions.length && stateRef.current.open) {
      cancelAdvance()
      commit({ ...stateRef.current, open: false, current: null })
      openedHere.current = false
    }
  }, [questions.length])
  useEffect(() => {
    if (state.open && questions.length && state.current && !questions.some(q => keyOf(q) === state.current)) {
      cancelAdvance()
      commit({ ...stateRef.current, current: keyOf(questions[0]!) })
      setCursor(-1)
      setOtherActive(false)
      setNoteIndex(null)
      setPreviewHover(null)
      lockUntil.current = performance.now() + 350
    }
  }, [currentKey])
  useLayoutEffect(() => {
    const clone = outgoing.current
    if (!clone || !state.open || !card.current) { clone?.remove(); return }
    card.current.appendChild(clone)
    const remove = () => { clone.remove(); if (outgoing.current === clone) outgoing.current = null }
    clone.addEventListener('animationend', remove, { once: true })
    const timeout = setTimeout(remove, 230)
    return () => { clearTimeout(timeout); remove() }
  }, [currentKey, state.open])
  useLayoutEffect(() => {
    const row = pendingRow.current
    if (row && questions[0]) {
      const key = keyOf(questions[0])
      if (!seenRows.current.has(key)) { row.classList.add('animate-toast-in'); seenRows.current.add(key) }
      if (questions.length > previousCount.current) row.querySelector('.nq-count')?.classList.add('nq-count-tick')
    }
    previousCount.current = questions.length
  }, [questions.length, state.open, currentKey])
  useEffect(() => {
    if (!state.open || !enabled || !openedHere.current) return
    if (current?.options.length === 0 || otherActive || noteIndex !== null) input.current?.focus({ preventScroll: true })
    else card.current?.focus({ preventScroll: true })
  }, [state.open, currentKey, otherActive, noteIndex, enabled])
  useEffect(() => {
    if (!enabled || !state.open) return
    const outside = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element) || card.current?.contains(target)) return
      // Navigation is not a card-close gesture. Preserve the owner's draft.
      if (target.closest('[data-pending-question-owner]')?.getAttribute('data-pending-question-owner') !== sessionId || target.closest('[role="tab"], [data-session-tab], [data-pane-switch]')) return
      close()
    }
    const focus = (event: FocusEvent) => {
      const target = event.target
      if (windowActive.current && performance.now() >= reactivationUntil.current && target instanceof Element && target.closest('[data-pending-question-owner]')?.getAttribute('data-pending-question-owner') === sessionId && target.closest('textarea, [contenteditable="true"]') && !card.current?.contains(target)) close()
    }
    window.addEventListener('pointerdown', outside)
    window.addEventListener('focusin', focus)
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('focusin', focus) }
  }, [enabled, state.open, currentKey, sessionId])
  useEffect(() => {
    const blur = () => { windowActive.current = false; cancelAdvance(); openedHere.current = false; composing.current = false }
    const focus = () => {
      windowActive.current = true
      if (stateRef.current.open && !openedHere.current) {
        lockUntil.current = performance.now() + 350
        reactivationUntil.current = lockUntil.current
        setCursor(-1)
      }
    }
    window.addEventListener('blur', blur)
    window.addEventListener('focus', focus)
    return () => { window.removeEventListener('blur', blur); window.removeEventListener('focus', focus) }
  }, [])
  useEffect(() => {
    const element = card.current
    if (!state.open || !element) return
    const swipe = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return
      event.preventDefault()
      const now = performance.now()
      if (!windowActive.current || !enabledRef.current || closing.current || dismissing.current || now < lockUntil.current) return
      if (now < wheel.current.until) { wheel.current.until = Math.max(wheel.current.until, now + 150); return }
      wheel.current.sum += event.deltaX
      if (Math.abs(wheel.current.sum) >= 40) {
        go(wheel.current.sum > 0 ? 1 : -1)
        wheel.current = { sum: 0, until: now + 450 }
      }
    }
    // React installs passive wheel handlers. This gesture must suppress native
    // horizontal navigation without preventing the body's vertical scrolling.
    element.addEventListener('wheel', swipe, { passive: false })
    return () => element.removeEventListener('wheel', swipe)
  }, [state.open, currentKey])
  useEffect(() => {
    if (!enabled || questions.length === 0) return
    const keydown = (event: KeyboardEvent) => {
      if (!windowActive.current) return
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'j') {
        event.preventDefault(); event.stopImmediatePropagation()
        if (stateRef.current.open) close(); else open()
        return
      }
      if (!stateRef.current.open || event.defaultPrevented || event.repeat || event.isComposing || composing.current || event.metaKey || event.altKey) return
      if (event.ctrlKey && event.key !== 'n' && event.key !== 'p') return
      const target = event.target instanceof Element ? event.target : null
      if (target && !card.current?.contains(target) && target.closest('input, textarea, select, button, [contenteditable="true"]')) return
      if (event.key === 'Escape') { event.preventDefault(); close(); return }
      if (performance.now() < lockUntil.current || !editable) return
      const control = target?.closest('button')
      if (control && (event.key === 'Enter' || event.key === ' ') &&
        !(event.key === 'Enter' && control.matches('[role="radio"], [role="checkbox"]'))) return
      if (target?.closest('input, textarea')) {
        if (event.key === 'Enter') { event.preventDefault(); if (noteIndex !== null && current?.multiSelect) { setNoteIndex(null); card.current?.focus() } else settle() }
        return
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); go(event.key === 'ArrowLeft' ? -1 : 1); return }
      if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); dismiss(); return }
      if (!current || !current.options.length) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'j' || event.key === 'k' || event.ctrlKey && (event.key === 'n' || event.key === 'p')) {
        event.preventDefault()
        setPreviewHover(null)
        const delta = event.key === 'ArrowUp' || event.key === 'k' || event.ctrlKey && event.key === 'p' ? -1 : 1
        const rows = current.options.length + (current.multiSelect ? 2 : 1)
        setCursor(index => index < 0 ? delta > 0 ? 0 : rows - 1 : (index + delta + rows) % rows)
      } else if (/^[1-9]$/.test(event.key)) {
        const index = Number(event.key) - 1
        if (index < current.options.length) { event.preventDefault(); choose(index) }
        else if (index === current.options.length) { event.preventDefault(); setOtherActive(true); setNoteIndex(null); setCursor(index) }
      } else if (event.key === 'o' || event.key === 'O') { event.preventDefault(); setOtherActive(true); setNoteIndex(null); setCursor(current.options.length) }
      else if (event.key === 'n' && cursor >= 0 && cursor < current.options.length) { event.preventDefault(); note(cursor) }
      else if (event.key === ' ' && current.multiSelect && cursor >= 0 && cursor < current.options.length) { event.preventDefault(); choose(cursor) }
      else if (event.key === 'Enter' && cursor >= 0) {
        event.preventDefault()
        if (cursor === current.options.length) { setOtherActive(true); setNoteIndex(null) }
        else if (current.multiSelect || draft.optionIndices.includes(cursor)) settle()
        else choose(cursor)
      }
    }
    window.addEventListener('keydown', keydown, true)
    return () => window.removeEventListener('keydown', keydown, true)
  }, [enabled, state.open, questions, currentKey, cursor, draft, noteIndex, editable])

  if (!questions.length || !current) return null
  if (!state.open) return <button ref={pendingRow} type="button" className="nq-pending" title="Open question  ⌘J" onClick={open}>
    <span className="nq-glyph"><QuestionGlyph /></span><span className="nq-pending-text">{questions[0]!.question}</span>
    {questions.length > 1 ? <span className="nq-count"><b>{questions.length}</b> pending</span> : null}
  </button>
  const options = current.options.map(option => ({ ...option, preview: option.preview ?? null }))
  const hasPreviews = !current.multiSelect && options.some(option => option.preview !== null)
  const shownPreview = previewHover ?? (cursor >= 0 ? cursor : draft.optionIndices[0] ?? -1)
  const selected = draft.optionIndices.length + (draft.other.trim() ? 1 : 0)
  return <section ref={card} tabIndex={-1} role="group" aria-label="Pending questions" className={`nq-card${questions.length > 1 ? ' nq-many' : ''}`} onMouseLeave={() => setPreviewHover(null)}>
    <div className="nq-nav"><button type="button" className="nq-nav-button" aria-label="Dismiss question" title="Dismiss" onClick={dismiss}>×</button>{questions.length > 1 ? <span className="nq-position">{at + 1}/{questions.length}</span> : null}</div>
    <div key={currentKey} className={`nq-body${slide ? ` nq-in-${slide}` : ''}`} onAnimationEnd={() => setSlide(null)}>
      <button type="button" className="nq-head" title="Close  esc" onClick={close}><span className="nq-glyph"><QuestionGlyph /></span><h2 className="nq-title">{current.question}</h2></button>
      {current.multiSelect && current.options.length ? <p className="nq-hint">{selected ? `${selected} selected` : 'Pick as many as you like'}</p> : null}
      <div className={hasPreviews ? 'ask-question-split' : undefined}>
      {!current.options.length ? <input ref={input} aria-label="Your answer" className="nq-input nq-free" value={draft.other} maxLength={MAX_NONBLOCKING_QUESTION_TEXT_CHARS} onChange={event => update({ ...draft, other: event.target.value })} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} /> : <div className="nq-options" role={current.multiSelect ? 'group' : 'radiogroup'}>
        {current.options.map((option, index) => {
          const checked = draft.optionIndices.includes(index) && !(otherActive && !current.multiSelect && !draft.other.trim())
          const noted = checked && (noteIndex === index || draft.notes?.[index] !== undefined)
          return <div className={`nq-wrap${noted ? ' nq-noted' : ''}`} key={index} onMouseEnter={() => setPreviewHover(index)}>
            <button type="button" className={`nq-row${checked ? ' nq-checked' : ''}${cursor === index ? ' nq-active' : ''}`} role={current.multiSelect ? 'checkbox' : 'radio'} aria-checked={checked} onFocus={() => setCursor(index)} onClick={() => choose(index)}>
              <span className={`nq-mark${current.multiSelect ? ' nq-box' : ''}`}>{checked ? '✓' : ''}</span><span className="nq-text"><span className="nq-label">{option.label}</span><span className="nq-description">{option.description}</span></span>
              {!noted ? <span className="nq-note-space" /> : null}<span className="nq-key">{index + 1}</span>
            </button>
            {!noted ? <button type="button" className="nq-note-button" onClick={() => note(index)} aria-label={`Add a note to ${option.label}`}>note</button> : <div className="nq-note-field"><input ref={noteIndex === index ? input : undefined} className="nq-input" aria-label={`Note for ${option.label}`} value={draft.notes?.[index] ?? ''} maxLength={MAX_NONBLOCKING_QUESTION_TEXT_CHARS} onFocus={() => { setNoteIndex(index); setCursor(index); setOtherActive(false); setPreviewHover(null) }} onChange={event => update({ ...draft, notes: { ...draft.notes, [index]: event.target.value } })} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} /></div>}
          </div>
        })}
        <div onMouseEnter={() => setPreviewHover(current.options.length)} className={`nq-row nq-other${draft.other.trim() || otherActive && !current.multiSelect ? ' nq-checked' : ''}${cursor === current.options.length ? ' nq-active' : ''}`}>
          <span className={`nq-mark${current.multiSelect ? ' nq-box' : ''}`}>{draft.other.trim() || otherActive && !current.multiSelect ? '✓' : ''}</span>
          {otherActive ? <input ref={input} className="nq-input nq-other-input" aria-label="Other answer" placeholder="Type your own answer…" value={draft.other} maxLength={MAX_NONBLOCKING_QUESTION_TEXT_CHARS} onChange={event => update({ ...draft, other: event.target.value, ...(!current.multiSelect ? { optionIndices: [] } : {}) })} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} /> : <button type="button" className="nq-other-label" onClick={() => { if (editable && performance.now() >= lockUntil.current) { setOtherActive(true); setNoteIndex(null); setCursor(current.options.length) } }}>{draft.other.trim() || 'Other…'}</button>}
          <span className="nq-key">{current.options.length + 1}</span>
        </div>
        {current.multiSelect ? <button type="button" className={`nq-row nq-other${cursor === current.options.length + 1 ? ' nq-active' : ''}`} disabled={!hasAskAnswer(draft)} onClick={settle}><span className="nq-done-mark" /><span className="nq-other-label">Done</span><span className="nq-key">↵</span></button> : null}
      </div>}
      {hasPreviews ? <div className="ask-question-preview-panel"><OptionPreviews options={options} shownIndex={shownPreview} /></div> : null}
      </div>
    </div>
    {questions.length > 1 ? <div className="nq-pager"><button type="button" className="nq-nav-button" aria-label="Previous question" onClick={() => { if (editable && performance.now() >= lockUntil.current) go(-1) }}>‹</button><button type="button" className="nq-nav-button" aria-label="Next question" onClick={() => { if (editable && performance.now() >= lockUntil.current) go(1) }}>›</button></div> : null}
  </section>
}
