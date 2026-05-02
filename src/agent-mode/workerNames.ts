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

const NAME_POOLS: Record<string, string[]> = {
  'agent-mode-coding-worker': CODING_WORKER_NAMES,
  'agent-mode-verifier': VERIFIER_NAMES,
}

const activeNames = new Set<string>()

function getReservedNames(
  reservedNames: Iterable<string> = [],
): Set<string> {
  const reserved = new Set(activeNames)
  for (const name of reservedNames) {
    reserved.add(name)
  }
  return reserved
}

function pickRandom(pool: string[], reservedNames: Iterable<string>): string {
  const reserved = getReservedNames(reservedNames)
  const available = pool.filter(n => !reserved.has(n))
  if (available.length === 0) {
    const baseName = pool[Math.floor(Math.random() * pool.length)]!
    let suffix = 2
    let candidate = `${baseName}-${suffix}`

    while (reserved.has(candidate)) {
      suffix += 1
      candidate = `${baseName}-${suffix}`
    }

    return candidate
  }
  return available[Math.floor(Math.random() * available.length)]!
}

export function allocateWorkerName(
  agentType: string,
  reservedNames: Iterable<string> = [],
): string | null {
  const pool = NAME_POOLS[agentType]
  if (!pool) return null
  const name = pickRandom(pool, reservedNames)
  activeNames.add(name)
  return name
}

export function reserveWorkerName(name: string): void {
  activeNames.add(name)
}

export function releaseWorkerName(name: string): void {
  activeNames.delete(name)
}
