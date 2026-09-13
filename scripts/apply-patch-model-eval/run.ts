import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  APPLY_PATCH_MODEL_EVAL_CASES,
  APPLY_PATCH_MODEL_EVAL_MANIFEST_VERSION,
  APPLY_PATCH_MODEL_EVAL_POLICY,
  type EvalFileMap,
} from './manifest.js'

type Contract = (typeof APPLY_PATCH_MODEL_EVAL_POLICY.contracts)[number]

interface Args {
  currentCli: string
  candidateCli: string
  out: string
  maxTotalUsd: number
  maxRunUsd: number
}

interface ToolAttempt {
  id: string | null
  name: string
  input: string | null
  rejected: boolean | null
}

interface RunResult {
  manifestVersion: number
  contract: Contract
  caseId: string
  repeat: number
  taskCorrect: boolean
  unexpectedPaths: string[]
  mismatchedPaths: string[]
  applyPatchAttempts: number
  rejectedAttempts: number
  canonicalNameAttempts: number
  legacyNameAttempts: number
  costUsd: number
  durationMs: number
  exitCode: number
  processError: boolean
  resultText: string
  rawFile: string
  finalFilesDir: string
}

const RUN_TIMEOUT_MS = 480_000
const SPEND_RESERVE_USD = 0.3

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  const get = (flag: string): string | null => {
    const index = argv.indexOf(flag)
    return index >= 0 ? (argv[index + 1] ?? null) : null
  }
  const currentCli = resolve(get('--current-cli') ?? join(import.meta.dir, '..', '..', 'cli-dev'))
  const candidate = get('--candidate-cli')
  if (!candidate) throw new Error('--candidate-cli is required')
  const candidateCli = resolve(candidate)
  const out = resolve(get('--out') ?? '/private/tmp/apply-patch-model-eval')
  const maxTotalUsd = Number(get('--max-total-usd') ?? '12')
  const maxRunUsd = Number(get('--max-run-usd') ?? '0.18')
  if (!existsSync(currentCli)) throw new Error(`current CLI does not exist: ${currentCli}`)
  if (!existsSync(candidateCli)) throw new Error(`candidate CLI does not exist: ${candidateCli}`)
  if (!Number.isFinite(maxTotalUsd) || maxTotalUsd <= 0) throw new Error('invalid --max-total-usd')
  if (!Number.isFinite(maxRunUsd) || maxRunUsd <= 0) throw new Error('invalid --max-run-usd')
  return { currentCli, candidateCli, out, maxTotalUsd, maxRunUsd }
}

function writeFixture(root: string, files: EvalFileMap): void {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
  }
}

function listFiles(root: string, prefix = ''): string[] {
  const directory = join(root, prefix)
  const result: string[] = []
  for (const entry of readdirSync(directory)) {
    const relative = prefix ? join(prefix, entry) : entry
    const absolute = join(root, relative)
    if (statSync(absolute).isDirectory()) result.push(...listFiles(root, relative))
    else result.push(relative)
  }
  return result.sort()
}

function copyFinalFiles(source: string, destination: string): void {
  rmSync(destination, { recursive: true, force: true })
  for (const relative of listFiles(source)) {
    const target = join(destination, relative)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, readFileSync(join(source, relative)))
  }
}

function childObjects(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') return Object.values(value)
  return []
}

function collectObjects(value: unknown, output: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return output
  if (!Array.isArray(value)) output.push(value as Record<string, unknown>)
  for (const child of childObjects(value)) collectObjects(child, output)
  return output
}

function parseStream(stdout: string): {
  attempts: ToolAttempt[]
  costUsd: number
  resultText: string
  streamError: boolean
} {
  const rows: unknown[] = []
  let streamError = false
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      streamError = true
    }
  }
  const objects = rows.flatMap(row => collectObjects(row))
  const resultsById = new Map<string, boolean>()
  for (const object of objects) {
    const toolUseId = typeof object.tool_use_id === 'string' ? object.tool_use_id : null
    if (toolUseId && (object.type === 'tool_result' || 'is_error' in object)) {
      resultsById.set(toolUseId, object.is_error === true)
    }
  }
  const seenIds = new Set<string>()
  const attempts: ToolAttempt[] = []
  for (const object of objects) {
    const name = typeof object.name === 'string' ? object.name : null
    if (name !== 'apply_patch' && name !== 'Apply_patch') continue
    const id = typeof object.id === 'string' ? object.id : null
    const dedupe = id ?? `${name}:${String(object.input)}`
    if (seenIds.has(dedupe)) continue
    seenIds.add(dedupe)
    attempts.push({
      id,
      name,
      input: typeof object.input === 'string' ? object.input : null,
      rejected: id && resultsById.has(id) ? resultsById.get(id)! : null,
    })
  }
  let costUsd = 0
  let resultText = ''
  for (const object of objects) {
    if (typeof object.total_cost_usd === 'number') costUsd = object.total_cost_usd
    if (object.type === 'result' && typeof object.result === 'string') resultText = object.result
    if (object.type === 'result' && object.is_error === true) streamError = true
  }
  return { attempts, costUsd, resultText, streamError }
}

