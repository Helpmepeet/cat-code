/**
 * Pure analysis for the renderer memory trajectory sampler.
 *
 * The runner (`renderer-memory-trajectory.ts`) owns every impure act: reading
 * the app's operational log, shelling out to `vmmap`, sleeping between samples.
 * Everything that has to be RIGHT lives here and is unit tested against
 * synthetic series: vmmap parsing, the post-warm-up slope fit, curve-shape
 * classification, and threshold evaluation.
 *
 * Where the numbers come from (CC-59 Phase 7 asks for a specific list, and only
 * part of it exists as a real source; nothing here estimates a missing one):
 *
 *  - Physical footprint, resident/dirty bytes, region counts: macOS
 *    `vmmap --summary <renderer pid>`. Same instrument as `ram-probe.ts`.
 *  - PartitionAlloc and V8 residency: Chromium tags every PartitionAlloc/V8
 *    mmap with a VM tag from `partition_alloc::PageTag` (kBlinkGC = 252,
 *    kPartitionAlloc = 253, kChromium = 254, kV8 = 255), and vmmap reports a
 *    tagged region as "Memory Tag <n>". This is the ONLY route: the MALLOC ZONE
 *    table cannot see the zone at all, and says so ("Can't examine target
 *    process's malloc zone PartitionAlloc_0x...").
 *  - JS heap, renderer working set, committed renders, event-loop lag: the
 *    app's own `renderer.health.sample` operational record
 *    (`app/shared/operationalLog.ts:130`), which main writes every 30s.
 *
 * Not obtainable, and therefore never present as a filled column: mounted
 * transcript DOM descendant counts (nothing reports them, and CC-59 Phase 4
 * forbids adding a bridge for them), render-commit LATENCY (the health record
 * carries a committed-render COUNT, not a duration), visible-anchor error, and
 * bottom gap.
 */

/** vmmap prints binary units, so "750 MB" here means 750 MiB. */
export const BYTES_PER_MB = 1024 * 1024

export type ChromiumPageTag = 'blinkGc' | 'partitionAlloc' | 'chromium' | 'v8'

/** `partition_alloc::PageTag` values as vmmap renders them. */
export const CHROMIUM_PAGE_TAG_REGIONS: Readonly<Record<ChromiumPageTag, string>> = {
  blinkGc: 'Memory Tag 252',
  partitionAlloc: 'Memory Tag 253',
  chromium: 'Memory Tag 254',
  v8: 'Memory Tag 255',
}

/* -------------------------------------------------------------------------- *
 * vmmap --summary parsing
 * -------------------------------------------------------------------------- */

export type VmmapRegionRow = Readonly<{
  type: string
  virtualBytes: number | null
  residentBytes: number | null
  dirtyBytes: number | null
  regionCount: number | null
}>

export type VmmapSummary = Readonly<{
  footprintBytes: number | null
  footprintPeakBytes: number | null
  totalResidentBytes: number | null
  totalDirtyBytes: number | null
  totalRegionCount: number | null
  rows: readonly VmmapRegionRow[]
}>

/** "1.4T" / "138.2M" / "3456K" / "0K" / "320" (bare = bytes) into bytes. */
export function parseSizeToken(token: string): number | null {
  const match = token.trim().match(/^([\d.]+)\s*([KMGT])?$/)
  if (!match) return null
  const value = Number.parseFloat(match[1])
  if (!Number.isFinite(value)) return null
  switch (match[2]) {
    case 'T': return value * 1024 ** 4
    case 'G': return value * 1024 ** 3
    case 'M': return value * 1024 ** 2
    case 'K': return value * 1024
    default: return value
  }
}

