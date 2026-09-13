#!/usr/bin/env bun
/**
 * Offline, read-only replay for apply_patch placement contracts.
 *
 * This runner intentionally accepts snapshots only when they are supplied by
 * an explicit fixture manifest or inline transcript fields.  It never follows
 * a path from a transcript into the working tree and never opens Cat Code
 * state.  That makes a replay useful for historical sessions without making a
 * historical session an accidental write or quota boundary.
 */
import { readFileSync, statSync } from 'node:fs'
import { normalize, resolve } from 'node:path'

import {
  applyUpdateHunks,
  applyUpdatePlan,
  serializeBuffer,
} from '../src/tools/FilePatchTool/applier.js'
import { parseFilePatchInput } from '../src/tools/FilePatchTool/parser.js'
import {
  planUpdateHunks,
  type PlannerHunk,
  type PlannerResult,
  type PlannerSource,
} from '../src/tools/FilePatchTool/planner.js'
import { inputSchema } from '../src/tools/FilePatchTool/types.js'
import type { FilePatchOperation, ParsedFilePatch } from '../src/tools/FilePatchTool/types.js'

export const REPLAY_TOOL_NAMES = ['apply_patch', 'Apply_patch'] as const
export type ReplayToolName = (typeof REPLAY_TOOL_NAMES)[number]

export type ReplayPolicy =
  | 'current-per-hunk'
  | 'historical-first-forward'
  | 'complete-exact'
  | 'complete-tolerant'
  | 'hint-substring'
  | 'hint-whole-line'
  | 'newline-semantics'

export const DEFAULT_REPLAY_POLICIES: readonly ReplayPolicy[] = [
  'current-per-hunk',
  'historical-first-forward',
  'complete-exact',
  'complete-tolerant',
  'hint-substring',
  'hint-whole-line',
  'newline-semantics',
]

export type ReplaySource = string | null

export type ReplayFixtureCase = {
  id?: string
  patch?: unknown
  input?: unknown
  envelope?: unknown
  path?: string
  source?: ReplaySource
  sourceText?: ReplaySource
  sourceByPath?: Record<string, ReplaySource | { content?: string; exists?: boolean }>
  sources?: Record<string, ReplaySource | { content?: string; exists?: boolean }>
  files?: Record<string, ReplaySource | { content?: string; exists?: boolean }>
  expectedByPath?: Record<string, ReplaySource | { content?: string; exists?: boolean }>
  metadata?: Record<string, unknown>
}

export type ReplayFixtureManifest = {
  schema?: number
  cases: ReplayFixtureCase[]
}

export type ExtractedReplayEnvelope = {
  id: string
  toolName: ReplayToolName
  input: unknown
  sourceByPath: ReadonlyMap<string, ReplaySource>
  expectedByPath?: ReadonlyMap<string, ReplaySource>
  recordIndex?: number
}

export type ReplayReason = {
  code: string
  detail?: string
}

export type ReplayDecision = {
  policy: ReplayPolicy
  status: 'accepted' | 'rejected' | 'unknown'
  reasons: ReplayReason[]
  operationCount: number
  placements?: Array<{ path: string; hunk?: number; start?: number; end?: number }>
}

export type ReplayCaseResult = {
  id: string
  toolName: ReplayToolName
  envelope: 'complete' | 'malformed'
  reconstructable: boolean
  unknownReasons: ReplayReason[]
  decisions: ReplayDecision[]
}

export type ReplayAggregate = {
  schema: 1
  readOnly: true
  policies: ReplayPolicy[]
  denominators: {
    /** Full cohort denominator, including malformed and unreconstructable calls. */
    full: number
    complete: number
    reconstructable: number
    unknown: number
  }
  unknownReasons: Array<ReplayReason & { count: number }>
  byPolicy: Record<ReplayPolicy, { accepted: number; rejected: number; unknown: number }>
  cases: ReplayCaseResult[]
  omittedCases: number
  outputTruncated: boolean
  outputBytes: number
  integration: {
    planner: { connected: boolean; entrypoint: string; hook: string }
  }
}

export type ReplayPlannerAdapter = (input: {
  path: string
  source: PlannerSource
  hunks: readonly PlannerHunk[]
}) => PlannerResult

/** Narrow seam for a release-gated planner/applier candidate. */
export const defaultPlannerAdapter: ReplayPlannerAdapter = input => planUpdateHunks(input)

export type ReplayOptions = {
  policies?: readonly ReplayPolicy[]
  maxCases?: number
  maxReasons?: number
  maxOperationsPerEnvelope?: number
  maxHunksPerOperation?: number
  maxSourceLinesPerFile?: number
  maxPatchBytes?: number
  maxSourceBytesPerFile?: number
  maxOutputBytes?: number
  planner?: ReplayPlannerAdapter
}

const DEFAULT_MAX_CASES = 200
const DEFAULT_MAX_REASONS = 50
const DEFAULT_MAX_OPERATIONS_PER_ENVELOPE = 128
const DEFAULT_MAX_HUNKS_PER_OPERATION = 512
const DEFAULT_MAX_SOURCE_LINES_PER_FILE = 100_000
const DEFAULT_MAX_PATCH_BYTES = 1_000_000
const DEFAULT_MAX_SOURCE_BYTES_PER_FILE = 1_000_000
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000
const MAX_REPLAY_CASES = 10_000
const MAX_REPLAY_REASONS = 1_000
const MAX_REPLAY_OPERATIONS = 1_024
const MAX_REPLAY_HUNKS = 4_096
const MAX_REPLAY_SOURCE_LINES = 1_000_000
const MAX_REPLAY_PATCH_BYTES = 4_000_000
const MAX_REPLAY_SOURCE_BYTES = 4_000_000
const MAX_REPLAY_OUTPUT_BYTES = 4_000_000
const MAX_REPLAY_COHORT_CASES = 100_000
const MAX_REPLAY_TEXT_BYTES = 800
const MAX_REPLAY_PATH_BYTES = 512
export const MAX_REPLAY_INPUT_FILE_BYTES = 64 * 1024 * 1024
const PLANNER_ENTRYPOINT = 'src/tools/FilePatchTool/planner.ts:planUpdateHunks'

