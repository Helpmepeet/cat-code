#!/usr/bin/env bun

import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { writeFileAtomicDurableSync } from '../src/utils/atomicFile.js'
import { acquireMutationLockSync } from '../src/utils/lockfile.js'
import {
  validateWorkspaceMaps,
  type MapLintResult,
} from './workspaceMapLint.js'

export const REFRESH_STATE_SCHEMA_VERSION = 1 as const

export type CoverageMode =
  | 'incremental'
  | 'baseline-partial'
  | 'baseline-complete'
  | 'divergence-pending'
  | 'divergence-reconciled'

export type RefreshRunStatus =
  | 'in-progress'
  | 'published'
  | 'complete'
  | 'blocked'

export type ChangedPath = {
  path: string
  previousPath?: string
  status: string
}

export type MapFileDigest = {
  bytes: number
  sha256: string
}

export type MapSnapshotFile = MapFileDigest & {
  contentBase64: string
}

export type MapSnapshot = {
  capturedAt: string
  baseSha: string
  repositoryRoot: string
  schemaVersion: typeof REFRESH_STATE_SCHEMA_VERSION
  snapshotSha256: string
  targetSha: string
  files: Record<string, MapSnapshotFile>
}

export type SnapshotReference = {
  bytes: number
  path: string
  sha256: string
}

export type RefreshValidation = MapLintResult & {
  checkedAt: string
  sourceTargetSha: string
}

/**
 * The model owns the semantic audit; the helper owns its identity and
 * completeness checks. Keeping the attestation in the manifest makes the
 * completion decision inspectable without introducing a second state store.
 */
export type RefreshAuditEvidence = {
  schemaVersion: typeof REFRESH_STATE_SCHEMA_VERSION
  runId: string
  targetSha: string
  coverageMode: CoverageMode
  auditedPaths: string[]
  structuralQueue: string[]
  resolvedStructuralQueue: string[]
  pathIntegrity: 'pass'
  orphanScan: 'pass'
  mapTreeHash: string
}

export type RefreshAuditInput = Omit<RefreshAuditEvidence, 'mapTreeHash'>

export type RefreshManifest = {
  baseSha: string
  blockers: string[]
  branch: string
  changedPaths: ChangedPath[]
  comparisonBasis: string
  coverageMode: CoverageMode
  createdAt: string
  cursorBefore: string | null
  initialMapFiles: Record<string, MapFileDigest>
  memoryUpdated: boolean
  pendingPaths: string[]
  repositoryRoot: string
  runId: string
  schemaVersion: typeof REFRESH_STATE_SCHEMA_VERSION
  snapshot: SnapshotReference | null
  status: RefreshRunStatus
  structuralQueue: string[]
  targetSha: string
  updatedAt: string
  validation: RefreshValidation | null
  validationInputs: Record<string, MapFileDigest>
  patch: SnapshotReference | null
  audit: RefreshAuditEvidence | null
}

export type CursorResolution = {
  ancestorOfTarget: boolean
  comparisonBasis: string
  cursorCandidate: string | null
  cursorCommitValid: boolean
  coverageMode: CoverageMode
  memoryFound: boolean
  mergeBase: string | null
  usableCursor: boolean
}

export type StartRefreshRunOptions = {
  repoRoot: string
  runId?: string
  stateDir: string
}

export type PublishRefreshRunOptions = {
  audit?: RefreshAuditInput
  blockers?: string[]
  repoRoot: string
  runId: string
  stateDir: string
  status: 'blocked' | 'complete'
}

export type PublishRefreshRunResult = {
  manifest: RefreshManifest
  requestedStatus: 'blocked' | 'complete'
  status: RefreshRunStatus
}

type StatePaths = {
  currentManifest: string
  currentPatch: string
  currentSnapshot: string
  lockTarget: string
  memory: string
  stateDir: string
}

type MapSnapshotOptions = {
  baseSha: string
  targetSha: string
}

function now(): string {
  return new Date().toISOString()
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  )
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate)
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  )
}

