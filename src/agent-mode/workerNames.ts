import { recipientNameKey } from '../utils/recipientIdentity.js'

const CODING_WORKER_NAMES = [
  'Turing', 'Hopper', 'Curie', 'Galileo', 'Kepler', 'Lovelace', 'Ramanujan',
  'Darwin', 'Faraday', 'Pasteur', 'Tesla', 'Euclid', 'Archimedes', 'Euler',
  'Gauss', 'Feynman', 'Bohr', 'Sagan', 'Franklin', 'Bell',
]

const VERIFIER_NAMES = [
  'Noether', 'Heisenberg', 'Hypatia', 'Shannon', 'Hamming', 'Knuth',
  'Tarski', 'Godel', 'Liskov', 'Lamport', 'BernersLee', 'Dijkstra',
  'Torvalds', 'McCarthy', 'Babbage', 'Minsky', 'Khayyam', 'Poincare',
]

const GENERIC_WORKER_NAMES = [
  'Ada', 'Katherine', 'Johnson', 'Hamilton', 'Ritchie', 'Kay',
  'Wilkes', 'Goldstine', 'Backus', 'Engelbart', 'Cerf', 'Barton',
]

const NAME_POOLS: Record<string, string[]> = {
  'agent-mode-coding-worker': CODING_WORKER_NAMES,
  implementor: CODING_WORKER_NAMES,
  'agent-mode-verifier': VERIFIER_NAMES,
}

const activeNames = new Set<string>()
const poolCursors = new Map<string[], number>()

function getReservedNames(
  reservedNames: Iterable<string> = [],
): Set<string> {
  const reserved = new Set(activeNames)
  for (const name of reservedNames) {
    reserved.add(recipientNameKey(name))
  }
  return reserved
}

function getPoolCursor(pool: string[]): number {
  const existing = poolCursors.get(pool)
  if (existing !== undefined) return existing
  const initial = Math.floor(Math.random() * pool.length)
  poolCursors.set(pool, initial)
  return initial
}

function advancePoolCursor(pool: string[], index: number): void {
  poolCursors.set(pool, (index + 1) % pool.length)
}

function pickNext(pool: string[], reservedNames: Iterable<string>): string {
  const reserved = getReservedNames(reservedNames)
  const startIndex = getPoolCursor(pool)
  for (let offset = 0; offset < pool.length; offset += 1) {
    const index = (startIndex + offset) % pool.length
    const candidate = pool[index]!
    if (!reserved.has(recipientNameKey(candidate))) {
      advancePoolCursor(pool, index)
      return candidate
    }
  }

  for (let offset = 0; offset < pool.length; offset += 1) {
    const index = (startIndex + offset) % pool.length
    const baseName = pool[index]!
    let suffix = 2
    let candidate = `${baseName}-${suffix}`

    while (reserved.has(recipientNameKey(candidate))) {
      suffix += 1
      candidate = `${baseName}-${suffix}`
    }

    advancePoolCursor(pool, index)
    return candidate
  }

  throw new Error('Worker name pool must not be empty')
}

/**
 * Atomically claims a name in the process-local reservation set. Returns
 * false without mutating state if the name (case-insensitively) is already
 * held — callers must not reserve on a failed attempt.
 */
export function tryReserveWorkerName(name: string): boolean {
  const key = recipientNameKey(name)
  if (activeNames.has(key)) return false
  activeNames.add(key)
  return true
}

/**
 * Advances the pool cursor and returns a free candidate name without
 * reserving it. Callers that need atomic ownership must follow up with
 * `tryReserveWorkerName` (or an external allocation) before acting on the
 * candidate, since another caller could claim it first.
 */
export function selectWorkerNameCandidate(
  agentType: string,
  reservedNames: Iterable<string> = [],
  options: { allowGeneric?: boolean } = {},
): string | null {
  const pool = NAME_POOLS[agentType] ?? (
    options.allowGeneric ? GENERIC_WORKER_NAMES : null
  )
  if (!pool) return null
  return pickNext(pool, reservedNames)
}

export function allocateWorkerName(
  agentType: string,
  reservedNames: Iterable<string> = [],
  options: { allowGeneric?: boolean } = {},
): string | null {
  const name = selectWorkerNameCandidate(agentType, reservedNames, options)
  if (!name) return null
  tryReserveWorkerName(name)
  return name
}

/** Compatibility wrapper — callers that only ever add (never race) a name. */
export function reserveWorkerName(name: string): void {
  tryReserveWorkerName(name)
}

export function releaseWorkerName(name: string): void {
  activeNames.delete(recipientNameKey(name))
}

export function resetWorkerNamesForTests(): void {
  activeNames.clear()
  poolCursors.clear()
}
