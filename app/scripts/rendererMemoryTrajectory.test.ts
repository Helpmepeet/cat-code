import { describe, expect, test } from 'bun:test'
import {
  BYTES_PER_MB,
  MIN_FIT_SAMPLES,
  TRAJECTORY_THRESHOLDS,
  analyseRun,
  analyseSeries,
  buildTrajectoryRun,
  evaluateThresholds,
  formatSummary,
  parseSizeToken,
  parseVmmapSummary,
  selectTagRow,
  slopePerMinute,
  type SeriesOptions,
  type SeriesPoint,
  type TrajectorySample,
} from './rendererMemoryTrajectory.js'

/* -------------------------------------------------------------------------- *
 * vmmap parsing
 * -------------------------------------------------------------------------- */

// Abridged from a real `vmmap --summary` of a live Chromium renderer. The two
// traps are deliberate: the MALLOC ZONE table below carries its own TOTAL row
// with a different column layout, and "Memory Tag 255 (reserved)" is unallocated
// address space that must never be added to the V8 residency.
const VMMAP_FIXTURE = `Process:         Electron Helper (Renderer) [73559]

Physical footprint:         580.9M
Physical footprint (peak):  738.9M
Idle exit:                  untracked
----

                                VIRTUAL RESIDENT    DIRTY  SWAPPED VOLATILE   NONVOL    EMPTY   REGION
REGION TYPE                        SIZE     SIZE     SIZE     SIZE     SIZE     SIZE     SIZE    COUNT (non-coalesced)
===========                     ======= ========    =====  ======= ========   ======    =====  =======
.note.gnu.prope                     320      320       0K       0K       0K       0K       0K        1
MALLOC_SMALL                      16.0M      32K      32K     256K       0K       0K       0K        4         see MALLOC ZONE table below
Memory Tag 253                    48.0G   138.2M    92.2M    33.2M       0K       0K       0K     3291
Memory Tag 255                     1.4T   439.8M   430.7M    12.4M       0K       0K       0K     2946
Memory Tag 255 (reserved)         2240K       0K       0K       0K       0K       0K       0K       35         reserved VM address space (unallocated)
__TEXT                             1.4G   549.8M       0K       0K       0K       0K       0K     1043
===========                     ======= ========    =====  ======= ========   ======    =====  =======
TOTAL                              1.4T     1.3G   533.1M    47.8M       0K      16K     112K    12117
TOTAL, minus reserved VM space     1.4T     1.3G   533.1M    47.8M       0K      16K     112K    12117

                                          VIRTUAL   RESIDENT      DIRTY    SWAPPED ALLOCATION      BYTES DIRTY+SWAP          REGION
MALLOC ZONE                                  SIZE       SIZE       SIZE       SIZE      COUNT  ALLOCATED  FRAG SIZE  % FRAG   COUNT
===========                               =======  =========  =========  =========  =========  =========  =========  ======  ======
DefaultMallocZone_0x1049b4000               20.5M       288K       288K       256K       1688       250K       294K     54%       7
===========                               =======  =========  =========  =========  =========  =========  =========  ======  ======
TOTAL                                       20.5M       288K       288K       256K       1688       250K       294K     54%       7
`

describe('parseSizeToken', () => {
  test('reads the binary units vmmap prints, and a bare number as bytes', () => {
    expect(parseSizeToken('0K')).toBe(0)
    expect(parseSizeToken('320')).toBe(320)
    expect(parseSizeToken('3456K')).toBe(3456 * 1024)
    expect(parseSizeToken('138.2M')).toBeCloseTo(138.2 * 1024 ** 2, 0)
    expect(parseSizeToken('1.4T')).toBeCloseTo(1.4 * 1024 ** 4, 0)
    expect(parseSizeToken('COUNT')).toBeNull()
  })
})

