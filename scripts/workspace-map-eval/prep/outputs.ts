// Tool outputs of one transcript (Cat Code, Claude Code, or Codex), decoded,
// with the time of the call that produced them. Persisted large outputs are
// read from their saved file.
import { readFileSync } from 'node:fs'

export type Output = { ts: string; command: string; text: string }

export function outputs(path: string): Output[] {
  const res: Output[] = []
  const calls = new Map<string, { ts: string; command: string }>()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    let r: any; try { r = JSON.parse(line) } catch { continue }
    const p = r.payload ?? {}
    if (r.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')) calls.set(p.call_id, { ts: r.timestamp, command: String(p.arguments ?? p.input ?? '') })
    if (r.type === 'response_item' && (p.type === 'function_call_output' || p.type === 'custom_tool_call_output')) {
      const c = calls.get(p.call_id) ?? { ts: r.timestamp, command: '' }
      const items = Array.isArray(p.output) ? p.output : [{ text: typeof p.output === 'string' ? p.output : JSON.stringify(p.output) }]
      for (const it of items) {
        const t = String(it?.text ?? '')
        for (const chunk of t.startsWith('{') ? t.split('\n') : [t]) {
          try { const o = JSON.parse(chunk); res.push({ ...c, text: String(o.output ?? o.value?.output ?? o.reason ?? '') }) } catch { res.push({ ...c, text: chunk }) }
        }
      }
    }
    if (r.type === 'assistant' && Array.isArray(r.message?.content)) {
      for (const c of r.message.content) if (c?.type === 'tool_use') calls.set(c.id, { ts: r.timestamp, command: JSON.stringify(c.input ?? {}) })
    }
    if (r.type === 'user' && Array.isArray(r.message?.content)) {
      for (const c of r.message.content) {
        if (c?.type !== 'tool_result') continue
        const s = typeof c.content === 'string' ? c.content : (c.content ?? []).map((x: any) => x?.text ?? '').join('\n')
        const persisted = s.match(/Full output saved to: (\S+)/)
        let text = s
        if (persisted) try { text = readFileSync(persisted[1]!, 'utf8') } catch {}
        res.push({ ...(calls.get(c.tool_use_id) ?? { ts: r.timestamp, command: '' }), text })
      }
    }
  }
  return res
}

const PORCELAIN = /^(?: M|M |MM|AM|A | D|D |R |\?\?) (\S.*)$/
/** `git status --short` blocks: every output whose lines are mostly porcelain. */
export function statusBlocks(list: Output[]): { ts: string; entries: { code: string; path: string }[] }[] {
  const blocks = []
  for (const o of list) {
    if (!/git status/.test(o.command)) continue
    const entries = o.text.split('\n').flatMap(l => { const m = PORCELAIN.exec(l.replace(/^\s*\d+\t/, '')); return m ? [{ code: l.slice(0, 2), path: m[1]! }] : [] })
    // An empty result proves a clean tree only when the call ran git status alone.
    const alone = /^\{"command":"git (?:--no-optional-locks )?status(?: --short| -s| --porcelain)*"/.test(o.command)
    const clean = alone && !o.text.split('\n').some(l => l.trim() && !/fsmonitor|^Exit code 0$/.test(l))
    if (entries.length || clean) blocks.push({ ts: o.ts, entries })
  }
  return blocks
}
