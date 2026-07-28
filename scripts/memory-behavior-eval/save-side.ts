import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { homedir } from 'os'
import { basename, join, resolve, sep } from 'path'
import { createHash } from 'crypto'
import { getGlobalClaudeFile } from '../../src/utils/env.js'

/**
 * Delete the session transcript a `-p` run wrote to the real config dir. The
 * harness isolates memory (CLAUDE_COWORK_MEMORY_PATH_OVERRIDE) but NOT session
 * storage, so without this every run leaks a transcript into the operator's
 * ~/.cat-code/projects catalog. Keyed on the run's unique session id.
 */
function deleteSessionTranscript(sessionId: string): void {
  if (!/^[0-9a-f-]{8,}$/i.test(sessionId)) return
  const projects = join(
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.cat-code'),
    'projects',
  )
  let dirs: string[]
  try {
    dirs = readdirSync(projects)
  } catch {
    return
  }
  for (const d of dirs) {
    const f = join(projects, d, `${sessionId}.jsonl`)
    if (existsSync(f)) {
      try {
        unlinkSync(f)
      } catch {
        // best-effort cleanup
      }
    }
  }
}

/**
 * Read the run's session id out of `-p` stdout. This harness always spawns with
 * `--output-format json --verbose`, and that combination prints the whole
 * message ARRAY (src/cli/print.ts `needsFullArray` / `jsonStringify(messages)`),
 * not the result object, so the id has to be found inside the array.
 */
function extractSessionId(stdout: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  const sessionIdOf = (value: unknown): string | null => {
    if (!value || typeof value !== 'object') return null
    const sessionId = (value as { session_id?: unknown }).session_id
    return typeof sessionId === 'string' ? sessionId : null
  }
  if (Array.isArray(parsed)) {
    for (const message of parsed) {
      const sessionId = sessionIdOf(message)
      if (sessionId) return sessionId
    }
    return null
  }
  return sessionIdOf(parsed)
}

/**
 * Live save-behavior evaluator. Direct lanes force background extraction off;
 * extraction lanes suppress primary-agent tools and require the real forked
 * extractor to start and finish. Use --list to inspect the run plan without
 * consuming model usage.
 */
const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const CLI = join(REPO_ROOT, 'cli-dev')
const RUN_TIMEOUT_MS = 480_000
const EXTRACTION_PRIMARY_PROMPT =
  'For the primary assistant response only, do not use tools or write or edit memory files. Respond briefly in text. This restriction does not apply when you are acting as the memory extraction subagent; in that role, follow the extraction task and use its allowed memory tools.'

type Verdict = 'PASS' | 'FAIL' | 'ERROR'
type ExecutionLane = 'direct' | 'extraction'

type MemorySnapshot = {
  index: string
  topics: Array<{ path: string; content: string }>
}

type CaseDef = {
  id: string
  prompt: string
  seed?: (memoryDir: string) => void
  seedTeam?: (teamDir: string) => void
  expectsDirectWrite: boolean
  score: (
    snapshot: MemorySnapshot,
    teamSnapshot?: MemorySnapshot,
  ) => { verdict: Verdict; reasons: string[] }
}

type RunDef = {
  id: string
  lane: ExecutionLane
  caseDef: CaseDef
}

type ExecutionEvidence = {
  mainToolNames: string[]
  mainMemoryWritePaths: string[]
  extractionStarted: boolean
  extractionFinished: boolean
  extractionSkippedDirectWrite: boolean
  outputParseError?: string
}

function hasAll(text: string, patterns: RegExp[]): boolean {
  return patterns.every(pattern => pattern.test(text))
}

