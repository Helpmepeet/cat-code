import { observePaneBottomLock, observePaneScroll, reportPaneLayoutChange } from './markdownScrollCoordinator.js'
import { TRANSCRIPT_ROW_KEY_ATTRIBUTE } from './transcriptScrollMemory.js'
import { readTranscriptRowOffset } from './transcriptRowNavigation.js'

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
  let landing = false
  let userOffset: { id: string; top: number } | null = null
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
  const readUserOffset = () => {
    if (!state.userRowId) return null
    const element = row(state.userRowId)
    const top = element ? offset(element) : readTranscriptRowOffset(scroller, state.userRowId)
    if (top !== null) userOffset = { id: state.userRowId, top }
    return userOffset?.id === state.userRowId ? userOffset.top : null
  }
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
    // React can replace Welcome with a new column after this controller mounts.
    // Keep the imperative reservation after that column before measuring it.
    if (scroller.lastElementChild !== spacer) scroller.append(spacer)
    const top = readUserOffset()
    if (!state.generating || top === null) return
    // scrollHeight is at least clientHeight, even for a short first turn.
    const contentEnd = offset(spacer)
    setSpace(scroller.clientHeight - (contentEnd - top))
  }
  const target = () => {
    const top = landing ? readUserOffset() : null
    if (top !== null) return top
    return max()
  }
  const settleLanding = () => {
    // Estimated offsets mount a virtual row; its real position gets one final
    // correction before navigation yields to ordinary reading.
    if (!motion && space === 0 && row(state.userRowId)) landing = false
  }
  const tick = (now: number) => {
    frame = 0
    if (disposed || !motion) return
    const progress = Math.min(1, Math.max(0, (now - motion.start) / motion.duration))
    const eased = motion.collapse ? standardEase(progress) : 1 - Math.pow(1 - progress, 3)
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
      settleLanding()
    }
  }
  const animate = (collapse: boolean) => {
    cancel()
    if (reducedMotion()) {
      if (collapse) setSpace(0)
      else reserve()
      write(target())
      settleLanding()
      return
    }
    motion = { start: performance.now(), duration: collapse ? 320 : 420,
      from: collapse ? space : scroller.scrollTop, collapse }
    frame = requestAnimationFrame(tick)
  }
  const release = () => {
    if (disposed) return
    const collapsing = motion?.collapse
    cancel()
    mayResume = false
    landing = false
    setFollowing(false)
    if (collapsing) setSpace(0)
  }
  const resume = () => {
    if (disposed) return
    cancel()
    landing = false
    setFollowing(true)
    if (state.generating) reserve()
    else setSpace(0)
    write(target())
  }
  const stopObserving = observePaneScroll(scroller, () => {
    if (disposed || motion || (!state.generating && !landing)) return
    reserve()
    if (following) write(target())
    settleLanding()
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
    if (event.deltaY < 0 || (!state.generating && event.deltaY > 0)) release()
    if (event.deltaY > 0) mayResume = true
  }
  const onTouch = () => { release(); mayResume = true }
  const onKey = (event: KeyboardEvent) => {
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) ||
      (!state.generating && ['ArrowDown', 'PageDown', 'End'].includes(event.key))) release()
    if (['ArrowDown', 'PageDown', 'End'].includes(event.key)) mayResume = true
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
      const answered = !next.generating && next.answerRowId != null && next.answerRowId !== state.answerRowId
      state = next
      initialized = true
      if (sent) { landing = false; setFollowing(true) }
      if ((ended || answered) && following && next.answerRowId) landing = true
      reserve()
      if (ended) animate(true)
      else if (sent && following) animate(false)
      else if (!motion && following && (state.generating || landing)) {
        write(target())
        settleLanding()
      }
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

/** Match the stylesheet's --ease-standard for reserved-height removal. */
function standardEase(progress: number): number {
  if (progress <= 0 || progress >= 1) return progress
  let low = 0, high = 1
  for (let iteration = 0; iteration < 12; iteration++) {
    const t = (low + high) / 2
    const x = 3 * (1 - t) ** 2 * t * 0.4 + 3 * (1 - t) * t ** 2 * 0.2 + t ** 3
    if (x < progress) low = t
    else high = t
  }
  const t = (low + high) / 2
  return 3 * (1 - t) * t ** 2 + t ** 3
}