export function isReplayToolName(value: unknown): value is ReplayToolName {
  return value === 'apply_patch' || value === 'Apply_patch'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(maximum, Math.floor(value!)))
}

function boundedText(value: unknown, maxBytes = MAX_REPLAY_TEXT_BYTES): string {
  const text = typeof value === 'string' ? value : String(value)
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const suffix = '… [truncated]'
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'))
  let end = Math.min(text.length, budget)
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > budget) end -= 1
  return `${text.slice(0, end)}${suffix}`
}

function boundedPath(value: unknown): string {
  return boundedText(value, MAX_REPLAY_PATH_BYTES)
}

function boundedReason(reason: ReplayReason): ReplayReason {
  return {
    code: boundedText(reason.code),
    ...(reason.detail === undefined ? {} : { detail: boundedText(reason.detail) }),
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function inputStringBytes(value: unknown, seen = new Set<unknown>()): number {
  if (typeof value === 'string') return byteLength(value)
  if (!isRecord(value) && !Array.isArray(value)) return 0
  if (seen.has(value)) return 0
  seen.add(value)
  let total = 0
  const values = Array.isArray(value) ? value : Object.values(value)
  for (const child of values) {
    total += inputStringBytes(child, seen)
    if (total > MAX_REPLAY_PATCH_BYTES) return total
  }
  return total
}

function normalizedOptions(options: ReplayOptions): Required<Pick<ReplayOptions,
  'maxCases' | 'maxReasons' | 'maxOperationsPerEnvelope' | 'maxHunksPerOperation' |
  'maxSourceLinesPerFile' | 'maxPatchBytes' | 'maxSourceBytesPerFile' | 'maxOutputBytes'>> {
  return {
    maxCases: safeLimit(options.maxCases, DEFAULT_MAX_CASES, MAX_REPLAY_CASES),
    maxReasons: safeLimit(options.maxReasons, DEFAULT_MAX_REASONS, MAX_REPLAY_REASONS),
    maxOperationsPerEnvelope: safeLimit(options.maxOperationsPerEnvelope, DEFAULT_MAX_OPERATIONS_PER_ENVELOPE, MAX_REPLAY_OPERATIONS),
    maxHunksPerOperation: safeLimit(options.maxHunksPerOperation, DEFAULT_MAX_HUNKS_PER_OPERATION, MAX_REPLAY_HUNKS),
    maxSourceLinesPerFile: safeLimit(options.maxSourceLinesPerFile, DEFAULT_MAX_SOURCE_LINES_PER_FILE, MAX_REPLAY_SOURCE_LINES),
    maxPatchBytes: safeLimit(options.maxPatchBytes, DEFAULT_MAX_PATCH_BYTES, MAX_REPLAY_PATCH_BYTES),
    maxSourceBytesPerFile: safeLimit(options.maxSourceBytesPerFile, DEFAULT_MAX_SOURCE_BYTES_PER_FILE, MAX_REPLAY_SOURCE_BYTES),
    maxOutputBytes: Math.max(4_096, safeLimit(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_REPLAY_OUTPUT_BYTES)),
  }
}

function normalizedPolicies(options: ReplayOptions): ReplayPolicy[] {
  const requested = options.policies ?? DEFAULT_REPLAY_POLICIES
  const known = new Set<ReplayPolicy>(DEFAULT_REPLAY_POLICIES)
  const policies = [...new Set(requested)].filter(policy => known.has(policy))
  return policies.length > 0 ? policies : [...DEFAULT_REPLAY_POLICIES]
}

function asSource(value: unknown): ReplaySource | undefined {
  if (value === null) return null
  if (typeof value === 'string') return value
  if (!isRecord(value)) return undefined
  if (value.exists === false) return null
  return typeof value.content === 'string' ? value.content : undefined
}

function sourceMapFromValue(value: unknown): Map<string, ReplaySource> {
  const result = new Map<string, ReplaySource>()
  if (!isRecord(value)) return result
  for (const [path, candidate] of Object.entries(value)) {
    const source = asSource(candidate)
    if (source !== undefined) result.set(path, source)
  }
  return result
}

function extractSources(value: unknown): Map<string, ReplaySource> {
  const result = new Map<string, ReplaySource>()
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (!isRecord(node)) return

    for (const key of ['files', 'sources', 'sourceByPath', 'workingTree', 'currentFiles', 'snapshot']) {
      const map = sourceMapFromValue(node[key])
      for (const [path, source] of map) result.set(path, source)
    }
    const directPath = typeof node.path === 'string' ? node.path : undefined
    const directSource = asSource(node.source ?? node.sourceText ?? node.content)
    if (directPath !== undefined && directSource !== undefined) {
      result.set(directPath, directSource)
    }
    for (const [key, child] of Object.entries(node)) {
      // Do not reinterpret patch lines as source snapshots.  The named
      // containers above and explicit path/source pairs are the only evidence.
      if (!['input', 'patch', 'envelope', 'content', 'source', 'sourceText'].includes(key)) visit(child)
    }
  }
  visit(value)
  return result
}

function getToolUse(value: unknown): { name: ReplayToolName; input: unknown } | undefined {
  if (!isRecord(value)) return undefined
  const name = value.name ?? value.tool_name
  const input = value.input ?? value.tool_input
  return isReplayToolName(name) && input !== undefined ? { name, input } : undefined
}

function walkToolUses(value: unknown, callback: (use: { name: ReplayToolName; input: unknown }, record: unknown) => void, record: unknown = value): void {
  const use = getToolUse(value)
  if (use) callback(use, record)
  if (Array.isArray(value)) {
    for (const child of value) walkToolUses(child, callback, record)
  } else if (isRecord(value)) {
    for (const child of Object.values(value)) walkToolUses(child, callback, record)
  }
}

export function extractReplayEnvelopes(records: readonly unknown[]): ExtractedReplayEnvelope[] {
  const result: ExtractedReplayEnvelope[] = []
  let ordinal = 0
  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    const record = records[recordIndex]
    walkToolUses(record, (use, sourceRecord) => {
      result.push({
        id: `transcript-${recordIndex}-${ordinal++}`,
        toolName: use.name,
        input: use.input,
        sourceByPath: extractSources(sourceRecord),
        recordIndex,
      })
    })
  }
  return result
}

