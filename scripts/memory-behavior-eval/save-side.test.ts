import { describe, expect, test } from 'bun:test'
import { _forTest } from './save-side.js'

describe('save-side evaluation lanes', () => {
  const runs = _forTest.buildRuns(_forTest.CASES, ['direct', 'extraction'])

  test('builds direct and extraction coverage for every case', () => {
    expect(runs).toHaveLength(_forTest.CASES.length * 2)
    expect(runs.filter(run => run.lane === 'direct').map(run => run.id)).toEqual(
      _forTest.CASES.map(caseDef => caseDef.id),
    )
    expect(
      runs.filter(run => run.lane === 'extraction').map(run => run.id),
    ).toEqual(
      _forTest.CASES.map(caseDef => `extraction-${caseDef.id}`),
    )
  })

  test('forces deterministic gates for extraction and team-memory cases', () => {
    const direct = runs.find(run => run.id === 'durable-ask')!
    const extraction = runs.find(
      run => run.id === 'extraction-durable-ask',
    )!
    const teamExtraction = runs.find(
      run => run.id === 'extraction-team-private-override',
    )!

    expect(_forTest.buildForcedGateOverrides(direct)).toEqual({
      tengu_passport_quail: false,
      tengu_slate_thimble: false,
      tengu_moth_copse: false,
      tengu_herring_clock: false,
      tengu_bramble_lintel: 1,
    })
    expect(_forTest.buildForcedGateOverrides(extraction)).toEqual({
      tengu_passport_quail: true,
      tengu_slate_thimble: true,
      tengu_moth_copse: false,
      tengu_herring_clock: false,
      tengu_bramble_lintel: 1,
    })
    expect(_forTest.buildForcedGateOverrides(teamExtraction)).toEqual({
      tengu_passport_quail: true,
      tengu_slate_thimble: true,
      tengu_moth_copse: false,
      tengu_herring_clock: true,
      tengu_bramble_lintel: 1,
    })
  })

  test('forces the non-interactive extraction gate so -p sessions drain extraction (EVAL-1)', () => {
    // isExtractModeActive() (src/memdir/paths.ts) requires BOTH
    // tengu_passport_quail and, under a non-interactive session,
    // tengu_slate_thimble. Forcing only the first leaves extraction inactive
    // under `-p`, so every extraction-lane case fails scoreExecution's
    // "background extraction did not complete" check regardless of truth.
    for (const run of runs.filter(r => r.lane === 'extraction')) {
      expect(_forTest.buildForcedGateOverrides(run).tengu_slate_thimble).toBe(
        true,
      )
    }
    for (const run of runs.filter(r => r.lane === 'direct')) {
      expect(_forTest.buildForcedGateOverrides(run).tengu_slate_thimble).toBe(
        false,
      )
    }
  })

  test('requires a scoped private rule without changing team policy', () => {
    const teamCase = _forTest.CASES.find(
      caseDef => caseDef.id === 'team-private-override',
    )!
    const privateMemory = {
      index:
        '- [Prototype dependency choice](feedback_prototype_dependencies.md) — when working alone in a throwaway prototype, choose the latest compatible patch for patch-only upgrades without asking\n',
      topics: [
        {
          path: 'feedback_prototype_dependencies.md',
          content:
            '---\nname: prototype dependency choice\ndescription: Choose patches in solo throwaway prototypes\ntype: feedback\n---\n\nWhen working alone in a throwaway prototype, choose the latest compatible patch for patch-only dependency upgrades without asking.\n',
        },
      ],
    }
    const teamMemory = {
      index:
        '- [Dependency policy](feedback_dependency_policy.md) — always ask before choosing any dependency version for team work\n',
      topics: [
        {
          path: 'feedback_dependency_policy.md',
          content:
            '---\nname: dependency policy\ndescription: Team dependency selection policy\ntype: feedback\n---\n\nAlways ask before choosing a dependency version.\n\n**Why:** Dependency changes require team review.\n**How to apply:** Ask before selecting any dependency version for team work.\n',
        },
      ],
    }

    expect(teamCase.score(privateMemory, teamMemory).verdict).toBe('PASS')
    expect(
      teamCase.score(privateMemory, {
        ...teamMemory,
        index: '- [Changed](feedback_dependency_policy.md) — changed\n',
      }).reasons,
    ).toContain('private correction modified team memory')
  })

  test('does not reject a preserved ask-first rule that is properly scoped by an exception (EVAL-4)', () => {
    const contradictionCase = _forTest.CASES.find(
      caseDef => caseDef.id === 'contradiction-supersession',
    )!
    const scopedTopic =
      '---\nname: dependency upgrade questions\ndescription: Ask before choosing dependency versions\ntype: feedback\n---\n\nAlways ask before choosing a dependency version, except during a security response, where for patch-only dependency upgrades choose the latest compatible patch.\n'
    const scopedHook =
      '- [Dependency upgrade questions](feedback_dependency_upgrade_questions.md) — always ask before choosing a dependency version, except during a security response, where for patch-only dependency upgrades choose the latest compatible patch\n'
    const scopedSnapshot = {
      index: scopedHook,
      topics: [
        { path: 'feedback_dependency_upgrade_questions.md', content: scopedTopic },
      ],
    }

    const scored = contradictionCase.score(scopedSnapshot)
    expect(scored.reasons).not.toContain(
      'superseded unconditional ask-first rule remains',
    )
    expect(scored.verdict).toBe('PASS')

    const unconditionalTopic =
      '---\nname: dependency upgrade questions\ndescription: Ask before choosing dependency versions\ntype: feedback\n---\n\nAlways ask before choosing a dependency version. Also, during a security response, for patch-only dependency upgrades choose the latest compatible patch.\n'
    const unconditionalHook =
      '- [Dependency upgrade questions](feedback_dependency_upgrade_questions.md) — always ask before choosing a dependency version; also during a security response choose the latest compatible patch for patch-only dependency upgrades\n'
    const staleSnapshot = {
      index: unconditionalHook,
      topics: [
        {
          path: 'feedback_dependency_upgrade_questions.md',
          content: unconditionalTopic,
        },
      ],
    }
    expect(contradictionCase.score(staleSnapshot).reasons).toContain(
      'superseded unconditional ask-first rule remains',
    )
  })
})