describe('parseVmmapSummary', () => {
  const summary = parseVmmapSummary(VMMAP_FIXTURE)

  test('reads the physical footprint and its peak', () => {
    expect(summary.footprintBytes).toBeCloseTo(580.9 * BYTES_PER_MB, 0)
    expect(summary.footprintPeakBytes).toBeCloseTo(738.9 * BYTES_PER_MB, 0)
  })

  test('takes the region-type TOTAL, not the differently shaped MALLOC ZONE total', () => {
    expect(summary.totalResidentBytes).toBeCloseTo(1.3 * 1024 ** 3, 0)
    expect(summary.totalRegionCount).toBe(12_117)
  })

  test('separates PartitionAlloc and V8 by their Chromium page tags', () => {
    const partitionAlloc = selectTagRow(summary, 'partitionAlloc')
    expect(partitionAlloc?.residentBytes).toBeCloseTo(138.2 * BYTES_PER_MB, 0)
    expect(partitionAlloc?.dirtyBytes).toBeCloseTo(92.2 * BYTES_PER_MB, 0)
    expect(partitionAlloc?.regionCount).toBe(3291)
    const v8 = selectTagRow(summary, 'v8')
    expect(v8?.residentBytes).toBeCloseTo(439.8 * BYTES_PER_MB, 0)
    expect(v8?.regionCount).toBe(2946)
  })

  test('never counts a reserved address-space row as residency', () => {
    // "Memory Tag 255 (reserved)" is unallocated. Matching it as the V8 row
    // would report 0 resident bytes for a renderer holding 439.8M.
    const v8 = selectTagRow(summary, 'v8')
    expect(v8?.type).toBe('Memory Tag 255')
    expect(summary.rows.some(row => row.type === 'Memory Tag 255 (reserved)')).toBe(true)
  })

  test('reports an untagged allocator as missing rather than as zero', () => {
    // This Electron build emits no Blink GC tag. Zero would read as an empty
    // heap; null reads as what it is, an absent measurement.
    expect(selectTagRow(summary, 'blinkGc')).toBeNull()
  })

  test('degrades to nulls when vmmap could not produce a summary', () => {
    const summary = parseVmmapSummary('vmmap: unable to examine process')
    expect(summary.footprintBytes).toBeNull()
    expect(summary.totalRegionCount).toBeNull()
    expect(summary.rows).toHaveLength(0)
  })
})

/* -------------------------------------------------------------------------- *
 * Series arithmetic
 * -------------------------------------------------------------------------- */

const OPTIONS: SeriesOptions = {
  warmUpMs: 5 * 60_000,
  finalWindowMs: 5 * 60_000,
  accelerationTolerancePerMinute: 1,
}

/** A 15 minute run sampled every 30 seconds, valued by elapsed minutes. */
function fifteenMinutes(value: (minutes: number) => number): SeriesPoint[] {
  return Array.from({ length: 31 }, (_unused, index) => ({
    atMs: index * 30_000,
    value: value(index / 2),
  }))
}

describe('slopePerMinute', () => {
  test('fits the slope of a known line', () => {
    expect(slopePerMinute(fifteenMinutes(minutes => 500 + 2 * minutes))).toBeCloseTo(2, 6)
  })

  test('refuses a fit too few samples could only fake', () => {
    // A garbage collection between two captures moves the footprint by tens of
    // MB. Fitting that would report a spectacular slope from allocator noise.
    const short = Array.from({ length: MIN_FIT_SAMPLES - 1 }, (_unused, index) => ({
      atMs: index * 30_000,
      value: index === 0 ? 1 : 900,
    }))
    expect(slopePerMinute(short)).toBeNull()
    expect(slopePerMinute([...short, { atMs: 4 * 30_000, value: 900 }])).not.toBeNull()
  })

  test('ignores samples that carry no value', () => {
    const withGaps: SeriesPoint[] = fifteenMinutes(minutes => 500 + 2 * minutes)
      .map((point, index) => (index % 3 === 0 ? { atMs: point.atMs, value: null } : point))
    expect(slopePerMinute(withGaps)).toBeCloseTo(2, 6)
  })
})

