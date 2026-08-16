// React 19's DEVELOPMENT build records a User Timing measure for every
// component render of every commit, attaching a serialization of that
// component's changed props as `detail` with no cap on string length
// (`logComponentRender`, react-dom-client.development.js:4096; detail assembly
// at :25542). Chromium structured-clones each `detail` into native
// PartitionAlloc memory on a per-document timeline that has no size limit for
// measures, is never read, and lives until navigation. An Electron window never
// navigates, so a streaming session retains a copy of the whole accumulated
// message once per commit at ~45 commits/second: 6.4 GB across 13 turns on
// 2026-08-16, ending in Chromium's deliberate PartitionAlloc out-of-memory
// abort. The bisection that isolated it is
// docs/reports/2026-08-16-cc59-blink-native-memory-claude-fable-5.md §3.
//
// Production react-dom carries none of this instrumentation, so packaged builds
// were never affected and this filter is dev-only.
//
// Dropping these calls costs the DevTools Components performance track and
// nothing else: React discards the return value at every one of its call sites,
// and measures from any other caller pass through untouched.

/**
 * React's dev-track measures are the only `performance.measure` calls that
 * carry a `detail.devtools` payload; that payload is both the identifying mark
 * and the thing being cloned. Narrowed at runtime rather than typed, because
 * the argument arrives as whatever the caller passed.
 */
function isReactDevTrackMeasure(options: unknown): boolean {
  if (typeof options !== 'object' || options === null) return false
  if (!('detail' in options)) return false
  const { detail } = options
  if (typeof detail !== 'object' || detail === null) return false
  return 'devtools' in detail
}

let installed = false
let original: typeof performance.measure | null = null

// React discards what `performance.measure` returns, but the signature promises
// a `PerformanceMeasure`; handing back one frozen inert entry keeps the contract
// without minting an object per commit, which is the cost being removed here.
const droppedMeasure: PerformanceMeasure = Object.freeze({
  name: '',
  entryType: 'measure',
  startTime: 0,
  duration: 0,
  detail: null,
  toJSON: () => ({}),
})

/**
 * Replaces `performance.measure` with a filter that drops React's dev-track
 * measures and forwards everything else.
 *
 * Call sites re-read the property on every commit, so this only has to run
 * before the first render rather than before react-dom is evaluated. Installing
 * it at the top of the renderer entry is the simplest way to guarantee that.
 *
 * Idempotent, and a no-op wherever the timing API is absent (test environments).
 */
export function installReactDevPerformanceTrackFilter(): void {
  if (typeof performance === 'undefined') return
  if (typeof performance.measure !== 'function') return
  if (installed) return

  const forward = performance.measure.bind(performance)
  original = performance.measure
  installed = true

  performance.measure = function measure(
    name: string,
    startOrMeasureOptions?: string | PerformanceMeasureOptions,
    endMark?: string,
  ): PerformanceMeasure {
    if (isReactDevTrackMeasure(startOrMeasureOptions)) {
      return droppedMeasure
    }
    return forward(name, startOrMeasureOptions, endMark)
  }
}

export const _forTest = {
  /** Restores the untouched `performance.measure`, so one test's install
   *  cannot follow the module instance into the next. */
  uninstall(): void {
    if (original !== null) performance.measure = original
    original = null
    installed = false
  },
}
