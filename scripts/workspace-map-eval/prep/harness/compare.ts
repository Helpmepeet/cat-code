#!/usr/bin/env bun
// Usage: bun compare.ts <mandatoryProbeDir> <nomapProbeDir> --engine <mandatoryEngineDir> [--json out.json]
// Startup checks over every captured model request. Exits 1 when any fails.
//  - no-map: no map text in ANY request (main, workers, auxiliary), after removing
//    only unrelated phrases ("maps to rg --glob", an external "docs map"). The
//    no-map engine omits the engine's conditional routing sentence; the
//    mandatory engine keeps it in its worker prompts.
//  - nudge after the first broad search: present in mandatory, absent in no-map.
//  - every enabled worker type in each setup reached a final response, and no
//    frame reports a worker error or an unusable classifier verdict.
//  - tools identical between setups.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const [mand, nomap] = args as [string, string]
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
const engine = opt('--engine') ?? '/Users/Shared/cce/5c23b91a'
const jsonOut = opt('--json')
// Workers the offline probe cannot reach (e.g. pinned to a provider whose
// credentials runs will not carry). Allowed only when both setups fail them
// identically; they are reported, never counted as covered.
const expectUnavailable = (opt('--expect-unavailable') ?? '').split(',').filter(Boolean)
// The task's own no-map prompt was scrubbed with the precise rules at build
// time; its remaining "map" words are other senses (a verb, a data structure)
// and are excluded here, wherever the prompt is echoed (main, title request).
// Text is compared with escapes and whitespace normalized (the engine may embed
// the prompt JSON-encoded, or expand a skill command around its arguments).
const norm = (s: string) => s.replace(/\\+[nrt]/g, ' ').replace(/\\+(["'\/])/g, '$1').replace(/\s+/g, ' ')
const nomapPrompt = opt('--nomap-prompt') ? norm(readFileSync(opt('--nomap-prompt')!, 'utf8').replace(/^\/[\w-]+ /, '')).trim() : ''
const ENGINE_GUIDANCE = (readFileSync(join(engine, 'src/tools/AgentTool/built-in/mapRoutingGuidance.ts'), 'utf8').match(/"([^"]+)"/) ?? [])[1]!
const BENIGN = [/maps to rg --glob/gi, /docs map/gi, /docs-map/gi]
const MAP = /docs\/maps|WORKSPACE_MAP|workspace map|focused map|routing nudge|map-first|maps route|\bmaps?\b/gi

type Req = { file: string; label: string; body: any }
function load(dir: string): Req[] {
  const d = join(dir, 'stub', 'requests')
  return readdirSync(d).sort().map(f => ({ file: f, label: f.replace(/^\d+-\d+-/, '').replace(/\.json$/, ''), body: JSON.parse(readFileSync(join(d, f), 'utf8')).body }))
}
const text = (v: unknown) => typeof v === 'string' ? v : JSON.stringify(v ?? '')
function mapHits(s: string) {
  let t = s
  if (nomapPrompt) t = norm(t).split(nomapPrompt).join(' ')
  for (const b of BENIGN) t = t.replace(b, ' ')
  return [...t.matchAll(MAP)].map(m => t.slice(Math.max(0, m.index! - 50), m.index! + 50).replace(/\s+/g, ' '))
}
const find = (rs: Req[], re: RegExp) => rs.find(r => re.test(r.label))

function summarize(dir: string) {
  const rs = load(dir)
  const main = find(rs, /main-grep$/)
  const agentDesc = String((main?.body.tools ?? []).find((t: any) => t.name === 'Agent')?.description ?? '')
  const enabled = [...agentDesc.matchAll(/^- ([a-zA-Z][\w-]*): /gm)].map(m => m[1]!).filter(t => !['Lookups', 'Investigations'].includes(t))
  // A worker counts as finished when the parent received a non-error result for
  // the probe's Agent call (from the frames the sidecar sent to the client).
  const frames = existsSync(join(dir, 'frames.json')) ? readFileSync(join(dir, 'frames.json'), 'utf8') : ''
  const results = new Map<string, boolean>()
  const walk = (v: any) => { if (!v || typeof v !== 'object') return; if (v.type === 'tool_result' && typeof v.tool_use_id === 'string') results.set(v.tool_use_id, v.is_error !== true && !/completed_with_error/.test(JSON.stringify(v.content))); for (const x of Object.values(v)) walk(x) }
  walk(frames ? JSON.parse(frames) : [])
  const finished = enabled.filter(t => results.get(`probe_agent_${t}`) === true)
  const errors = [...frames.matchAll(/completed_with_error|Unable to connect to API|classifier response - blocking|classifier was unavailable/g)].map(m => m[0])
  const afterMainSearch = text(find(rs, /main-agent-/)?.body.input)
  const perRequestHits = rs.map(r => ({ request: r.label, hits: mapHits(text(r.body.instructions) + text(r.body.input) + text(r.body.tools) + text(r.body.system) + text(r.body.messages)) })).filter(x => x.hits.length)
  const engineGuidanceIn = rs.filter(r => text(r.body.instructions).includes(ENGINE_GUIDANCE)).map(r => r.label)
  return { requests: rs.map(r => r.label), enabled, finished, missingWorkers: enabled.filter(t => !finished.includes(t)), errors: [...new Set(errors)],
    nudgeAfterMainSearch: /Routing nudge/.test(afterMainSearch), nudgeAnywhere: rs.some(r => /Routing nudge/.test(text(r.body.input))),
    perRequestHits, engineGuidanceIn, mainTools: (main?.body.tools ?? []).map((t: any) => t.name) }
}

const a = summarize(mand), b = summarize(nomap)
const checks = {
  nudgeInMandatory: a.nudgeAfterMainSearch,
  noNudgeInNomap: !b.nudgeAnywhere,
  nomapNoMapTextInAnyRequest: b.perRequestHits.length === 0,
  allWorkersFinishedMandatory: a.enabled.length > 0 && a.missingWorkers.every(w => expectUnavailable.includes(w)),
  allWorkersFinishedNomap: b.enabled.length > 0 && b.missingWorkers.every(w => expectUnavailable.includes(w)),
  unavailableWorkersIdentical: JSON.stringify(a.missingWorkers) === JSON.stringify(b.missingWorkers),
  noClassifierErrors: ![...a.errors, ...b.errors].some(e => /classifier/.test(e)),
  noUnexpectedWorkerErrors: (a.errors.length === 0 && b.errors.length === 0) || (expectUnavailable.length > 0 && a.missingWorkers.length > 0 && JSON.stringify(a.errors) === JSON.stringify(b.errors) && ![...a.errors].some(e => /classifier/.test(e))),
  sameTools: JSON.stringify(a.mainTools) === JSON.stringify(b.mainTools) && JSON.stringify(a.enabled) === JSON.stringify(b.enabled),
  engineGuidanceOnlyInMandatory: a.engineGuidanceIn.length > 0 && b.engineGuidanceIn.length === 0,
}
const result = { checks, expectUnavailable, pass: Object.values(checks).every(Boolean), engineConditionalGuidance: { mandatory: a.engineGuidanceIn, nomap: b.engineGuidanceIn }, mandatory: a, nomap: b }
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(result, null, 1))
console.log(JSON.stringify({ pass: result.pass, checks, engineConditionalGuidance: result.engineConditionalGuidance, nomapHits: b.perRequestHits.slice(0, 5), missing: [a.missingWorkers, b.missingWorkers], errors: [a.errors, b.errors] }, null, 1))
process.exit(result.pass ? 0 : 1)
