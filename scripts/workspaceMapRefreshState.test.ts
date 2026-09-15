import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertMapSnapshotIntegrity,
  captureMapSnapshot,
  classifyCursor,
  compareMapSnapshot,
  publishRefreshRun,
  recoverPublishedRun,
  reconstructMapSnapshot,
  resolveCursor,
  startRefreshRun,
  type CoverageMode,
} from './workspaceMapRefreshState.js'

function auditFor(run: {
  coverageMode: CoverageMode
  pendingPaths: string[]
  runId: string
  structuralQueue: string[]
  targetSha: string
}, coverageMode: CoverageMode = run.coverageMode) {
  return {
    auditedPaths: run.pendingPaths,
    coverageMode,
    orphanScan: 'pass' as const,
    pathIntegrity: 'pass' as const,
    resolvedStructuralQueue: run.structuralQueue,
    runId: run.runId,
    schemaVersion: 1 as const,
    structuralQueue: [],
    targetSha: run.targetSha,
  }
}

const roots: string[] = []

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim()
}

function createRepository(): { commit: string; repoRoot: string; stateDir: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'workspace-map-refresh-repo-'))
  const stateDir = mkdtempSync(join(tmpdir(), 'workspace-map-refresh-state-'))
  roots.push(repoRoot, stateDir)
  mkdirSync(join(repoRoot, 'docs', 'maps'), { recursive: true })
  mkdirSync(join(repoRoot, 'src'), { recursive: true })
  writeFileSync(join(repoRoot, 'src', 'owner.ts'), 'export const owner = 1\n')
  writeFileSync(
    join(repoRoot, 'docs', 'maps', 'WORKSPACE_MAP.md'),
    '# Workspace Map\n\nLast refreshed: 2026-09-05\n\n## Map Index\n\n| Sub-map | Scope | Last refreshed |\n|---|---|---|\n| [`docs/maps/domain.md`](domain.md) | Domain. | 2026-09-05 |\n',
  )
  writeFileSync(
    join(repoRoot, 'docs', 'maps', 'domain.md'),
    '# Domain\n\nLast refreshed: 2026-09-05\n\n## First Files To Inspect\n\n- `src/owner.ts`\n\n## Tests And Validation\n\n- Read it.\n\n## Traps And Stale Assumptions\n\n- None.\n',
  )
  git(repoRoot, ['init', '-q'])
  git(repoRoot, ['config', 'user.email', 'workspace-map-test@example.com'])
  git(repoRoot, ['config', 'user.name', 'Workspace Map Test'])
  git(repoRoot, ['add', '.'])
  git(repoRoot, ['commit', '-q', '-m', 'initial map fixture'])
  return { commit: git(repoRoot, ['rev-parse', 'HEAD']), repoRoot, stateDir }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