describe('analyseSeries', () => {
  test('a flat series has no slope, no growth, and a steady shape', () => {
    const trend = analyseSeries(fifteenMinutes(() => 500), OPTIONS)
    expect(trend.slopePerMinute).toBeCloseTo(0, 6)
    expect(trend.peak).toBe(500)
    expect(trend.finalWindowGrowthPercent).toBeCloseTo(0, 6)
    expect(trend.shape).toBe('steady')
  })

  test('a linear series reports its real slope and stays steady', () => {
    const trend = analyseSeries(fifteenMinutes(minutes => 500 + 2 * minutes), OPTIONS)
    expect(trend.slopePerMinute).toBeCloseTo(2, 6)
    expect(trend.firstHalfSlopePerMinute).toBeCloseTo(2, 6)
    expect(trend.secondHalfSlopePerMinute).toBeCloseTo(2, 6)
    expect(trend.shape).toBe('steady')
    // The final five minutes climb 10 MB off a 520 MB base.
    expect(trend.finalWindowGrowthPercent).toBeCloseTo((10 / 520) * 100, 4)
  })

  test('an accelerating series is called accelerating, not merely steep', () => {
    const trend = analyseSeries(fifteenMinutes(minutes => 500 + 0.5 * minutes ** 2), OPTIONS)
    expect(trend.shape).toBe('accelerating')
    expect(trend.secondHalfSlopePerMinute).toBeGreaterThan(trend.firstHalfSlopePerMinute ?? 0)
  })

  test('a series that spikes then settles is called flattening', () => {
    const trend = analyseSeries(
      fifteenMinutes(minutes => {
        if (minutes < 5) return 300
        if (minutes < 8) return 300 + 60 * (minutes - 5)
        return 480
      }),
      OPTIONS,
    )
    expect(trend.peak).toBe(480)
    expect(trend.shape).toBe('flattening')
    // The point of the shape call: the overall post-warm-up slope is steeply
    // positive even though the curve has already stopped climbing.
    expect(trend.slopePerMinute ?? 0).toBeGreaterThan(5)
    expect(trend.finalWindowGrowthPercent).toBeCloseTo(0, 6)
  })

  test('the warm-up window is excluded from the slope', () => {
    // All the growth happens before the five minute mark.
    const trend = analyseSeries(
      fifteenMinutes(minutes => (minutes < 5 ? 100 + 40 * minutes : 300)),
      OPTIONS,
    )
    expect(trend.slopePerMinute).toBeCloseTo(0, 6)
    expect(trend.peak).toBe(300)
  })

  test('a run too short to have a post-warm-up curve says so', () => {
    const trend = analyseSeries(
      [0, 1, 2, 3].map(index => ({ atMs: index * 30_000, value: 100 })),
      OPTIONS,
    )
    expect(trend.slopePerMinute).toBeNull()
    expect(trend.shape).toBe('insufficient-data')
  })

  test('an all-null series reports nothing rather than zero', () => {
    const trend = analyseSeries(fifteenMinutes(() => 0).map(point => ({ ...point, value: null })), OPTIONS)
    expect(trend.count).toBe(0)
    expect(trend.peak).toBeNull()
    expect(trend.finalWindowGrowthPercent).toBeNull()
  })
})

/* -------------------------------------------------------------------------- *
 * Verdicts
 * -------------------------------------------------------------------------- */

function sample(index: number, overrides: Partial<TrajectorySample> = {}): TrajectorySample {
  const minutes = index / 2
  return {
    index,
    atIso: new Date(Date.UTC(2026, 7, 15) + index * 30_000).toISOString(),
    elapsedMs: index * 30_000,
    rendererPid: 4242,
    footprintBytes: (500 + 2 * minutes) * BYTES_PER_MB,
    footprintPeakBytes: (500 + 2 * minutes) * BYTES_PER_MB,
    partitionAllocResidentBytes: 140 * BYTES_PER_MB,
    partitionAllocDirtyBytes: 95 * BYTES_PER_MB,
    partitionAllocRegionCount: 1200,
    v8ResidentBytes: 440 * BYTES_PER_MB,
    v8DirtyBytes: 430 * BYTES_PER_MB,
    blinkGcResidentBytes: null,
    totalResidentBytes: 1300 * BYTES_PER_MB,
    totalRegionCount: 12_117,
    rssBytes: 900 * BYTES_PER_MB,
    jsHeapUsedBytes: 120 * BYTES_PER_MB,
    rendererWorkingSetBytes: 700 * BYTES_PER_MB,
    rendersCommitted: index * 40,
    eventLoopLagMs: 12,
    sessions: 3,
    visible: true,
    healthAgeMs: 4_000,
    paneCount: 3,
    ...overrides,
  }
}

const RUN_SAMPLES = Array.from({ length: 31 }, (_unused, index) => sample(index))

