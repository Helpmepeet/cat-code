import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { usage, cost } from './run.js'
// An interrupted parent must not erase an admitted provider attempt. Its
// incomplete raw ledger is retained; absent timing/usage stays unknown.
export function loadResults(root: string) {
  const input = JSON.parse(readFileSync(join(root, 'results.json'), 'utf8'))
  for (const dir of readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory())) {
    const folder = join(root, dir.name)
    if (!existsSync(join(folder, 'attempt.json'))) continue
    const attempt = JSON.parse(readFileSync(join(folder, 'attempt.json'), 'utf8'))
    if (input.results.some((r: any) => r.caseId === attempt.caseId && r.repeat === attempt.repeat && r.arm === attempt.arm)) continue
    const records: any[] = []
    if (existsSync(join(folder, 'requests.jsonl'))) for (const line of readFileSync(join(folder, 'requests.jsonl'), 'utf8').split('\n')) {
      try { records.push(JSON.parse(line)) } catch { /* Last append can be incomplete on termination. */ }
    }
    input.results.push({ ...attempt, valid: false, complete: false, error: 'Interrupted attempt; no finalized result',
      omissions: ['ungraded interrupted attempt'], incorrect: [], elapsedMs: null,
      usage: usage(records), costUsdEstimate: input.prices ? cost(records, input.prices) : null })
  }
  return input
}
export function collect(input: {live: boolean; manifestSha256: string; results: any[]}) {
  const cohorts: any = {}
  for (const name of ['forced', 'forced-safety', 'ordinary']) {
    const rows = input.results.filter(r => r.cohort === name)
    const pairs: any[] = []
    for (const key of new Set(rows.map(r => `${r.caseId}:${r.repeat}`))) {
      const pair = rows.filter(r => `${r.caseId}:${r.repeat}` === key)
      const off = pair.find(r => r.arm === 'off'), on = pair.find(r => r.arm === 'on')
      pairs.push({ key, valid: !!off?.valid && !!on?.valid, offComplete: off?.complete ?? null, onComplete: on?.complete ?? null,
        outcome: !off?.valid || !on?.valid ? 'incomplete/invalid' : on.complete && !off.complete ? 'on-win' : off.complete && !on.complete ? 'on-loss' : 'tie' })
    }
    const arms: any = {}
    for (const arm of ['off', 'on']) {
      const attempts = rows.filter(r => r.arm === arm), completed = attempts.filter(r => r.valid && r.complete).length
      const elapsedMs = attempts.some(r => !Number.isFinite(r.elapsedMs)) ? null : attempts.reduce((n, r) => n + r.elapsedMs, 0)
      const unknown = attempts.some(r => r.usage.unknownAttempts > 0 || r.costUsdEstimate === null)
      const cost = unknown ? null : attempts.reduce((n, r) => n + r.costUsdEstimate, 0)
      arms[arm] = { attempts: attempts.length, valid: attempts.filter(r => r.valid).length, completed,
        restorationDeliveryGaps: attempts.filter(r => r.restorationDeliveryGap).length,
        omissions: attempts.flatMap(r => r.omissions), incorrect: attempts.flatMap(r => r.incorrect),
        elapsedMs, msPerVerifiedCompletion: completed && elapsedMs !== null ? elapsedMs / completed : null,
        costUsdEstimate: cost, costPerVerifiedCompletion: completed && cost !== null ? cost / completed : null,
        usage: attempts.map(r => r.usage), allFailuresCharged: true }
    }
    cohorts[name] = { pairs, arms }
  }
  return { schema: 1, manifestSha256: input.manifestSha256, evidence: input.live ? 'live model screening' : 'MOCKED transport infrastructure only', cohorts,
    interpretation: 'One repair family with two lifecycle variants and two repeats is still one task cluster. No non-inferiority, population benefit, p95, or everyday frequency claim. Manual compaction results stay separate. Token-based billing estimates are not provider invoices. Default remains off.' }
}
if (import.meta.main) {
  const root = resolve(process.argv[2]!)
  const report = collect(loadResults(root))
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
