import { observePaneBottomLock, observePaneScroll, reportPaneLayoutChange } from './markdownScrollCoordinator.js'
import { TRANSCRIPT_ROW_KEY_ATTRIBUTE } from './transcriptScrollMemory.js'

export type FocusedTranscriptScrollState = {
  generating: boolean
  userRowId: string | null
  /** Supply only when the answer is reliably identified, not for live narration. */
  answerRowId?: string | null
}

export type FocusedTranscriptScrollOptions = {
  initialFollowing: boolean
  onFollowingChange?: (following: boolean) => void
  reducedMotion?: () => boolean
}

/** Owns only Focused-mode navigation. The pooled coordinator still owns reflow correction. */
export function createFocusedTranscriptScroll(scroller: HTMLElement, options: FocusedTranscriptScrollOptions) {
  const spacer = scroller.ownerDocument.createElement('div')
  spacer.className = 'focused-transcript-space'
  spacer.setAttribute('aria-hidden', 'true')
  scroller.append(spacer)
  let state: FocusedTranscriptScrollState = { generating: false, userRowId: null }
  let initialized = false
  let following = options.initialFollowing
  let disposed = false
  let space = 0
  let frame = 0
  let motion: { start: number; duration: number; from: number; collapse: boolean } | null = null
  let ownScrollTop: number | null = null
  let mayResume = false
  const reducedMotion = options.reducedMotion ?? (() => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  const setFollowing = (next: boolean) => {
    if (following === next) return
    following = next
    options.onFollowingChange?.(next)
  }
  const cancel = () => {
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    motion = null
  }
  const setSpace = (height: number) => {
    height = Math.max(0, height)
    if (space === height) return
    space = height
    spacer.style.setProperty('--focused-transcript-space-height', `${height}px`)
    reportPaneLayoutChange(scroller)
  }
  const row = (id: string | null | undefined) => id == null ? null
    : Array.from(scroller.querySelectorAll<HTMLElement>(`[${TRANSCRIPT_ROW_KEY_ATTRIBUTE}]`))
      .find(element => element.getAttribute(TRANSCRIPT_ROW_KEY_ATTRIBUTE) === id) ?? null
  const offset = (element: HTMLElement) => element.getBoundingClientRect().top
    - scroller.getBoundingClientRect().top - scroller.clientTop + scroller.scrollTop
  const max = () => Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  const write = (top: number) => {
    if (!following || disposed) return
    const next = Math.max(0, Math.min(max(), top))
    if (Math.abs(scroller.scrollTop - next) < 0.5) return
    scroller.scrollTop = next
    ownScrollTop = scroller.scrollTop
    // The coordinator recognizes explicit writes before their scroll event arrives.
    reportPaneLayoutChange(scroller)
  }
  const reserve = () => {
    const user = row(state.userRowId)
    if (!state.generating || !user) return
    const contentEnd = scroller.scrollHeight - space
    setSpace(scroller.clientHeight - (contentEnd - offset(user)))
  }
  const target = () => {
    const user = row(state.userRowId)
    // Answer-first navigation returns to the message that began this turn.
    if (state.answerRowId && row(state.answerRowId) && user) return offset(user)
    return max()
  }
  const tick = (now: number) => {
    frame = 0
    if (disposed || !motion) return
    const progress = Math.min(1, Math.max(0, (now - motion.start) / motion.duration))
    const eased = 1 - Math.pow(1 - progress, 3)
    if (motion.collapse) {
      setSpace(motion.from * (1 - eased))
      if (following) write(target())
    } else {
      reserve()
      write(motion.from + (target() - motion.from) * eased)
    }
    if (progress < 1) frame = requestAnimationFrame(tick)
    else {
      if (motion.collapse) setSpace(0)
      motion = null
    }
  }
  const animate = (collapse: boolean) => {
    cancel()
    if (reducedMotion()) {
      if (collapse) setSpace(0)
      else reserve()
      write(target())
      return
    }
    motion = { start: performance.now(), duration: collapse ? 260 : 420,
      from: collapse ? space : scroller.scrollTop, collapse }
    frame = requestAnimationFrame(tick)
  }
  const release = () => {
    if (disposed) return
    const collapsing = motion?.collapse
    cancel()
    mayResume = false
    setFollowing(false)
    if (collapsing) setSpace(0)
  }
  const resume = () => {
    if (disposed) return
    cancel()
    setFollowing(true)
    reserve()
    write(target())
  }
  const stopObserving = observePaneScroll(scroller, () => {
    if (disposed || motion) return
    reserve()
    if (following) write(target())
  })
  // A false lock subscribes to correction writes without taking anchor ownership.
  // Their browser scroll events are not reader requests to resume following.
  const stopCorrections = observePaneBottomLock(scroller, () => false, top => { ownScrollTop = top })
  const onScroll = () => {
    if (ownScrollTop !== null && Math.abs(scroller.scrollTop - ownScrollTop) < 0.5) {
      ownScrollTop = null
      return
    }
    ownScrollTop = null
    // Browsers also deliver scroll events when a shrinking document clamps the
    // position. Only reader input toward the end may resume following.
    if (!following && mayResume && max() - scroller.scrollTop <= 1) resume()
  }
  const onWheel = (event: WheelEvent) => {
    if (event.deltaY < 0) release()
    else if (event.deltaY > 0) mayResume = true
  }
  const onTouch = () => { release(); mayResume = true }
  const onKey = (event: KeyboardEvent) => {
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) release()
    else if (['ArrowDown', 'PageDown', 'End'].includes(event.key)) mayResume = true
  }
  const onPointer = (event: PointerEvent) => {
    const bounds = scroller.getBoundingClientRect()
    const left = bounds.left + scroller.clientLeft
    const right = left + scroller.clientWidth
    // Overlay scrollbars occupy the content box rather than a layout gutter.
    if (event.target === scroller && (event.clientX >= right - 14 || event.clientX < left)) {
      release()
      mayResume = true
    }
  }
  const onDisclosure = (event: Event) => {
    if (event.target instanceof Element && event.target.closest('.focused-fold-head, .focused-step-head')) release()
  }
  scroller.addEventListener('scroll', onScroll, { passive: true })
  scroller.addEventListener('wheel', onWheel, { passive: true })
  scroller.addEventListener('touchmove', onTouch, { passive: true })
  scroller.addEventListener('keydown', onKey)
  scroller.addEventListener('pointerdown', onPointer)
  scroller.addEventListener('click', onDisclosure, true)
  return {
    update(next: FocusedTranscriptScrollState) {
      if (disposed) return
      const sent = initialized && next.userRowId !== null && next.userRowId !== state.userRowId
      const ended = state.generating && !next.generating
      state = next
      initialized = true
      if (sent) setFollowing(true)
      reserve()
      if (ended) animate(true)
      else if (sent && following) animate(false)
      else if (!motion && following) write(target())
    },
    resume,
    release,
    isFollowing: () => following,
    dispose() {
      if (disposed) return
      disposed = true
      cancel()
      stopObserving()
      stopCorrections()
      scroller.removeEventListener('scroll', onScroll)
      scroller.removeEventListener('wheel', onWheel)
      scroller.removeEventListener('touchmove', onTouch)
      scroller.removeEventListener('keydown', onKey)
      scroller.removeEventListener('pointerdown', onPointer)
      scroller.removeEventListener('click', onDisclosure, true)
      spacer.remove()
    },
  }
}