export function parseReplayJsonl(text: string): ExtractedReplayEnvelope[] {
  const result: ExtractedReplayEnvelope[] = []
  if (byteLength(text) > MAX_REPLAY_INPUT_FILE_BYTES) {
    throw new Error(`transcript exceeds ${MAX_REPLAY_INPUT_FILE_BYTES} bytes`)
  }
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === '') continue
    try {
      result.push(...extractReplayEnvelopes([JSON.parse(line)]).map((envelope, ordinal) => ({
        ...envelope,
        id: `transcript-${index}-${ordinal}`,
        recordIndex: index,
      })))
    } catch {
      // A malformed JSONL record is not evidence of an apply_patch call.
      continue
    }
  }
  return result
}

export function parseReplayManifest(value: unknown): ReplayFixtureManifest {
  const source = isRecord(value) ? value : { cases: value }
  const cases = source.cases ?? source.fixtures ?? source.rows
  if (!Array.isArray(cases)) throw new Error('fixture manifest must contain a cases array')
  return { schema: typeof source.schema === 'number' ? source.schema : 1, cases: cases as ReplayFixtureCase[] }
}

function patchInput(caseDef: ReplayFixtureCase): unknown {
  return caseDef.patch ?? caseDef.input ?? caseDef.envelope
}

function fixtureEnvelope(caseDef: ReplayFixtureCase, index: number): ExtractedReplayEnvelope {
  const sourceByPath = new Map<string, ReplaySource>()
  const maps = [caseDef.sources, caseDef.files, caseDef.sourceByPath]
  for (const map of maps) {
    for (const [path, value] of Object.entries(map ?? {})) {
      const source = asSource(value)
      if (source !== undefined) sourceByPath.set(path, source)
    }
  }
  if (caseDef.path !== undefined && caseDef.source !== undefined) sourceByPath.set(caseDef.path, caseDef.source)
  if (caseDef.path !== undefined && caseDef.sourceText !== undefined) sourceByPath.set(caseDef.path, caseDef.sourceText)
  return {
    id: caseDef.id ?? `fixture-${index + 1}`,
    toolName: 'apply_patch',
    input: patchInput(caseDef),
    sourceByPath,
    expectedByPath: sourceMapFromValue(caseDef.expectedByPath),
  }
}

function normalizeInput(input: unknown, options: ReplayOptions = {}): { parsed?: ParsedFilePatch; reason?: ReplayReason } {
  const limits = normalizedOptions(options)
  try {
    const candidate = typeof input === 'string' ? { input } : input
    if (inputStringBytes(candidate) > limits.maxPatchBytes) {
      return { reason: { code: 'replay-input-limit', detail: `patch exceeds ${limits.maxPatchBytes} bytes` } }
    }
    const validated = inputSchema().safeParse(candidate)
    if (!validated.success) {
      return { reason: { code: 'invalid-envelope', detail: boundedText(validated.error.message) } }
    }
    return { parsed: parseFilePatchInput(validated.data) }
  } catch (error) {
    return { reason: { code: 'invalid-envelope', detail: boundedText(error instanceof Error ? error.message : String(error)) } }
  }
}

function sourceForOperation(sources: ReadonlyMap<string, ReplaySource>, path: string): ReplaySource | undefined {
  return sources.get(path)
}

function normalizedReplayPath(path: string): string {
  return normalize(path)
}

function operationPaths(operation: FilePatchOperation): string[] {
  return operation.type === 'update' && operation.moveTo !== undefined
    ? [operation.path, operation.moveTo]
    : [operation.path]
}

function envelopeIndependenceFailure(operations: readonly FilePatchOperation[]): ReplayReason | undefined {
  const ownerByPath = new Map<string, number>()
  for (let operationIndex = 0; operationIndex < operations.length; operationIndex += 1) {
    for (const path of operationPaths(operations[operationIndex]!)) {
      const normalized = normalizedReplayPath(path)
      const owner = ownerByPath.get(normalized)
      if (owner !== undefined && owner !== operationIndex) {
        return {
          code: 'operation-path-conflict',
          detail: `${path} is also touched by operation ${owner + 1}`,
        }
      }
      ownerByPath.set(normalized, operationIndex)
    }
  }
  return undefined
}

