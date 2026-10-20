import { afterEach, describe, expect, test } from 'bun:test'

import {
  allocateWorkerName,
  releaseWorkerName,
  resetWorkerNamesForTests,
  selectWorkerNameCandidate,
  tryReserveWorkerName,
} from './workerNames.js'

const originalRandom = Math.random

afterEach(() => {
  Math.random = originalRandom
  resetWorkerNamesForTests()
})

describe('workerNames', () => {
  test('allocates generic handles for workers', () => {
    Math.random = () => 0

    expect(allocateWorkerName()).toBe('Ada')
  })

  test('randomizes each allocation instead of following the pool sequence', () => {
    Math.random = () => 0
    expect(allocateWorkerName()).toBe('Ada')

    Math.random = () => 1 - Number.EPSILON
    expect(allocateWorkerName()).toBe('Peyton-Jones')

    Math.random = () => 0
    expect(allocateWorkerName()).toBe('Katherine')
  })

  test('skips names already reserved by restored workers', () => {
    Math.random = () => 0
    expect(tryReserveWorkerName('Ada')).toBe(true)

    expect(allocateWorkerName()).toBe('Katherine')
  })

  test('makes a fresh random selection after releasing a worker handle', () => {
    Math.random = () => 0

    const firstName = allocateWorkerName()
    releaseWorkerName(firstName)

    Math.random = () => 1 - Number.EPSILON
    expect(allocateWorkerName()).toBe('Peyton-Jones')

    Math.random = () => 0
    expect(allocateWorkerName()).toBe(firstName)
  })

  test('uses a suffixed handle when the pool is exhausted', () => {
    Math.random = () => 0
    const names = Array.from(
      { length: 75 },
      () => allocateWorkerName(),
    )

    expect(new Set(names).size).toBe(75)
    expect(allocateWorkerName(['ADA-2', 'ada-3'])).toBe('Ada-4')
    expect(allocateWorkerName()).toBe('Ada-2')
    expect(allocateWorkerName()).toBe('Ada-3')

    Math.random = () => 1 - Number.EPSILON
    expect(allocateWorkerName()).toBe('Peyton-Jones-2')
  })

  test('excludes restored names case-insensitively without reserving candidate selection', () => {
    Math.random = () => 0

    expect(selectWorkerNameCandidate(['ada'])).toBe('Katherine')
    expect(tryReserveWorkerName('Katherine')).toBe(true)
    expect(allocateWorkerName(['ADA'])).toBe('Johnson')
  })

  test('atomic reservation rejects a case-variant of an already-held name', () => {
    expect(tryReserveWorkerName('Ada')).toBe(true)
    expect(tryReserveWorkerName('ada')).toBe(false)
  })
})