function validateSingleLinkedMemory(snapshot: MemorySnapshot): {
  reasons: string[]
  topicText: string
  hook: string
} {
  const reasons: string[] = []
  if (snapshot.topics.length !== 1) {
    reasons.push(`expected exactly one topic memory, found ${snapshot.topics.length}`)
  }

  const topic = snapshot.topics[0]
  const topicText = topic?.content ?? ''
  if (
    topic &&
    !/^---\nname: [^\n]+\ndescription: [^\n]+\ntype: feedback\n---\n\n\S/.test(
      topicText,
    )
  ) {
    reasons.push('topic memory does not have valid feedback frontmatter')
  }

  const indexLines = snapshot.index
    .split('\n')
    .filter(line => line.trim().length > 0)
  if (indexLines.length !== 1) {
    reasons.push(`expected exactly one MEMORY.md pointer, found ${indexLines.length}`)
  }
  const match = indexLines[0]?.match(
    /^- \[[^\]]+\]\(([^)]+\.md)\) — (.+)$/,
  )
  if (!match) {
    if (indexLines.length > 0) reasons.push('MEMORY.md entry is not a valid pointer')
    return { reasons, topicText, hook: '' }
  }
  if (topic && match[1] !== topic.path) {
    reasons.push(`MEMORY.md points to ${match[1]} instead of ${topic.path}`)
  }
  return { reasons, topicText, hook: match[2] ?? '' }
}

function noMemoryExpected(snapshot: MemorySnapshot): {
  verdict: Verdict
  reasons: string[]
} {
  const reasons: string[] = []
  if (snapshot.topics.length > 0) {
    reasons.push(`unexpected topic files: ${snapshot.topics.map(t => t.path).join(', ')}`)
  }
  if (snapshot.index.trim().length > 0) {
    reasons.push('MEMORY.md should remain empty')
  }
  return { verdict: reasons.length === 0 ? 'PASS' : 'FAIL', reasons }
}

function durableConditionExpected(
  snapshot: MemorySnapshot,
  conditionPatterns: RegExp[],
  actionPatterns: RegExp[],
  forbiddenPatterns: RegExp[],
): { verdict: Verdict; reasons: string[] } {
  const { reasons, topicText, hook } = validateSingleLinkedMemory(snapshot)
  if (!hasAll(topicText, conditionPatterns)) {
    reasons.push('topic rule dropped part of its trigger condition')
  }
  if (!hasAll(hook, conditionPatterns)) {
    reasons.push('MEMORY.md hook dropped part of its trigger condition')
  }
  if (!hasAll(topicText, actionPatterns) || !hasAll(hook, actionPatterns)) {
    reasons.push('topic rule or MEMORY.md hook dropped or inverted the guidance')
  }
  if (
    forbiddenPatterns.some(
      pattern => pattern.test(topicText) || pattern.test(hook),
    )
  ) {
    reasons.push('topic rule or MEMORY.md hook contains opposite guidance')
  }
  return { verdict: reasons.length === 0 ? 'PASS' : 'FAIL', reasons }
}