function envelopeLimitFailure(
  operations: readonly FilePatchOperation[],
  sources: ReadonlyMap<string, ReplaySource>,
  options: ReplayOptions,
): ReplayReason | undefined {
  const limits = normalizedOptions(options)
  const maxOperations = limits.maxOperationsPerEnvelope
  const maxHunks = limits.maxHunksPerOperation
  const maxSourceLines = limits.maxSourceLinesPerFile
  if (operations.length > maxOperations) {
    return { code: 'replay-input-limit', detail: `operation count exceeds ${maxOperations}` }
  }
  for (const operation of operations) {
    for (const path of operationPaths(operation)) {
      if (byteLength(path) > MAX_REPLAY_PATH_BYTES) {
        return { code: 'replay-input-limit', detail: `path exceeds ${MAX_REPLAY_PATH_BYTES} bytes` }
      }
    }
    if (operation.type === 'update' && operation.hunks.length > maxHunks) {
      return { code: 'replay-input-limit', detail: `${boundedPath(operation.path)} exceeds ${maxHunks} hunks` }
    }
  }
  if (sources.size > maxOperations) {
    return { code: 'replay-input-limit', detail: `source snapshot count exceeds ${maxOperations}` }
  }
  for (const [path, source] of sources) {
    if (source !== null && byteLength(source) > limits.maxSourceBytesPerFile) {
      return { code: 'replay-input-limit', detail: `${boundedPath(path)} exceeds ${limits.maxSourceBytesPerFile} source bytes` }
    }
    if (source !== null && source.split(/\r?\n/, maxSourceLines + 2).length > maxSourceLines + 1) {
      return { code: 'replay-input-limit', detail: `${boundedPath(path)} exceeds ${maxSourceLines} source lines` }
    }
  }
  return undefined
}

function splitSource(source: string): PlannerSource {
  const normalized = source.replaceAll('\r\n', '\n')
  const hasFinalNewline = normalized.endsWith('\n')
  if (normalized.length === 0) return { lines: [], hasFinalNewline: false }
  const lines = normalized.split('\n')
  if (hasFinalNewline) lines.pop()
  return { lines, hasFinalNewline }
}

function expectedOutputMismatch(
  expectedByPath: ReadonlyMap<string, ReplaySource>,
  path: string,
  actual: ReplaySource,
): ReplayReason | undefined {
  return expectedByPath.has(path) && expectedByPath.get(path) !== actual
    ? { code: 'expected-output-mismatch', detail: path }
    : undefined
}

function fingerprint(hunk: PlannerHunk): string[] {
  return hunk.lines.filter(line => line.kind !== 'add').map(line => line.text)
}

function hints(hunk: PlannerHunk): string[] {
  return (hunk.hints ?? hunk.scopeHints ?? []).map(value => value.trim()).filter(Boolean)
}

function exactMatches(lines: readonly string[], fp: readonly string[], start = 0, match: (actual: string, expected: string) => boolean = (a, b) => a === b): number[] {
  if (fp.length === 0) return [Math.max(0, start)]
  const result: number[] = []
  for (let i = start; i + fp.length <= lines.length; i += 1) {
    if (fp.every((line, offset) => match(lines[i + offset]!, line))) result.push(i)
  }
  return result
}

function hintPasses(lines: readonly string[], hunk: PlannerHunk, start: number, mode: 'substring' | 'whole-line'): boolean {
  let from = 0
  for (const hint of hints(hunk)) {
    let found = -1
    for (let i = from; i <= start && i < lines.length; i += 1) {
      const candidate = lines[i]?.trim() ?? ''
      if (mode === 'whole-line' ? candidate === hint : candidate.includes(hint)) {
        found = i
        break
      }
    }
    if (found < 0) return false
    from = found + 1
  }
  return true
}

function currentMatcherCandidates(lines: readonly string[], hunk: PlannerHunk, start: number): number[] {
  // This is the historical ladder used by the production applier.  Replay
  // records it as evidence only; complete-exact remains the mutation policy.
  for (const match of CURRENT_MATCHER_TIERS) {
    const candidates = exactMatches(lines, fingerprint(hunk), start, match)
      .filter(position => hintPasses(lines, hunk, position, 'substring'))
    if (candidates.length > 0) return candidates
  }
  return []
}

const CURRENT_MATCHER_TIERS: readonly ((actual: string, expected: string) => boolean)[] = [
  (actual, expected) => actual === expected,
  (actual, expected) => actual.trimEnd() === expected.trimEnd(),
  (actual, expected) => actual.trim() === expected.trim(),
  (actual, expected) => unicodeNormalize(actual) === unicodeNormalize(expected),
]

type OrderedPlacement = { start: number; end: number }

function completeCandidateSets(
  lines: readonly string[],
  hunks: readonly PlannerHunk[],
  match: ((actual: string, expected: string) => boolean) | readonly ((actual: string, expected: string) => boolean)[],
  hintMode: 'substring' | 'whole-line',
): { sets?: OrderedPlacement[][]; reason?: ReplayReason } {
  const sets: OrderedPlacement[][] = []
  for (let index = 0; index < hunks.length; index += 1) {
    const hunk = hunks[index]!
    const fp = fingerprint(hunk)
    let starts: number[]
    if (fp.length === 0) {
      if (hunk.isEndOfFile) {
        if (index !== hunks.length - 1) {
          return { reason: { code: 'hard-eof-conflict', detail: `hunk ${index + 1}` } }
        }
        starts = [lines.length]
      } else if (index === 0) {
        starts = [0]
      } else {
        return { reason: { code: 'invalid-insertion', detail: `hunk ${index + 1}` } }
      }
    } else {
      const tiers = Array.isArray(match) ? match : [match]
      starts = []
      for (const tier of tiers) {
        let tierStarts = exactMatches(lines, fp, 0, tier)
          .filter(start => hintPasses(lines, hunk, start, hintMode))
        if (hunk.isEndOfFile) {
          if (index !== hunks.length - 1) {
            return { reason: { code: 'hard-eof-conflict', detail: `hunk ${index + 1}` } }
          }
          tierStarts = tierStarts.filter(start => start + fp.length === lines.length)
        }
        if (tierStarts.length > 0) {
          starts = tierStarts
          break
        }
      }
    }
    const candidates = starts
      .filter(start => hintPasses(lines, hunk, start, hintMode))
      .map(start => ({ start, end: start + fp.length }))
    if (candidates.length === 0) {
      return { reason: { code: 'anchor-not-found', detail: `hunk ${index + 1}` } }
    }
    sets.push(candidates)
  }
  return { sets }
}