// name, then VIRTUAL RESIDENT DIRTY SWAPPED VOLATILE NONVOL EMPTY, then REGION
// COUNT, then an optional trailing annotation ("see MALLOC ZONE table below").
const REGION_ROW =
  /^(\S.*?)\s{2,}(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s*(.*)$/

export function parseVmmapSummary(text: string): VmmapSummary {
  let footprintBytes: number | null = null
  let footprintPeakBytes: number | null = null
  let totalResidentBytes: number | null = null
  let totalDirtyBytes: number | null = null
  let totalRegionCount: number | null = null
  const rows: VmmapRegionRow[] = []
  // The MALLOC ZONE table further down has its own differently shaped rows and
  // its own TOTAL, so rows are only read while inside the REGION TYPE table.
  let inRegionTable = false

  for (const line of text.split('\n')) {
    const peak = line.match(/^Physical footprint \(peak\):\s*(\S+)/)
    if (peak) {
      footprintPeakBytes = parseSizeToken(peak[1])
      continue
    }
    const footprint = line.match(/^Physical footprint:\s*(\S+)/)
    if (footprint) {
      footprintBytes = parseSizeToken(footprint[1])
      continue
    }
    if (line.startsWith('REGION TYPE')) {
      inRegionTable = true
      continue
    }
    if (!inRegionTable) continue
    const row = line.match(REGION_ROW)
    if (!row) continue
    const type = row[1].trim()
    const residentBytes = parseSizeToken(row[3])
    const dirtyBytes = parseSizeToken(row[4])
    const regionCount = Number.parseInt(row[9], 10)
    if (type.startsWith('TOTAL')) {
      totalResidentBytes = residentBytes
      totalDirtyBytes = dirtyBytes
      totalRegionCount = Number.isFinite(regionCount) ? regionCount : null
      inRegionTable = false
      continue
    }
    rows.push({
      type,
      virtualBytes: parseSizeToken(row[2]),
      residentBytes,
      dirtyBytes,
      regionCount: Number.isFinite(regionCount) ? regionCount : null,
    })
  }

  return { footprintBytes, footprintPeakBytes, totalResidentBytes, totalDirtyBytes, totalRegionCount, rows }
}

/**
 * A tag with no row is reported as null rather than zero: an Electron build that
 * does not tag Blink GC pages is a missing measurement, not an empty heap.
 */
export function selectTagRow(summary: VmmapSummary, tag: ChromiumPageTag): VmmapRegionRow | null {
  const name = CHROMIUM_PAGE_TAG_REGIONS[tag]
  return summary.rows.find(row => row.type === name) ?? null
}

/* -------------------------------------------------------------------------- *
 * Samples
 * -------------------------------------------------------------------------- */

export type TrajectorySample = Readonly<{
  index: number
  atIso: string
  elapsedMs: number
  rendererPid: number
  /** vmmap-sourced. */
  footprintBytes: number | null
  footprintPeakBytes: number | null
  partitionAllocResidentBytes: number | null
  partitionAllocDirtyBytes: number | null
  partitionAllocRegionCount: number | null
  v8ResidentBytes: number | null
  v8DirtyBytes: number | null
  blinkGcResidentBytes: number | null
  totalResidentBytes: number | null
  totalRegionCount: number | null
  rssBytes: number | null
  /** From the app's own `renderer.health.sample` record, when one was written. */
  jsHeapUsedBytes: number | null
  rendererWorkingSetBytes: number | null
  rendersCommitted: number | null
  eventLoopLagMs: number | null
  sessions: number | null
  visible: boolean | null
  /**
   * Age of the health record these fields came from. The app writes one every
   * 30s on its own clock, so a health reading is never exactly contemporaneous
   * with the vmmap capture beside it, and a stale one must be visible as stale.
   */
  healthAgeMs: number | null
  /** Open panes, from the debug state file when CATCODE_DEBUG_STATE=1. */
  paneCount: number | null
  /** Present only when the sample could not be taken. */
  error?: string
}>

/* -------------------------------------------------------------------------- *
 * Series arithmetic
 * -------------------------------------------------------------------------- */

export type SeriesPoint = Readonly<{ atMs: number; value: number | null }>

export type SeriesShape = 'flattening' | 'steady' | 'accelerating' | 'insufficient-data'

export type SeriesTrend = Readonly<{
  /** Points that carried a value. */
  count: number
  first: number | null
  last: number | null
  peak: number | null
  /** Least-squares slope over samples after the warm-up, in units per minute. */
  slopePerMinute: number | null
  /** The two halves of the post-warm-up window, which decide the shape. */
  firstHalfSlopePerMinute: number | null
  secondHalfSlopePerMinute: number | null
  shape: SeriesShape
  /** Growth across the final window, as a percentage of its first value. */
  finalWindowGrowthPercent: number | null
}>

export type SeriesOptions = Readonly<{
  warmUpMs: number
  finalWindowMs: number
  /**
   * How much the second half of the run must out-climb the first half before
   * the curve is called accelerating. Sampling jitter alone moves the halves by
   * a fraction of a MB per minute, so a bare comparison would flip on noise.
   */
  accelerationTolerancePerMinute: number
}>

/**
 * Fewer samples than this cannot carry a trend. A garbage collection between
 * two captures moves the renderer footprint by tens of MB, so a fit over three
 * or four points reports allocator noise as a slope, and the operator can end a
 * run early at any moment. Reporting nothing is the honest answer there.
 */
export const MIN_FIT_SAMPLES = 5

/** Least-squares slope of value against time, in units per minute. */
export function slopePerMinute(points: readonly SeriesPoint[]): number | null {
  const valid = points.filter((point): point is { atMs: number; value: number } => point.value !== null)
  if (valid.length < MIN_FIT_SAMPLES) return null
  const minutes = valid.map(point => point.atMs / 60_000)
  const meanX = minutes.reduce((sum, x) => sum + x, 0) / minutes.length
  const meanY = valid.reduce((sum, point) => sum + point.value, 0) / valid.length
  let numerator = 0
  let denominator = 0
  for (let index = 0; index < valid.length; index++) {
    const dx = minutes[index] - meanX
    numerator += dx * (valid[index].value - meanY)
    denominator += dx * dx
  }
  if (denominator === 0) return null
  return numerator / denominator
}

export function analyseSeries(points: readonly SeriesPoint[], options: SeriesOptions): SeriesTrend {
  const valid = points.filter((point): point is { atMs: number; value: number } => point.value !== null)
  if (valid.length === 0) {
    return {
      count: 0, first: null, last: null, peak: null, slopePerMinute: null,
      firstHalfSlopePerMinute: null, secondHalfSlopePerMinute: null,
      shape: 'insufficient-data', finalWindowGrowthPercent: null,
    }
  }

  const lastAtMs = valid[valid.length - 1].atMs
  const postWarmUp = valid.filter(point => point.atMs >= options.warmUpMs)
  // Halves are split on TIME, not on sample count: a run that dropped samples
  // in the middle must not have its midpoint pulled toward the dense end.
  const halfCut = postWarmUp.length > 0
    ? postWarmUp[0].atMs + (lastAtMs - postWarmUp[0].atMs) / 2
    : 0
  const firstHalf = slopePerMinute(postWarmUp.filter(point => point.atMs <= halfCut))
  const secondHalf = slopePerMinute(postWarmUp.filter(point => point.atMs >= halfCut))

  let shape: SeriesShape = 'insufficient-data'
  if (firstHalf !== null && secondHalf !== null) {
    const delta = secondHalf - firstHalf
    if (delta > options.accelerationTolerancePerMinute) shape = 'accelerating'
    else if (delta < -options.accelerationTolerancePerMinute) shape = 'flattening'
    else shape = 'steady'
  }

  // Drawn from the post-warm-up points, not from every point: a final window
  // wider than the run's settled part would score warm-up allocation and
  // report it as a measured failure.
  const finalWindow = postWarmUp.filter(
    point => point.atMs >= lastAtMs - options.finalWindowMs,
  )
  const windowFirst = finalWindow.length >= 2 ? finalWindow[0].value : null
  const windowLast = finalWindow.length >= 2 ? finalWindow[finalWindow.length - 1].value : null
  const finalWindowGrowthPercent =
    windowFirst !== null && windowLast !== null && windowFirst !== 0
      ? ((windowLast - windowFirst) / windowFirst) * 100
      : null

  return {
    count: valid.length,
    first: valid[0].value,
    last: valid[valid.length - 1].value,
    peak: valid.reduce((max, point) => Math.max(max, point.value), valid[0].value),
    slopePerMinute: slopePerMinute(postWarmUp),
    firstHalfSlopePerMinute: firstHalf,
    secondHalfSlopePerMinute: secondHalf,
    shape,
    finalWindowGrowthPercent,
  }
}

/* -------------------------------------------------------------------------- *
 * Run analysis
 * -------------------------------------------------------------------------- */

export type WorkloadId = 'single-turn' | 'two-session' | 'three-pane' | 'many-short-rows' | 'unspecified'

export const WORKLOAD_IDS: readonly WorkloadId[] = [
  'single-turn', 'two-session', 'three-pane', 'many-short-rows', 'unspecified',
]

export type TrajectoryAnalysis = Readonly<{
  sampleCount: number
  measuredSampleCount: number
  /** Samples taken while the window was hidden, which Chromium throttles. */
  hiddenSampleCount: number
  /**
   * Distinct renderer pids seen. A restart drops footprint by hundreds of MB,
   * so a slope fitted across one reads as flattening and the gate passes on a
   * trajectory that describes two different processes.
   */
  rendererPidCount: number
  /**
   * Most panes seen open at once. A three-pane limit graded against a run the
   * operator did in one pane is the quiet way this gate would go wrong, so the
   * summary states what was actually open.
   */
  maxPaneCount: number | null
  durationMs: number
  warmUpMs: number
  finalWindowMs: number
  footprintMB: SeriesTrend
  partitionAllocDirtyMB: SeriesTrend
  partitionAllocResidentMB: SeriesTrend
  partitionAllocRegionCount: SeriesTrend
  v8ResidentMB: SeriesTrend
  totalResidentMB: SeriesTrend
  totalRegionCount: SeriesTrend
  jsHeapMB: SeriesTrend
  rendererWorkingSetMB: SeriesTrend
  eventLoopLagMs: SeriesTrend
}>

function series(
  samples: readonly TrajectorySample[],
  read: (sample: TrajectorySample) => number | null,
  scale: number,
  options: SeriesOptions,
): SeriesTrend {
  return analyseSeries(
    samples.map(sample => {
      const raw = read(sample)
      return { atMs: sample.elapsedMs, value: raw === null ? null : raw / scale }
    }),
    options,
  )
}

export function analyseRun(
  samples: readonly TrajectorySample[],
  options: SeriesOptions,
): TrajectoryAnalysis {
  const mb = BYTES_PER_MB
  return {
    sampleCount: samples.length,
    measuredSampleCount: samples.filter(sample => sample.footprintBytes !== null).length,
    hiddenSampleCount: samples.filter(sample => sample.visible === false).length,
    rendererPidCount: new Set(
      samples
        .map(sample => sample.rendererPid)
        .filter((pid): pid is number => typeof pid === 'number'),
    ).size,
    maxPaneCount: samples.reduce<number | null>(
      (max, sample) => (sample.paneCount === null ? max : Math.max(max ?? 0, sample.paneCount)),
      null,
    ),
    durationMs: samples.length === 0 ? 0 : samples[samples.length - 1].elapsedMs,
    warmUpMs: options.warmUpMs,
    finalWindowMs: options.finalWindowMs,
    footprintMB: series(samples, s => s.footprintBytes, mb, options),
    partitionAllocDirtyMB: series(samples, s => s.partitionAllocDirtyBytes, mb, options),
    partitionAllocResidentMB: series(samples, s => s.partitionAllocResidentBytes, mb, options),
    partitionAllocRegionCount: series(samples, s => s.partitionAllocRegionCount, 1, options),
    v8ResidentMB: series(samples, s => s.v8ResidentBytes, mb, options),
    totalResidentMB: series(samples, s => s.totalResidentBytes, mb, options),
    totalRegionCount: series(samples, s => s.totalRegionCount, 1, options),
    jsHeapMB: series(samples, s => s.jsHeapUsedBytes, mb, options),
    rendererWorkingSetMB: series(samples, s => s.rendererWorkingSetBytes, mb, options),
    eventLoopLagMs: series(samples, s => s.eventLoopLagMs, 1, options),
  }
}

/* -------------------------------------------------------------------------- *
 * Thresholds
 *
 * One table, so the gate can be retuned here rather than hunted through code.
 * Every limit is transcribed from the blocking acceptance criteria in
 * `docs/plans/2026-08-15-cc59-transcript-leaf-virtualization-execution.md`
 * Phase 7. All of them are strict "below", as that plan words them.
 * -------------------------------------------------------------------------- */

export type ThresholdSource = 'measured' | 'unmeasured' | 'operator'

export type ThresholdSpec = Readonly<{
  id: string
  label: string
  /** Which workload the limit belongs to, or 'all' for every run. */
  workloads: readonly WorkloadId[] | 'all'
  source: ThresholdSource
  kind: 'max' | 'shape'
  limit: number | null
  unit: string
  read: ((analysis: TrajectoryAnalysis) => number | null) | null
  note: string | null
}>

export const TRAJECTORY_THRESHOLDS: readonly ThresholdSpec[] = [
  {
    id: 'footprint-single-turn',
    label: 'Peak renderer footprint, one long streaming turn',
    workloads: ['single-turn'], source: 'measured', kind: 'max', limit: 750, unit: 'MB',
    read: analysis => analysis.footprintMB.peak, note: null,
  },
  {
    id: 'footprint-two-session',
    label: 'Peak renderer footprint, two-session reproduction',
    workloads: ['two-session'], source: 'measured', kind: 'max', limit: 1024, unit: 'MB',
    read: analysis => analysis.footprintMB.peak, note: null,
  },
  {
    id: 'partitionalloc-dirty-two-session',
    label: 'Peak PartitionAlloc dirty bytes, two-session reproduction',
    workloads: ['two-session'], source: 'measured', kind: 'max', limit: 700, unit: 'MB',
    read: analysis => analysis.partitionAllocDirtyMB.peak, note: null,
  },
  {
    id: 'regions-two-session',
    label: 'Peak PartitionAlloc region count, two-session reproduction',
    workloads: ['two-session'], source: 'measured', kind: 'max', limit: 3000, unit: 'regions',
    read: analysis => analysis.partitionAllocRegionCount.peak,
    // Phase 7 says "fewer than 3,000 regions" in the same breath as the
    // PartitionAlloc dirty limit, so this reads the PartitionAlloc region count.
    // Total process regions are a different number entirely (a blank Chromium
    // renderer already carries over 6,000, nearly all of them dylib segments),
    // and the run file records both so the reading can be revisited.
    note: 'Counts PartitionAlloc regions, not total process regions.',
  },
  {
    id: 'footprint-three-pane',
    label: 'Peak renderer footprint, three panes',
    workloads: ['three-pane'], source: 'measured', kind: 'max', limit: 1536, unit: 'MB',
    read: analysis => analysis.footprintMB.peak, note: null,
  },
  {
    id: 'slope-three-pane',
    label: 'Post-warm-up footprint slope, three panes',
    workloads: ['three-pane'], source: 'measured', kind: 'max', limit: 5, unit: 'MB/min',
    read: analysis => analysis.footprintMB.slopePerMinute, note: null,
  },
  {
    id: 'curve-not-accelerating',
    label: 'Footprint curve after warm-up is not accelerating',
    workloads: 'all', source: 'measured', kind: 'shape', limit: null, unit: '',
    read: null, note: null,
  },
  {
    id: 'region-growth-final-window',
    label: 'PartitionAlloc region growth across the final window',
    workloads: 'all', source: 'measured', kind: 'max', limit: 5, unit: '%',
    read: analysis => analysis.partitionAllocRegionCount.finalWindowGrowthPercent, note: null,
  },
  {
    id: 'mounted-dom-under-10x-source',
    label: 'Mounted transcript DOM grows no more than 15% under 10x source growth',
    workloads: 'all', source: 'unmeasured', kind: 'max', limit: 15, unit: '%',
    read: null,
    note: 'No mounted-DOM count is reported by the app, and CC-59 Phase 4 rules out adding a bridge for one.',
  },
  {
    id: 'transcript-descendants-per-pane',
    label: 'No more than 12,000 transcript descendants per pane',
    workloads: 'all', source: 'unmeasured', kind: 'max', limit: 12_000, unit: 'nodes',
    read: null,
    note: 'Same missing source as the mounted-DOM check.',
  },
  {
    id: 'render-commit-p95',
    label: 'p95 streaming render commit below 50 ms',
    workloads: 'all', source: 'unmeasured', kind: 'max', limit: 50, unit: 'ms',
    read: null,
    note: 'Health records carry a committed-render count, not a duration. Renderer event-loop lag is recorded in the run file as a related but different signal.',
  },
  {
    id: 'settled-anchor-error',
    label: 'Settled anchor error no more than 2 px and bottom gap no more than 2 px',
    workloads: 'all', source: 'operator', kind: 'max', limit: 2, unit: 'px',
    read: null, note: 'Layout judgement, verified by the operator.',
  },
  {
    id: 'state-survives-remount',
    label: 'Expansion, reveal extent, reasoning state, search, and copy survive remount',
    workloads: 'all', source: 'operator', kind: 'max', limit: null, unit: '',
    read: null, note: 'Interaction judgement, verified by the operator.',
  },
]

export type VerdictStatus = 'pass' | 'fail' | 'unmeasured' | 'operator' | 'not-applicable'

export type Verdict = Readonly<{
  id: string
  label: string
  status: VerdictStatus
  measured: string
  limit: string
  note: string | null
}>

function formatNumber(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1000) return value.toFixed(0)
  if (abs >= 10) return value.toFixed(1)
  return value.toFixed(2)
}