function scoreFixture(root: string, expected: EvalFileMap): {
  taskCorrect: boolean
  unexpectedPaths: string[]
  mismatchedPaths: string[]
} {
  const actualPaths = listFiles(root)
  const expectedPaths = Object.keys(expected).sort()
  const unexpectedPaths = actualPaths.filter(path => !(path in expected))
  const missingPaths = expectedPaths.filter(path => !actualPaths.includes(path))
  const mismatchedPaths = expectedPaths.filter(path => {
    if (!actualPaths.includes(path)) return true
    return !readFileSync(join(root, path)).equals(Buffer.from(expected[path]!))
  })
  return {
    taskCorrect: unexpectedPaths.length === 0 && missingPaths.length === 0 && mismatchedPaths.length === 0,
    unexpectedPaths,
    mismatchedPaths,
  }
}

function resultKey(contract: Contract, caseId: string, repeat: number): string {
  return `${contract}-${caseId}-r${repeat}`
}

function runResultPath(out: string, contract: Contract, caseId: string, repeat: number): string {
  return join(out, 'results', `${resultKey(contract, caseId, repeat)}.json`)
}

function loadCompletedResults(out: string): RunResult[] {
  const resultsDir = join(out, 'results')
  if (!existsSync(resultsDir)) return []
  const results: RunResult[] = []
  for (const name of readdirSync(resultsDir).sort()) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(join(resultsDir, name), 'utf8')) as RunResult
      if (parsed.manifestVersion === APPLY_PATCH_MODEL_EVAL_MANIFEST_VERSION) results.push(parsed)
    } catch {
      // A partial result is not completed evidence and will be rerun.
    }
  }
  return results
}

function buildRunArgs(cli: string, prompt: string, maxRunUsd: number): string[] {
  return [
    cli,
    '-p',
    prompt,
    '--model',
    APPLY_PATCH_MODEL_EVAL_POLICY.model,
    '--effort',
    APPLY_PATCH_MODEL_EVAL_POLICY.effort,
    '--output-format',
    'stream-json',
    '--max-turns',
    '8',
    '--max-budget-usd',
    String(maxRunUsd),
    '--permission-mode',
    'acceptEdits',
    '--tools',
    'Read,apply_patch',
    '--bare',
    '--no-session-persistence',
  ]
}