const CASES: CaseDef[] = [
  {
    id: 'turn-ask',
    prompt:
      'You asked whether I prefer strict or loose parsing. Up to you, do not ask me anymore. Choose one for this parser and briefly tell me why.',
    expectsDirectWrite: false,
    score: noMemoryExpected,
  },
  {
    id: 'durable-ask',
    prompt:
      'Remember this preference for future conversations: when choosing reversible local implementation defaults, choose a reasonable default instead of asking me a follow-up question. This is a durable correction to how you should work with me. Briefly acknowledge after saving it.',
    expectsDirectWrite: true,
    score: snapshot =>
      durableConditionExpected(snapshot, [
        /reversible/i,
        /local/i,
        /implementation/i,
        /default/i,
        /ask|question/i,
      ], [
        /choose.{0,100}(reasonable|sensible).{0,40}default/i,
        /(instead of|without).{0,50}(ask|question)/i,
      ], [/always ask/i, /do not choose/i, /never choose/i]),
  },
  {
    id: 'turn-delegation',
    prompt:
      'Stop the worker. Continue this yourself and do not spawn more subagents. Briefly acknowledge the correction.',
    expectsDirectWrite: false,
    score: noMemoryExpected,
  },
  {
    id: 'durable-delegation',
    prompt:
      'Remember this preference for future conversations: for one-file text-only edits whose answer is already in the current context, handle the work directly instead of delegating it. This is a durable correction. Briefly acknowledge after saving it.',
    expectsDirectWrite: true,
    score: snapshot =>
      durableConditionExpected(snapshot, [
        /one-file/i,
        /text-only/i,
        /current context|context is sufficient|answer(?:ed|able) in context/i,
        /direct|delegat/i,
      ], [
        /(handle|edit|work).{0,100}direct/i,
        /(instead of|without|rather than).{0,50}delegat/i,
      ], [/do not (handle|edit|work).{0,40}direct/i, /always delegat/i]),
  },
  {
    id: 'contradiction-supersession',
    prompt:
      'Remember this replacement preference for future conversations: during a security response, for patch-only dependency upgrades choose the latest compatible patch without asking me. This supersedes my earlier ask-first preference only under that condition. Briefly acknowledge after reconciling the existing memory.',
    expectsDirectWrite: true,
    seed: memoryDir => {
      writeFileSync(
        join(memoryDir, 'feedback_dependency_upgrade_questions.md'),
        `---\nname: dependency upgrade questions\ndescription: Ask before choosing dependency versions\ntype: feedback\n---\n\nAlways ask before choosing a dependency version.\n\n**Why:** The user previously wanted explicit control over every upgrade.\n**How to apply:** Ask before selecting any dependency version.\n`,
      )
      writeFileSync(
        join(memoryDir, 'MEMORY.md'),
        '- [Dependency upgrade questions](feedback_dependency_upgrade_questions.md) — always ask before choosing any dependency version\n',
      )
    },
    score: snapshot => {
      const { reasons, topicText, hook } = validateSingleLinkedMemory(snapshot)
      const required = [
        /security[- ]responses?/i,
        /patch-only/i,
        /dependency.{0,40}(upgrade|version)|patch-only.{0,30}upgrade/i,
        /latest compatible patch/i,
      ]
      if (!hasAll(topicText, required)) {
        reasons.push('topic memory does not contain the scoped replacement rule')
      }
      if (!hasAll(hook, required)) {
        reasons.push('MEMORY.md hook does not contain the scoped replacement rule')
      }
      const keepsGeneralRule = /ask (first|before)|ask-first/i
      if (!keepsGeneralRule.test(topicText) || !keepsGeneralRule.test(hook)) {
        reasons.push('ask-first guidance outside the exception was not preserved')
      }
      const scopedAction = /choose.{0,80}latest compatible patch/i
      const exceptionConnector =
        /except|unless|otherwise|all other|generally|by default/i
      if (
        !scopedAction.test(topicText) ||
        !scopedAction.test(hook) ||
        !exceptionConnector.test(topicText) ||
        !exceptionConnector.test(hook) ||
        /(?:do not|never).{0,30}choose.{0,50}latest compatible patch/i.test(
          `${topicText}\n${hook}`,
        )
      ) {
        reasons.push('scoped replacement action is missing or inverted')
      }
      if (
        /always ask before choosing (a |any )?dependency version(?!.{0,60}(except|unless|otherwise|all other|generally|by default))/i.test(
          `${topicText}\n${hook}`,
        )
      ) {
        reasons.push('superseded unconditional ask-first rule remains')
      }
      return { verdict: reasons.length === 0 ? 'PASS' : 'FAIL', reasons }
    },
  },
  {
    id: 'team-private-override',
    prompt:
      "Remember this personal preference for future conversations: when I'm working alone in a throwaway prototype and a dependency upgrade is patch-only, choose the latest compatible patch without asking me. The team's normal dependency policy still applies everywhere else. Briefly acknowledge after saving it.",
    expectsDirectWrite: true,
    seedTeam: teamDir => {
      writeFileSync(
        join(teamDir, 'feedback_dependency_policy.md'),
        `---\nname: dependency policy\ndescription: Team dependency selection policy\ntype: feedback\n---\n\nAlways ask before choosing a dependency version.\n\n**Why:** Dependency changes require team review.\n**How to apply:** Ask before selecting any dependency version for team work.\n`,
      )
      writeFileSync(
        join(teamDir, 'MEMORY.md'),
        '- [Dependency policy](feedback_dependency_policy.md) — always ask before choosing any dependency version for team work\n',
      )
    },
    score: (snapshot, teamSnapshot) => {
      const result = durableConditionExpected(
        snapshot,
        [
          /working alone|solo/i,
          /throwaway/i,
          /prototype/i,
          /patch-only/i,
          /ask|question/i,
        ],
        [
          /choose.{0,80}latest compatible patch/i,
          /(without|instead of).{0,50}(ask|question)/i,
        ],
        [
          /(?:do not|never).{0,30}choose.{0,50}latest compatible patch/i,
        ],
      )
      if (!teamSnapshot) {
        result.reasons.push('team memory snapshot is missing')
      } else {
        const expectedIndex =
          '- [Dependency policy](feedback_dependency_policy.md) — always ask before choosing any dependency version for team work\n'
        const expectedTopic = `---\nname: dependency policy\ndescription: Team dependency selection policy\ntype: feedback\n---\n\nAlways ask before choosing a dependency version.\n\n**Why:** Dependency changes require team review.\n**How to apply:** Ask before selecting any dependency version for team work.\n`
        if (
          teamSnapshot.index !== expectedIndex ||
          teamSnapshot.topics.length !== 1 ||
          teamSnapshot.topics[0]?.path !== 'feedback_dependency_policy.md' ||
          teamSnapshot.topics[0]?.content !== expectedTopic
        ) {
          result.reasons.push('private correction modified team memory')
        }
      }
      return {
        verdict: result.reasons.length === 0 ? 'PASS' : 'FAIL',
        reasons: result.reasons,
      }
    },
  },
]

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function runGit(...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString())
  }
  return result.stdout.toString().trim()
}