describe('workspace map refresh state', () => {
  test('classifies missing or divergent cursors as unusable', () => {
    const missing = classifyCursor(
      {
        ancestorOfTarget: false,
        cursorCandidate: null,
        cursorCommitValid: false,
        memoryFound: false,
        mergeBase: null,
      },
      'target-sha',
    )
    expect(missing.usableCursor).toBe(false)
    expect(missing.coverageMode).toBe('baseline-partial')
    expect(missing.comparisonBasis).toContain('full-tree baseline required')

    const divergent = classifyCursor(
      {
        ancestorOfTarget: false,
        cursorCandidate: 'old-sha',
        cursorCommitValid: true,
        memoryFound: true,
        mergeBase: 'merge-sha',
      },
      'target-sha',
    )
    expect(divergent.usableCursor).toBe(false)
    expect(divergent.coverageMode).toBe('divergence-pending')
    expect(divergent.comparisonBasis).toContain('merge-base merge-sha')
  })

  test('uses the newest retained memory entry as the cursor', () => {
    const { commit: initialCommit, repoRoot, stateDir } = createRepository()
    writeFileSync(join(repoRoot, 'src', 'owner.ts'), 'export const owner = 2\n')
    git(repoRoot, ['add', 'src/owner.ts'])
    git(repoRoot, ['commit', '-q', '-m', 'second source change'])
    const newestCommit = git(repoRoot, ['rev-parse', 'HEAD'])
    writeFileSync(join(repoRoot, 'src', 'owner.ts'), 'export const owner = 3\n')
    git(repoRoot, ['add', 'src/owner.ts'])
    git(repoRoot, ['commit', '-q', '-m', 'third source change'])
    const targetCommit = git(repoRoot, ['rev-parse', 'HEAD'])
    writeFileSync(
      join(stateDir, 'memory.md'),
      `Last run: 2026-09-05T03:00:00Z\n\n- Processed source SHA: ${newestCommit}\n\nLast run: 2026-09-04T03:00:00Z\n\n- Processed source SHA: ${initialCommit}\n`,
    )

    expect(resolveCursor(repoRoot, join(stateDir, 'memory.md'), targetCommit).cursorCandidate).toBe(newestCommit)
  })

  test('captures exact map bytes, detects working-tree drift, and reconstructs them', () => {
    const { repoRoot } = createRepository()
    const snapshot = captureMapSnapshot(repoRoot, {
      baseSha: 'base-sha',
      targetSha: 'target-sha',
    })
    assertMapSnapshotIntegrity(snapshot)

    const reconstructionRoot = mkdtempSync(join(tmpdir(), 'workspace-map-reconstruction-'))
    roots.push(reconstructionRoot)
    reconstructMapSnapshot(snapshot, reconstructionRoot)
    expect(compareMapSnapshot(snapshot, reconstructionRoot)).toEqual({
      changed: [],
      extra: [],
      missing: [],
    })

    writeFileSync(join(repoRoot, 'docs', 'maps', 'domain.md'), 'changed\n')
    expect(compareMapSnapshot(snapshot, repoRoot).changed).toEqual(['docs/maps/domain.md'])
  })

  test('rejects symlinked map files before they enter a snapshot', () => {
    const { repoRoot } = createRepository()
    const outside = join(repoRoot, '..', 'workspace-map-refresh-outside.md')
    const symlinkPath = join(repoRoot, 'docs', 'maps', 'escape.md')
    writeFileSync(outside, 'outside\n')
    roots.push(outside)
    symlinkSync(outside, symlinkPath)

    expect(() => captureMapSnapshot(repoRoot, {
      baseSha: 'base-sha',
      targetSha: 'target-sha',
    })).toThrow('workspace map is a symlink')
  })

  test('rejects a symlinked refresh state directory', () => {
    const { repoRoot, stateDir } = createRepository()
    const stateAlias = join(repoRoot, 'state-alias')
    symlinkSync(stateDir, stateAlias, 'dir')

    expect(() => startRefreshRun({
      repoRoot,
      runId: 'state-symlink-test',
      stateDir: stateAlias,
    })).toThrow('refresh state directory is a symlink')
  })

  test('runs a complete incremental publish with an exact snapshot and memory cursor', () => {
    const { commit: initialCommit, repoRoot, stateDir } = createRepository()
    writeFileSync(join(stateDir, 'memory.md'), `Last run: 2026-09-04T03:00:00Z\n\n- Processed source SHA: ${initialCommit}\n`)
    writeFileSync(join(repoRoot, 'src', 'owner.ts'), 'export const owner = 2\n')
    git(repoRoot, ['add', 'src/owner.ts'])
    git(repoRoot, ['commit', '-q', '-m', 'change source owner'])
    const targetCommit = git(repoRoot, ['rev-parse', 'HEAD'])

    const started = startRefreshRun({
      repoRoot,
      runId: 'publish-test',
      stateDir,
    })
    expect(started.coverageMode).toBe('incremental')
    expect(started.changedPaths).toEqual([{ path: 'src/owner.ts', status: 'M' }])

    writeFileSync(
      join(repoRoot, 'docs', 'maps', 'domain.md'),
      readFileSync(join(repoRoot, 'docs', 'maps', 'domain.md'), 'utf8') + '\n- `src/owner.ts` remains the source owner.\n',
    )
    const published = publishRefreshRun({
      repoRoot,
      runId: 'publish-test',
      stateDir,
      status: 'complete',
      audit: auditFor(started),
    })

    expect(published.status).toBe('complete')
    expect(published.manifest.targetSha).toBe(targetCommit)
    expect(published.manifest.pendingPaths).toEqual([])
    expect(published.manifest.audit?.auditedPaths).toEqual(['src/owner.ts'])
    expect(published.manifest.snapshot?.path).toBe('last-run.snapshot.json')
    expect(published.manifest.patch?.path).toBe('last-run.patch')
    expect(readFileSync(join(stateDir, 'memory.md'), 'utf8')).toContain('- Run ID: publish-test')
    expect(readFileSync(join(stateDir, 'last-run.patch'), 'utf8')).toContain('snapshot-sha256:')
    expect(readFileSync(join(stateDir, 'last-run.snapshot.json'), 'utf8')).toContain('contentBase64')
    expect(readFileSync(join(stateDir, 'manifest.json'), 'utf8')).toContain('"status": "complete"')
  })

  test('completes the CLI start and publish path for an acknowledged baseline', () => {
    const { repoRoot, stateDir } = createRepository()
    const helper = join(import.meta.dir, 'workspaceMapRefreshState.ts')
    const started = JSON.parse(execFileSync('bun', [helper, 'start', '--repo-root', repoRoot, '--state-dir', stateDir, '--run-id', 'cli-test'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }))
    expect(started.coverageMode).toBe('baseline-partial')
    const auditPath = join(stateDir, 'audit.json')
    writeFileSync(auditPath, JSON.stringify(auditFor(started, 'baseline-complete')))

    const published = JSON.parse(execFileSync('bun', [
      helper,
      'publish',
      '--repo-root',
      repoRoot,
      '--state-dir',
      stateDir,
      '--run-id',
      'cli-test',
      '--status',
      'complete',
      '--audit-file',
      auditPath,
    ], { cwd: repoRoot, encoding: 'utf8' }))
    expect(published.status).toBe('complete')
    expect(published.manifest.memoryUpdated).toBe(true)
  })

  test('blocks completion without a durable audit attestation', () => {
    const { repoRoot, stateDir } = createRepository()
    const started = startRefreshRun({
      repoRoot,
      runId: 'baseline-test',
      stateDir,
    })
    expect(started.coverageMode).toBe('baseline-partial')
    expect(started.cursorBefore).toBeNull()
    expect(() => publishRefreshRun({
      repoRoot,
      runId: 'baseline-test',
      stateDir,
      status: 'complete',
    })).toThrow('complete publish requires a refresh audit evidence file')
  })

  test('does not complete when the audit omits pending paths', () => {
    const { commit: initialCommit, repoRoot, stateDir } = createRepository()
    writeFileSync(join(stateDir, 'memory.md'), `- Processed source SHA: ${initialCommit}\n`)
    writeFileSync(join(repoRoot, 'src', 'owner.ts'), 'export const owner = 2\n')
    git(repoRoot, ['add', 'src/owner.ts'])
    git(repoRoot, ['commit', '-q', '-m', 'pending source change'])
    const started = startRefreshRun({ repoRoot, runId: 'audit-coverage-test', stateDir })
    const incomplete = auditFor(started)
    incomplete.auditedPaths = []

    expect(() => publishRefreshRun({
      audit: incomplete,
      repoRoot,
      runId: started.runId,
      stateDir,
      status: 'complete',
    })).toThrow('refresh audit does not cover exactly the pending paths')
  })

  test('records an explicit blocked decision and preserves pending work', () => {
    const { repoRoot, stateDir } = createRepository()
    const started = startRefreshRun({
      repoRoot,
      runId: 'blocked-test',
      stateDir,
    })
    writeFileSync(join(repoRoot, 'docs', 'maps', 'untracked.md'), '# Untracked map\n')

    const published = publishRefreshRun({
      repoRoot,
      runId: started.runId,
      stateDir,
      status: 'blocked',
    })

    expect(published.status).toBe('blocked')
    expect(published.manifest.blockers).toContain('validator: focused map is not indexed: docs/maps/untracked.md')
    expect(published.manifest.pendingPaths).toEqual(started.pendingPaths)
    expect(published.manifest.memoryUpdated).toBe(false)
    expect(readFileSync(join(stateDir, 'last-run.snapshot.json'), 'utf8')).toContain('docs/maps/untracked.md')
    expect(readFileSync(join(stateDir, 'last-run.patch'), 'utf8')).toContain('untracked.md')
  })

  test('records a caller-requested block even when mechanical validation is clean', () => {
    const { repoRoot, stateDir } = createRepository()
    const started = startRefreshRun({ repoRoot, runId: 'explicit-block-test', stateDir })

    const published = publishRefreshRun({
      repoRoot,
      runId: started.runId,
      stateDir,
      status: 'blocked',
    })

    expect(published.manifest.blockers).toContain('refresh explicitly blocked by caller')
  })

  test('fails closed when validation inputs drift after the target is captured', () => {
    const { repoRoot, stateDir } = createRepository()
    mkdirSync(join(repoRoot, 'scripts'), { recursive: true })
    writeFileSync(join(repoRoot, 'scripts', 'workspaceMapLint.ts'), 'export const validatorVersion = 1\n')
    writeFileSync(join(repoRoot, 'scripts', 'workspaceMapRefreshState.ts'), 'export const stateVersion = 1\n')
    const started = startRefreshRun({ repoRoot, runId: 'validator-drift-test', stateDir })
    writeFileSync(join(repoRoot, 'scripts', 'workspaceMapLint.ts'), 'export const validatorVersion = 2\n')

    expect(() => publishRefreshRun({
      repoRoot,
      runId: started.runId,
      stateDir,
      status: 'complete',
    })).toThrow('validation inputs changed during refresh')
  })

  test('recovers a published run after the memory write boundary', () => {
    const { commit: initialCommit, repoRoot, stateDir } = createRepository()
    writeFileSync(join(stateDir, 'memory.md'), `Last run: 2026-09-04T03:00:00Z\n\n- Processed source SHA: ${initialCommit}\n`)
    writeFileSync(join(repoRoot, 'src', 'owner.ts'), 'export const owner = 2\n')
    git(repoRoot, ['add', 'src/owner.ts'])
    git(repoRoot, ['commit', '-q', '-m', 'change source owner'])

    const started = startRefreshRun({ repoRoot, runId: 'recovery-test', stateDir })
    writeFileSync(
      join(repoRoot, 'docs', 'maps', 'domain.md'),
      readFileSync(join(repoRoot, 'docs', 'maps', 'domain.md'), 'utf8') + '\n- `src/owner.ts` remains the source owner.\n',
    )
    const completed = publishRefreshRun({
      repoRoot,
      runId: started.runId,
      stateDir,
      status: 'complete',
      audit: auditFor(started),
    })
    const manifestPath = join(stateDir, 'manifest.json')
    const published = { ...completed.manifest, memoryUpdated: false, status: 'published' }
    writeFileSync(manifestPath, `${JSON.stringify(published, null, 2)}\n`)
    writeFileSync(join(repoRoot, 'docs', 'maps', 'domain.md'), 'newer map work\n')

    const recovered = recoverPublishedRun(stateDir)
    expect(recovered.status).toBe('complete')
    expect(recovered.memoryUpdated).toBe(true)
    expect(readFileSync(join(stateDir, 'memory.md'), 'utf8')).toContain('- Run ID: recovery-test')
  })

  test('turns an interrupted in-progress run into a safe blocked checkpoint', () => {
    const { repoRoot, stateDir } = createRepository()
    startRefreshRun({ repoRoot, runId: 'interrupted-test', stateDir })

    const recovered = recoverPublishedRun(stateDir)
    expect(recovered.status).toBe('blocked')
    expect(recovered.memoryUpdated).toBe(false)
    expect(recovered.blockers).toContain('refresh interrupted before publication; rerun required')
  })
})
