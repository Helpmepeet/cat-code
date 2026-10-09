#!/usr/bin/env bun
/**
 * Build the candidate task inventory for the workspace map study: the first
 * substantive prompt of every Cat Code, Claude Code, and Codex session whose
 * working directory is this repository, deduplicated by full prompt text.
 *
 * Output holds raw user prompts, so write it outside the repository.
 * Kind labels are keyword hints for screening, not validated categories.
 */
import { createReadStream, existsSync, lstatSync, realpathSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'

// Last first-prompt timestamp included in the frozen 2026-10-06 inventory.
const DEFAULT_CUTOFF = '2026-10-06T08:45:00Z'
const REPO_ROOT = resolve(import.meta.dir, '../..')

export function resolveOutsideRepository(out: string, repo = REPO_ROOT): string {
  if (!isAbsolute(out)) throw new Error(`output path must be absolute: ${out}`)
  const target = resolve(out)
  try {
    if (lstatSync(target).isSymbolicLink()) throw new Error(`refusing symlink output path: ${out}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  let existing = target
  const suffix: string[] = []
  while (true) {
    try {
      const stat = lstatSync(existing)
      if (stat.isSymbolicLink() && !existsSync(existing)) throw new Error(`refusing dangling symlink ancestor: ${out}`)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(existing)
      if (parent === existing) throw error
      suffix.unshift(existing.slice(existing.lastIndexOf(sep) + 1))
      existing = parent
    }
  }
  const actual = join(realpathSync(existing), ...suffix)
  const fromRepo = relative(realpathSync(repo), actual)
  if (fromRepo === '' || (!fromRepo.startsWith(`..${sep}`) && fromRepo !== '..' && !isAbsolute(fromRepo))) {
    throw new Error(`refusing to write raw prompts inside the repository: ${out}`)
  }
  return target
}

type Source = 'catcode' | 'claude' | 'codex'
type Entry = { ts: string; src: Source; id: string; text: string }

const CLAUDE_SKIP = ['<local-command', '<system-reminder>', 'Caveat:', '<command-name>/clear', '<command-name>/model']
const CODEX_SKIP = ['# AGENTS.md', '<environment_context', '<turn_aborted', '<user_instructions', '<permissions', '<INSTRUCTIONS', '<skill', '<user_shell_command']
// Client-supplied context the Codex app prepends to a user message; the
// request, if any, follows the block.
const CODEX_CONTEXT_BLOCK = /^\s*<(recommended_plugins|external_codex_apps_\w+|in-app-browser-context|environment_context)\b[^>]*>[\s\S]*?<\/\1>/

function stripCodexContext(text: string): string {
  let rest = text
  for (let match = CODEX_CONTEXT_BLOCK.exec(rest); match; match = CODEX_CONTEXT_BLOCK.exec(rest)) rest = rest.slice(match[0].length)
  return rest.trim()
}

async function* lines(path: string): AsyncGenerator<Record<string, any>> {
  const reader = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  for await (const line of reader) {
    try {
      yield JSON.parse(line)
    } catch {
      // Partial trailing lines occur in live transcripts.
    }
  }
}

function jsonlFiles(dir: string, recursive: boolean): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (name.endsWith('.jsonl')) out.push(path)
    else if (recursive && statSync(path).isDirectory()) out.push(...jsonlFiles(path, true))
  }
  return out
}

async function claudeLike(src: Source, projectsDir: string): Promise<Entry[]> {
  const out: Entry[] = []
  if (!existsSync(projectsDir)) return out
  for (const project of readdirSync(projectsDir)) {
    if (!project.startsWith('-Users-pt-cat-code')) continue
    for (const file of jsonlFiles(join(projectsDir, project), false)) {
      // A local slash command (/compact, /login, ...) is recorded after a meta
      // caveat record; it is not a request, so the next prompt is used instead.
      let afterCaveat = false
      for await (const record of lines(file)) {
        if (record.type !== 'user' || record.isSidechain) continue
        const caveat = afterCaveat
        afterCaveat = record.isMeta === true && JSON.stringify(record.message?.content ?? '').includes('<local-command-caveat>')
        if (record.isMeta || record.isCompactSummary) continue
        let content = record.message?.content
        if (Array.isArray(content)) {
          if (content.some((part: any) => part?.type === 'tool_result')) continue
          content = content.filter((part: any) => part?.type === 'text').map((part: any) => part.text ?? '').join(' ')
        }
        if (typeof content !== 'string') continue
        const text = content.trim()
        if (!text || CLAUDE_SKIP.some(prefix => text.startsWith(prefix))) continue
        if (caveat && text.startsWith('<command-name>')) continue
        out.push({ ts: record.timestamp ?? '', src, id: basename(file, '.jsonl'), text })
        break
      }
    }
  }
  return out
}

async function codex(codexHome: string): Promise<Entry[]> {
  const out: Entry[] = []
  const files = [...jsonlFiles(join(codexHome, 'sessions'), true), ...jsonlFiles(join(codexHome, 'archived_sessions'), true)]
  for (const file of files) {
    let cwd = ''
    let subagent = false
    for await (const record of lines(file)) {
      const payload = record.payload ?? {}
      if (record.type === 'session_meta') {
        cwd = String(payload.cwd ?? '').replace('file://', '')
        subagent = typeof payload.source === 'object' && JSON.stringify(payload.source).includes('subagent')
        continue
      }
      if (record.type !== 'response_item' || payload.type !== 'message' || payload.role !== 'user') continue
      const text = (payload.content ?? [])
        .map((part: any) => stripCodexContext(part?.text ?? ''))
        .filter((part: string) => part && !CODEX_SKIP.some(prefix => part.startsWith(prefix)))
        .join(' ')
        .trim()
      if (!text || CODEX_SKIP.some(prefix => text.startsWith(prefix))) continue
      const inRepo = cwd.startsWith('/Users/pt/cat-code') || (cwd.startsWith('/Users/pt/.codex/worktrees') && cwd.includes('cat-code'))
      if (inRepo && !subagent) out.push({ ts: record.timestamp ?? '', src: 'codex', id: basename(file, '.jsonl').slice(-36), text })
      break
    }
  }
  return out
}

const OFF = /^(hi\b|hello|say hi|what is your (name|model)|what (is|are) (mcp|the mcp)|is there any mcp|remember the word|write a (ghost|long haiku)|print anything|show me the math|find the smallest|give me 10 dsa|debate|discuss with your friend|create peer session and talk|have a philosophical|open (youtube|and play)|this is stress test|try ask me|do you see the message|let.?s have a brief good-faith)|ghost story|leetcode|haiku|philoso/i
const OPS = /^(push|we can push|let merge|merge|restart|install|in stall|reinstall|let reinstall|can we package|can you run caff|do we have anything uncommitted|what is the state of main|commit)|packaging-cat-code|\/compact|\/cache-stats/i
const BRIEF = /^(you are|the user (asked|asks|wants|approved|saw)|work (in|only|from)|read-only|goal\b|role\b|implement (the|this|auto|agents)|# files pasted|# files mentioned|investigation|investigate and report|act as a|act as orchestrator|review (a|the|this) (proposed|change|plan|final)|adversarial(ly)? (review|critique) (a|of a|this proposed)|perform|apply an|rebuild|do not edit|automation:|explore only|continue (implementing|the)|cat code \(|retire agent mode|other session was|this was a instruction|<pasted_content|count the|create a session to|which session|test the mcp|fix a bash|title:|diagnose|root-cause|establish)/i

function kind(text: string): string {
  if (OFF.test(text)) return 'off'
  if (OPS.test(text)) return 'ops'
  if (/\b(adversarial|review|audit|validate|critique|pressure test|do you agree|is this valid|missed anything|check (the|this) (plan|report))/i.test(text)) return 'review'
  if (/(app [0-9a-f]{8}-|engine [0-9a-f]{8}-|\bwhy\b|what happen|happend|investigat|root.?cause|diagnos|where does .* come from|error|crash|stuck|cant start|can.?t start|log\b|is it applied)/i.test(text)) return 'diagnosis'
  if (/\b(fix|bug|implement|change|add|remove|rename|refactor|migrat|upgrade|support|polish|end to end|follow (the|from) plan)/i.test(text)) return 'change'
  if (/\b(design|redesign|mockup|html|propose|plan only|ux)\b/i.test(text)) return 'design'
  if (/\b(sweep|find (a|every|all|serious|serius)|opportunit|inspect|tour|architecture|explain|understand|how .* work|describe|what (is|are|do|does)|tell me|compare|check|count|list|search|trace)/i.test(text)) return 'understanding'
  return 'other'
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const outIndex = args.indexOf('--out')
  const cutoffIndex = args.indexOf('--cutoff')
  const repoIndex = args.indexOf('--repo')
  const out = outIndex >= 0 ? args[outIndex + 1] : undefined
  const cutoff = cutoffIndex >= 0 ? args[cutoffIndex + 1] : DEFAULT_CUTOFF
  const repo = repoIndex >= 0 ? args[repoIndex + 1] : REPO_ROOT
  if (!out) throw new Error('usage: taskInventory.ts --out <path outside the repo> [--repo <root>] [--cutoff <ISO timestamp>]')
  const safeOut = resolveOutsideRepository(out, repo)

  const home = homedir()
  const raw = [
    ...(await claudeLike('catcode', join(home, '.cat-code/projects'))),
    ...(await claudeLike('claude', join(home, '.claude/projects'))),
    ...(await codex(join(home, '.codex'))),
  ].filter(entry => entry.ts && entry.ts <= cutoff)
  raw.sort((a, b) => b.ts.localeCompare(a.ts) || a.src.localeCompare(b.src) || a.id.localeCompare(b.id))

  const seen = new Set<string>()
  const tasks = []
  for (const entry of raw) {
    const text = entry.text.replace(/\s+/g, ' ').trim()
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (text.length < 15) continue
    tasks.push({ ...entry, text, kind: kind(text), brief: BRIEF.test(text) || text.length > 1200 })
  }

  writeFileSync(safeOut, JSON.stringify({ cutoff, rawSessions: raw.length, tasks }, null, 1))
  const bySource = (list: { src: Source }[]) =>
    Object.fromEntries((['catcode', 'claude', 'codex'] as const).map(src => [src, list.filter(e => e.src === src).length]))
  console.log(JSON.stringify({ cutoff, rawSessions: raw.length, raw: bySource(raw), deduplicated: tasks.length, dedup: bySource(tasks) }))
}

if (import.meta.main) await main()
