import { recipientNameKey } from './recipientIdentity.js'

const GENERIC_WORKER_NAMES = [
  'Ada', 'Katherine', 'Johnson', 'Hamilton', 'Ritchie', 'Kay',
  'Wilkes', 'Goldstine', 'Backus', 'Engelbart', 'Cerf', 'Barton',
  'Hopper', 'Turing', 'McCarthy', 'Lamarr', 'Knuth', 'Dijkstra',
  'Allen', 'Berners-Lee', 'Naur', 'Iverson', 'Minsky', 'Shannon',
  'Lovelace', 'Boole', 'Babbage', 'Torvalds', 'Matsumoto', 'Raskin',
  'Thompson', 'Kernighan', 'Stroustrup', 'Meyer', 'Ousterhout', 'Liskov',
  'Karger', 'Sutherland', 'Metcalfe', 'Kahn', 'Codd', 'Brooks',
  'Hamming', 'Sperry', 'Hollerith', 'Zuse', 'Tukey', 'Nielsen',
  'Moggridge', 'Norman', 'Abelson', 'Sussman', 'Miller', 'Reddy',
  'Ullman', 'Aho', 'Sedgewick', 'Tarjan', 'Karp', 'Rivest',
  'Shamir', 'Adleman', 'Diffie', 'Hellman', 'Moser', 'Conway',
  'Moore', 'Lampson', 'Wirth', 'Hoare', 'Hewitt', 'Milner',
  'Kiczales', 'Cardelli', 'Peyton-Jones',
]

const activeNames = new Set<string>()

function getReservedNames(
  reservedNames: Iterable<string> = [],
): Set<string> {
  const reserved = new Set(activeNames)
  for (const name of reservedNames) {
    reserved.add(recipientNameKey(name))
  }
  return reserved
}

function pickNext(reservedNames: Iterable<string>): string {
  const reserved = getReservedNames(reservedNames)
  const available = GENERIC_WORKER_NAMES.filter(
    name => !reserved.has(recipientNameKey(name)),
  )
  if (available.length > 0) {
    return available[Math.floor(Math.random() * available.length)]!
  }

  const baseName = GENERIC_WORKER_NAMES[
    Math.floor(Math.random() * GENERIC_WORKER_NAMES.length)
  ]!
  let suffix = 2
  while (reserved.has(recipientNameKey(`${baseName}-${suffix}`))) suffix += 1
  return `${baseName}-${suffix}`
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
 * Randomly selects a free candidate name without
 * reserving it. Callers must acquire `tryReserveWorkerName` before awaiting
 * external allocation or using the candidate.
 */
export function selectWorkerNameCandidate(
  reservedNames: Iterable<string> = [],
): string {
  return pickNext(reservedNames)
}

export function allocateWorkerName(
  reservedNames: Iterable<string> = [],
): string {
  const name = selectWorkerNameCandidate(reservedNames)
  tryReserveWorkerName(name)
  return name
}

export function releaseWorkerName(name: string): void {
  activeNames.delete(recipientNameKey(name))
}

export function resetWorkerNamesForTests(): void {
  activeNames.clear()
}
