const SLOT = 10
const POINTER_RADIUS = 24

function lensSide(span: number, pitch: number) {
  const stretch = SLOT / pitch
  // Spend space on the three neighbors nearest the cursor. Distribute the
  // compression over the rest so the marks don't pile up at the endpoints.
  const near = Math.min(3 * pitch, span / (2 * stretch))
  const farScale = span > 0 ? (span - near * stretch) / (span - near) : 1
  return (distance: number) => distance <= near
    ? distance * stretch
    : span - (span - distance) * farScale
}

/** Lay out the real button hit boxes in one batch, without a React render. */
export function mountTranscriptOutlineLens(rail: HTMLElement, onLayout: () => void) {
  const ticks = Array.from(rail.children) as HTMLButtonElement[]
  rail.style.setProperty('--outline-ideal-height', `${ticks.length * SLOT}px`)
  let pitch = 0
  let pivot: number | null = null
  let focusedIndex: number | null = null
  let pointerY: number | null = null
  let frame = 0

  const paint = (release = false) => {
    const first = pitch / 2
    const last = pitch * ticks.length - first
    const center = focusedIndex === null ? pivot : (focusedIndex + .5) * pitch
    const magnified = center !== null && pitch > 0 && pitch < SLOT
    const above = magnified ? lensSide(center - first, pitch) : null
    const below = magnified ? lensSide(last - center, pitch) : null
    const position = (index: number) => {
      const rest = (index + .5) * pitch
      if (center === null || !above || !below || index === 0 || index === ticks.length - 1) return rest
      return rest < center ? center - above(center - rest) : center + below(rest - center)
    }

    rail.toggleAttribute('data-releasing', release)
    let start = 0
    let mark = first
    for (let i = 0; i < ticks.length; i++) {
      const next = position(i + 1)
      const end = i === ticks.length - 1 ? pitch * ticks.length : (mark + next) / 2
      const { style } = ticks[i]!
      style.setProperty('--outline-tick-top', `${start}px`)
      style.setProperty('--outline-tick-height', `${end - start}px`)
      style.setProperty('--outline-mark-y', `${mark - start}px`)
      start = end
      mark = next
    }
    if (!release) onLayout()
  }

  const move = (box: DOMRect) => {
    if (pointerY === null || pitch === 0 || pitch === SLOT) return
    const y = Math.max(0, Math.min(pointerY - box.top, box.height))
    const rest = (Math.min(ticks.length - 1, Math.floor(y / pitch)) + .5) * pitch
    // Let the pointer travel across the expanded buttons before moving the
    // lens. Following every pixel would compress each target back to its idle
    // pitch as soon as the pointer tried to reach the adjacent button.
    const next = pivot === null ? rest : Math.max(y - POINTER_RADIUS, Math.min(pivot, y + POINTER_RADIUS))
    const center = Math.max(pitch / 2, Math.min(next, box.height - pitch / 2))
    if (center === pivot && focusedIndex === null) return
    pivot = center
    focusedIndex = null
    paint()
  }

  const resize = () => {
    const box = rail.getBoundingClientRect()
    const next = Math.min(SLOT, box.height / ticks.length)
    if (pitch === next) return
    pitch = next
    pivot = null
    rail.toggleAttribute('data-dense', pitch < 4)
    if (pointerY !== null && pitch > 0 && pitch < SLOT) move(box)
    else paint()
  }
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
  observer?.observe(rail)
  resize()

  return {
    pointerAt(clientY: number) {
      if (pitch === SLOT || (pointerY === clientY && focusedIndex === null)) return
      pointerY = clientY
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        move(rail.getBoundingClientRect())
      })
    },
    focus(index: number) {
      pointerY = pivot = null
      if (focusedIndex === index) return
      focusedIndex = index
      if (pitch < SLOT) paint()
    },
    release() {
      pointerY = null
      if (pivot === null && focusedIndex === null) return
      pivot = focusedIndex = null
      if (pitch < SLOT) paint(true)
    },
    dispose() {
      observer?.disconnect()
      if (frame !== 0) cancelAnimationFrame(frame)
    },
  }
}