function assertNoSymlinkComponents(path: string, label: string): void {
  const absolutePath = resolve(path)
  const components = absolutePath.split(sep).filter(Boolean)
  let current = absolutePath.startsWith(sep) ? sep : ''
  for (const component of components) {
    current = join(current || '.', component)
    if (!existsSync(current)) continue
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} contains a symlink: ${current}`)
    }
  }
}

function assertDirectory(path: string, label: string): string {
  if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`)
  if (lstatSync(path).isSymbolicLink()) throw new Error(`${label} is a symlink: ${path}`)
  const canonicalPath = realpathSync(path)
  assertNoSymlinkComponents(canonicalPath, label)
  const stat = lstatSync(canonicalPath)
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${path}`)
  return canonicalPath
}

function ensureDirectory(path: string, label: string): string {
  mkdirSync(path, { recursive: true })
  return assertDirectory(path, label)
}

function ensureStateDirectory(path: string): string {
  return ensureDirectory(path, 'refresh state directory')
}

function assertSafeFilePath(filePath: string, root: string, label: string): void {
  const absoluteRoot = realpathSync(root)
  const absolutePath = resolve(filePath)
  const parent = dirname(absolutePath)
  const canonicalParent = realpathSync(parent)
  const canonicalPath = join(canonicalParent, basename(absolutePath))
  if (!isWithin(absoluteRoot, canonicalPath)) {
    throw new Error(`${label} escapes its approved directory: ${filePath}`)
  }
  assertNoSymlinkComponents(canonicalParent, label)
  if (existsSync(absolutePath) && lstatSync(absolutePath).isSymbolicLink()) {
    throw new Error(`${label} is a symlink: ${filePath}`)
  }
}

function validateRunId(runId: string): string {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(runId)) {
    throw new Error(`invalid refresh run id: ${runId}`)
  }
  return runId
}

function statePaths(stateDir: string): StatePaths {
  const canonicalStateDir = ensureStateDirectory(stateDir)
  const memory = join(canonicalStateDir, 'memory.md')
  assertSafeFilePath(memory, canonicalStateDir, 'refresh memory path')
  return {
    currentManifest: join(canonicalStateDir, 'manifest.json'),
    currentPatch: join(canonicalStateDir, 'last-run.patch'),
    currentSnapshot: join(canonicalStateDir, 'last-run.snapshot.json'),
    lockTarget: join(canonicalStateDir, 'refresh-run-lock'),
    memory,
    stateDir: canonicalStateDir,
  }
}

function writeStateText(filePath: string, content: string, paths: StatePaths): void {
  assertSafeFilePath(filePath, paths.stateDir, 'refresh state file')
  writeFileAtomicDurableSync(filePath, content, { mode: 0o600 })
}

function writeStateJson(filePath: string, value: unknown, paths: StatePaths): void {
  writeStateText(filePath, `${JSON.stringify(value, null, 2)}\n`, paths)
}

function readStateJson<T>(filePath: string, paths: StatePaths): T {
  assertSafeFilePath(filePath, paths.stateDir, 'refresh state file')
  return JSON.parse(readFileSync(filePath, 'utf8')) as T
}

function mapDirectory(repoRoot: string): string {
  const canonicalRepoRoot = assertDirectory(repoRoot, 'repository root')
  const mapsDir = join(canonicalRepoRoot, 'docs', 'maps')
  assertDirectory(mapsDir, 'workspace map directory')
  return mapsDir
}

function mapPathIsSafe(relativePath: string): boolean {
  return /^docs\/maps\/[^/]+\.md$/.test(relativePath)
}

function listMapFiles(repoRoot: string): Array<{ bytes: Buffer; path: string }> {
  const mapsDir = mapDirectory(repoRoot)
  return readdirSync(mapsDir)
    .filter(file => file.endsWith('.md'))
    .sort()
    .map(file => {
      const absolutePath = join(mapsDir, file)
      const stat = lstatSync(absolutePath)
      if (stat.isSymbolicLink()) {
        throw new Error(`workspace map is a symlink: ${absolutePath}`)
      }
      if (!stat.isFile()) throw new Error(`workspace map is not a file: ${absolutePath}`)
      return { bytes: readFileSync(absolutePath), path: `docs/maps/${file}` }
    })
}

function mapDigests(repoRoot: string): Record<string, MapFileDigest> {
  const digests: Record<string, MapFileDigest> = {}
  for (const file of listMapFiles(repoRoot)) {
    digests[file.path] = { bytes: file.bytes.length, sha256: sha256(file.bytes) }
  }
  return sortedRecord(digests)
}

function mapTreeHash(files: Record<string, MapFileDigest>): string {
  return sha256(JSON.stringify(sortedRecord(files)))
}

const VALIDATION_INPUT_PATHS = [
  'scripts/workspaceMapLint.ts',
  'scripts/workspaceMapRefreshState.ts',
]

function validationInputDigests(repoRoot: string): Record<string, MapFileDigest> {
  const digests: Record<string, MapFileDigest> = {}
  for (const path of VALIDATION_INPUT_PATHS) {
    const absolutePath = resolve(repoRoot, path)
    if (!existsSync(absolutePath)) continue
    assertSafeFilePath(absolutePath, repoRoot, 'validation input')
    const stat = lstatSync(absolutePath)
    if (stat.isSymbolicLink()) throw new Error(`validation input is a symlink: ${path}`)
    if (!stat.isFile()) throw new Error(`validation input is not a file: ${path}`)
    const bytes = readFileSync(absolutePath)
    digests[path] = { bytes: bytes.length, sha256: sha256(bytes) }
  }
  return sortedRecord(digests)
}

function sameDigests(left: Record<string, MapFileDigest>, right: Record<string, MapFileDigest>): boolean {
  return JSON.stringify(sortedRecord(left)) === JSON.stringify(sortedRecord(right))
}

function snapshotPayload(snapshot: MapSnapshot): object {
  return {
    capturedAt: snapshot.capturedAt,
    baseSha: snapshot.baseSha,
    repositoryRoot: snapshot.repositoryRoot,
    schemaVersion: snapshot.schemaVersion,
    targetSha: snapshot.targetSha,
    files: sortedRecord(snapshot.files),
  }
}

function snapshotHash(snapshot: MapSnapshot): string {
  return sha256(JSON.stringify(snapshotPayload(snapshot)))
}

export function captureMapSnapshot(
  repoRoot: string,
  options: MapSnapshotOptions,
): MapSnapshot {
  const canonicalRepoRoot = realpathSync(repoRoot)
  mapDirectory(canonicalRepoRoot)
  const files: Record<string, MapSnapshotFile> = {}
  for (const file of listMapFiles(canonicalRepoRoot)) {
    files[file.path] = {
      bytes: file.bytes.length,
      contentBase64: file.bytes.toString('base64'),
      sha256: sha256(file.bytes),
    }
  }
  const snapshot: MapSnapshot = {
    capturedAt: now(),
    baseSha: options.baseSha,
    repositoryRoot: canonicalRepoRoot,
    schemaVersion: REFRESH_STATE_SCHEMA_VERSION,
    snapshotSha256: '',
    targetSha: options.targetSha,
    files: sortedRecord(files),
  }
  snapshot.snapshotSha256 = snapshotHash(snapshot)
  return snapshot
}

export function assertMapSnapshotIntegrity(snapshot: MapSnapshot): void {
  if (snapshot.schemaVersion !== REFRESH_STATE_SCHEMA_VERSION) {
    throw new Error(`unsupported map snapshot schema: ${snapshot.schemaVersion}`)
  }
  const decodedFiles: Record<string, MapFileDigest> = {}
  for (const [path, file] of Object.entries(snapshot.files)) {
    if (!mapPathIsSafe(path)) throw new Error(`unsafe map snapshot path: ${path}`)
    const bytes = Buffer.from(file.contentBase64, 'base64')
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) {
      throw new Error(`map snapshot content checksum mismatch: ${path}`)
    }
    decodedFiles[path] = { bytes: file.bytes, sha256: file.sha256 }
  }
  if (snapshotHash(snapshot) !== snapshot.snapshotSha256) {
    throw new Error('map snapshot metadata checksum mismatch')
  }
  if (Object.keys(decodedFiles).length !== Object.keys(snapshot.files).length) {
    throw new Error('map snapshot file set checksum failure')
  }
}

export function compareMapSnapshot(
  snapshot: MapSnapshot,
  repoRoot: string,
): { changed: string[]; extra: string[]; missing: string[] } {
  assertMapSnapshotIntegrity(snapshot)
  const actual = mapDigests(repoRoot)
  const expected = Object.fromEntries(
    Object.entries(snapshot.files).map(([path, file]) => [path, { bytes: file.bytes, sha256: file.sha256 }]),
  )
  const changed: string[] = []
  const missing: string[] = []
  const extra: string[] = []
  for (const path of Object.keys(expected)) {
    if (!actual[path]) missing.push(path)
    else if (JSON.stringify(actual[path]) !== JSON.stringify(expected[path])) changed.push(path)
  }
  for (const path of Object.keys(actual)) if (!expected[path]) extra.push(path)
  return { changed: changed.sort(), extra: extra.sort(), missing: missing.sort() }
}

export function reconstructMapSnapshot(snapshot: MapSnapshot, destinationRoot: string): void {
  assertMapSnapshotIntegrity(snapshot)
  const root = assertDirectory(destinationRoot, 'snapshot reconstruction directory')
  for (const [path, file] of Object.entries(snapshot.files)) {
    if (!mapPathIsSafe(path)) throw new Error(`unsafe map snapshot path: ${path}`)
    const destination = resolve(root, path)
    if (!isWithin(root, destination)) throw new Error(`snapshot path escapes destination: ${path}`)
    const parent = dirname(destination)
    ensureDirectory(parent, 'snapshot reconstruction parent')
    assertSafeFilePath(destination, root, 'snapshot reconstruction file')
    writeFileAtomicDurableSync(destination, Buffer.from(file.contentBase64, 'base64'), { mode: 0o600 })
  }
}

function runGit(repoRoot: string, args: string[], allowFailure = false): Buffer {
  const result = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'buffer' })
  if (result.error) throw result.error
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '')
  if (result.status !== 0 && !allowFailure) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : String(result.stderr ?? '')
    throw new Error(`git ${args.join(' ')} failed: ${stderr.trim() || `exit ${result.status}`}`)
  }
  return stdout
}

function runText(repoRoot: string, args: string[], allowFailure = false): string {
  return runGit(repoRoot, args, allowFailure).toString('utf8')
}

function gitCommitExists(repoRoot: string, commit: string): boolean {
  const result = spawnSync('git', ['-C', repoRoot, 'cat-file', '-e', `${commit}^{commit}`], {
    encoding: 'utf8',
  })
  return result.status === 0
}

function isAncestor(repoRoot: string, ancestor: string, target: string): boolean {
  const result = spawnSync('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', ancestor, target], {
    encoding: 'utf8',
  })
  return result.status === 0
}

function mergeBase(repoRoot: string, left: string, right: string): string | null {
  const output = runText(repoRoot, ['merge-base', left, right], true).trim()
  return output || null
}

function latestProcessedSourceSha(memory: string): string | null {
  const matches = [...memory.matchAll(/^\s*- Processed source SHA:\s*(\S+)\s*$/gm)]
  return matches[0]?.[1] ?? null
}

export function classifyCursor(
  resolution: Pick<CursorResolution, 'cursorCandidate' | 'cursorCommitValid' | 'ancestorOfTarget' | 'memoryFound' | 'mergeBase'>,
  targetSha: string,
): CursorResolution {
  if (resolution.cursorCandidate && resolution.cursorCommitValid && resolution.ancestorOfTarget) {
    return {
      ...resolution,
      comparisonBasis: `${resolution.cursorCandidate}..${targetSha}`,
      coverageMode: 'incremental',
      usableCursor: true,
    }
  }
  if (resolution.cursorCandidate && resolution.cursorCommitValid) {
    return {
      ...resolution,
      comparisonBasis: resolution.mergeBase
        ? `divergent cursor; merge-base ${resolution.mergeBase}; branch-specific reconciliation required`
        : 'divergent cursor with no merge base; full-tree reconciliation required',
      coverageMode: 'divergence-pending',
      usableCursor: false,
    }
  }
  return {
    ...resolution,
    comparisonBasis: resolution.memoryFound
      ? 'cursor candidate invalid; full-tree baseline required'
      : 'memory missing; full-tree baseline required',
    coverageMode: 'baseline-partial',
    usableCursor: false,
  }
}

export function resolveCursor(
  repoRoot: string,
  memoryPath: string,
  targetSha: string,
): CursorResolution {
  const memoryFound = existsSync(memoryPath)
  const memory = memoryFound ? readFileSync(memoryPath, 'utf8') : ''
  const cursorCandidate = latestProcessedSourceSha(memory)
  const cursorCommitValid = cursorCandidate ? gitCommitExists(repoRoot, cursorCandidate) : false
  const ancestorOfTarget = cursorCandidate && cursorCommitValid
    ? isAncestor(repoRoot, cursorCandidate, targetSha)
    : false
  const mergeBaseValue = cursorCandidate && cursorCommitValid && !ancestorOfTarget
    ? mergeBase(repoRoot, cursorCandidate, targetSha)
    : null
  return classifyCursor(
    {
      ancestorOfTarget,
      cursorCandidate,
      cursorCommitValid,
      memoryFound,
      mergeBase: mergeBaseValue,
    },
    targetSha,
  )
}

function parseChangedPaths(output: Buffer): ChangedPath[] {
  const fields = output.toString('utf8').split('\0').filter(Boolean)
  const changed: ChangedPath[] = []
  for (let index = 0; index < fields.length;) {
    const status = fields[index++]!
    const kind = status[0]
    if (kind === 'R' || kind === 'C') {
      const previousPath = fields[index++]
      const path = fields[index++]
      if (!previousPath || !path) throw new Error('malformed rename record from git diff')
      changed.push({ path, previousPath, status })
    } else {
      const path = fields[index++]
      if (!path) throw new Error('malformed path record from git diff')
      changed.push({ path, status })
    }
  }
  return changed
}

function changedPathsForRange(repoRoot: string, cursor: string, target: string): ChangedPath[] {
  return parseChangedPaths(runGit(repoRoot, ['diff', '--name-status', '-z', '--find-renames', cursor, target, '--']))
}

function allPathsAtTarget(repoRoot: string, target: string): string[] {
  return runGit(repoRoot, ['ls-tree', '-r', '-z', '--name-only', target, '--'])
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
}

function withTargetTree<T>(repoRoot: string, targetSha: string, callback: (sourceRoot: string) => T): T {
  const targetDirectory = mkdtempSync(join(tmpdir(), 'workspace-map-target-'))
  const archivePath = join(targetDirectory, 'source.tar')
  try {
    writeFileSync(archivePath, runGit(repoRoot, ['archive', '--format=tar', targetSha]), { flag: 'wx', mode: 0o600 })
    const result = spawnSync('tar', ['-xf', archivePath, '-C', targetDirectory], { encoding: 'utf8' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`tar failed: ${String(result.stderr ?? '').trim()}`)
    return callback(targetDirectory)
  } finally {
    rmSync(targetDirectory, { force: true, recursive: true })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`invalid ${label}`)
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`invalid ${label}`)
  }
}

function assertDigestRecord(value: unknown, label: string): asserts value is Record<string, MapFileDigest> {
  if (!isRecord(value)) throw new Error(`invalid ${label}`)
  for (const [path, digest] of Object.entries(value)) {
    if (!isRecord(digest) || !Number.isInteger(digest.bytes) || digest.bytes < 0 ||
      typeof digest.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(digest.sha256)) {
      throw new Error(`invalid ${label}: ${path}`)
    }
  }
}

function assertSnapshotReference(value: unknown, label: string): asserts value is SnapshotReference {
  if (!isRecord(value) || !Number.isInteger(value.bytes) || value.bytes < 0 ||
    typeof value.path !== 'string' ||
    typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error(`invalid ${label}`)
  }
}

function assertAuditInput(value: unknown): asserts value is RefreshAuditInput {
  if (!isRecord(value) || value.schemaVersion !== REFRESH_STATE_SCHEMA_VERSION) {
    throw new Error('invalid refresh audit evidence')
  }
  assertString(value.runId, 'refresh audit run id')
  assertString(value.targetSha, 'refresh audit target SHA')
  if (!['incremental', 'baseline-partial', 'baseline-complete', 'divergence-pending', 'divergence-reconciled'].includes(String(value.coverageMode))) {
    throw new Error('invalid refresh audit coverage mode')
  }
  assertStringArray(value.auditedPaths, 'refresh audit paths')
  assertStringArray(value.structuralQueue, 'refresh audit structural queue')
  assertStringArray(value.resolvedStructuralQueue, 'refresh audit resolved structural queue')
  if (value.pathIntegrity !== 'pass' || value.orphanScan !== 'pass') {
    throw new Error('refresh audit did not pass path and orphan checks')
  }
}

function assertAuditEvidence(value: unknown): asserts value is RefreshAuditEvidence {
  assertAuditInput(value)
  assertString(value.mapTreeHash, 'refresh audit map tree hash')
}

function assertManifestShape(value: unknown): asserts value is RefreshManifest {
  if (!isRecord(value) || value.schemaVersion !== REFRESH_STATE_SCHEMA_VERSION) {
    throw new Error(`unsupported refresh manifest schema: ${isRecord(value) ? String(value.schemaVersion) : 'unknown'}`)
  }
  for (const key of [
    'baseSha', 'branch', 'comparisonBasis', 'createdAt', 'repositoryRoot',
    'runId', 'targetSha', 'updatedAt',
  ]) assertString(value[key], `refresh manifest ${key}`)
  validateRunId(value.runId)
  if (!['incremental', 'baseline-partial', 'baseline-complete', 'divergence-pending', 'divergence-reconciled'].includes(String(value.coverageMode))) {
    throw new Error('invalid refresh manifest coverage mode')
  }
  if (!['in-progress', 'published', 'complete', 'blocked'].includes(String(value.status))) {
    throw new Error('invalid refresh manifest status')
  }
  for (const key of ['blockers', 'pendingPaths', 'structuralQueue']) {
    assertStringArray(value[key], `refresh manifest ${key}`)
  }
  if (typeof value.cursorBefore !== 'string' && value.cursorBefore !== null) throw new Error('invalid refresh manifest cursor')
  if (typeof value.memoryUpdated !== 'boolean') throw new Error('invalid refresh manifest memory flag')
  assertDigestRecord(value.initialMapFiles, 'refresh manifest initial map files')
  assertDigestRecord(value.validationInputs, 'refresh manifest validation inputs')
  if (value.snapshot !== null) assertSnapshotReference(value.snapshot, 'refresh manifest snapshot')
  if (value.patch !== null) assertSnapshotReference(value.patch, 'refresh manifest patch')
  if (value.validation !== null) {
    if (!isRecord(value.validation) || !Number.isInteger(value.validation.mapCount)) throw new Error('invalid refresh manifest validation')
    assertStringArray(value.validation.errors, 'refresh manifest validation errors')
    assertStringArray(value.validation.warnings, 'refresh manifest validation warnings')
    assertString(value.validation.checkedAt, 'refresh manifest validation timestamp')
    assertString(value.validation.sourceTargetSha, 'refresh manifest validation target')
  }
  if (value.audit !== null) assertAuditEvidence(value.audit)
  if (value.status === 'complete' && (!value.memoryUpdated || value.snapshot === null || value.patch === null || value.audit === null)) {
    throw new Error('complete refresh manifest lacks completion metadata')
  }
  if ((value.status === 'published' || value.status === 'complete') && value.audit === null) {
    throw new Error('published refresh manifest lacks audit evidence')
  }
  if (value.memoryUpdated && value.status !== 'complete') throw new Error('refresh memory flag does not match status')
}

function readManifest(paths: StatePaths): RefreshManifest {
  if (!existsSync(paths.currentManifest)) throw new Error(`refresh manifest is missing: ${paths.currentManifest}`)
  const manifest = readStateJson<unknown>(paths.currentManifest, paths)
  assertManifestShape(manifest)
  return manifest
}

function writeManifest(manifest: RefreshManifest, paths: StatePaths): void {
  assertManifestShape(manifest)
  writeStateJson(paths.currentManifest, manifest, paths)
}

function assertValidationInputsUnchanged(repoRoot: string, manifest: RefreshManifest): void {
  if (!sameDigests(manifest.validationInputs, validationInputDigests(repoRoot))) {
    throw new Error('validation inputs changed during refresh; rerun against the new validator state')
  }
}

function snapshotReference(snapshot: MapSnapshot, path: string, bytes: number, artifactSha256: string): SnapshotReference {
  return {
    bytes,
    path,
    sha256: artifactSha256,
  }
}

function patchReference(path: string, patch: string): SnapshotReference {
  return {
    bytes: Buffer.byteLength(patch),
    path,
    sha256: sha256(patch),
  }
}

function trackedPathsAtTarget(repoRoot: string, targetSha: string): Set<string> {
  return new Set(allPathsAtTarget(repoRoot, targetSha).filter(mapPathIsSafe))
}

function buildRecoveryPatch(
  repoRoot: string,
  targetSha: string,
  snapshot: MapSnapshot,
  runId: string,
): string {
  let patch = [
    '# Workspace map refresh recovery snapshot',
    `# run-id: ${runId}`,
    `# target-sha: ${targetSha}`,
    `# snapshot-sha256: ${snapshot.snapshotSha256}`,
    '# The JSON snapshot is authoritative for exact map bytes.',
    '',
  ].join('\n')
  patch += runText(repoRoot, ['diff', '--binary', targetSha, '--', 'docs/maps'])
  const tracked = trackedPathsAtTarget(repoRoot, targetSha)
  for (const path of Object.keys(snapshot.files).sort()) {
    if (tracked.has(path)) continue
    const absolutePath = join(repoRoot, path)
    const result = spawnSync('git', ['-C', repoRoot, 'diff', '--no-index', '--binary', '/dev/null', absolutePath], {
      encoding: 'utf8',
    })
    if (result.error) throw result.error
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(`git diff could not snapshot untracked map: ${path}`)
    }
    patch += String(result.stdout ?? '')
  }
  return patch
}