function uniqueOrderedPlan(
  sets: readonly OrderedPlacement[][],
  maxTransitions = 100_000,
): { count: 0 | 1 | 2; path?: OrderedPlacement[]; limited?: boolean } {
  if (sets.length > 512) return { count: 2, limited: true }
  let transitions = 0
  const visit = (
    index: number,
    previousEnd: number,
  ): { count: 0 | 1 | 2; path?: OrderedPlacement[] } => {
    if (index === sets.length) return { count: 1, path: [] }
    let count: 0 | 1 | 2 = 0
    let path: OrderedPlacement[] | undefined
    for (const candidate of sets[index]!) {
      transitions += 1
      if (transitions > maxTransitions) return { count: 2 }
      if (candidate.start < previousEnd) continue
      const tail = visit(index + 1, candidate.end)
      if (tail.count === 0) continue
      if (tail.count === 2 || count === 1) return { count: 2 }
      count = 1
      path = [candidate, ...(tail.path ?? [])]
    }
    return { count, ...(path ? { path } : {}) }
  }
  const result = visit(0, -1)
  return {
    ...result,
    ...(transitions > maxTransitions ? { limited: true } : {}),
  }
}

function applyHistoricalHunk(lines: readonly string[], hunk: PlannerHunk, start: number): { lines: string[]; cursor: number } {
  const output = lines.slice(0, start)
  let sourceCursor = start
  for (const line of hunk.lines) {
    if (line.kind === 'add') output.push(line.text)
    else {
      if (line.kind === 'context') output.push(lines[sourceCursor]!)
      sourceCursor += 1
    }
  }
  output.push(...lines.slice(sourceCursor))
  // This is deliberately a model of the old mutable-buffer cursor, not a
  // source-coordinate placement. It is retained only for replay comparison.
  return { lines: output, cursor: output.length - lines.slice(sourceCursor).length }
}

function unicodeNormalize(value: string): string {
  return value.trim().replace(/[‐‑‒–—―−]/g, '-').replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"')
}

