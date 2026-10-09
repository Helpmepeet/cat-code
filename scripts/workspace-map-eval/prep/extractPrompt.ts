#!/usr/bin/env bun
// Usage: bun extractPrompt.ts <inventoryIndex> <outFile> [--images <dir>]
// Writes the first substantive request verbatim (the inventory stores it
// whitespace-collapsed) and lists any image parts. Verifies the match by
// comparing the normalized text against the inventory entry.
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const [idx, outFile] = process.argv.slice(2) as [string, string]
const inv = JSON.parse(readFileSync('/Users/pt/workspace-map-study/selection-v2/tasks.json', 'utf8')).tasks[Number(idx)]
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
const home = homedir()

function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc
  for (const n of readdirSync(dir)) { const p = join(dir, n); statSync(p).isDirectory() ? walk(p, acc) : n.endsWith('.jsonl') && acc.push(p) }
  return acc
}

let file = ''
if (inv.src === 'codex') {
  file = [...walk(join(home, '.codex/sessions')), ...walk(join(home, '.codex/archived_sessions'))]
    .find(f => f.endsWith(`${inv.id}.jsonl`))!
} else {
  const root = join(home, inv.src === 'catcode' ? '.cat-code/projects' : '.claude/projects')
  for (const p of readdirSync(root)) {
    if (!p.startsWith('-Users-pt-cat-code')) continue
    for (const n of readdirSync(join(root, p))) if (n === `${inv.id}.jsonl`) file = join(root, p, n)
  }
}
// Same client-context stripping as taskInventory.ts: the Codex app prepends
// these blocks to a user message; they are not the user's words.
const CONTEXT = /^\s*<(recommended_plugins|external_codex_apps_\w+|in-app-browser-context|environment_context)\b[^>]*>[\s\S]*?<\/\1>/
const SKIP = ['# AGENTS.md', '<environment_context', '<turn_aborted', '<user_instructions', '<permissions', '<INSTRUCTIONS', '<skill', '<user_shell_command']
function strip(t: string) { let r = t; for (let m = CONTEXT.exec(r); m; m = CONTEXT.exec(r)) r = r.slice(m[0].length); return r.replace(/^\s+/, '') }
const records = readFileSync(file, 'utf8').split('\n').flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })
let text = '', images = 0
for (const r of records) {
  if (r.timestamp !== inv.ts) continue
  let parts: any[] = []
  if (inv.src === 'codex') { if (r.type !== 'response_item' || r.payload?.role !== 'user') continue; parts = r.payload.content ?? [] }
  else { if (r.type !== 'user') continue; const c = r.message?.content; parts = typeof c === 'string' ? [{ type: 'text', text: c }] : c ?? [] }
  if (inv.src === 'codex') parts = parts.map(p => p.type === 'input_text' ? { ...p, text: strip(p.text ?? '') } : p).filter(p => p.type !== 'input_text' || (p.text && !SKIP.some(k => p.text.startsWith(k))))
  const t = parts.filter(p => p.type === 'text' || p.type === 'input_text').map(p => p.text ?? '').join(' ')
  if (norm(t) !== inv.text && !norm(t).startsWith(inv.text.slice(0, 200))) continue
  // Claude-like joins text parts with a space in the inventory; keep parts verbatim, newline-joined.
  text = parts.filter(p => p.type === 'text' || p.type === 'input_text').map(p => p.text ?? '').join('\n\n')
  const imgs = parts.filter(p => p.type === 'image' || p.type === 'input_image')
  images = imgs.length
  const dir = process.argv.includes('--images') ? process.argv[process.argv.indexOf('--images') + 1]! : ''
  if (dir) {
    mkdirSync(dir, { recursive: true })
    imgs.forEach((p, n) => {
      // Claude-like: {source:{media_type,data}}; Codex: {image_url:"data:<type>;base64,<data>"}
      const m = /^data:([^;]+);base64,(.*)$/s.exec(String(p.image_url ?? ''))
      const mediaType = p.source?.media_type ?? m?.[1]
      const data = p.source?.data ?? m?.[2]
      if (!mediaType || !data) throw new Error(`unreadable image part ${n}`)
      writeFileSync(join(dir, `${n + 1}.${mediaType.split('/')[1]}`), Buffer.from(data, 'base64'))
    })
  }
  break
}
if (!text) throw new Error(`verbatim prompt not found in ${file}`)
writeFileSync(outFile, text)
console.log(JSON.stringify({ file, chars: text.length, images, normalizedMatches: norm(text) === inv.text }))
