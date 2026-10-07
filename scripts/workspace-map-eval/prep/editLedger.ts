#!/usr/bin/env bun
// Builds an index of every file-modifying tool call that touched a cat-code
// checkout (main tree or .worktrees/*), across Cat Code, Claude Code, and Codex
// transcripts. Output: JSONL rows {ts, src, file, tool, ok, paths, payload}.
// Used to tell whether a file was dirty at a task's prompt time, and to replay
// uncommitted edits when the task needs them.
import { createReadStream, existsSync, readdirSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const home = homedir()
const out = process.argv[2]!
writeFileSync(out, '')
const REPO = '/Users/pt/cat-code'

function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, acc)
    else if (name.endsWith('.jsonl')) acc.push(p)
  }
  return acc
}

async function* lines(path: string) {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.includes('cat-code') && !line.includes('tool_result') && !line.includes('_output"')) { yield null; continue }
    try { yield JSON.parse(line) } catch { yield null }
  }
}

function patchPaths(text: string, cwd: string): string[] {
  const paths: string[] = []
  for (const m of text.matchAll(/\*\*\* (?:Update|Add|Delete) File: ([^\n\\"]+)/g)) {
    const p = m[1]!.trim()
    paths.push(p.startsWith('/') ? p : join(cwd, p))
  }
  for (const m of text.matchAll(/\*\*\* Move to: ([^\n\\"]+)/g)) {
    const p = m[1]!.trim()
    paths.push(p.startsWith('/') ? p : join(cwd, p))
  }
  return paths
}

const BASH_WRITE = /(sed -i|perl -[a-z]*i|>\s*[^&\s|]|\btee\b|git (checkout|restore|reset|stash|apply|am|cherry-pick|revert|merge|rebase)|\bmv\b|\brm\b|python3? .*write|bun .*writeFile)/

let rows = 0
function emit(row: Record<string, unknown>) {
  appendFileSync(out, JSON.stringify(row) + '\n')
  rows++
}

async function claudeLike(src: string, root: string) {
  for (const file of walk(root)) {
    const pending = new Map<string, Record<string, unknown>>()
    let cwd = REPO
    for await (const r of lines(file)) {
      if (!r) continue
      if (r.cwd) cwd = r.cwd
      const content = r.message?.content
      if (!Array.isArray(content)) continue
      if (r.type === 'assistant') {
        for (const part of content) {
          if (part?.type !== 'tool_use') continue
          const i = part.input ?? {}
          let paths: string[] = []
          let tool = part.name
          if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(part.name)) paths = [i.file_path ?? i.notebook_path]
          else if (/^apply_patch$|^Apply_patch$/.test(part.name)) paths = patchPaths(String(i.patch ?? i.input ?? JSON.stringify(i)), cwd)
          else if (part.name === 'Bash' && BASH_WRITE.test(String(i.command ?? ''))) { tool = 'Bash-write'; paths = [] }
          else continue
          if (tool !== 'Bash-write' && !paths.some(p => p?.includes('cat-code'))) continue
          if (tool === 'Bash-write' && !(String(i.command).includes('cat-code') || cwd.includes('cat-code'))) continue
          pending.set(part.id, { ts: r.timestamp, src, file, session: r.sessionId, cwd, tool, paths, payload: i })
        }
      } else if (r.type === 'user') {
        for (const part of content) {
          if (part?.type !== 'tool_result' || !pending.has(part.tool_use_id)) continue
          const row = pending.get(part.tool_use_id)!
          pending.delete(part.tool_use_id)
          const text = typeof part.content === 'string' ? part.content : JSON.stringify(part.content)
          emit({ ...row, ok: !part.is_error && !/tool_use_error|<error>/.test(text.slice(0, 300)) })
        }
      }
    }
    for (const row of pending.values()) emit({ ...row, ok: null })
  }
}

async function codex() {
  const files = [...walk(join(home, '.codex/sessions')), ...walk(join(home, '.codex/archived_sessions'))]
  for (const file of files) {
    let cwd = ''
    const pending = new Map<string, Record<string, unknown>>()
    for await (const r of lines(file)) {
      if (!r) continue
      const p = r.payload ?? {}
      if (r.type === 'session_meta') { cwd = String(p.cwd ?? ''); continue }
      if (r.type === 'turn_context' && p.cwd) cwd = String(p.cwd)
      if (r.type !== 'response_item') continue
      if (p.type === 'custom_tool_call' || p.type === 'function_call') {
        const input = String(p.input ?? p.arguments ?? '')
        const isPatch = p.name === 'apply_patch' || input.includes('apply_patch')
        const isBashWrite = !isPatch && BASH_WRITE.test(input)
        if (!isPatch && !isBashWrite) continue
        const paths = isPatch ? patchPaths(input.replace(/\\n/g, '\n'), cwd) : []
        if (isPatch && !paths.some(q => q.includes('cat-code'))) continue
        if (isBashWrite && !(cwd.includes('cat-code') || input.includes('cat-code'))) continue
        pending.set(p.call_id, { ts: r.timestamp, src: 'codex', file, cwd, tool: isPatch ? 'apply_patch' : 'Bash-write', paths, payload: input })
      } else if ((p.type === 'custom_tool_call_output' || p.type === 'function_call_output') && pending.has(p.call_id)) {
        const row = pending.get(p.call_id)!
        pending.delete(p.call_id)
        const text = typeof p.output === 'string' ? p.output : JSON.stringify(p.output)
        emit({ ...row, ok: !/error|failed|Failed/.test(text.slice(0, 400)) ? true : null })
      }
    }
    for (const row of pending.values()) emit({ ...row, ok: null })
  }
}

await claudeLike('catcode', join(home, '.cat-code/projects'))
await claudeLike('claude', join(home, '.claude/projects'))
await codex()
console.log(JSON.stringify({ rows }))
