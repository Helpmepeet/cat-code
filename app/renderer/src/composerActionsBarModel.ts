export function focusFirstComposerFace(container: HTMLElement | null): boolean {
  if (!container) return false
  const faces = container.querySelectorAll<HTMLElement>('[data-composer-face]')
  for (const face of faces) {
    if (
      face.hasAttribute('disabled') ||
      face.getAttribute('aria-disabled') === 'true'
    ) {
      continue
    }
    face.focus()
    return document.activeElement === face
  }
  return false
}