function operationDecision(
  policy: ReplayPolicy,
  operation: FilePatchOperation,
  sources: ReadonlyMap<string, ReplaySource>,
  expectedByPath: ReadonlyMap<string, ReplaySource>,
  planner: ReplayPlannerAdapter,
): ReplayDecision {
  const source = sourceForOperation(sources, operation.path)
  if (operation.type === 'add') {
    if (source === undefined) return { policy, status: 'unknown', reasons: [{ code: 'missing-source-snapshot', detail: operation.path }], operationCount: 1 }
    if (source !== null) return { policy, status: 'rejected', reasons: [{ code: 'target-exists' }], operationCount: 1 }
    const content = operation.lines.length === 0
      ? ''
      : operation.noNewlineAtEndOfFile
        ? operation.lines.join('\n')
        : `${operation.lines.join('\n')}\n`
    const mismatch = expectedOutputMismatch(expectedByPath, operation.path, content)
    return { policy, status: mismatch ? 'rejected' : 'accepted', reasons: mismatch ? [mismatch] : [], operationCount: 1 }
  }
  if (operation.type === 'delete') {
    if (source === undefined) return { policy, status: 'unknown', reasons: [{ code: 'missing-source-snapshot', detail: operation.path }], operationCount: 1 }
    if (source === null) return { policy, status: 'rejected', reasons: [{ code: 'target-absent' }], operationCount: 1 }
    const mismatch = expectedOutputMismatch(expectedByPath, operation.path, null)
    return { policy, status: mismatch ? 'rejected' : 'accepted', reasons: mismatch ? [mismatch] : [], operationCount: 1 }
  }
  if (source === undefined) return { policy, status: 'unknown', reasons: [{ code: 'missing-source-snapshot', detail: operation.path }], operationCount: operation.hunks.length }
  if (source === null) return { policy, status: 'rejected', reasons: [{ code: 'target-absent' }], operationCount: operation.hunks.length }
  if (operation.moveTo !== undefined) {
    const destination = sourceForOperation(sources, operation.moveTo)
    if (destination === undefined) return { policy, status: 'unknown', reasons: [{ code: 'missing-source-snapshot', detail: operation.moveTo }], operationCount: operation.hunks.length }
    if (destination !== null) return { policy, status: 'rejected', reasons: [{ code: 'move-destination-exists', detail: operation.moveTo }], operationCount: operation.hunks.length }
  }
  const src = splitSource(source)
  const placements: ReplayDecision['placements'] = []
  const decision = (status: ReplayDecision['status'], reasons: ReplayReason[] = []): ReplayDecision => ({ policy, status, reasons, operationCount: operation.hunks.length, ...(placements.length > 0 ? { placements } : {}) })

  if (policy === 'complete-exact') {
    const result = planner({ path: operation.path, source: src, hunks: operation.hunks })
    if (!('failure' in result)) {
      // Replay the candidate application too: a successful placement decision
      // is not sufficient evidence if the authorized plan cannot produce the
      // complete output buffer under the same newline contract.
      try {
        const applied = applyUpdatePlan(
          {
            content: source,
            lineEndings: source.includes('\r\n') ? 'CRLF' : 'LF',
            noNewlineAtEndOfFile: source.length > 0 && !source.endsWith('\n'),
          },
          operation.hunks,
          operation.path,
          result.plan,
        )
        const actualByPath = operation.moveTo === undefined
          ? new Map<string, ReplaySource>([[operation.path, serializeBuffer(applied.buffer)]])
          : new Map<string, ReplaySource>([
              [operation.path, null],
              [operation.moveTo, serializeBuffer(applied.buffer)],
            ])
        for (const [path, actual] of actualByPath) {
          const mismatch = expectedOutputMismatch(expectedByPath, path, actual)
          if (mismatch) return decision('rejected', [mismatch])
        }
      } catch (error) {
        return decision('rejected', [{
          code: 'candidate-application-failed',
          detail: error instanceof Error ? error.message : String(error),
        }])
      }
      for (const candidate of result.plan.hunks) placements.push({ path: operation.path, hunk: candidate.hunkIndex, start: candidate.sourceStart, end: candidate.sourceEnd })
      return decision('accepted')
    }
    return decision('rejected', [{ code: result.failure.code, detail: result.failure.message }])
  }
  if (policy === 'current-per-hunk') {
    try {
      applyUpdateHunks(
        {
          content: source,
          lineEndings: source.includes('\r\n') ? 'CRLF' : 'LF',
          noNewlineAtEndOfFile: source.length > 0 && !source.endsWith('\n'),
        },
        operation.hunks,
        operation.path,
      )
      return decision('accepted')
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : 'current-matcher-error'
      return decision('rejected', [
        {
          code,
          detail: error instanceof Error ? error.message : String(error),
        },
      ])
    }
  }
  if (policy === 'historical-first-forward') {
    let cursor = 0
    let workingLines = src.lines.slice()
    for (let index = 0; index < operation.hunks.length; index += 1) {
      const hunk = operation.hunks[index]!
      const searchLines = workingLines
      const fingerprintLines = fingerprint(hunk)
      const startAt = fingerprintLines.length === 0
        ? (hunk.isEndOfFile ? workingLines.length : cursor)
        : cursor
      const candidates = currentMatcherCandidates(searchLines, hunk, startAt)
      if (candidates.length === 0) return decision('rejected', [{ code: 'anchor-not-found', detail: `hunk ${index + 1}` }])
      const start = candidates[0]!
      const end = start + fingerprintLines.length
      placements.push({ path: operation.path, hunk: index, start, end })
      const applied = applyHistoricalHunk(workingLines, hunk, start)
      workingLines = applied.lines
      cursor = applied.cursor
    }
    return decision('accepted')
  }
  if (policy === 'complete-tolerant') {
    const discovered = completeCandidateSets(
      src.lines,
      operation.hunks,
      CURRENT_MATCHER_TIERS,
      'substring',
    )
    if (!discovered.sets) return decision('rejected', [discovered.reason!])
    const complete = uniqueOrderedPlan(discovered.sets)
    if (complete.limited) {
      return decision('unknown', [{ code: 'replay-transition-limit' }])
    }
    if (complete.count === 0) return decision('rejected', [{ code: 'tolerant-order-conflict' }])
    if (complete.count === 2 || !complete.path) return decision('rejected', [{ code: 'tolerant-ambiguity' }])
    complete.path.forEach((candidate, index) => {
      placements.push({ path: operation.path, hunk: index, ...candidate })
    })
    return decision('accepted', [{ code: 'diagnostic-only-tolerant-match' }])
  }
  if (policy === 'hint-substring' || policy === 'hint-whole-line') {
    const mode = policy === 'hint-substring' ? 'substring' : 'whole-line'
    const discovered = completeCandidateSets(
      src.lines,
      operation.hunks,
      (actual, expected) => actual === expected,
      mode,
    )
    if (!discovered.sets) return decision('rejected', [discovered.reason!])
    const complete = uniqueOrderedPlan(discovered.sets)
    if (complete.limited) return decision('unknown', [{ code: 'replay-transition-limit' }])
    if (complete.count === 0) return decision('rejected', [{ code: 'hint-order-conflict' }])
    if (complete.count === 2 || !complete.path) return decision('rejected', [{ code: 'hint-ambiguity' }])
    complete.path.forEach((candidate, index) => {
      placements.push({ path: operation.path, hunk: index, ...candidate })
    })
    return decision('accepted')
  }
  // Newline semantics are evidence accounting rather than another placement
  // policy. Structured legacy booleans intentionally cannot prove old-side EOF.
  const legacy = operation.hunks.filter(hunk => hunk.newline?.kind === 'legacy-output' || hunk.noNewlineAtEndOfFile !== undefined).length
  const canonical = operation.hunks.filter(hunk => hunk.newline?.kind === 'canonical').length
  return decision('accepted', [
    ...(canonical > 0 ? [{ code: 'canonical-marker-evidence', detail: `${canonical} hunk(s)` }] : []),
    ...(legacy > 0 ? [{ code: 'legacy-output-only', detail: 'legacy newline metadata cannot prove old-side EOF' }] : []),
  ])
}

