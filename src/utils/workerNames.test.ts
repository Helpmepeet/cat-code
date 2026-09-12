import { afterEach, describe, expect, test } from 'bun:test'

import {
  allocateWorkerName,
  releaseWorkerName,
  reserveWorkerName,
  resetWorkerNamesForTests,
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

    expect(allocateWorkerName('implementor')).toBe('Ada')
  })

  test('skips names already reserved by restored workers', () => {
    Math.random = () => 0
    reserveWorkerName('Ada')

    expect(allocateWorkerName('implementor')).toBe('Katherine')
  })

  test('does not immediately reuse a released worker handle', () => {
    Math.random = () => 0

    const firstName = allocateWorkerName('implementor')
    if (firstName) releaseWorkerName(firstName)

    expect(allocateWorkerName('implementor')).toBe('Katherine')
  })

  test('uses a suffixed handle when the pool is exhausted', () => {
    Math.random = () => 0
    const names = Array.from(
      { length: 75 },
      () => allocateWorkerName('implementor'),
    )

    expect(new Set(names).size).toBe(75)
    expect(allocateWorkerName('implementor')).toBe('Ada-2')
  })

  test('skips reserved generic handles', () => {
    Math.random = () => 0
    reserveWorkerName('Ada')

    expect(
      allocateWorkerName('general-purpose'),
    ).toBe('Katherine')
  })

  test('atomic reservation rejects a case-variant of an already-held name', () => {
    expect(tryReserveWorkerName('Ada')).toBe(true)
    expect(tryReserveWorkerName('ada')).toBe(false)
  })
})