function buildRuns(
  cases: CaseDef[],
  lanes: ExecutionLane[],
): RunDef[] {
  return lanes.flatMap(lane =>
    cases.map(caseDef => ({
      id: lane === 'direct' ? caseDef.id : `extraction-${caseDef.id}`,
      lane,
      caseDef,
    })),
  )
}

function readCachedGateState(): Record<string, unknown> {
  const configPath = getGlobalClaudeFile()
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as {
      cachedGrowthBookFeatures?: Record<string, unknown>
    }
    const cached = parsed.cachedGrowthBookFeatures ?? {}
    return {
      cachePath: configPath,
      cachedFeatureCount: Object.keys(cached).length,
      tengu_passport_quail: cached.tengu_passport_quail ?? false,
      tengu_moth_copse: cached.tengu_moth_copse ?? false,
      tengu_herring_clock: cached.tengu_herring_clock ?? false,
      tengu_bramble_lintel: cached.tengu_bramble_lintel ?? null,
    }
  } catch (error) {
    return {
      cachePath: configPath,
      readError: error instanceof Error ? error.message : String(error),
    }
  }
}

function parseFeatureOverrides(): Record<string, unknown> {
  const raw = process.env.CLAUDE_INTERNAL_FC_OVERRIDES
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('value must be a JSON object')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    throw new Error(
      `invalid CLAUDE_INTERNAL_FC_OVERRIDES: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

function buildForcedGateOverrides(run: RunDef): Record<string, unknown> {
  return {
    tengu_passport_quail: run.lane === 'extraction',
    // isExtractModeActive() (src/memdir/paths.ts) also requires this gate
    // under a non-interactive `-p` session; without it every extraction-lane
    // run exits before drainPendingExtraction() can await the background
    // extractor, so scoreExecution always sees extractionFinished === false.
    tengu_slate_thimble: run.lane === 'extraction',
    tengu_moth_copse: false,
    tengu_herring_clock: run.caseDef.seedTeam !== undefined,
    tengu_bramble_lintel: 1,
  }
}

function snapshotMemory(memoryDir: string): MemorySnapshot {
  const entries = readdirSync(memoryDir)
  const topics = entries
    .filter(name => name.endsWith('.md') && name !== 'MEMORY.md')
    .sort()
    .map(name => ({ path: name, content: readFileSync(join(memoryDir, name), 'utf8') }))
  const indexPath = join(memoryDir, 'MEMORY.md')
  const index = entries.includes('MEMORY.md') ? readFileSync(indexPath, 'utf8') : ''
  return { index, topics }
}

function inspectExecution(
  stdout: string,
  debugLog: string,
  projectDir: string,
  memoryDir: string,
): ExecutionEvidence {
  const evidence: ExecutionEvidence = {
    mainToolNames: [],
    mainMemoryWritePaths: [],
    extractionStarted: debugLog.includes('[extractMemories] starting'),
    extractionFinished: debugLog.includes('[extractMemories] finished'),
    extractionSkippedDirectWrite: debugLog.includes(
      '[extractMemories] skipping — conversation already wrote to memory files',
    ),
  }

  let messages: unknown
  try {
    messages = JSON.parse(stdout)
  } catch (error) {
    evidence.outputParseError =
      error instanceof Error ? error.message : String(error)
    return evidence
  }
  if (!Array.isArray(messages)) {
    evidence.outputParseError = 'verbose JSON output is not an array'
    return evidence
  }

  const memoryRoot = resolve(memoryDir)
  for (const item of messages) {
    if (!item || typeof item !== 'object') continue
    const message = (item as { message?: unknown }).message
    if (!message || typeof message !== 'object') continue
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const toolUse = block as {
        type?: unknown
        name?: unknown
        input?: { file_path?: unknown }
      }
      if (toolUse.type === 'tool_use' && typeof toolUse.name === 'string') {
        evidence.mainToolNames.push(toolUse.name)
      }
      if (
        toolUse.type !== 'tool_use' ||
        (toolUse.name !== 'Write' && toolUse.name !== 'Edit') ||
        typeof toolUse.input?.file_path !== 'string'
      ) {
        continue
      }
      const filePath = resolve(projectDir, toolUse.input.file_path)
      if (
        filePath === memoryRoot ||
        filePath.startsWith(memoryRoot + sep)
      ) {
        evidence.mainMemoryWritePaths.push(filePath)
      }
    }
  }

  return evidence
}

function scoreExecution(
  run: RunDef,
  evidence: ExecutionEvidence,
): string[] {
  const reasons: string[] = []
  if (evidence.outputParseError) {
    reasons.push(`could not inspect main-agent tool calls: ${evidence.outputParseError}`)
  }
  if (run.lane === 'extraction') {
    if ((evidence.mainToolNames ?? []).length > 0) {
      reasons.push('main agent used tools during the extraction lane')
    }
    if (!evidence.extractionStarted || !evidence.extractionFinished) {
      reasons.push('background extraction did not complete')
    }
  } else {
    if (
      evidence.extractionStarted ||
      evidence.extractionFinished ||
      evidence.extractionSkippedDirectWrite
    ) {
      reasons.push('background extraction ran during the direct lane')
    }
    const didWrite = evidence.mainMemoryWritePaths.length > 0
    if (didWrite !== run.caseDef.expectsDirectWrite) {
      reasons.push(
        run.caseDef.expectsDirectWrite
          ? 'direct lane did not contain a main-agent memory write'
          : 'direct lane unexpectedly contained a main-agent memory write',
      )
    }
  }
  return reasons
}

function parseArgs(): {
  model: string
  effort: string
  out: string
  caseIds: string[] | null
  lanes: ExecutionLane[]
  keepFixture: boolean
  scoreExisting: boolean
  list: boolean
} {
  const argv = process.argv.slice(2)
  const get = (flag: string): string | null => {
    const index = argv.indexOf(flag)
    return index >= 0 ? (argv[index + 1] ?? null) : null
  }
  const cases = get('--cases')
  const lanes = (get('--lanes') ?? 'direct,extraction')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
  return {
    model: get('--model') ?? 'gpt-5.6-luna',
    effort: get('--effort') ?? 'low',
    out: get('--out') ?? join(REPO_ROOT, 'scripts', 'memory-behavior-eval', 'save-out'),
    caseIds:
      cases === null
        ? null
        : cases
            .split(',')
            .map(value => value.trim())
            .filter(Boolean),
    lanes: lanes.map(lane => {
      if (lane !== 'direct' && lane !== 'extraction') {
        throw new Error(`unknown --lanes value: ${lane}`)
      }
      return lane
    }),
    keepFixture: argv.includes('--keep-fixture'),
    scoreExisting: argv.includes('--score-existing'),
    list: argv.includes('--list'),
  }
}

async function main(): Promise<void> {
  const {
    model,
    effort,
    out,
    caseIds,
    lanes,
    keepFixture,
    scoreExisting,
    list,
  } = parseArgs()
  const selectedCases = CASES.filter(c => !caseIds || caseIds.includes(c.id))
  if (caseIds) {
    const knownCaseIds = new Set(CASES.map(c => c.id))
    const unknownCaseIds = caseIds.filter(id => !knownCaseIds.has(id))
    if (unknownCaseIds.length > 0) {
      throw new Error(`unknown --cases values: ${unknownCaseIds.join(', ')}`)
    }
  }
  if (selectedCases.length === 0) {
    throw new Error('no save-side evaluation cases selected')
  }
  if (lanes.length === 0) {
    throw new Error('no save-side evaluation lanes selected')
  }
  if (new Set(lanes).size !== lanes.length) {
    throw new Error('duplicate --lanes values are not allowed')
  }
  const runs = buildRuns(selectedCases, lanes)

  if (list) {
    console.log(
      JSON.stringify(
        runs.map(run => ({
          id: run.id,
          lane: run.lane,
          teamMemory: run.caseDef.seedTeam !== undefined,
          forcedGrowthBookOverrides: buildForcedGateOverrides(run),
        })),
        null,
        2,
      ),
    )
    return
  }

  const outDir = resolve(out)
  if (scoreExisting) {
    let hasFailure = false
    console.log('=== SAVE-SIDE EXISTING-ARTIFACT SUMMARY ===')
    for (const run of runs) {
      const memoryPath = join(outDir, `${run.id}-memory.json`)
      if (!existsSync(memoryPath)) {
        hasFailure = true
        console.log(`${run.id.padEnd(40)} ERROR`)
        console.log(`  missing artifact: ${memoryPath}`)
        continue
      }
      const teamMemoryPath = join(outDir, `${run.id}-team-memory.json`)
      if (run.caseDef.seedTeam && !existsSync(teamMemoryPath)) {
        hasFailure = true
        console.log(`${run.id.padEnd(40)} ERROR`)
        console.log(`  missing artifact: ${teamMemoryPath}`)
        continue
      }
      const snapshot = JSON.parse(
        readFileSync(memoryPath, 'utf8'),
      ) as MemorySnapshot
      const teamSnapshot = run.caseDef.seedTeam
        ? (JSON.parse(readFileSync(teamMemoryPath, 'utf8')) as MemorySnapshot)
        : undefined
      const scored = run.caseDef.score(snapshot, teamSnapshot)
      const evidencePath = join(outDir, `${run.id}-evidence.json`)
      const executionReasons = existsSync(evidencePath)
        ? scoreExecution(
            run,
            JSON.parse(
              readFileSync(evidencePath, 'utf8'),
            ) as ExecutionEvidence,
          )
        : [`${run.lane} artifact has no execution evidence`]
      const reasons = [...scored.reasons, ...executionReasons]
      const verdict =
        scored.verdict === 'PASS' && reasons.length === 0 ? 'PASS' : 'FAIL'
      if (verdict !== 'PASS') hasFailure = true
      console.log(`${run.id.padEnd(40)} ${verdict}`)
      for (const reason of reasons) console.log(`  ${reason}`)
      console.log(
        `  topics: ${snapshot.topics.map(topic => basename(topic.path)).join(', ') || '(none)'}`,
      )
      console.log(`  index: ${JSON.stringify(snapshot.index.trim())}`)
    }
    process.exitCode = hasFailure ? 1 : 0
    return
  }

  const metadata = {
    recordedAt: new Date().toISOString(),
    model,
    effort,
    cliPath: CLI,
    cliSha256: sha256(CLI),
    cliBytes: statSync(CLI).size,
    sourceHead: runGit('rev-parse', 'HEAD'),
    sourceStatus: runGit('status', '--short'),
    gateEvidence:
      'Each result records the disk cache immediately before its process starts. Forced per-run overrides are authoritative for the memory gates under test.',
  }
  mkdirSync(outDir, { recursive: true })
  const fixtureBase = mkdtempSync(join(outDir, 'fixture-'))
  writeFileSync(
    join(outDir, 'metadata.json'),
    JSON.stringify(metadata, null, 2) + '\n',
  )

  const results: Array<{
    caseId: string
    lane: ExecutionLane
    verdict: Verdict
    reasons: string[]
    exitCode: number
    durationMs: number
    memory: MemorySnapshot
    teamMemory?: MemorySnapshot
    executionEvidence: ExecutionEvidence
    runMetadata: Record<string, unknown>
    rawFile: string
  }> = []

  console.log(JSON.stringify(metadata, null, 2))
  console.log(`running ${runs.length} save-side evaluations sequentially`)

  for (const run of runs) {
    const c = run.caseDef
    const caseDir = join(fixtureBase, run.id)
    const projectDir = join(caseDir, 'project')
    const memoryDir = join(caseDir, 'memory')
    const teamDir = join(memoryDir, 'team')
    const debugFile = join(caseDir, 'debug.log')
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(memoryDir, { recursive: true })
    writeFileSync(
      join(projectDir, 'package.json'),
      JSON.stringify(
        { name: `memory-save-eval-${run.id}`, private: true },
        null,
        2,
      ) + '\n',
    )
    c.seed?.(memoryDir)
    if (c.seedTeam) {
      mkdirSync(teamDir, { recursive: true })
      c.seedTeam(teamDir)
    }

    const forcedGrowthBookOverrides = buildForcedGateOverrides(run)
    const runMetadata = {
      recordedAt: new Date().toISOString(),
      lane: run.lane,
      forcedUserType: 'ant',
      forcedGrowthBookOverrides,
      cachedGateStateBeforeRun: readCachedGateState(),
    }
    const args = [
      CLI,
      '-p',
      c.prompt,
      '--model',
      model,
      '--effort',
      effort,
      '--output-format',
      'json',
      '--verbose',
      '--max-turns',
      '8',
      '--debug-file',
      debugFile,
      '--permission-mode',
      'dontAsk',
      '--allowedTools',
      run.lane === 'direct' ? 'Read,Write,Edit' : 'Read',
    ]
    if (run.lane === 'extraction') {
      args.push('--append-system-prompt', EXTRACTION_PRIMARY_PROMPT)
    }

    const started = Date.now()
    const proc = Bun.spawn(args, {
      cwd: projectDir,
      env: {
        ...process.env,
        USER_TYPE: 'ant',
        CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: memoryDir,
        CLAUDE_INTERNAL_FC_OVERRIDES: JSON.stringify({
          ...parseFeatureOverrides(),
          ...forcedGrowthBookOverrides,
        }),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const killer = setTimeout(() => proc.kill(), RUN_TIMEOUT_MS)
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    clearTimeout(killer)

    // Clean up the transcript this run wrote to the real session catalog — the
    // harness isolates memory but not session storage (deleteSessionTranscript).
    const sessionId = extractSessionId(stdout)
    if (sessionId) deleteSessionTranscript(sessionId)

    const debugLog = existsSync(debugFile)
      ? readFileSync(debugFile, 'utf8')
      : ''
    const rawFile = join(outDir, `${run.id}.json`)
    const memory = snapshotMemory(memoryDir)
    const teamMemory = c.seedTeam ? snapshotMemory(teamDir) : undefined
    const executionEvidence = inspectExecution(
      stdout,
      debugLog,
      projectDir,
      memoryDir,
    )
    writeFileSync(
      rawFile,
      JSON.stringify(
        {
          runMetadata,
          args,
          exitCode,
          stdout,
          stderr,
          executionEvidence,
        },
        null,
        2,
      ) + '\n',
    )
    const behavior =
      exitCode === 0
        ? c.score(memory, teamMemory)
        : {
            verdict: 'ERROR' as const,
            reasons: [`cli-dev exited ${exitCode}`],
          }
    const executionReasons =
      exitCode === 0 ? scoreExecution(run, executionEvidence) : []
    const reasons = [...behavior.reasons, ...executionReasons]
    const verdict =
      behavior.verdict === 'ERROR'
        ? 'ERROR'
        : behavior.verdict === 'PASS' && reasons.length === 0
          ? 'PASS'
          : 'FAIL'
    const result = {
      caseId: run.id,
      lane: run.lane,
      verdict,
      reasons,
      exitCode,
      durationMs: Date.now() - started,
      memory,
      teamMemory,
      executionEvidence,
      runMetadata,
      rawFile,
    }
    results.push(result)
    writeFileSync(
      join(outDir, `${run.id}-memory.json`),
      JSON.stringify(memory, null, 2) + '\n',
    )
    if (teamMemory) {
      writeFileSync(
        join(outDir, `${run.id}-team-memory.json`),
        JSON.stringify(teamMemory, null, 2) + '\n',
      )
    }
    writeFileSync(
      join(outDir, `${run.id}-evidence.json`),
      JSON.stringify(executionEvidence, null, 2) + '\n',
    )
    writeFileSync(
      join(outDir, `${run.id}-metadata.json`),
      JSON.stringify(runMetadata, null, 2) + '\n',
    )
    console.log(
      `${run.id}: ${result.verdict}${
        result.reasons.length > 0
          ? ` — ${result.reasons.join('; ')}`
          : ''
      }`,
    )
  }

  writeFileSync(
    join(outDir, 'results.jsonl'),
    results.map(result => JSON.stringify(result)).join('\n') + '\n',
  )

  console.log('\n=== SAVE-SIDE SUMMARY ===')
  for (const result of results) {
    console.log(`${result.caseId.padEnd(40)} ${result.verdict}`)
    for (const reason of result.reasons) console.log(`  ${reason}`)
    console.log(
      `  topics: ${
        result.memory.topics
          .map(topic => basename(topic.path))
          .join(', ') || '(none)'
      }`,
    )
    console.log(`  index: ${JSON.stringify(result.memory.index.trim())}`)
  }
  console.log(`\nartifacts: ${outDir}`)

  if (!keepFixture) rmSync(fixtureBase, { recursive: true, force: true })
  if (results.some(result => result.verdict !== 'PASS')) process.exitCode = 1
}

export const _forTest = {
  CASES,
  buildForcedGateOverrides,
  buildRuns,
  extractSessionId,
  inspectExecution,
  scoreExecution,
}

if (import.meta.main) {
  await main()
}