function storeArtifacts(
  snapshot: MapSnapshot,
  patch: string,
  paths: StatePaths,
): { patch: SnapshotReference; snapshot: SnapshotReference } {
  const snapshotRelativePath = 'last-run.snapshot.json'
  const snapshotPath = paths.currentSnapshot
  const snapshotText = `${JSON.stringify(snapshot, null, 2)}\n`
  writeStateText(snapshotPath, snapshotText, paths)

  const patchRelativePath = 'last-run.patch'
  writeStateText(paths.currentPatch, patch, paths)

  return {
    patch: patchReference(patchRelativePath, patch),
    snapshot: snapshotReference(snapshot, snapshotRelativePath, Buffer.byteLength(snapshotText), sha256(snapshotText)),
  }
}

function snapshotFromReference(reference: SnapshotReference, paths: StatePaths): MapSnapshot {
  if (reference.path !== 'last-run.snapshot.json') throw new Error('refresh snapshot path is not current')
  const snapshotPath = resolve(paths.stateDir, reference.path)
  assertSafeFilePath(snapshotPath, paths.stateDir, 'refresh snapshot artifact')
  const snapshotText = readFileSync(snapshotPath, 'utf8')
  if (Buffer.byteLength(snapshotText) !== reference.bytes || sha256(snapshotText) !== reference.sha256) {
    throw new Error('refresh snapshot artifact checksum mismatch')
  }
  const snapshot = JSON.parse(snapshotText) as MapSnapshot
  assertMapSnapshotIntegrity(snapshot)
  return snapshot
}