describe('evaluateThresholds', () => {
  test('the encoded limits still match the Phase 7 acceptance criteria', () => {
    const limits = Object.fromEntries(TRAJECTORY_THRESHOLDS.map(spec => [spec.id, spec.limit]))
    expect(limits).toMatchObject({
      'footprint-single-turn': 750,
      'footprint-two-session': 1024,
      'partitionalloc-dirty-two-session': 700,
      'regions-two-session': 3000,
      'footprint-three-pane': 1536,
      'slope-three-pane': 5,
      'region-growth-final-window': 5,
    })
  })

  test('a healthy three-pane run passes every limit that applies to it', () => {
    const analysis = analyseRun(RUN_SAMPLES, OPTIONS)
    const verdicts = evaluateThresholds(analysis, 'three-pane')
    const byId = new Map(verdicts.map(verdict => [verdict.id, verdict]))
    expect(byId.get('footprint-three-pane')?.status).toBe('pass')
    expect(byId.get('slope-three-pane')?.status).toBe('pass')
    expect(byId.get('curve-not-accelerating')?.status).toBe('pass')
    expect(byId.get('region-growth-final-window')?.status).toBe('pass')
    // A single-turn limit must not silently grade a three-pane run.
    expect(byId.get('footprint-single-turn')?.status).toBe('not-applicable')
  })

  test('a footprint over the limit fails, with the measured value beside it', () => {
    const heavy = RUN_SAMPLES.map(item => sample(item.index, { footprintBytes: 1600 * BYTES_PER_MB }))
    const verdict = evaluateThresholds(analyseRun(heavy, OPTIONS), 'three-pane')
      .find(item => item.id === 'footprint-three-pane')
    expect(verdict?.status).toBe('fail')
    expect(verdict?.measured).toBe('1600 MB')
    expect(verdict?.limit).toBe('below 1536 MB')
  })

  test('an accelerating curve fails the shape criterion', () => {
    const climbing = RUN_SAMPLES.map(item =>
      sample(item.index, { footprintBytes: (500 + 0.5 * (item.index / 2) ** 2) * BYTES_PER_MB }))
    const verdict = evaluateThresholds(analyseRun(climbing, OPTIONS), 'three-pane')
      .find(item => item.id === 'curve-not-accelerating')
    expect(verdict?.status).toBe('fail')
    expect(verdict?.measured).toBe('accelerating')
  })

  test('a criterion with no source is marked, never scored', () => {
    const verdicts = evaluateThresholds(analyseRun(RUN_SAMPLES, OPTIONS), 'three-pane')
    const dom = verdicts.find(item => item.id === 'mounted-dom-under-10x-source')
    expect(dom?.status).toBe('unmeasured')
    expect(dom?.measured).toBe('no source')
    expect(verdicts.find(item => item.id === 'settled-anchor-error')?.status).toBe('operator')
  })

  test('a metric vmmap could not read is unmeasured rather than passing at zero', () => {
    const blind = RUN_SAMPLES.map(item => sample(item.index, { partitionAllocDirtyBytes: null }))
    const verdict = evaluateThresholds(analyseRun(blind, OPTIONS), 'two-session')
      .find(item => item.id === 'partitionalloc-dirty-two-session')
    expect(verdict?.status).toBe('unmeasured')
  })
})

describe('buildTrajectoryRun', () => {
  const run = buildTrajectoryRun({
    label: 'baseline',
    workload: 'three-pane',
    startedAtIso: '2026-08-15T12:00:00.000Z',
    finishedAtIso: '2026-08-15T12:15:00.000Z',
    rendererPid: 4242,
    intervalMs: 30_000,
    plannedDurationMs: 15 * 60_000,
    stoppedReason: 'run length reached',
    samples: RUN_SAMPLES,
    seriesOptions: OPTIONS,
  })

  test('states how many panes were actually open, so the workload can be checked', () => {
    expect(run.analysis.maxPaneCount).toBe(3)
    expect(formatSummary(run)).toContain('panes open       3')
    const unreported = buildTrajectoryRun({
      label: 'no-debug-state',
      workload: 'three-pane',
      startedAtIso: '2026-08-15T12:00:00.000Z',
      finishedAtIso: '2026-08-15T12:15:00.000Z',
      rendererPid: 4242,
      intervalMs: 30_000,
      plannedDurationMs: 15 * 60_000,
      stoppedReason: 'run length reached',
      samples: RUN_SAMPLES.map(item => sample(item.index, { paneCount: null })),
      seriesOptions: OPTIONS,
    })
    expect(unreported.analysis.maxPaneCount).toBeNull()
    expect(formatSummary(unreported)).toContain('CATCODE_DEBUG_STATE=1')
  })

  test('carries the samples, analysis, and verdicts in one comparable file', () => {
    expect(run.schemaVersion).toBe(1)
    expect(run.samples).toHaveLength(31)
    expect(run.analysis.footprintMB.peak).toBeCloseTo(530, 6)
    expect(run.verdicts.length).toBe(TRAJECTORY_THRESHOLDS.length)
  })

  test('the human summary states the shape, the verdicts, and what is still open', () => {
    const summary = formatSummary(run)
    expect(summary).toContain('renderer footprint (MB)')
    expect(summary).toContain('Result: every measured criterion passed.')
    expect(summary).toContain('Still open:')
    // Operator rule: no em dash on any surface a person reads.
    expect(summary).not.toContain('—')
  })

  test('a run sampled behind a hidden window warns instead of reporting a flat curve', () => {
    const hidden = buildTrajectoryRun({
      label: 'hidden',
      workload: 'three-pane',
      startedAtIso: '2026-08-15T12:00:00.000Z',
      finishedAtIso: '2026-08-15T12:15:00.000Z',
      rendererPid: 4242,
      intervalMs: 30_000,
      plannedDurationMs: 15 * 60_000,
      stoppedReason: 'run length reached',
      samples: RUN_SAMPLES.map(item => sample(item.index, { visible: false })),
      seriesOptions: OPTIONS,
    })
    expect(hidden.analysis.hiddenSampleCount).toBe(31)
    expect(formatSummary(hidden)).toContain('window hidden')
  })
})
