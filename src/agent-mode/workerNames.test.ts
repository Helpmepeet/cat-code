import { afterEach, describe, expect, test } from 'bun:test'

import {
  allocateWorkerName,
  releaseWorkerName,
  reserveWorkerName,
  resetWorkerNamesForTests,
} from './workerNames.js'

const originalRandom = Math.random

afterEach(() => {
  Math.random = originalRandom
  resetWorkerNamesForTests()
})

describe('workerNames', () => {
  test('allocates themed handles for coding workers', () => {
    Math.random = () => 0

    expect(allocateWorkerName('agent-mode-coding-worker')).toBe('Turing')
  })

  test('allocates coding-themed handles for normal implementors', () => {
    Math.random = () => 0

    expect(allocateWorkerName('implementor')).toBe('Turing')
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

  test('does not immediately reuse a released worker handle', () => {
    Math.random = () => 0

    const firstName = allocateWorkerName('agent-mode-coding-worker')
    if (firstName) releaseWorkerName(firstName)

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

  test('allocates generic handles for Explore workers when generic fallback is enabled', () => {
    Math.random = () => 0

    expect(allocateWorkerName('Explore', [], { allowGeneric: true })).toBe('Ada')
  })

  test('does not allocate generic handles for Explore workers by default', () => {
    Math.random = () => 0

    expect(allocateWorkerName('Explore')).toBe(null)
  })

  test('skips reserved generic handles', () => {
    Math.random = () => 0
    reserveWorkerName('Ada')

    expect(
      allocateWorkerName('general-purpose', [], { allowGeneric: true }),
    ).toBe('Katherine')
  })
})