function changedMapFiles(
  initial: Record<string, MapFileDigest>,
  final: MapSnapshot,
): string[] {
  const finalDigests = Object.fromEntries(
    Object.entries(final.files).map(([path, file]) => [path, { bytes: file.bytes, sha256: file.sha256 }]),
  )
  const paths = new Set([...Object.keys(initial), ...Object.keys(finalDigests)])
  return [...paths].filter(path => JSON.stringify(initial[path]) !== JSON.stringify(finalDigests[path])).sort()
}

function snapshotMapTreeHash(snapshot: MapSnapshot): string {
  const digests = Object.fromEntries(
    Object.entries(snapshot.files).map(([path, file]) => [path, { bytes: file.bytes, sha256: file.sha256 }]),
  )
  return mapTreeHash(digests)
}

function validateAuditForPublish(
  audit: RefreshAuditInput | undefined,
  manifest: RefreshManifest,
  snapshot: MapSnapshot,
  finalCoverageMode: CoverageMode,
): RefreshAuditEvidence {
  if (!audit) throw new Error('complete publish requires a refresh audit evidence file')
  assertAuditInput(audit)
  validateRunId(audit.runId)
  if (audit.runId !== manifest.runId) throw new Error('refresh audit run id does not match the manifest')
  if (audit.targetSha !== manifest.targetSha) throw new Error('refresh audit target SHA does not match the manifest')
  if (audit.coverageMode !== finalCoverageMode) throw new Error('refresh audit coverage mode does not match the publish')

  const expectedPaths = [...new Set(manifest.pendingPaths)].sort()
  const auditedPaths = [...new Set(audit.auditedPaths)].sort()
  if (JSON.stringify(auditedPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error('refresh audit does not cover exactly the pending paths')
  }
  if (audit.structuralQueue.length > 0) throw new Error('refresh audit leaves structural work unresolved')
  const expectedStructural = [...manifest.structuralQueue].sort()
  const resolvedStructural = [...new Set(audit.resolvedStructuralQueue)].sort()
  if (JSON.stringify(resolvedStructural) !== JSON.stringify(expectedStructural)) {
    throw new Error('refresh audit does not account for the structural queue')
  }
  return {
    ...audit,
    auditedPaths,
    structuralQueue: [],
    resolvedStructuralQueue: resolvedStructural,
    mapTreeHash: snapshotMapTreeHash(snapshot),
  }
}

function appendMemoryEntry(
  paths: StatePaths,
  manifest: RefreshManifest,
  snapshot: MapSnapshot,
  validation: RefreshValidation,
): void {
  const existing = existsSync(paths.memory) ? readFileSync(paths.memory, 'utf8') : ''
  const entries = existing.split(/(?=^Last run:\s)/m).filter(entry => entry.trim())
  const entry = [
    `Last run: ${new Date().toISOString()}`,
    '',
    `- Run ID: ${manifest.runId}`,
    `- Processed source SHA: ${manifest.targetSha}`,
    `- Scan branch: ${manifest.branch}`,
    `- Coverage mode: ${manifest.coverageMode}`,
    `- Processed range: ${manifest.comparisonBasis}.`,
    `- Changed paths: ${manifest.changedPaths.length}; audited paths: ${manifest.audit?.auditedPaths.length ?? 0}.`,
    `- Map files edited: ${changedMapFiles(manifest.initialMapFiles, snapshot).join(', ') || 'none detected'}.`,
    `- Verification: ${validation.mapCount} maps, ${validation.errors.length} errors, ${validation.warnings.length} warnings.`,
    `- Map snapshot: ${manifest.snapshot?.path ?? 'none'} (${snapshot.snapshotSha256}).`,
    `- Recovery patch: ${manifest.patch?.path ?? 'none'} (${manifest.patch?.sha256 ?? 'none'}).`,
    '- Flags: uncommitted source excluded from claims; map snapshot is exact final working-tree content.',
  ].join('\n')
  const withoutDuplicate = entries.filter(previous => previous.match(/^\s*- Run ID:\s*(\S+)\s*$/m)?.[1] !== manifest.runId)
  const next = [entry, ...withoutDuplicate].slice(0, 5).join('\n\n') + '\n'
  writeStateText(paths.memory, next, paths)
}

function memoryContainsRun(paths: StatePaths, runId: string): boolean {
  if (!existsSync(paths.memory)) return false
  return new RegExp(`^\\s*- Run ID:\\s*${runId.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*$`, 'm').test(
    readFileSync(paths.memory, 'utf8'),
  )
}

function currentIdentity(repoRoot: string): { branch: string; repositoryRoot: string; targetSha: string } {
  const repositoryRoot = realpathSync(runText(repoRoot, ['rev-parse', '--show-toplevel']).trim())
  const expectedRoot = realpathSync(repoRoot)
  if (repositoryRoot !== expectedRoot) throw new Error(`repository root mismatch: ${repositoryRoot}`)
  return {
    branch: runText(repoRoot, ['branch', '--show-current']).trim() || '(detached)',
    repositoryRoot,
    targetSha: runText(repoRoot, ['rev-parse', 'HEAD']).trim(),
  }
}

function assertTargetIdentity(repoRoot: string, manifest: RefreshManifest): void {
  const identity = currentIdentity(repoRoot)
  if (identity.repositoryRoot !== manifest.repositoryRoot) throw new Error('repository identity changed during refresh')
  if (identity.targetSha !== manifest.targetSha) throw new Error(`HEAD moved during refresh: expected ${manifest.targetSha}, found ${identity.targetSha}`)
  if (identity.branch !== manifest.branch) throw new Error(`branch changed during refresh: expected ${manifest.branch}, found ${identity.branch}`)
}

function acquireRefreshLock(paths: StatePaths): () => void {
  assertNoSymlinkComponents(paths.stateDir, 'refresh state directory')
  assertSafeFilePath(paths.lockTarget, paths.stateDir, 'refresh lock')
  return acquireMutationLockSync(paths.lockTarget, {
    label: 'workspace map refresh',
    waitMs: 5_000,
  })
}

export function startRefreshRun(options: StartRefreshRunOptions): RefreshManifest {
  const paths = statePaths(options.stateDir)
  const release = acquireRefreshLock(paths)
  try {
    if (existsSync(paths.currentManifest)) {
      const previous = readManifest(paths)
      if (previous.status === 'in-progress') {
        throw new Error(`refresh run ${previous.runId} is still in progress; recover or inspect it first`)
      }
      if (previous.status === 'published' && !previous.memoryUpdated) {
        throw new Error(`refresh run ${previous.runId} needs memory recovery before a new run`)
      }
    }
    const identity = currentIdentity(options.repoRoot)
    const resolution = resolveCursor(options.repoRoot, paths.memory, identity.targetSha)
    const runId = validateRunId(options.runId ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`)
    if (existsSync(paths.currentManifest) && readManifest(paths).runId === runId) {
      throw new Error(`refresh run id has already been used: ${runId}`)
    }
    const changedPaths = resolution.usableCursor
      ? changedPathsForRange(options.repoRoot, resolution.cursorCandidate!, identity.targetSha)
      : allPathsAtTarget(options.repoRoot, identity.targetSha).map(path => ({ path, status: 'BASELINE' }))
    const initialMapFiles = mapDigests(options.repoRoot)
    const validationInputs = validationInputDigests(options.repoRoot)
    const manifest: RefreshManifest = {
      baseSha: resolution.usableCursor ? resolution.cursorCandidate! : identity.targetSha,
      blockers: [],
      branch: identity.branch,
      changedPaths,
      comparisonBasis: resolution.comparisonBasis,
      coverageMode: resolution.coverageMode,
      createdAt: now(),
      cursorBefore: resolution.usableCursor ? resolution.cursorCandidate : null,
      initialMapFiles,
      memoryUpdated: false,
      pendingPaths: changedPaths.map(change => change.path),
      repositoryRoot: identity.repositoryRoot,
      runId,
      schemaVersion: REFRESH_STATE_SCHEMA_VERSION,
      snapshot: null,
      status: 'in-progress',
      structuralQueue: resolution.usableCursor ? [] : ['Complete a full-tree baseline before creating a trusted cursor.'],
      targetSha: identity.targetSha,
      updatedAt: now(),
      validation: null,
      validationInputs,
      patch: null,
      audit: null,
    }
    writeManifest(manifest, paths)
    return manifest
  } finally {
    release()
  }
}

function stableValidatedSnapshot(
  repoRoot: string,
  manifest: RefreshManifest,
): { snapshot: MapSnapshot; validation: RefreshValidation } {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = captureMapSnapshot(repoRoot, {
      baseSha: manifest.baseSha,
      targetSha: manifest.targetSha,
    })
    const result = withTargetTree(repoRoot, manifest.targetSha, sourceRoot =>
      validateWorkspaceMaps(repoRoot, { sourceRoot }),
    )
    const after = captureMapSnapshot(repoRoot, {
      baseSha: manifest.baseSha,
      targetSha: manifest.targetSha,
    })
    if (snapshotMapTreeHash(before) === snapshotMapTreeHash(after)) {
      const validation: RefreshValidation = {
        ...result,
        checkedAt: now(),
        sourceTargetSha: manifest.targetSha,
      }
      return { snapshot: after, validation }
    }
  }
  throw new Error('workspace maps changed during validation; no stable snapshot was published')
}

export function publishRefreshRun(options: PublishRefreshRunOptions): PublishRefreshRunResult {
  const paths = statePaths(options.stateDir)
  const release = acquireRefreshLock(paths)
  try {
    const manifest = readManifest(paths)
    if (manifest.runId !== validateRunId(options.runId)) throw new Error('refresh run id does not match the current manifest')
    assertTargetIdentity(options.repoRoot, manifest)
    assertValidationInputsUnchanged(options.repoRoot, manifest)

    const finalCoverageMode = options.status === 'complete'
      ? manifest.coverageMode === 'baseline-partial'
        ? 'baseline-complete'
        : manifest.coverageMode === 'divergence-pending'
          ? 'divergence-reconciled'
          : manifest.coverageMode
      : manifest.coverageMode

    const { snapshot, validation } = stableValidatedSnapshot(options.repoRoot, manifest)
    const reconstructionDirectory = mkdtempSync(join(tmpdir(), 'workspace-map-reconstruct-'))
    try {
      reconstructMapSnapshot(snapshot, reconstructionDirectory)
      const reconstructionDiff = compareMapSnapshot(snapshot, reconstructionDirectory)
      if (reconstructionDiff.changed.length || reconstructionDiff.extra.length || reconstructionDiff.missing.length) {
        throw new Error(`snapshot reconstruction mismatch: ${JSON.stringify(reconstructionDiff)}`)
      }
    } finally {
      rmSync(reconstructionDirectory, { force: true, recursive: true })
    }

    const errors = validation.errors
    const blockers = [...new Set([
      ...(manifest.blockers ?? []),
      ...(options.blockers ?? []),
      ...errors.map(error => `validator: ${error}`),
      ...(options.status === 'blocked' && (options.blockers?.length ?? 0) === 0 && errors.length === 0
        ? ['refresh explicitly blocked by caller']
        : []),
    ])]
    const completeRequested = options.status === 'complete'
    const canComplete = completeRequested && blockers.length === 0
    const audit = canComplete
      ? validateAuditForPublish(options.audit, manifest, snapshot, finalCoverageMode)
      : null

    const patch = buildRecoveryPatch(options.repoRoot, manifest.targetSha, snapshot, manifest.runId)
    const finalMapDrift = compareMapSnapshot(snapshot, options.repoRoot)
    if (finalMapDrift.changed.length || finalMapDrift.extra.length || finalMapDrift.missing.length) {
      throw new Error('workspace maps changed after validation; retry the publish')
    }
    assertTargetIdentity(options.repoRoot, manifest)
    assertValidationInputsUnchanged(options.repoRoot, manifest)
    const artifacts = storeArtifacts(snapshot, patch, paths)
    const published: RefreshManifest = {
      ...manifest,
      blockers,
      coverageMode: finalCoverageMode,
      memoryUpdated: false,
      pendingPaths: canComplete ? [] : manifest.pendingPaths,
      patch: artifacts.patch,
      snapshot: artifacts.snapshot,
      status: canComplete ? 'published' : 'blocked',
      structuralQueue: canComplete ? audit!.structuralQueue : manifest.structuralQueue,
      updatedAt: now(),
      validation,
      audit,
    }
    writeManifest(published, paths)

    if (canComplete) {
      const preMemoryDrift = compareMapSnapshot(snapshot, options.repoRoot)
      if (preMemoryDrift.changed.length || preMemoryDrift.extra.length || preMemoryDrift.missing.length) {
        throw new Error('workspace maps changed before cursor advancement; retry the publish')
      }
      assertTargetIdentity(options.repoRoot, manifest)
      appendMemoryEntry(paths, published, snapshot, validation)
      const complete: RefreshManifest = {
        ...published,
        memoryUpdated: true,
        status: 'complete',
        updatedAt: now(),
      }
      writeManifest(complete, paths)
      return { manifest: complete, requestedStatus: options.status, status: 'complete' as const }
    }

    const result = { manifest: published, requestedStatus: options.status, status: 'blocked' as const }
    return result
  } finally {
    release()
  }
}

export function recoverPublishedRun(stateDir: string): RefreshManifest {
  const paths = statePaths(stateDir)
  const release = acquireRefreshLock(paths)
  try {
    const manifest = readManifest(paths)
    if (manifest.status === 'in-progress') {
      const blocked: RefreshManifest = {
        ...manifest,
        blockers: [...new Set([
          ...(manifest.blockers ?? []),
          'refresh interrupted before publication; rerun required',
        ])],
        status: 'blocked',
        updatedAt: now(),
      }
      writeManifest(blocked, paths)
      return blocked
    }
    if (manifest.status !== 'published') return manifest
    if (!manifest.snapshot || !manifest.patch || !manifest.validation || !manifest.audit) {
      throw new Error(`published refresh ${manifest.runId} lacks recovery metadata`)
    }
    assertTargetIdentity(manifest.repositoryRoot, manifest)
    const snapshot = snapshotFromReference(manifest.snapshot, paths)
    if (
      snapshot.repositoryRoot !== manifest.repositoryRoot ||
      snapshot.targetSha !== manifest.targetSha
    ) {
      throw new Error(`published refresh ${manifest.runId} snapshot identity does not match its manifest`)
    }
    if (manifest.audit.runId !== manifest.runId || manifest.audit.targetSha !== manifest.targetSha ||
      manifest.audit.coverageMode !== manifest.coverageMode || manifest.audit.mapTreeHash !== snapshotMapTreeHash(snapshot)) {
      throw new Error(`published refresh ${manifest.runId} audit evidence does not match its snapshot`)
    }
    if (!memoryContainsRun(paths, manifest.runId)) {
      const mapDrift = compareMapSnapshot(snapshot, manifest.repositoryRoot)
      if (mapDrift.changed.length || mapDrift.extra.length || mapDrift.missing.length) {
        throw new Error(`published refresh map snapshot no longer matches the working tree: ${JSON.stringify(mapDrift)}`)
      }
    }
    const patchPath = resolve(paths.stateDir, manifest.patch.path)
    assertSafeFilePath(patchPath, paths.stateDir, 'refresh patch artifact')
    if (!existsSync(patchPath)) throw new Error(`published refresh patch is missing: ${manifest.patch.path}`)
    const patch = readFileSync(patchPath, 'utf8')
    if (Buffer.byteLength(patch) !== manifest.patch.bytes || sha256(patch) !== manifest.patch.sha256) {
      throw new Error('refresh patch artifact checksum mismatch')
    }
    for (const marker of [
      `# run-id: ${manifest.runId}`,
      `# target-sha: ${manifest.targetSha}`,
      `# snapshot-sha256: ${snapshot.snapshotSha256}`,
    ]) {
      if (!patch.includes(marker)) throw new Error(`published refresh patch is missing identity marker: ${marker}`)
    }
    if (!memoryContainsRun(paths, manifest.runId)) appendMemoryEntry(paths, manifest, snapshot, manifest.validation)
    const complete: RefreshManifest = {
      ...manifest,
      memoryUpdated: true,
      status: 'complete',
      updatedAt: now(),
    }
    writeManifest(complete, paths)
    return complete
  } finally {
    release()
  }
}

