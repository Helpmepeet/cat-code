/**
 * Proof against the real `react-dom/client` development build, which a fixture
 * of hand-written measure options cannot give: React's own commit path is what
 * has to be caught, and its options shape is undocumented internal detail that
 * a future React release may change.
 *
 * The baseline test is the load-bearing half. It pins the CC-59 mechanism
 * itself: a component's full prop string is serialized verbatim, uncapped, into
 * a User Timing entry that is retained per commit and never read. If React ever
 * stops doing that, the baseline fails loudly rather than leaving the filter
 * silently guarding nothing.
 *
 * No JSX on purpose, per `BoundedMarkdown.dom.test.ts`: keeping the file `.ts`
 * keeps it outside the `lint:fast-refresh` boundary rule for `renderer/src/**.tsx`.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { createElement } from 'react'
import { createDomTestHarness } from './domTestHarness.js'
import type { DomTestHarness } from './domTestHarness.js'
import {
  _forTest,
  installReactDevPerformanceTrackFilter,
} from './reactDevPerformanceTrack.js'

let harness: DomTestHarness

const PROP_CHUNK = 'streamed-source-'.repeat(64)

/** Stands in for a streaming message body: one large, growing string prop. */
function StreamedBody({ source }: { source: string }) {
  return createElement('div', null, source)
}

/** Mounts, then re-renders with a longer prop, as a streamed turn would. */
async function streamCommits(count: number): Promise<void> {
  const tree = await harness.mount(
    createElement(StreamedBody, { source: PROP_CHUNK }),
  )
  for (let index = 1; index < count; index += 1) {
    await tree.render(
      createElement(StreamedBody, { source: PROP_CHUNK.repeat(index + 1) }),
    )
  }
}

function retainedMeasures(): PerformanceEntryList {
  return performance.getEntriesByType('measure')
}

beforeAll(async () => {
  harness = await createDomTestHarness()
})

// `bun test app/` shares one process and one performance timeline across every
// file, so earlier React-rendering suites leave measures behind. Each test here
// asserts on what it recorded, not on the process-wide total.
beforeEach(() => {
  performance.clearMeasures()
})

afterEach(async () => {
  await harness.unmountAll()
  _forTest.uninstall()
  performance.clearMeasures()
})

afterAll(async () => {
  await harness.teardown()
})

describe('React dev performance track', () => {
  test('retains the full prop text per commit when left alone', async () => {
    await streamCommits(4)

    const entries = retainedMeasures()
    expect(entries.length).toBeGreaterThan(0)

    // `getEntriesByType` is typed as plain `PerformanceEntry`; `detail` is the
    // `PerformanceMeasure` half, narrowed here rather than cast.
    const serialized = JSON.stringify(
      entries.map(entry => ('detail' in entry ? entry.detail : null)),
    )
    expect(serialized).toContain(PROP_CHUNK)
  })

  test('retains nothing once the filter is installed', async () => {
    installReactDevPerformanceTrackFilter()

    await streamCommits(4)

    expect(retainedMeasures()).toEqual([])
  })

  test('leaves an application measure recorded alongside React commits', async () => {
    installReactDevPerformanceTrackFilter()

    await streamCommits(2)
    performance.measure('app-timing', { start: 0, end: 1 })

    expect(retainedMeasures().map(entry => entry.name)).toEqual(['app-timing'])
  })
})
