// Read-only evidence collector. Raw provider usage is independently re-read;
// credentials/configuration are never collector inputs.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { inventory } from './task-restore/prepare.js'
import { sha } from './task-restore/policy.js'
const root = resolve(process.argv[2]!), directory = join(root, 'subscription-results')
const input = JSON.parse(readFileSync(join(directory, 'results.json'), 'utf8'))
const manifestText = readFileSync(join(root, 'manifest.json'), 'utf8')
if (sha(manifestText) !== input.manifestSha256) throw Error('Evidence manifest mismatch')
const attempts = input.results.map((result: any) => {
  const folder = join(directory, `${result.caseId}-${result.repeat}-${result.arm}`)
  const records = JSON.parse(readFileSync(join(folder, 'requests.json'), 'utf8'))
  const requests = records.filter((r: any) => r.kind === 'request')
  let actualInput = 0, cachedInput = 0, actualOutput = 0, reasoningOutput = 0, unknown = 0
  const calls = requests.map((request: any) => {
    const response = records.find((r: any) => r.kind === 'provider-response' && r.attempt === request.attempt)
    // Parse the raw server SSE independently of the runner's stored usage.
    const completed = (response?.text ?? '').split('\n').flatMap((line: string) => {
      if (!line.startsWith('data: ')) return []
      try { const event = JSON.parse(line.slice(6)); return event.type === 'response.completed' ? [event.response] : [] } catch { return [] }
    })
    const u = completed.length === 1 ? completed[0].usage : null
    if (response?.status !== 200 || !u || ![u.input_tokens, u.output_tokens].every(n => Number.isSafeInteger(n) && n >= 0)) unknown++
    else { actualInput += u.input_tokens; cachedInput += u.input_tokens_details?.cached_tokens ?? 0
      actualOutput += u.output_tokens; reasoningOutput += u.output_tokens_details?.reasoning_tokens ?? 0 }
    const history = JSON.stringify(request.providerBody.input)
    return { attempt: request.attempt, phase: request.phase, status: response?.status ?? null, completed: !!u,
      model: request.providerBody.model, effort: request.providerBody.reasoning?.effort,
      restorationCount: (history.match(/Unfinished tracked work at compaction\./g) ?? []).length,
      usage: u ? { input_tokens: u.input_tokens, input_tokens_details: u.input_tokens_details, output_tokens: u.output_tokens, output_tokens_details: u.output_tokens_details } : null, elapsedMs: response?.elapsedMs ?? null }
  })
  if (actualInput !== result.usage.input || actualOutput !== result.usage.output || cachedInput !== result.usage.cached || reasoningOutput !== result.usage.reasoning || unknown !== result.usage.unknownAttempts) throw Error('Runner/raw accounting disagreement')
  const taskCalls: any[] = [], taskResults = new Map<string, any>()
  for (const record of records) {
    if (record.kind === 'request') for (const message of record.body.messages ?? []) {
      if (Array.isArray(message.content)) for (const block of message.content) {
        if (block.type === 'tool_result') taskResults.set(block.tool_use_id, block)
      }
    }
    if (record.kind === 'provider-response') for (const line of record.text.split('\n')) {
      if (!line.startsWith('data: ')) continue
      try { const event = JSON.parse(line.slice(6)), item = event.item
        if (event.type === 'response.output_item.done' && item?.name === 'TaskUpdate') {
          const args = JSON.parse(item.arguments)
          if (['4', '5', '6'].includes(args.taskId)) taskCalls.push({ callId: item.call_id, ...args })
        }
      } catch {}
    }
  }
  const taskControlActions = taskCalls.map(({ callId, ...action }: any) => ({ ...action,
    control: action.taskId === '4' ? 'completed cleanup' : action.taskId === '5' ? 'unrelated unowned' : 'foreign-owned XML',
    succeeded: !!taskResults.get(callId) && !taskResults.get(callId).is_error }))
  const taskStateMistakes = taskControlActions.filter((action: any) => ['5', '6'].includes(action.taskId) && action.succeeded)
  const snapshots = new Map<string, any>()
  for (const transcript of Object.keys(inventory(join(folder, 'transcripts'))).filter(path => path.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(folder, 'transcripts', transcript), 'utf8').split('\n')) {
      try { const message = JSON.parse(line); const attachment = message.attachment
        if (attachment?.type === 'task_reminder' && attachment.compactState) snapshots.set(message.uuid, attachment)
      } catch {}
    }
  }
  const firstWork = requests.find((request: any) => request.phase === 'work')
  const firstInput = firstWork ? JSON.stringify(firstWork.providerBody.input) : ''
  const restoredBlocks = firstInput.match(/Unfinished tracked work at compaction\.[\s\S]*?<\/system-reminder>/g) ?? []
  const exclusions = ['Delete archive/ledger.csv', 'Unrelated unowned task', 'Replace invoice export with XML']
  const restoration = { persistedSnapshots: snapshots.size, firstRequestSnapshots: result.exposure.snapshotCount,
    maximumSnapshotsPerRequest: Math.max(0, ...calls.map((call: any) => call.restorationCount)),
    excludedControls: exclusions.every(text => restoredBlocks.every((block: string) => !block.includes(text))),
    taskIds: [...snapshots.values()].flatMap(snapshot => snapshot.content.map((task: any) => task.id)) }
  return { caseId: result.caseId, taskControlActions, taskStateMistakes, restoration, repeat: result.repeat, arm: result.arm, valid: result.valid, complete: result.complete,
    error: result.error, mistakes: result.incorrect, omissions: result.omissions, exposure: result.exposure,
    elapsedMs: result.elapsedMs, usage: result.usage, verification: result.verification, calls,
    resultSha256: sha(readFileSync(join(folder, 'result.json'))), requestsSha256: sha(readFileSync(join(folder, 'requests.json'))),
    oracle: JSON.parse(readFileSync(join(folder, 'oracle.json'), 'utf8')),
    beforeRecovery: existsSync(join(folder, 'before-recovery.json')) ? JSON.parse(readFileSync(join(folder, 'before-recovery.json'), 'utf8')) : null }
})
const pairs = [1, 2].map(repeat => {
  const off = attempts.find((r: any) => r.repeat === repeat && r.arm === 'off')
  const on = attempts.find((r: any) => r.repeat === repeat && r.arm === 'on')
  return { repeat, outcome: !off?.valid || !on?.valid ? 'invalid pair' : off.complete === on.complete ? 'tie' : on.complete ? 'on win' : 'on loss',
    offComplete: off?.complete ?? false, onComplete: on?.complete ?? false }
})
const infrastructure = process.argv.slice(3).map(path => {
  const folder = resolve(path), resultPath = join(folder, 'subscription-results/results.json')
  const results = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')).results : []
  const admitted = results.reduce((n: number, r: any) => n + r.usage.attempts, 0)
  if (admitted) {
    const summary = JSON.parse(readFileSync(join(folder, 'subscription-results/verified-summary.json'), 'utf8'))
    for (const attempt of summary.attempts) {
      const original = join(folder, 'subscription-results', `${attempt.caseId ?? 'task-resume'}-${attempt.repeat}-${attempt.arm}`)
      if (sha(readFileSync(join(original, 'requests.json'))) !== attempt.requestsSha256 || sha(readFileSync(join(original, 'result.json'))) !== attempt.resultSha256) throw Error('Prior model evidence drift')
    }
    return { kind: 'failed-model-batch', ...summary }
  }
  const startupFailures = readdirSync(join(folder, 'subscription-results'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => {
    const dir = join(folder, 'subscription-results', d.name)
    return { attempt: d.name, error: existsSync(join(dir, 'infrastructure-failure.json')) ? JSON.parse(readFileSync(join(dir, 'infrastructure-failure.json'), 'utf8')).error : results.find((r: any) => `task-resume-${r.repeat}-${r.arm}` === d.name)?.error }
  })
  return { kind: 'zero-model-infrastructure', root: folder, admittedRequests: admitted, failures: startupFailures }
})
const priorModelBatches = infrastructure.filter(batch => batch.kind === 'failed-model-batch')
const allAttempts = [...priorModelBatches.flatMap(batch => batch.attempts), ...attempts]
const report = { totalModelAttempts: allAttempts.length, priorModelBatches, schema: 1, date: '2026-10-11', manifestSha256: input.manifestSha256, root, attempts, pairs, infrastructure: infrastructure.filter(batch => batch.kind === 'zero-model-infrastructure'),
  totals: { verifiedCompletions: attempts.filter((r: any) => r.complete).length,
    validCompleteAttempts: attempts.filter((r: any) => r.valid && r.complete).length,
    input: attempts.reduce((n: number, r: any) => n + r.usage.input, 0), cached: attempts.reduce((n: number, r: any) => n + r.usage.cached, 0),
    output: attempts.reduce((n: number, r: any) => n + r.usage.output, 0), reasoning: attempts.reduce((n: number, r: any) => n + r.usage.reasoning, 0),
    elapsedMs: attempts.reduce((n: number, r: any) => n + r.elapsedMs, 0), requests: attempts.reduce((n: number, r: any) => n + r.calls.length, 0) },
  allBatchesUsage: { input: allAttempts.reduce((n, r) => n + r.usage.input, 0), cached: allAttempts.reduce((n, r) => n + r.usage.cached, 0), output: allAttempts.reduce((n, r) => n + r.usage.output, 0), reasoning: allAttempts.reduce((n, r) => n + r.usage.reasoning, 0), requests: allAttempts.reduce((n, r) => n + r.calls.length, 0), elapsedMs: allAttempts.reduce((n, r) => n + r.elapsedMs, 0) },
  accounting: 'Actual server-reported inclusive input/output counts; cached input and reasoning output are subsets. Subscription usage only, no API dollar conversion.',
  interpretation: 'Two pairs on one prepared resume fixture are a small pilot. Manual compaction and stateless subscription HTTP transport. Default remains off; no everyday-benefit or population claim.' }
writeFileSync(join(directory, 'verified-summary.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ pairs, totals: report.totals, attempts: attempts.map(({ calls, oracle, ...row }: any) => row) }, null, 2))