function boundedDecision(decision: ReplayDecision): ReplayDecision {
  return {
    policy: decision.policy,
    status: decision.status,
    reasons: decision.reasons.slice(0, 8).map(boundedReason),
    operationCount: decision.operationCount,
    ...(decision.placements === undefined
      ? {}
      : {
          placements: decision.placements.slice(0, 40).map(placement => ({
            ...placement,
            path: boundedPath(placement.path),
          })),
        }),
  }
}

export function replayEnvelope(envelope: ExtractedReplayEnvelope, options: ReplayOptions = {}): ReplayCaseResult {
  const policies = normalizedPolicies(options)
  const normalized = normalizeInput(envelope.input, options)
  if (!normalized.parsed) {
    const reason = boundedReason(normalized.reason ?? { code: 'invalid-envelope' })
    return { id: boundedText(envelope.id), toolName: envelope.toolName, envelope: 'malformed', reconstructable: false, unknownReasons: [reason], decisions: policies.map(policy => ({ policy, status: 'unknown', reasons: [reason], operationCount: 0 })) }
  }
  const parsed = normalized.parsed
  const envelopeFailure = envelopeIndependenceFailure(parsed.ops)
  const limitFailure = envelopeLimitFailure(parsed.ops, envelope.sourceByPath, options)
  if (envelopeFailure) {
    return {
      id: boundedText(envelope.id),
      toolName: envelope.toolName,
      envelope: 'complete',
      reconstructable: true,
      unknownReasons: [],
      decisions: policies.map(policy => ({
        policy,
        status: 'rejected',
        reasons: [boundedReason(envelopeFailure)],
        operationCount: parsed.ops.length,
      })),
    }
  }
  if (limitFailure) {
    return {
      id: boundedText(envelope.id),
      toolName: envelope.toolName,
      envelope: 'complete',
      reconstructable: false,
      unknownReasons: [boundedReason(limitFailure)],
      decisions: policies.map(policy => ({
        policy,
        status: 'unknown',
        reasons: [boundedReason(limitFailure)],
        operationCount: parsed.ops.length,
      })),
    }
  }
  const missing = parsed.ops.flatMap(operation => {
    const paths = operation.type === 'update' && operation.moveTo !== undefined
      ? [operation.path, operation.moveTo]
      : [operation.path]
    return paths.filter(path => !envelope.sourceByPath.has(path)).map(path => ({ code: 'missing-source-snapshot', detail: path }))
  })
  const unknownReasons = missing
  const planner = options.planner ?? defaultPlannerAdapter
  const expectedByPath = envelope.expectedByPath ?? new Map<string, ReplaySource>()
  const decisions: ReplayDecision[] = []
  for (const policy of policies) {
    const operationDecisions = parsed.ops.map(operation => operationDecision(policy, operation, envelope.sourceByPath, expectedByPath, planner))
    const unknown = operationDecisions.filter(item => item.status === 'unknown')
    const rejected = operationDecisions.filter(item => item.status === 'rejected')
    const status: ReplayDecision['status'] = unknown.length > 0 ? 'unknown' : rejected.length > 0 ? 'rejected' : 'accepted'
    decisions.push({ policy, status, reasons: operationDecisions.flatMap(item => item.reasons).slice(0, 8), operationCount: parsed.ops.length, placements: operationDecisions.flatMap(item => item.placements ?? []).slice(0, 40) })
  }
  return {
    id: boundedText(envelope.id),
    toolName: envelope.toolName,
    envelope: 'complete',
    reconstructable: missing.length === 0,
    unknownReasons: unknownReasons.map(boundedReason),
    decisions: decisions.map(boundedDecision),
  }
}

function incrementReason(
  map: Map<string, { code: string; detail?: string; count: number }>,
  reason: ReplayReason,
): boolean {
  const key = `${reason.code}\u0000${reason.detail ?? ''}`
  const prior = map.get(key)
  if (prior) {
    prior.count += 1
    return true
  }
  if (map.size >= MAX_REPLAY_REASONS) return false
  map.set(key, { ...reason, count: 1 })
  return true
}

export function aggregateReplay(cases: readonly ExtractedReplayEnvelope[], options: ReplayOptions = {}): ReplayAggregate {
  if (cases.length > MAX_REPLAY_COHORT_CASES) {
    throw new Error(`replay cohort exceeds ${MAX_REPLAY_COHORT_CASES} cases`)
  }
  const policies = normalizedPolicies(options)
  const limits = normalizedOptions(options)
  const maxCases = limits.maxCases
  const maxReasons = limits.maxReasons
  const byPolicy = Object.fromEntries(policies.map(policy => [policy, { accepted: 0, rejected: 0, unknown: 0 }])) as ReplayAggregate['byPolicy']
  const reasonCounts = new Map<string, { code: string; detail?: string; count: number }>()
  const results: ReplayCaseResult[] = []
  let complete = 0
  let reconstructable = 0
  let reasonOutputTruncated = false
  for (let index = 0; index < cases.length; index += 1) {
    const result = replayEnvelope(cases[index]!, options)
    if (result.envelope === 'complete') complete += 1
    if (result.reconstructable) reconstructable += 1
    else {
      for (const reason of result.unknownReasons) {
        const retained = incrementReason(
          reasonCounts,
          boundedReason(reason),
        )
        if (!retained) reasonOutputTruncated = true
      }
    }
    for (const decision of result.decisions) byPolicy[decision.policy][decision.status] += 1
    if (results.length < maxCases) results.push(result)
  }
  const unknown = cases.length - reconstructable
  const reasons = [...reasonCounts.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)).slice(0, maxReasons)
  const report: ReplayAggregate = {
    schema: 1,
    readOnly: true,
    policies,
    denominators: { full: cases.length, complete, reconstructable, unknown },
    unknownReasons: reasons,
    byPolicy,
    cases: results,
    omittedCases: Math.max(0, cases.length - results.length),
    outputTruncated:
      reasonOutputTruncated ||
      reasonCounts.size > reasons.length ||
      Math.max(0, cases.length - results.length) > 0,
    outputBytes: 0,
    integration: { planner: { connected: true, entrypoint: PLANNER_ENTRYPOINT, hook: 'Pass options.planner to aggregateReplay/replayEnvelope to connect a future planner entrypoint.' } },
  }
  const outputLimit = limits.maxOutputBytes
  const measure = (): number => byteLength(JSON.stringify(report))
  while (measure() > outputLimit && report.cases.length > 0) {
    report.cases.pop()
    report.omittedCases += 1
    report.outputTruncated = true
  }
  if (measure() > outputLimit && report.unknownReasons.length > 0) {
    report.unknownReasons = []
    report.outputTruncated = true
  }
  for (;;) {
    report.outputBytes = measure()
    const finalSize = measure()
    if (finalSize <= outputLimit || report.cases.length === 0) break
    report.cases.pop()
    report.omittedCases += 1
    report.outputTruncated = true
  }
  report.outputBytes = measure()
  return report
}

