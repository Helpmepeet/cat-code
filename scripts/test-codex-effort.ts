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
  { effort: 'low', model: 'gpt-5.6-sol', expect: 'low', note: 'low on Sol' },
  { effort: 'low', model: 'gpt-5.6-luna', expect: 'low', note: 'low on Luna' },
  { effort: 'medium', model: 'gpt-5.6-luna', expect: 'medium', note: 'medium on Luna' },
  { effort: 'high', model: 'gpt-5.6-luna', expect: 'high', note: 'high on Luna' },
  { effort: 'low', model: 'gpt-5.6-terra', expect: 'low', note: 'low on Terra' },
  { effort: 'high', model: 'gpt-5.6-terra', expect: 'high', note: 'high on Terra' },

  // GPT-5.6 models preserve the reasoning levels advertised by Codex CLI.
  { effort: 'xhigh', model: 'gpt-5.6-sol', expect: 'xhigh', note: 'xhigh on Sol' },
  { effort: 'max', model: 'gpt-5.6-sol', expect: 'max', note: 'max on Sol' },
  { effort: 'ultra', model: 'gpt-5.6-sol', expect: 'ultra', note: 'ultra on Sol' },
  { effort: 'max', model: 'gpt-5.6-luna', expect: 'max', note: 'max on Luna' },
  { effort: 'ultra', model: 'gpt-5.6-luna', expect: undefined, note: 'ultra on Luna → omit' },
  { effort: 'max', model: 'gpt-5.2-codex', expect: 'xhigh', note: 'max on codex-variant → xhigh' },
  { effort: 'max', model: 'gpt-5.1-codex-max', expect: 'xhigh', note: 'max on codex-max → xhigh' },
  { effort: 'max', model: 'gpt-5.6-terra', expect: 'max', note: 'max on Terra' },
  { effort: 'ultra', model: 'gpt-5.6-terra', expect: 'ultra', note: 'ultra on Terra' },
  { effort: 'max', model: 'gpt-5.2', expect: 'high', note: 'max on base gpt-5.2 → high' },

  // minimal disables thinking and preserves the old fast-slot latency intent.
  { effort: 'minimal', model: 'gpt-5.6-terra', expect: 'none', note: 'minimal on Terra → none' },
  { effort: 'minimal', model: 'gpt-5.6-sol', expect: 'none', note: 'minimal on Sol → none' },
  { effort: 'minimal', model: 'gpt-5.6-luna', expect: 'none', note: 'minimal on Luna → none' },

  // undefined / auto / garbage → omit
  { effort: undefined, model: 'gpt-5.6-luna', expect: undefined, note: 'undefined → omit' },
  { effort: '', model: 'gpt-5.6-luna', expect: undefined, note: 'empty string → omit' },
  { effort: 'auto', model: 'gpt-5.6-luna', expect: undefined, note: 'auto → omit (server default)' },
  { effort: 'garbage', model: 'gpt-5.6-luna', expect: undefined, note: 'unknown → omit' },

  // case insensitivity
  { effort: 'HIGH', model: 'gpt-5.6-luna', expect: 'high', note: 'uppercase HIGH → high' },
  { effort: 'Max', model: 'gpt-5.6-luna', expect: 'max', note: 'mixed-case Max → max' },
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