export function evaluateThresholds(
  analysis: TrajectoryAnalysis,
  workload: WorkloadId,
): Verdict[] {
  return TRAJECTORY_THRESHOLDS.map((spec): Verdict => {
    const limit = spec.limit === null
      ? 'none'
      : `below ${formatNumber(spec.limit)}${spec.unit ? ` ${spec.unit}` : ''}`
    const base = { id: spec.id, label: spec.label, limit, note: spec.note }

    if (spec.source === 'operator') return { ...base, status: 'operator', measured: 'operator check' }
    if (spec.source === 'unmeasured') return { ...base, status: 'unmeasured', measured: 'no source' }
    if (spec.workloads !== 'all' && !spec.workloads.includes(workload)) {
      return { ...base, status: 'not-applicable', measured: `applies to ${spec.workloads.join(', ')}` }
    }

    if (spec.kind === 'shape') {
      const shape = analysis.footprintMB.shape
      if (shape === 'insufficient-data') {
        return { ...base, status: 'unmeasured', measured: 'too few samples after warm-up', limit: 'not accelerating' }
      }
      return {
        ...base,
        status: shape === 'accelerating' ? 'fail' : 'pass',
        measured: shape,
        limit: 'not accelerating',
      }
    }

    const value = spec.read === null ? null : spec.read(analysis)
    if (value === null) return { ...base, status: 'unmeasured', measured: 'no sample' }
    return {
      ...base,
      status: spec.limit !== null && value < spec.limit ? 'pass' : 'fail',
      measured: `${formatNumber(value)}${spec.unit ? ` ${spec.unit}` : ''}`,
    }
  })
}