type CliArguments = { transcripts: string[]; manifests: string[]; json: boolean; maxCases: number; maxReasons: number; policies: ReplayPolicy[] }

const POLICY_SET = new Set<ReplayPolicy>(DEFAULT_REPLAY_POLICIES)

export function parseReplayArguments(argv: readonly string[]): CliArguments {
  const result: CliArguments = { transcripts: [], manifests: [], json: false, maxCases: DEFAULT_MAX_CASES, maxReasons: DEFAULT_MAX_REASONS, policies: [...DEFAULT_REPLAY_POLICIES] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') { result.json = true; continue }
    if (arg === '--transcript' || arg === '--session') { const path = argv[++i]; if (!path) throw new Error(`${arg} requires a JSONL path`); result.transcripts.push(path); continue }
    if (arg === '--manifest') { const path = argv[++i]; if (!path) throw new Error('--manifest requires a JSON path'); result.manifests.push(path); continue }
    if (arg === '--max-cases' || arg === '--max-reasons') {
      const value = Number(argv[++i])
      if (!Number.isInteger(value) || value < 0) throw new Error(`${arg} requires a non-negative integer`)
      if (arg === '--max-cases') result.maxCases = safeLimit(value, DEFAULT_MAX_CASES, MAX_REPLAY_CASES)
      else result.maxReasons = safeLimit(value, DEFAULT_MAX_REASONS, MAX_REPLAY_REASONS)
      continue
    }
    if (arg === '--policy') { const value = argv[++i] as ReplayPolicy | undefined; if (!value || !POLICY_SET.has(value)) throw new Error(`unknown replay policy: ${value ?? '(missing)'}`); result.policies = [value]; continue }
    if (arg === '--help' || arg === '-h') throw new Error('usage: bun run scripts/replay-apply-patch.ts --manifest FIXTURES.json [--transcript SESSION.jsonl] [--policy POLICY] [--json]')
    throw new Error(`unknown argument: ${arg}`)
  }
  if (result.transcripts.length === 0 && result.manifests.length === 0) throw new Error('provide at least one explicit --transcript/--session or --manifest path')
  return result
}

export function loadReplayInputs(args: Pick<CliArguments, 'transcripts' | 'manifests'>): ExtractedReplayEnvelope[] {
  const envelopes: ExtractedReplayEnvelope[] = []
  const readExplicitInput = (path: string, kind: string): string => {
    const resolved = resolve(path)
    const size = statSync(resolved).size
    if (size > MAX_REPLAY_INPUT_FILE_BYTES) {
      throw new Error(`${kind} exceeds ${MAX_REPLAY_INPUT_FILE_BYTES} bytes`)
    }
    return readFileSync(resolved, 'utf8')
  }
  for (const path of args.transcripts) envelopes.push(...parseReplayJsonl(readExplicitInput(path, 'transcript')))
  for (const path of args.manifests) {
    const manifest = parseReplayManifest(JSON.parse(readExplicitInput(path, 'manifest')))
    manifest.cases.forEach((caseDef, index) => envelopes.push(fixtureEnvelope(caseDef, index)))
  }
  return envelopes
}

function humanReport(report: ReplayAggregate): string {
  const lines = [
    'apply_patch replay (read-only)',
    `full cohort: ${report.denominators.full}; complete envelopes: ${report.denominators.complete}; reconstructable: ${report.denominators.reconstructable}; unknown: ${report.denominators.unknown}`,
  ]
  for (const policy of report.policies) {
    const counts = report.byPolicy[policy]
    lines.push(`${policy}: accepted ${counts.accepted}, rejected ${counts.rejected}, unknown ${counts.unknown}`)
  }
  if (report.unknownReasons.length > 0) lines.push(`top unknown reason: ${report.unknownReasons[0]!.code} (${report.unknownReasons[0]!.count})`)
  if (report.omittedCases > 0) lines.push(`omitted case details: ${report.omittedCases}`)
  return lines.join('\n')
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseReplayArguments(argv)
    const report = aggregateReplay(loadReplayInputs(args), { policies: args.policies, maxCases: args.maxCases, maxReasons: args.maxReasons })
    process.stdout.write(args.json ? `${JSON.stringify(report)}\n` : `${humanReport(report)}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
}

if (import.meta.main) process.exit(await main())
