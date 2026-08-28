/**
 * Toggle the account switcher, requesting a fresh global pool only as it opens.
 *
 * Keeping the request outside a React state updater avoids StrictMode's
 * development-only updater double invocation.
 */
export function toggleAccountChip(
  open: boolean,
  onOpen?: () => void,
): boolean {
  if (!open) onOpen?.()
  return !open
}