/* -------------------------------------------------------------------------- *
 * Run file + human summary
 * -------------------------------------------------------------------------- */

export const TRAJECTORY_SCHEMA_VERSION = 1 as const

export type TrajectoryRun = Readonly<{
  schemaVersion: typeof TRAJECTORY_SCHEMA_VERSION
  label: string
  workload: WorkloadId
  startedAtIso: string
  finishedAtIso: string
  rendererPid: number
  intervalMs: number
  plannedDurationMs: number
  stoppedReason: string
  samples: readonly TrajectorySample[]
  analysis: TrajectoryAnalysis
  verdicts: readonly Verdict[]
}>

export function buildTrajectoryRun(input: {
  label: string
  workload: WorkloadId
  startedAtIso: string
  finishedAtIso: string
  rendererPid: number
  intervalMs: number
  plannedDurationMs: number
  stoppedReason: string
  samples: readonly TrajectorySample[]
  seriesOptions: SeriesOptions
}): TrajectoryRun {
  const analysis = analyseRun(input.samples, input.seriesOptions)
  return {
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    label: input.label,
    workload: input.workload,
    startedAtIso: input.startedAtIso,
    finishedAtIso: input.finishedAtIso,
    rendererPid: input.rendererPid,
    intervalMs: input.intervalMs,
    plannedDurationMs: input.plannedDurationMs,
    stoppedReason: input.stoppedReason,
    samples: input.samples,
    analysis,
    verdicts: evaluateThresholds(analysis, input.workload),
  }
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length)
}

