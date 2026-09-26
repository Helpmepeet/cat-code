/** Explicit host-owned association for a desktop session. */
export type SessionBinding =
  | { kind: 'project' }
  | { kind: 'managed'; storageRootId: string; storageId: string }

export function isSessionBinding(value: unknown): value is SessionBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  if (candidate.kind === 'project') return Object.keys(candidate).length === 1
  return (
    candidate.kind === 'managed' &&
    typeof candidate.storageRootId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.storageRootId) &&
    typeof candidate.storageId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.storageId) &&
    Object.keys(candidate).length === 3
  )
}
