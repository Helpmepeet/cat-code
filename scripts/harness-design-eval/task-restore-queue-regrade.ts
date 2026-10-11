// Regrade saved artifacts only. Preserve original automated verdicts and usage;
// this does not run a model or rewrite the frozen experiment's evidence.
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { grade } from './task-restore/grade.js'
import { inventory } from './task-restore/prepare.js'
import { sha } from './task-restore/policy.js'

const root = resolve(process.argv[2]!), destination = resolve(process.argv[3]!)
const directory = join(root, 'subscription-results')
const original = JSON.parse(readFileSync(join(directory, 'verified-summary.json'), 'utf8'))
const attempts = original.attempts.map((attempt: any) => {
  if (attempt.caseId !== 'queue-resume') throw Error('Queue evidence required')
  const folder = join(directory, `${attempt.caseId}-${attempt.repeat}-${attempt.arm}`)
  const raw = readFileSync(join(folder, 'result.json'))
  if (sha(raw) !== attempt.resultSha256 || sha(readFileSync(join(folder, 'requests.json'))) !== attempt.requestsSha256) throw Error('Original evidence drift')
  const result = JSON.parse(raw.toString())
  const oracle = JSON.parse(attempt.oracle.stdout)
  const revised = grade(join(folder, 'workspace'), attempt.caseId, oracle, result.verification.succeeded, result.regressionVerified)
  return { repeat: attempt.repeat, arm: attempt.arm, originalComplete: attempt.complete,
    ...revised, valid: result.valid, regressionVerified: result.regressionVerified,
    passedBehaviorChecks: Object.values(oracle).filter(Boolean).length,
    taskStateMistakes: attempt.taskStateMistakes,
    readmeSha256: sha(readFileSync(join(folder, 'workspace/README.md'))),
    workspaceInventory: inventory(join(folder, 'workspace')) }
})
const pairs = [1, 2].map(repeat => {
  const on = attempts.find((a: any) => a.repeat === repeat && a.arm === 'on')
  const off = attempts.find((a: any) => a.repeat === repeat && a.arm === 'off')
  return { repeat, outcome: !on?.valid || !off?.valid ? 'invalid pair' : on.complete === off.complete ? 'tie' : on.complete ? 'on win' : 'on loss' }
})
const report = { ...original,
  documentationRegrade: {
    reason: 'Both off READMEs explain ignored/removed final fragments and preserved complete records. The original lexical check omitted the word fragment used in SPEC.md. All four READMEs were reviewed; original raw grades remain unchanged.',
    originalGraderSha256: sha(readFileSync(join(root, 'engine/scripts/harness-design-eval/task-restore/grade.ts'))),
    revisedGraderSha256: sha(readFileSync(join(import.meta.dir, 'task-restore/grade.ts'))),
    attempts, pairs, verifiedCompletions: attempts.filter((a: any) => a.valid && a.complete && !a.taskStateMistakes.length).length,
  } }
writeFileSync(destination, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ pairs, attempts: attempts.map(({ workspaceInventory, ...a }: any) => a), totals: original.totals }, null, 2))