function trendLine(name: string, trend: SeriesTrend, unit: string): string {
  if (trend.count === 0) return `  ${pad(name, 30)}not available`
  const slope = trend.slopePerMinute === null ? 'n/a' : `${formatNumber(trend.slopePerMinute)} ${unit}/min`
  const growth = trend.finalWindowGrowthPercent === null ? 'n/a' : `${formatNumber(trend.finalWindowGrowthPercent)}%`
  return '  ' + [
    pad(name, 30),
    pad(`first ${formatNumber(trend.first ?? 0)}`, 16),
    pad(`last ${formatNumber(trend.last ?? 0)}`, 16),
    pad(`peak ${formatNumber(trend.peak ?? 0)}`, 16),
    pad(`slope ${slope}`, 26),
    pad(`final-window ${growth}`, 24),
    trend.shape,
  ].join('')
}

const STATUS_LABEL: Readonly<Record<VerdictStatus, string>> = {
  pass: 'PASS',
  fail: 'FAIL',
  unmeasured: 'NOT MEASURED',
  operator: 'OPERATOR',
  'not-applicable': 'n/a',
}

export function formatSummary(run: TrajectoryRun): string {
  const lines: string[] = []
  const minutes = (run.analysis.durationMs / 60_000).toFixed(1)
  lines.push('Renderer memory trajectory')
  lines.push(`  label            ${run.label}`)
  lines.push(`  workload         ${run.workload}`)
  lines.push(`  renderer pid     ${run.rendererPid}`)
  lines.push(`  started          ${run.startedAtIso}`)
  lines.push(`  duration         ${minutes} min over ${run.analysis.sampleCount} samples (${run.analysis.measuredSampleCount} with memory)`)
  lines.push(`  warm-up ignored  first ${(run.analysis.warmUpMs / 60_000).toFixed(1)} min`)
  lines.push(`  final window     last ${(run.analysis.finalWindowMs / 60_000).toFixed(1)} min`)
  lines.push(`  stopped because  ${run.stoppedReason}`)
  lines.push(
    `  panes open       ${run.analysis.maxPaneCount ?? 'not reported, run the app with CATCODE_DEBUG_STATE=1 to record it'}`,
  )
  if (run.analysis.rendererPidCount > 1) {
    lines.push(`  WARNING          the renderer restarted during this run (${run.analysis.rendererPidCount} processes). Footprint drops to near zero at a restart, so the slope and shape below describe two different processes and must not be read as a verdict. Re-run without a restart.`)
  }
  if (run.analysis.hiddenSampleCount > 0) {
    lines.push(`  WARNING          ${run.analysis.hiddenSampleCount} samples were taken with the window hidden. Chromium throttles a hidden renderer, so the trajectory is not comparable. Re-run with the window visible.`)
  }
  if (run.workload === 'unspecified') {
    lines.push('  WARNING          no workload was given, so only the workload-independent limits were evaluated. Pass --workload for a full gate.')
  }
  lines.push('')
  lines.push('Trajectory')
  lines.push(trendLine('renderer footprint (MB)', run.analysis.footprintMB, 'MB'))
  lines.push(trendLine('PartitionAlloc dirty (MB)', run.analysis.partitionAllocDirtyMB, 'MB'))
  lines.push(trendLine('PartitionAlloc resident (MB)', run.analysis.partitionAllocResidentMB, 'MB'))
  lines.push(trendLine('PartitionAlloc regions', run.analysis.partitionAllocRegionCount, 'regions'))
  lines.push(trendLine('V8 resident (MB)', run.analysis.v8ResidentMB, 'MB'))
  lines.push(trendLine('process resident (MB)', run.analysis.totalResidentMB, 'MB'))
  lines.push(trendLine('process regions', run.analysis.totalRegionCount, 'regions'))
  lines.push(trendLine('JS heap used (MB)', run.analysis.jsHeapMB, 'MB'))
  lines.push(trendLine('renderer working set (MB)', run.analysis.rendererWorkingSetMB, 'MB'))
  lines.push(trendLine('event loop lag (ms)', run.analysis.eventLoopLagMs, 'ms'))
  lines.push('')
  lines.push('Verdicts')
  for (const verdict of run.verdicts) {
    lines.push(`  ${pad(STATUS_LABEL[verdict.status], 14)}${pad(verdict.label, 76)}${pad(verdict.measured, 30)}${verdict.limit}`)
    if (verdict.note) lines.push(`  ${' '.repeat(14)}note: ${verdict.note}`)
  }
  lines.push('')
  const failures = run.verdicts.filter(verdict => verdict.status === 'fail').length
  const unmeasured = run.verdicts.filter(verdict => verdict.status === 'unmeasured').length
  const operator = run.verdicts.filter(verdict => verdict.status === 'operator').length
  lines.push(
    failures > 0
      ? `Result: ${failures} measured criteria failed.`
      : 'Result: every measured criterion passed.',
  )
  lines.push(`Still open: ${unmeasured} criteria have no source in this tool, ${operator} are operator judgement.`)
  return lines.join('\n')
}
