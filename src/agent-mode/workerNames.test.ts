import { afterEach, describe, expect, test } from 'bun:test'

import {
  allocateWorkerName,
  releaseWorkerName,
  reserveWorkerName,
} from './workerNames.js'

const originalRandom = Math.random
const ALL_TEST_NAMES = [
  'Turing',
  'Turing-2',
  'Hopper',
  'Curie',
  'Galileo',
  'Kepler',
  'Lovelace',
  'Ramanujan',
  'Darwin',
  'Faraday',
  'Pasteur',
  'Tesla',
  'Euclid',
  'Archimedes',
  'Euler',
  'Gauss',
  'Feynman',
  'Bohr',
  'Sagan',
  'Franklin',
  'Bell',
  'Noether',
]

afterEach(() => {
  Math.random = originalRandom
  for (const name of ALL_TEST_NAMES) {
    releaseWorkerName(name)
  }
})

describe('workerNames', () => {
  test('allocates themed handles for coding workers', () => {
    Math.random = () => 0

    expect(allocateWorkerName('agent-mode-coding-worker')).toBe('Turing')
  })

  test('allocates themed handles for verifiers from a separate pool', () => {
    Math.random = () => 0

    expect(allocateWorkerName('agent-mode-verifier')).toBe('Noether')
  })

  test('skips names already reserved by restored workers', () => {
    Math.random = () => 0
    reserveWorkerName('Turing')

    expect(allocateWorkerName('agent-mode-coding-worker')).toBe('Hopper')
  })

  test('falls back to a suffixed themed handle when the pool is exhausted', () => {
    Math.random = () => 0
    reserveWorkerName('Turing')
    reserveWorkerName('Hopper')
    reserveWorkerName('Curie')
    reserveWorkerName('Galileo')
    reserveWorkerName('Kepler')
    reserveWorkerName('Lovelace')
    reserveWorkerName('Ramanujan')
    reserveWorkerName('Darwin')
    reserveWorkerName('Faraday')
    reserveWorkerName('Pasteur')
    reserveWorkerName('Tesla')
    reserveWorkerName('Euclid')
    reserveWorkerName('Archimedes')
    reserveWorkerName('Euler')
    reserveWorkerName('Gauss')
    reserveWorkerName('Feynman')
    reserveWorkerName('Bohr')
    reserveWorkerName('Sagan')
    reserveWorkerName('Franklin')
    reserveWorkerName('Bell')

    expect(allocateWorkerName('agent-mode-coding-worker')).toBe('Turing-2')
  })
})
