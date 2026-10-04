/** Subscribe to source changes but notify only when the display projection changes. */
export function subscribeToProjection<T>(
  subscribe: (listener: () => void) => () => void,
  getProjection: () => T,
  listener: () => void,
): () => void {
  let previous = getProjection()
  return subscribe(() => {
    const next = getProjection()
    if (sameProjection(previous, next)) return
    previous = next
    listener()
  })
}

function sameProjection(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false
    if (!sameProjection((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false
    }
  }
  return true
}