async function runOne(
  args: Args,
  contract: Contract,
  caseId: string,
  repeat: number,
): Promise<RunResult> {
  const caseDef = APPLY_PATCH_MODEL_EVAL_CASES.find(item => item.id === caseId)
  if (!caseDef) throw new Error(`unknown case: ${caseId}`)
  const key = resultKey(contract, caseId, repeat)
  const fixtureDir = join(args.out, 'work', key)
  const rawFile = join(args.out, 'raw', `${key}.json`)
  const finalFilesDir = join(args.out, 'final', key)
  writeFixture(fixtureDir, caseDef.initialFiles)
  mkdirSync(dirname(rawFile), { recursive: true })

  const cli = contract === 'current' ? args.currentCli : args.candidateCli
  const command = buildRunArgs(cli, caseDef.prompt, args.maxRunUsd)
  const started = Date.now()
  const proc = Bun.spawn(command, {
    cwd: fixtureDir,
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
  const durationMs = Date.now() - started
  writeFileSync(rawFile, JSON.stringify({ command, exitCode, stdout, stderr }, null, 2))
  copyFinalFiles(fixtureDir, finalFilesDir)

  const stream = parseStream(stdout)
  const fixtureScore = scoreFixture(fixtureDir, caseDef.expectedFiles)
  const result: RunResult = {
    manifestVersion: APPLY_PATCH_MODEL_EVAL_MANIFEST_VERSION,
    contract,
    caseId,
    repeat,
    ...fixtureScore,
    applyPatchAttempts: stream.attempts.length,
    rejectedAttempts: stream.attempts.filter(attempt => attempt.rejected === true).length,
    canonicalNameAttempts: stream.attempts.filter(attempt => attempt.name === 'apply_patch').length,
    legacyNameAttempts: stream.attempts.filter(attempt => attempt.name === 'Apply_patch').length,
    costUsd: stream.costUsd,
    durationMs,
    exitCode,
    processError: stream.streamError || (exitCode !== 0 && !fixtureScore.taskCorrect),
    resultText: stream.resultText,
    rawFile,
    finalFilesDir,
  }
  const destination = runResultPath(args.out, contract, caseId, repeat)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, `${JSON.stringify(result, null, 2)}\n`)
  return result
}

function summarize(results: RunResult[], spentUsd: number): Record<string, unknown> {
  const byContract = Object.fromEntries(
    APPLY_PATCH_MODEL_EVAL_POLICY.contracts.map(contract => {
      const rows = results.filter(result => result.contract === contract)
      return [
        contract,
        {
          runs: rows.length,
          correct: rows.filter(result => result.taskCorrect).length,
          attempts: rows.reduce((sum, result) => sum + result.applyPatchAttempts, 0),
          rejectedAttempts: rows.reduce((sum, result) => sum + result.rejectedAttempts, 0),
          legacyNameAttempts: rows.reduce((sum, result) => sum + result.legacyNameAttempts, 0),
          processErrors: rows.filter(result => result.processError).length,
          costUsd: rows.reduce((sum, result) => sum + result.costUsd, 0),
        },
      ]
    }),
  )
  return {
    manifestVersion: APPLY_PATCH_MODEL_EVAL_MANIFEST_VERSION,
    model: APPLY_PATCH_MODEL_EVAL_POLICY.model,
    effort: APPLY_PATCH_MODEL_EVAL_POLICY.effort,
    expectedRuns: APPLY_PATCH_MODEL_EVAL_POLICY.expectedRuns,
    completedRuns: results.length,
    spentUsd,
    byContract,
  }
}

async function main(): Promise<void> {
  const args = parseArgs()
  mkdirSync(args.out, { recursive: true })
  writeFileSync(
    join(args.out, 'frozen-manifest.json'),
    `${JSON.stringify({
      version: APPLY_PATCH_MODEL_EVAL_MANIFEST_VERSION,
      policy: APPLY_PATCH_MODEL_EVAL_POLICY,
      cases: APPLY_PATCH_MODEL_EVAL_CASES,
    }, null, 2)}\n`,
  )

  const completed = loadCompletedResults(args.out)
  const completedKeys = new Set(
    completed.map(result => resultKey(result.contract, result.caseId, result.repeat)),
  )
  let spentUsd = completed.reduce((sum, result) => sum + result.costUsd, 0)
  const schedule: Array<{ contract: Contract; caseId: string; repeat: number }> = []
  for (let repeat = 1; repeat <= APPLY_PATCH_MODEL_EVAL_POLICY.repeats; repeat++) {
    for (const caseDef of APPLY_PATCH_MODEL_EVAL_CASES) {
      const contracts: readonly Contract[] =
        repeat % 2 === 0 ? ['candidate', 'current'] : ['current', 'candidate']
      for (const contract of contracts) schedule.push({ contract, caseId: caseDef.id, repeat })
    }
  }

  console.log(
    `apply_patch model eval v${APPLY_PATCH_MODEL_EVAL_MANIFEST_VERSION}: ` +
      `${schedule.length} runs, ${completed.length} already complete, $${spentUsd.toFixed(4)} spent`,
  )
  for (const job of schedule) {
    const key = resultKey(job.contract, job.caseId, job.repeat)
    if (completedKeys.has(key)) continue
    if (spentUsd + SPEND_RESERVE_USD > args.maxTotalUsd) {
      console.log(`STOP spend reserve: $${spentUsd.toFixed(4)} spent of $${args.maxTotalUsd.toFixed(2)}`)
      break
    }
    const result = await runOne(args, job.contract, job.caseId, job.repeat)
    completed.push(result)
    completedKeys.add(key)
    spentUsd += result.costUsd
    writeFileSync(
      join(args.out, 'summary.json'),
      `${JSON.stringify(summarize(completed, spentUsd), null, 2)}\n`,
    )
    console.log(
      `[${completed.length}/${schedule.length}] ${key} ` +
        `${result.taskCorrect ? 'PASS' : 'FAIL'} attempts=${result.applyPatchAttempts} ` +
        `rejected=${result.rejectedAttempts} cost=$${result.costUsd.toFixed(4)} ` +
        `total=$${spentUsd.toFixed(4)}`,
    )
  }

  const summary = summarize(completed, spentUsd)
  writeFileSync(join(args.out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify(summary, null, 2))
  if (completed.length !== schedule.length) process.exitCode = 2
}

if (import.meta.main) await main()

export const _forTest = {
  buildRunArgs,
  parseStream,
  scoreFixture,
  summarize,
}
