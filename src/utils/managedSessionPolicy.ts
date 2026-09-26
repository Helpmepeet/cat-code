import { join } from 'node:path'

/** Validated host context for a managed chat. Set once before engine bootstrap. */
export type ManagedSessionPolicy = {
  workingDirectory: string
  temporaryDirectory: string
  storageRootId: string
  storageId: string
  sharedFilesNotice?: boolean
}

let managedSessionPolicy: ManagedSessionPolicy | null = null
let managedSessionPolicyWasSet = false

function readSpawnManagedPolicy(): ManagedSessionPolicy | null {
  const raw = process.env.CATCODE_SESSION_BINDING_JSON
  const workingDirectory = process.env.CATCODE_SIDECAR_CWD
  if (!raw || !workingDirectory) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const candidate = value as Record<string, unknown>
    if (
      candidate.kind !== 'managed' ||
      typeof candidate.storageRootId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(candidate.storageRootId) ||
      typeof candidate.storageId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(candidate.storageId) ||
      Object.keys(candidate).length !== 3
    ) {
      return null
    }
    return {
      workingDirectory,
      temporaryDirectory: join(workingDirectory, 'tmp'),
      storageRootId: candidate.storageRootId,
      storageId: candidate.storageId,
    }
  } catch {
    return null
  }
}

export function setManagedSessionPolicy(
  policy: ManagedSessionPolicy | null,
): void {
  managedSessionPolicyWasSet = true
  managedSessionPolicy = policy
}

export function getManagedSessionPolicy(): ManagedSessionPolicy | null {
  return managedSessionPolicyWasSet
    ? managedSessionPolicy
    : readSpawnManagedPolicy()
}

export function isManagedSession(): boolean {
  return getManagedSessionPolicy() !== null
}
