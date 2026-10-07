#!/usr/bin/env bun
// Usage: bun taskEvidence.ts <src> <idPrefix> <firstPromptTs> [--full]
// Prints transcript evidence for one inventory task: transcript path, first
// prompt, cwd/branch/commit, attachments, and the tool calls that touched files.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const [src, idPrefix, ts] = process.argv.slice(2)
const full = process.argv.includes('--full')
const home = homedir()

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

function findTranscript(): string {
  if (src === 'codex') {
    const files = [...walk(join(home, '.codex/sessions')), ...walk(join(home, '.codex/archived_sessions'))]
    const hits = files.filter(f => f.endsWith(`${idPrefix}.jsonl`) || f.split('/').pop()!.slice(-44, -36) === idPrefix)
    for (const f of hits) {
      if (readFileSync(f, 'utf8').includes(`"timestamp":"${ts}"`)) return f
    }
    throw new Error(`no codex transcript for ${idPrefix} @ ${ts}: ${hits.join(', ')}`)
  }
  const root = join(home, src === 'catcode' ? '.cat-code/projects' : '.claude/projects')
  for (const project of readdirSync(root)) {
    if (!project.startsWith('-Users-pt-cat-code')) continue
    for (const name of readdirSync(join(root, project))) {
      if (name.startsWith(idPrefix) && name.endsWith('.jsonl')) return join(root, project, name)
    }
  }
  throw new Error(`no transcript for ${src} ${idPrefix}`)
}

const path = findTranscript()
const records = readFileSync(path, 'utf8').split('\n').flatMap(l => {
  try { return [JSON.parse(l)] } catch { return [] }
})

const out: Record<string, unknown> = { path }
const calls: { name: string; summary: string; at: string; error?: boolean }[] = []

if (src === 'codex') {
  const meta = records.find(r => r.type === 'session_meta')?.payload ?? {}
  out.cwd = meta.cwd
  out.git = meta.git
  out.source = meta.source
  const first = records.find(r => r.timestamp === ts && r.type === 'response_item' && r.payload?.role === 'user')
  out.prompt = (first?.payload?.content ?? []).map((p: any) => p.type === 'input_image' ? '[image]' : p.text ?? '').join('\n')
  for (const r of records) {
    const p = r.payload ?? {}
    if (r.type === 'response_item' && (p.type === 'custom_tool_call' || p.type === 'function_call')) {
      calls.push({ name: p.name, summary: String(p.input ?? p.arguments ?? '').slice(0, full ? 4000 : 300), at: r.timestamp })
    }
  }
} else {
  const meta = records.find(r => r.cwd) ?? {}
  out.cwd = meta.cwd
  out.gitBranch = meta.gitBranch
  out.cwds = [...new Set(records.map(r => r.cwd).filter(Boolean))]
  out.branches = [...new Set(records.map(r => r.gitBranch).filter(Boolean))]
  out.version = meta.version
  const first = records.find(r => r.timestamp === ts && r.type === 'user')
  const content = first?.message?.content
  out.prompt = typeof content === 'string' ? content : (content ?? []).map((p: any) => p.type === 'image' ? '[image]' : p.text ?? `[${p.type}]`).join('\n')
  out.pastedContents = first?.pastedContents ? Object.keys(first.pastedContents) : undefined
  out.firstRecordKeys = first ? Object.keys(first) : undefined
  for (const r of records) {
    if (r.type !== 'assistant' || r.isSidechain) continue
    for (const part of r.message?.content ?? []) {
      if (part?.type !== 'tool_use') continue
      const i = part.input ?? {}
      const summary = i.file_path ?? i.path ?? i.command ?? i.pattern ?? i.prompt ?? JSON.stringify(i)
      calls.push({ name: part.name, summary: String(summary).slice(0, full ? 4000 : 200), at: r.timestamp })
    }
  }
  const sub = path.replace(/\.jsonl$/, '/subagents')
  out.subagentTranscripts = existsSync(sub) ? readdirSync(sub).length : 0
  for (const fh of [join(home, '.cat-code/file-history'), join(home, '.claude/file-history')]) {
    const id = path.split('/').pop()!.replace('.jsonl', '')
    if (existsSync(join(fh, id))) out.fileHistory = readdirSync(join(fh, id)).length
  }
}

// HEAD of the shared checkout at prompt time, from the reflog.
try {
  const reflog = execFileSync('git', ['-C', join(home, 'cat-code'), 'reflog', '--date=iso-strict', '--format=%H %gd %gs'], { encoding: 'utf8' })
  const target = Date.parse(ts)
  for (const line of reflog.split('\n')) {
    const m = line.match(/^(\w+) HEAD@\{([^}]+)\} (.*)$/)
    if (m && Date.parse(m[2]!) <= target) { out.reflogHead = { commit: m[1], at: m[2], what: m[3] }; break }
  }
} catch {}

out.firstCalls = calls.slice(0, full ? 400 : 60)
out.callCount = calls.length
console.log(JSON.stringify(out, null, 1))

// Compact digest for screening.
if (process.argv.includes('--digest')) {
  const text = JSON.stringify(calls)
  const files = new Set<string>()
  for (const m of text.matchAll(/(?:\/Users\/pt\/cat-code\/)?((?:\.worktrees\/[\w.-]+\/)?(?:src|app|docs|scripts|tests?|web|\.claude)\/[\w./@-]+\.(?:tsx?|md|json|css|sh|html|mjs|js|txt|tsv))/g)) files.add(m[1]!)
  const prompt = String(out.prompt ?? '')
  const refs = {
    sessionIds: [...new Set(prompt.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [])],
    externalPaths: [...new Set(prompt.match(/(?:\/Users\/pt\/(?:Downloads|Desktop|\.codex\/attachments|\.cat-code|\.claude|\.agents)|\/var\/folders|\/private\/tmp|\/tmp)\/[^\s'"`)\]]+/g) ?? [])],
    images: (prompt.match(/\[image\]|Image attachment|\.png/g) ?? []).length,
    worktrees: [...new Set(prompt.match(/\.worktrees\/[\w.-]+|\.codex\/worktrees\/[\w./-]+/g) ?? [])],
    urls: [...new Set(prompt.match(/https?:\/\/[^\s'"`)\]]+/g) ?? [])],
    mapsMentioned: /docs\/maps|WORKSPACE_MAP|workspace map/i.test(prompt),
  }
  const gitCmds = calls.filter(c => /\bgit (show|log|diff|status|blame|stash|checkout)/.test(c.summary)).map(c => (c.summary.match(/git (show|log|diff|status|blame|stash|checkout)[^"\;&|]{0,60}/) ?? [''])[0])
  console.log('DIGEST ' + JSON.stringify({ path, cwd: out.cwd, branches: out.branches, git: out.git, reflogHead: out.reflogHead, promptLength: prompt.length, refs, gitCmds: [...new Set(gitCmds)].slice(0, 15), files: [...files].slice(0, 80), calls: calls.length, subagents: out.subagentTranscripts, fileHistory: out.fileHistory }, null, 1))
}
