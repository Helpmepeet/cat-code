const CODING_WORKER_NAMES = [
  'Ada', 'Ari', 'Blake', 'Cameron', 'Casey', 'Charlie', 'Dana', 'Drew',
  'Ellis', 'Felix', 'Finn', 'Gray', 'Harper', 'Indigo', 'Jasper', 'Jordan',
  'Jules', 'Kai', 'Lane', 'Lee', 'Logan', 'Luca', 'Morgan', 'Nova',
  'Parker', 'Phoenix', 'Quinn', 'Reese', 'Riley', 'River', 'Robin', 'Sage',
  'Sam', 'Scout', 'Shay', 'Skylar', 'Sloane', 'Sterling', 'Tatum', 'Taylor',
  'Teagan', 'Val', 'Winter', 'Wynne',
]

const VERIFIER_NAMES = [
  'Avery', 'Brett', 'Brooks', 'Dallas', 'Devon', 'Emory', 'Emerson',
  'Harlow', 'Haven', 'Hunter', 'Kelsey', 'Kendall', 'Kerry', 'Laurel',
  'Lexi', 'Marlo', 'Merritt', 'Milan', 'Nico', 'Noel', 'Oakley', 'Onyx',
  'Pax', 'Peyton', 'Remy', 'Roan', 'Roman', 'Rory', 'Rue', 'Sable',
  'Sawyer', 'Sidney', 'Spencer', 'Storm', 'Sutton', 'Sydney', 'Vesper',
]

const NAME_POOLS: Record<string, string[]> = {
  'agent-mode-coding-worker': CODING_WORKER_NAMES,
  'agent-mode-verifier': VERIFIER_NAMES,
}

const activeNames = new Set<string>()

function pickRandom(pool: string[]): string {
  const available = pool.filter(n => !activeNames.has(n))
  if (available.length === 0) {
    return pool[Math.floor(Math.random() * pool.length)]!
  }
  return available[Math.floor(Math.random() * available.length)]!
}

export function allocateWorkerName(agentType: string): string | null {
  const pool = NAME_POOLS[agentType]
  if (!pool) return null
  const name = pickRandom(pool)
  activeNames.add(name)
  return name
}

export function releaseWorkerName(name: string): void {
  activeNames.delete(name)
}
