#!/usr/bin/env bun
// Usage: bun ghNomapData.ts <gh-data dir> <out dir> <baseCommit> <headCommit> <pr number>
// Derives the no-map world's view of a pull request snapshot: the diff is
// regenerated between no-map transformed exports of base and head, commits
// that only exist for the maps are dropped, and PR/review/comment text goes
// through the same scrub as repository documents.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { noMapTreeScrubbed } from '../noMapTree.ts'

const [src, out, base, head, n] = process.argv.slice(2) as [string, string, string, string, string]
const LIVE = '/Users/pt/cat-code'
const tmp = mkdtempSync('/private/tmp/ghnomap-')
mkdirSync(out, { recursive: true })
try {
  // Diff between the two no-map trees.
  for (const [name, commit] of [['a', base], ['b', head]] as const) {
    mkdirSync(join(tmp, name))
    execFileSync('/bin/sh', ['-c', `git -C ${LIVE} archive ${commit} | tar -x -C '${join(tmp, name)}'`])
    noMapTreeScrubbed(join(tmp, name), join(out, `scrub-${name}.json`))
  }
  const d = spawnSync('git', ['diff', '--no-index', '--no-renames', 'a', 'b'], { cwd: tmp, encoding: 'utf8', maxBuffer: 1 << 28 })
  if (d.status !== 1) throw new Error(`diff failed: ${d.stderr}`)
  // --no-index names the trees' own directories (a/a/x, b/b/x); drop them.
  writeFileSync(join(out, `pr-${n}.diff`), d.stdout.replace(/^(diff --git |--- |\+\+\+ )(.*)$/gm, (_, h, rest) => h + rest.replace(/\b([ab])\/[ab]\//g, '$1/')))

  // Text fields through the document scrub.
  const pr = JSON.parse(readFileSync(join(src, `pr-${n}.json`), 'utf8'))
  const comments = JSON.parse(readFileSync(join(src, `pr-${n}-comments.json`), 'utf8'))
  const MAPCOMMIT = /\bmaps?\b|routing nudge|workspace map/i
  const dropped = (pr.commits ?? []).filter((c: any) => MAPCOMMIT.test(`${c.messageHeadline} ${c.messageBody ?? ''}`))
  pr.commits = (pr.commits ?? []).filter((c: any) => !dropped.includes(c))
  const texts = join(tmp, 'texts')
  mkdirSync(texts)
  writeFileSync(join(texts, 'body.md'), pr.body)
  ;(pr.reviews ?? []).forEach((r: any, i: number) => writeFileSync(join(texts, `review-${i}.md`), r.body ?? ''))
  ;(pr.comments ?? []).forEach((c: any, i: number) => writeFileSync(join(texts, `comment-${i}.md`), c.body ?? ''))
  comments.forEach((c: any, i: number) => writeFileSync(join(texts, `inline-${i}.md`), c.body ?? ''))
  const scrub = spawnSync('bun', [join(import.meta.dir, '..', 'scrubMaps.ts'), texts, '--setup', 'nomap', '--report', join(out, 'scrub-pr.json')], { encoding: 'utf8' })
  if (scrub.status !== 0) throw new Error(`PR text keeps map text: ${scrub.stdout}`)
  const read = (f: string) => readFileSync(join(texts, f), 'utf8')
  pr.body = read('body.md').replace(/: (\d+) commits\./, `: ${(pr.commits ?? []).length} commits.`)
  ;(pr.reviews ?? []).forEach((r: any, i: number) => { r.body = read(`review-${i}.md`) })
  ;(pr.comments ?? []).forEach((c: any, i: number) => { c.body = read(`comment-${i}.md`) })
  comments.forEach((c: any, i: number) => { c.body = read(`inline-${i}.md`) })
  pr.files = (pr.files ?? []).filter((f: any) => !/^docs\/maps\/|^scripts\/(?:mapRoutingNudge|workspaceMap)/.test(f.path))
  writeFileSync(join(out, `pr-${n}.json`), JSON.stringify(pr))
  writeFileSync(join(out, `pr-${n}-comments.json`), JSON.stringify(comments))
  cpSync(join(src, 'prs.json'), join(out, 'prs.json'))
  console.log(JSON.stringify({ droppedCommits: dropped.map((c: any) => c.messageHeadline), commits: pr.commits.length, files: pr.files.length, diffBytes: readFileSync(join(out, `pr-${n}.diff`)).length }))
} finally { rmSync(tmp, { recursive: true, force: true }) }
