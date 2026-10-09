#!/usr/bin/env bun
// Usage: bun restoreFile.ts --path <rel> --base <commit> --at <promptTs> --out <file> [--transcripts a,b]
// Reconstructs one file as it stood at a task's prompt time, trying, in order:
//  1. diff:   a session-printed `git diff` in the unchanged window, accepted only
//             when base + diff hashes to the diff's index line (fromDiff.ts).
//  2. replay: the base plus logged edits, checked against positive task-time evidence.
// Prints one JSON line {path, method, ok, sha256, evidence}. Exit 1 if no
// method yields a file supported by task-time evidence.
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const args = process.argv.slice(2)
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
const rel = opt('--path')!, base = opt('--base')!, at = opt('--at')!, out = opt('--out')!
const transcripts = opt('--transcripts')
const root = '/Users/pt/cat-code', tools = import.meta.dir
const sha = () => createHash('sha256').update(readFileSync(out)).digest('hex')
const run = (script: string, extra: string[]) => spawnSync('bun', [`${tools}/${script}`, ...extra], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 })
const done = (method: string, evidence: unknown, ok = true) => { console.log(JSON.stringify({ path: rel, method, ok, sha256: ok ? sha() : undefined, evidence })); process.exit(ok ? 0 : 1) }

// 1. diff
const d = run('fromDiff.ts', ['--path', rel, '--base', base, '--at', at, '--out', out, ...(transcripts ? ['--transcripts', transcripts] : [])])
const dj = JSON.parse(d.stdout.trim().split('\n').pop() || '{}')
if (dj.ok) done('diff', dj)

// Later commits are not task-time proof. Only use task-window diffs or replay.
const baseArg = spawnSync('git', ['-C', root, 'cat-file', '-e', `${base}:${rel}`]).status === 0 ? base : 'none'
const r = run('replay.ts', [rel, at, baseArg, '--out', out])
const failed = /failed=(\d+)/.exec(r.stdout + r.stderr)?.[1]
const edits = /edits=(\d+)/.exec(r.stdout + r.stderr)?.[1]
// No logged edit means the change was made some other way (a script, a copy):
// replay would only reproduce the base, which the status says is wrong.
if (r.status !== 0 || failed !== '0' || edits === '0') done('replay', { replay: (r.stdout + r.stderr).trim().split('\n').pop() }, false)
const v = run('verifyDirty.ts', ['--path', rel, '--candidate', out, '--base', base, '--at', at, '--transcripts', transcripts ?? ''])
done('replay', { replay: r.stdout.trim().split('\n').pop(), check: JSON.parse(v.stdout.trim() || '{}') }, v.status === 0)
