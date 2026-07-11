import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { basename, join, resolve } from 'path'
import { createHash } from 'crypto'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const CLI = join(REPO_ROOT, 'cli-dev')
const RUN_TIMEOUT_MS = 480_000

type Verdict = 'PASS' | 'FAIL' | 'ERROR'

type MemorySnapshot = {
  index: string
  topics: Array<{ path: string; content: string }>
}

type CaseDef = {
  id: string
  prompt: string
  seed?: (memoryDir: string) => void
  score: (snapshot: MemorySnapshot) => { verdict: Verdict; reasons: string[] }
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
    score: noMemoryExpected,
  },
  {
    id: 'durable-ask',
    prompt:
      'Remember this preference for future conversations: when choosing reversible local implementation defaults, choose a reasonable default instead of asking me a follow-up question. This is a durable correction to how you should work with me. Briefly acknowledge after saving it.',
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
    score: noMemoryExpected,
  },
  {
    id: 'durable-delegation',
    prompt:
      'Remember this preference for future conversations: for one-file text-only edits whose answer is already in the current context, handle the work directly instead of delegating it. This is a durable correction. Briefly acknowledge after saving it.',
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
        /always ask before choosing (a |any )?dependency version/i.test(
          `${topicText}\n${hook}`,
        )
      ) {
        reasons.push('superseded unconditional ask-first rule remains')
      }
      return { verdict: reasons.length === 0 ? 'PASS' : 'FAIL', reasons }
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

function readCachedGateState(): Record<string, unknown> {
  const configPath = join(process.env.HOME ?? '', '.cat-code', '.cat-code.json')
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
    }
  } catch (error) {
    return {
      cachePath: configPath,
      readError: error instanceof Error ? error.message : String(error),
    }
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

function parseArgs(): {
  model: string
  effort: string
  out: string
  caseIds: string[] | null
  keepFixture: boolean
  scoreExisting: boolean
} {
  const argv = process.argv.slice(2)
  const get = (flag: string): string | null => {
    const index = argv.indexOf(flag)
    return index >= 0 ? (argv[index + 1] ?? null) : null
  }
  const cases = get('--cases')
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
    keepFixture: argv.includes('--keep-fixture'),
    scoreExisting: argv.includes('--score-existing'),
  }
}

const { model, effort, out, caseIds, keepFixture, scoreExisting } = parseArgs()
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

const outDir = resolve(out)
if (scoreExisting) {
  let hasFailure = false
  console.log('=== SAVE-SIDE EXISTING-ARTIFACT SUMMARY ===')
  for (const c of selectedCases) {
    const snapshot = JSON.parse(
      readFileSync(join(outDir, `${c.id}-memory.json`), 'utf8'),
    ) as MemorySnapshot
    const scored = c.score(snapshot)
    if (scored.verdict !== 'PASS') hasFailure = true
    console.log(`${c.id.padEnd(28)} ${scored.verdict}`)
    for (const reason of scored.reasons) console.log(`  ${reason}`)
    console.log(
      `  topics: ${snapshot.topics.map(topic => basename(topic.path)).join(', ') || '(none)'}`,
    )
    console.log(`  index: ${JSON.stringify(snapshot.index.trim())}`)
  }
  process.exit(hasFailure ? 1 : 0)
}

mkdirSync(outDir, { recursive: true })
const fixtureBase = mkdtempSync(join(outDir, 'fixture-'))

const metadata = {
  recordedAt: new Date().toISOString(),
  model,
  effort,
  cliPath: CLI,
  cliSha256: sha256(CLI),
  cliBytes: statSync(CLI).size,
  sourceHead: runGit('rev-parse', 'HEAD'),
  sourceStatus: runGit('status', '--short'),
  cachedGateState: {
    ...readCachedGateState(),
    caveat:
      'Disk cache recorded before each run; a live GrowthBook payload could differ.',
  },
}
writeFileSync(join(outDir, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n')

const results: Array<{
  caseId: string
  verdict: Verdict
  reasons: string[]
  exitCode: number
  durationMs: number
  memory: MemorySnapshot
  rawFile: string
}> = []

console.log(JSON.stringify(metadata, null, 2))
console.log(`running ${selectedCases.length} save-side evaluations sequentially`)

for (const c of selectedCases) {
  const caseDir = join(fixtureBase, c.id)
  const projectDir = join(caseDir, 'project')
  const memoryDir = join(caseDir, 'memory')
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(memoryDir, { recursive: true })
  writeFileSync(
    join(projectDir, 'package.json'),
    JSON.stringify({ name: `memory-save-eval-${c.id}`, private: true }, null, 2) + '\n',
  )
  c.seed?.(memoryDir)

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
    '--max-turns',
    '8',
    '--allowedTools',
    'Read,Write,Edit',
  ]
  const started = Date.now()
  const proc = Bun.spawn(args, {
    cwd: projectDir,
    env: {
      ...process.env,
      CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: memoryDir,
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

  const rawFile = join(outDir, `${c.id}.json`)
  writeFileSync(rawFile, JSON.stringify({ args, exitCode, stdout, stderr }, null, 2) + '\n')
  const memory = snapshotMemory(memoryDir)
  const scored = exitCode === 0 ? c.score(memory) : { verdict: 'ERROR' as const, reasons: [`cli-dev exited ${exitCode}`] }
  const result = {
    caseId: c.id,
    ...scored,
    exitCode,
    durationMs: Date.now() - started,
    memory,
    rawFile,
  }
  results.push(result)
  writeFileSync(join(outDir, `${c.id}-memory.json`), JSON.stringify(memory, null, 2) + '\n')
  console.log(`${c.id}: ${result.verdict}${result.reasons.length > 0 ? ` — ${result.reasons.join('; ')}` : ''}`)
}

writeFileSync(
  join(outDir, 'results.jsonl'),
  results.map(result => JSON.stringify(result)).join('\n') + '\n',
)

console.log('\n=== SAVE-SIDE SUMMARY ===')
for (const result of results) {
  console.log(`${result.caseId.padEnd(28)} ${result.verdict}`)
  for (const reason of result.reasons) console.log(`  ${reason}`)
  console.log(`  topics: ${result.memory.topics.map(topic => basename(topic.path)).join(', ') || '(none)'}`)
  console.log(`  index: ${JSON.stringify(result.memory.index.trim())}`)
}
console.log(`\nartifacts: ${outDir}`)

if (!keepFixture) rmSync(fixtureBase, { recursive: true, force: true })
if (results.some(result => result.verdict !== 'PASS')) process.exitCode = 1
