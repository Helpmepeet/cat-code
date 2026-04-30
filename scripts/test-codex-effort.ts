/**
 * Standalone verification for /effort → Codex reasoning mapping.
 * Run with: bun run scripts/test-codex-effort.ts
 */
import { mapEffortToCodex } from '../src/services/api/codex-fetch-adapter.js'

type Case = {
  effort: string | undefined
  model: string
  expect: string | undefined
  note: string
}

const cases: Case[] = [
  // low / medium / high — pass-through on all Codex models
  { effort: 'low', model: 'gpt-5.3-codex', expect: 'low', note: 'low on codex' },
  { effort: 'medium', model: 'gpt-5.3-codex', expect: 'medium', note: 'medium on codex' },
  { effort: 'high', model: 'gpt-5.3-codex', expect: 'high', note: 'high on codex' },
  { effort: 'low', model: 'gpt-5.5', expect: 'low', note: 'low on latest base gpt' },
  { effort: 'high', model: 'gpt-5.5', expect: 'high', note: 'high on latest base gpt' },
  { effort: 'low', model: 'gpt-5.4', expect: 'low', note: 'low on base gpt' },
  { effort: 'high', model: 'gpt-5.4', expect: 'high', note: 'high on base gpt' },

  // max → xhigh on codex variants and supported base GPT models
  { effort: 'max', model: 'gpt-5.3-codex', expect: 'xhigh', note: 'max on codex → xhigh' },
  { effort: 'max', model: 'gpt-5.2-codex', expect: 'xhigh', note: 'max on codex-variant → xhigh' },
  { effort: 'max', model: 'gpt-5.1-codex-max', expect: 'xhigh', note: 'max on codex-max → xhigh' },
  { effort: 'max', model: 'gpt-5.5', expect: 'xhigh', note: 'max on latest base gpt → xhigh' },
  { effort: 'max', model: 'gpt-5.4', expect: 'xhigh', note: 'max on previous base gpt → xhigh' },
  { effort: 'max', model: 'gpt-5.2', expect: 'high', note: 'max on base gpt-5.2 → high' },

  // minimal passes through
  { effort: 'minimal', model: 'gpt-5.5', expect: 'minimal', note: 'minimal on latest base gpt' },
  { effort: 'minimal', model: 'gpt-5.4', expect: 'minimal', note: 'minimal on base gpt' },

  // undefined / auto / garbage → omit
  { effort: undefined, model: 'gpt-5.3-codex', expect: undefined, note: 'undefined → omit' },
  { effort: '', model: 'gpt-5.3-codex', expect: undefined, note: 'empty string → omit' },
  { effort: 'auto', model: 'gpt-5.3-codex', expect: undefined, note: 'auto → omit (server default)' },
  { effort: 'garbage', model: 'gpt-5.3-codex', expect: undefined, note: 'unknown → omit' },

  // case insensitivity
  { effort: 'HIGH', model: 'gpt-5.3-codex', expect: 'high', note: 'uppercase HIGH → high' },
  { effort: 'Max', model: 'gpt-5.3-codex', expect: 'xhigh', note: 'mixed-case Max → xhigh' },
]

let pass = 0
let fail = 0
for (const c of cases) {
  const got = mapEffortToCodex(c.effort, c.model)
  const ok = got === c.expect
  if (ok) {
    pass++
    console.log(`  PASS  ${c.note.padEnd(40)}  effort=${String(c.effort).padEnd(9)} model=${c.model.padEnd(22)} → ${String(got)}`)
  } else {
    fail++
    console.log(`X FAIL  ${c.note.padEnd(40)}  effort=${String(c.effort).padEnd(9)} model=${c.model.padEnd(22)} → got=${String(got)} expected=${String(c.expect)}`)
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
