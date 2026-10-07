#!/usr/bin/env bun
// Usage: bun makePrompts.ts <taskDir>
// From <taskDir>/prompt.raw.txt (verbatim first request) writes:
//   prompt.mandatory.txt  the request in the form the desktop composer sends:
//     Codex "Files pasted" wrappers become the pasted text inline (the composer
//     expands pastes), Codex image wrappers become the typed request (images go
//     as blocks from images/), a Claude Code skill command becomes "/name args";
//     the live checkout path becomes {{REPO}} and other home paths {{HOME}}.
//   prompt.nomap.txt  the same through the no-map document scrub (scrubCore.ts).
//   prompt.diff       unified diff between the two, for review.
//   prompt.json       what was translated.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ANY, scrubText } from './scrubCore.ts'

const dir = process.argv[2]!
const raw = readFileSync(join(dir, 'prompt.raw.txt'), 'utf8')
const notes: string[] = []
let text = raw

const pasted = /^\s*# Files pasted by the user:\s*\n([\s\S]*?)\n## My request:\s*\n?([\s\S]*)$/.exec(text)
if (pasted) {
  const files = [...pasted[1]!.matchAll(/^## "[^\n]*": (\/[^\n]+?)\s*$/gm)].map(m => m[1]!)
  if (!files.length) throw new Error('pasted wrapper without files')
  const bodies = files.map(f => { if (!existsSync(f)) throw new Error(`pasted attachment missing: ${f}`); return readFileSync(f, 'utf8') })
  const request = pasted[2]!.trim()
  text = [...bodies, ...(request ? [request] : [])].join('\n\n')
  notes.push(`pasted attachments inlined: ${files.join(', ')}`)
}
const mentioned = /^\s*# Files mentioned by the user:\s*\n([\s\S]*?)\n## My request(?: for Codex)?:\s*\n?([\s\S]*)$/.exec(text)
if (mentioned) {
  const nonImage = [...mentioned[1]!.matchAll(/^## ([^\n:]+): (\/[^\n]+)$/gm)].filter(m => !/\.(png|jpe?g|gif|webp)$/i.test(m[1]!))
  if (nonImage.length) throw new Error(`mentioned non-image files need handling: ${nonImage.map(m => m[2]).join(', ')}`)
  text = mentioned[2]!.replace(/<image name=\[Image #\d+\][^>]*>\s*<\/image>/g, '').trim()
  notes.push('image wrapper reduced to the typed request; images sent as blocks')
}
const skill = /^<command-message>([\w-]+)<\/command-message>\s*<command-name>\/([\w-]+)<\/command-name>\s*<command-args>([\s\S]*)<\/command-args>\s*$/.exec(text)
if (skill) { text = `/${skill[2]} ${skill[3]}`; notes.push(`skill command /${skill[2]} as typed`) }

const before = text
text = text.replace(/\/Users\/pt\/cat-code(?![\w-])/g, '{{REPO}}').replace(/\/Users\/pt\//g, '{{HOME}}/')
if (text !== before) notes.push('paths templated: /Users/pt/cat-code -> {{REPO}}, /Users/pt/ -> {{HOME}}/')

writeFileSync(join(dir, 'prompt.mandatory.txt'), text)
const nomap = ANY.test(text) ? scrubText('prompt.md', text) : text
writeFileSync(join(dir, 'prompt.nomap.txt'), nomap)
const diff = spawnSync('diff', ['-u', join(dir, 'prompt.mandatory.txt'), join(dir, 'prompt.nomap.txt')], { encoding: 'utf8' }).stdout
writeFileSync(join(dir, 'prompt.diff'), diff)
writeFileSync(join(dir, 'prompt.json'), JSON.stringify({ notes, nomapEdited: nomap !== text, residual: nomap.split('\n').filter(l => ANY.test(l)) }, null, 1))
console.log(JSON.stringify({ dir, chars: text.length, nomapEdited: nomap !== text, notes }))