describe('save-side execution evidence', () => {
  const runs = _forTest.buildRuns(_forTest.CASES, ['direct', 'extraction'])

  test('separates main-agent writes from extraction lifecycle evidence', () => {
    const stdout = JSON.stringify([
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Write',
              input: { file_path: '/tmp/memory/feedback_testing.md' },
            },
            {
              type: 'tool_use',
              name: 'Edit',
              input: { file_path: '/tmp/project/package.json' },
            },
          ],
        },
      },
    ])
    const evidence = _forTest.inspectExecution(
      stdout,
      '[extractMemories] starting\n[extractMemories] finished',
      '/tmp/project',
      '/tmp/memory',
    )

    expect(evidence.mainToolNames).toEqual(['Write', 'Edit'])
    expect(evidence.mainMemoryWritePaths).toEqual([
      '/tmp/memory/feedback_testing.md',
    ])
    expect(evidence.extractionStarted).toBe(true)
    expect(evidence.extractionFinished).toBe(true)
    expect(evidence.extractionSkippedDirectWrite).toBe(false)
    expect(evidence.outputParseError).toBeUndefined()
  })

  test('requires completed extraction with no main-agent memory write', () => {
    const extraction = runs.find(
      run => run.id === 'extraction-durable-ask',
    )!
    const validEvidence = {
      mainToolNames: [],
      mainMemoryWritePaths: [],
      extractionStarted: true,
      extractionFinished: true,
      extractionSkippedDirectWrite: false,
    }

    expect(_forTest.scoreExecution(extraction, validEvidence)).toEqual([])
    expect(
      _forTest.scoreExecution(extraction, {
        ...validEvidence,
        mainToolNames: ['Write'],
        mainMemoryWritePaths: ['/tmp/memory/feedback_testing.md'],
      }),
    ).toContain('main agent used tools during the extraction lane')
    expect(
      _forTest.scoreExecution(extraction, {
        ...validEvidence,
        extractionFinished: false,
      }),
    ).toContain('background extraction did not complete')
  })

  test('checks whether direct cases wrote only when expected', () => {
    const durable = runs.find(run => run.id === 'durable-ask')!
    const turnScoped = runs.find(run => run.id === 'turn-ask')!

    expect(
      _forTest.scoreExecution(durable, {
        mainToolNames: ['Write'],
        mainMemoryWritePaths: ['/tmp/memory/feedback_testing.md'],
        extractionStarted: false,
        extractionFinished: false,
        extractionSkippedDirectWrite: false,
      }),
    ).toEqual([])
    expect(
      _forTest.scoreExecution(turnScoped, {
        mainToolNames: [],
        mainMemoryWritePaths: [],
        extractionStarted: false,
        extractionFinished: false,
        extractionSkippedDirectWrite: false,
      }),
    ).toEqual([])
    expect(
      _forTest.scoreExecution(durable, {
        mainToolNames: ['Write'],
        mainMemoryWritePaths: ['/tmp/memory/feedback_testing.md'],
        extractionStarted: false,
        extractionFinished: false,
        extractionSkippedDirectWrite: true,
      }),
    ).toContain('background extraction ran during the direct lane')
  })
})

describe('save-side --score-existing execution evidence', () => {
  test('fails a direct-lane artifact that has no execution evidence', () => {
    const outDir = `/tmp/save-side-direct-evidence-${process.pid}-${Date.now()}`
    try {
      require('node:fs').mkdirSync(outDir, { recursive: true })
      require('node:fs').writeFileSync(
        `${outDir}/turn-ask-memory.json`,
        JSON.stringify({ index: '', topics: [] }),
      )
      const result = Bun.spawnSync(
        [
          'bun',
          import.meta.dir + '/save-side.ts',
          '--score-existing',
          '--lanes',
          'direct',
          '--cases',
          'turn-ask',
          '--out',
          outDir,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      expect(result.exitCode).toBe(1)
      expect(result.stdout.toString()).toContain(
        'direct artifact has no execution evidence',
      )
    } finally {
      require('node:fs').rmSync(outDir, { recursive: true, force: true })
    }
  })
})

describe('save-side --score-existing missing artifacts (EVAL-7)', () => {
  test('reports a deliberate ERROR verdict instead of throwing on a missing memory artifact', () => {
    const emptyOutDir = `/tmp/save-side-eval7-${process.pid}-${Date.now()}`
    const result = Bun.spawnSync(
      [
        'bun',
        import.meta.dir + '/save-side.ts',
        '--score-existing',
        '--lanes',
        'extraction',
        '--cases',
        'turn-ask',
        '--out',
        emptyOutDir,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const stdout = result.stdout.toString()
    expect(result.exitCode).toBe(1)
    expect(stdout).toContain('extraction-turn-ask')
    expect(stdout).toContain('ERROR')
    expect(stdout).toContain('missing artifact')
    expect(result.stderr.toString()).not.toContain('ENOENT')
  })
})
