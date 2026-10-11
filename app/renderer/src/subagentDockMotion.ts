const EASING = 'cubic-bezier(.2,0,0,1)'
type Rects = Map<string, DOMRect>
export function dockRowRects(panel: HTMLElement): Rects {
  const result: Rects = new Map()
  for (const row of panel.querySelectorAll<HTMLElement>('[data-dock-row]')) {
    if (row.closest('[inert]')) continue
    const id = row.dataset.dockRow
    if (id) result.set(id, row.getBoundingClientRect())
  }
  return result
}
export function animateDockReorder(panel: HTMLElement, previous: Rects) {
  const animations: Animation[] = []
  for (const row of panel.querySelectorAll<HTMLElement>('[data-dock-row]')) {
    if (row.closest('[inert]') || !row.animate) continue
    const before = previous.get(row.dataset.dockRow ?? '')
    if (!before) continue
    const dy = before.top - row.getBoundingClientRect().top
    if (Math.abs(dy) > .5) animations.push(row.animate([
      { transform: `translateY(${dy}px)` }, { transform: 'none' },
    ], { duration: 260, easing: EASING }))
  }
  return () => animations.forEach(animation => animation.cancel())
}
export type DockMorphStart = { box: DOMRect; faces: Map<string, DOMRect> }
export function dockMorphStart(chip: HTMLElement): DockMorphStart {
  const faces = new Map<string, DOMRect>()
  for (const face of chip.querySelectorAll<HTMLElement>('[data-dock-face]')) {
    const id = face.dataset.dockFace
    if (id) faces.set(id, face.getBoundingClientRect())
  }
  return { box: chip.getBoundingClientRect(), faces }
}
/** Moving clones live outside the panel clip, so their names travel with them. */
export function animateDockMorph(root: HTMLElement, panel: HTMLElement, chip: DockMorphStart, opening: boolean, done: () => void) {
  if (!panel.animate) { done(); return () => {} }
  const duration = opening ? 340 : 260
  const animations: Animation[] = []
  const clones: HTMLElement[] = []
  const box = panel.getBoundingClientRect()
  const origin = root.getBoundingClientRect()
  const clip = `inset(${chip.box.top - box.top}px ${box.right - chip.box.right}px ${box.bottom - chip.box.bottom}px ${chip.box.left - box.left}px round 10px)`
  const ordered = (a: Keyframe, b: Keyframe) => opening ? [a, b] : [b, a]
  const frame = document.createElement('div')
  frame.className = `subagent-dock-frame${panel.classList.contains('subagent-dock-floating') ? ' subagent-dock-floating' : ''}`
  frame.setAttribute('aria-hidden', 'true')
  root.appendChild(frame)
  clones.push(frame)
  const frameBox = (rect: DOMRect) => ({ left: `${rect.left - origin.left}px`, top: `${rect.top - origin.top}px`, width: `${rect.width}px`, height: `${rect.height}px` })
  animations.push(frame.animate(ordered(frameBox(chip.box), frameBox(box)), { duration, easing: EASING, fill: 'both' }))
  panel.classList.add('subagent-dock-morphing')
  animations.push(panel.animate(ordered({ clipPath: clip }, { clipPath: 'inset(0 round 10px)' }), { duration, easing: EASING, fill: 'both' }))
  for (const face of panel.querySelectorAll<HTMLElement>('[data-dock-face]')) {
    const row = face.closest<HTMLElement>('[data-dock-row]')
    const inertAncestor = row?.closest('[inert]')
    if (!row || inertAncestor && inertAncestor !== panel) continue
    const faceBox = face.getBoundingClientRect()
    const from = chip.faces.get(face.dataset.dockFace ?? '') ?? chip.box
    const offset = `translate(${from.left - faceBox.left}px, ${from.top - faceBox.top}px)`
    const name = row.querySelector<HTMLElement>('.subagent-dock-name')
    for (const element of [face, name]) {
      if (!element) continue
      const rect = element.getBoundingClientRect()
      const clone = element.cloneNode(true) as HTMLElement
      clone.classList.add('subagent-dock-flyer')
      clone.setAttribute('aria-hidden', 'true')
      clone.removeAttribute('id')
      clone.style.left = `${rect.left - origin.left}px`
      clone.style.top = `${rect.top - origin.top}px`
      clone.style.width = `${rect.width}px`
      root.appendChild(clone)
      clones.push(clone)
      const isName = element === name
      const frames = isName
        ? opening
          ? [{ transform: offset, opacity: 0 }, { opacity: 0, offset: .12 }, { opacity: 1, offset: .5 }, { transform: 'none', opacity: 1 }]
          : [{ transform: 'none', opacity: 1 }, { opacity: 1, offset: .4 }, { opacity: 0, offset: .8 }, { transform: offset, opacity: 0 }]
        : ordered({ transform: offset, opacity: chip.faces.has(face.dataset.dockFace ?? '') ? 1 : 0 }, { transform: 'none', opacity: 1 })
      animations.push(clone.animate(frames, { duration, easing: EASING, fill: 'both' }))
    }
  }
  for (const detail of panel.querySelectorAll<HTMLElement>('.subagent-dock-detail, .subagent-dock-header, .subagent-dock-finished-header')) {
    animations.push(detail.animate(opening
      ? [{ opacity: 0, transform: 'translateX(-10px)' }, { opacity: 1, transform: 'none' }]
      : [{ opacity: 1 }, { opacity: 0 }], { duration: opening ? 200 : 90, delay: opening ? 130 : 0, easing: EASING, fill: 'both' }))
  }
  const cleanup = () => {
    animations.forEach(animation => animation.cancel())
    clones.forEach(clone => clone.remove())
    panel.classList.remove('subagent-dock-morphing')
  }
  const timeout = setTimeout(() => { cleanup(); done() }, duration)
  return () => { clearTimeout(timeout); cleanup() }
}
