import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  _forTest,
  installReactDevPerformanceTrackFilter,
} from './reactDevPerformanceTrack.js'

// The exact shape react-dom's development build passes as its second argument
// (`reusableComponentOptions`, react-dom-client.development.js:25542). The
// filter keys on `detail.devtools`, so this fixture is what makes the test
// load-bearing: widen or narrow the predicate and one of the two cases below
// fails.
function reactDevTrackOptions(): PerformanceMeasureOptions {
  return {
    start: 0,
    end: 1,
    detail: {
      devtools: {
        color: 'primary',
        properties: [['Changed Props', 'source']],
        tooltipText: 'MessageBody',
        track: 'Components ⚛',
      },
    },
  }
}

// `bun test app/` runs every file in ONE process against ONE performance
// timeline, so earlier suites that rendered React leave their own measures
// behind. These assertions are about what this file recorded, not about what
// the process has ever recorded.
beforeEach(() => {
  performance.clearMeasures()
})

afterEach(() => {
  _forTest.uninstall()
  performance.clearMeasures()
})

describe('installReactDevPerformanceTrackFilter', () => {
  test("drops React's dev-track measures so nothing retains their detail", () => {
    installReactDevPerformanceTrackFilter()

    performance.measure('​MessageBody', reactDevTrackOptions())

    expect(measureNames()).toEqual([])
  })

  test('forwards every other measure untouched', () => {
    installReactDevPerformanceTrackFilter()

    performance.measure('app-timing', { start: 0, end: 1 })
    performance.measure('app-timing-with-detail', {
      start: 0,
      end: 1,
      detail: { reason: 'not react' },
    })

    expect(measureNames().sort()).toEqual([
      'app-timing',
      'app-timing-with-detail',
    ])
  })

  test('is idempotent, so a second install cannot double-wrap the API', () => {
    installReactDevPerformanceTrackFilter()
    const afterFirst = performance.measure

    installReactDevPerformanceTrackFilter()

    expect(performance.measure).toBe(afterFirst)

    performance.measure('​MessageBody', reactDevTrackOptions())
    performance.measure('app-timing', { start: 0, end: 1 })
    expect(measureNames()).toEqual(['app-timing'])
  })

  test('uninstall restores the original, which records React measures again', () => {
    installReactDevPerformanceTrackFilter()
    _forTest.uninstall()

    performance.measure('​MessageBody', reactDevTrackOptions())

    expect(measureNames()).toEqual(['​MessageBody'])
  })
})

function measureNames(): string[] {
  return performance.getEntriesByType('measure').map(entry => entry.name)
}