function optionValues(args: Map<string, string[]>, name: string): string[] {
  return args.get(name) ?? []
}

function parseCliArgs(argv: string[]): { command: string; options: Map<string, string[]> } {
  const [command = 'help', ...rest] = argv
  const options = new Map<string, string[]>()
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`)
    const equals = token.indexOf('=')
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals)
    const inlineValue = equals === -1 ? undefined : token.slice(equals + 1)
    const next = inlineValue ?? (rest[index + 1]?.startsWith('--') ? undefined : rest[++index])
    const values = options.get(name) ?? []
    values.push(next ?? 'true')
    options.set(name, values)
  }
  return { command, options }
}

function requiredOption(options: Map<string, string[]>, name: string): string {
  const value = optionValues(options, name)[0]
  if (!value || value === 'true') throw new Error(`missing --${name}`)
  return value
}

function readAuditOption(options: Map<string, string[]>): RefreshAuditInput | undefined {
  const path = optionValues(options, 'audit-file')[0]
  if (!path) return undefined
  const audit = JSON.parse(readFileSync(path, 'utf8')) as unknown
  assertAuditInput(audit)
  return audit
}

function assertKnownOptions(command: string, options: Map<string, string[]>): void {
  const allowed = command === 'start'
    ? new Set(['help', 'repo-root', 'run-id', 'state-dir'])
    : command === 'publish'
      ? new Set(['help', 'audit-file', 'blocker', 'repo-root', 'run-id', 'state-dir', 'status'])
      : command === 'recover'
        ? new Set(['help', 'state-dir'])
        : new Set(['help'])
  for (const name of options.keys()) {
    if (!allowed.has(name)) throw new Error(`unknown option: --${name}`)
  }
}

function cliUsage(): string {
  return [
    'Usage:',
    '  bun run ./scripts/workspaceMapRefreshState.ts start --repo-root <path> --state-dir <path>',
    '  bun run ./scripts/workspaceMapRefreshState.ts publish --repo-root <path> --state-dir <path> --run-id <id> --status <complete|blocked> [--audit-file <path>]',
    '  bun run ./scripts/workspaceMapRefreshState.ts recover --state-dir <path>',
    '',
    'A complete publish requires an audit file bound to this run, target, map snapshot, and pending-path set.',
  ].join('\n')
}

if (import.meta.main) {
  try {
    const { command, options } = parseCliArgs(process.argv.slice(2))
    assertKnownOptions(command, options)
    if (command === 'help' || options.has('help')) {
      console.log(cliUsage())
    } else if (command === 'start') {
      const manifest = startRefreshRun({
        repoRoot: optionValues(options, 'repo-root')[0] ?? process.cwd(),
        runId: optionValues(options, 'run-id')[0],
        stateDir: requiredOption(options, 'state-dir'),
      })
      console.log(JSON.stringify(manifest, null, 2))
    } else if (command === 'publish') {
      const status = requiredOption(options, 'status')
      if (status !== 'complete' && status !== 'blocked') throw new Error(`invalid publish status: ${status}`)
      const result = publishRefreshRun({
        audit: readAuditOption(options),
        blockers: optionValues(options, 'blocker'),
        repoRoot: optionValues(options, 'repo-root')[0] ?? process.cwd(),
        runId: requiredOption(options, 'run-id'),
        stateDir: requiredOption(options, 'state-dir'),
        status,
      })
      console.log(JSON.stringify(result, null, 2))
      if (status === 'complete' && result.status !== 'complete') process.exitCode = 1
    } else if (command === 'recover') {
      const manifest = recoverPublishedRun(requiredOption(options, 'state-dir'))
      console.log(JSON.stringify(manifest, null, 2))
    } else {
      throw new Error(`unknown command: ${command}\n\n${cliUsage()}`)
    }
  } catch (error) {
    console.error(`workspace-map-refresh: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
