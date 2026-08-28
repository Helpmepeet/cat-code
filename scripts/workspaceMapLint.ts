#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

export type MapLintResult = {
  errors: string[]
  mapCount: number
  warnings: string[]
}

const REQUIRED_FOCUSED_SECTIONS = [
  'First Files To Inspect',
  'Tests And Validation',
  'Traps And Stale Assumptions',
]

const PATH_ROOTS = ['app/', 'docs/', 'scripts/', 'src/']
const ROOT_FILES = new Set(['AGENTS.md', 'CLAUDE.md', 'package.json', 'README.md'])

function refreshedDate(markdown: string): string | null {
  return markdown.match(/^Last refreshed:\s*(\d{4}-\d{2}-\d{2})\b/m)?.[1] ?? null
}

function mapIndexEntries(markdown: string): Array<{ date: string; href: string; path: string }> {
  const entries: Array<{ date: string; href: string; path: string }> = []
  const pattern = /^\| \[`(docs\/maps\/[^`]+\.md)`\]\(([^)]+)\) \|.*\| (\d{4}-\d{2}-\d{2}) \|$/gm
  for (const match of markdown.matchAll(pattern)) {
    entries.push({ date: match[3]!, href: match[2]!, path: match[1]! })
  }
  return entries
}

function localMarkdownLinks(markdown: string): string[] {
  const links: string[] = []
  for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1]!.trim().replace(/^<|>$/g, '')
    const target = raw.split('#', 1)[0]!
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue
    try {
      links.push(decodeURIComponent(target))
    } catch {
      links.push(target)
    }
  }
  return links
}

function citationIsExplicitlyAbsent(
  line: string,
  start: number,
  end: number,
): boolean {
  const before = line.slice(0, start)
  const after = line.slice(end)
  return (
    /(?:\bmissing|\bremoved)\s*$/i.test(before) ||
    /^\s*(?:\([^)]*\)\s*)?(?:is\s+)?(?:missing|removed|does not exist|no longer exists)\b/i.test(
      after,
    )
  )
}

function citedRepoPaths(markdown: string): string[] {
  const paths = new Set<string>()
  for (const line of markdown.split('\n')) {
    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      const start = match.index ?? 0
      if (citationIsExplicitlyAbsent(line, start, start + match[0].length)) continue
      let token = match[1]!.trim().replace(/[.,;]+$/, '')
      if (
        !token ||
        /[\s*?{}<>|]/.test(token) ||
        token.includes('...') ||
        token.includes('…')
      ) {
        continue
      }
      token = token.replace(/(\.[A-Za-z0-9]+):.*$/, '$1')
      if (ROOT_FILES.has(token) || PATH_ROOTS.some(root => token.startsWith(root))) {
        paths.add(token)
      }
    }
  }
  return [...paths]
}

export function validateWorkspaceMaps(repoRoot: string): MapLintResult {
  const errors: string[] = []
  const warnings: string[] = []
  const mapsDir = join(repoRoot, 'docs', 'maps')
  const workspacePath = join(mapsDir, 'WORKSPACE_MAP.md')

  if (!existsSync(workspacePath)) {
    return { errors: ['missing docs/maps/WORKSPACE_MAP.md'], mapCount: 0, warnings }
  }

  const mapFiles = readdirSync(mapsDir)
    .filter(file => file.endsWith('.md'))
    .sort()
  const focusedMaps = mapFiles.filter(file => file !== 'WORKSPACE_MAP.md')
  const workspace = readFileSync(workspacePath, 'utf8')
  const indexEntries = mapIndexEntries(workspace)
  const indexPaths = indexEntries.map(entry => entry.path)
  const indexedSet = new Set(indexPaths)

  for (const path of new Set(indexPaths)) {
    if (indexPaths.filter(candidate => candidate === path).length > 1) {
      errors.push(`duplicate workspace-map index entry: ${path}`)
    }
  }

  for (const file of focusedMaps) {
    const repoPath = `docs/maps/${file}`
    if (!indexedSet.has(repoPath)) errors.push(`focused map is not indexed: ${repoPath}`)
  }
  for (const entry of indexEntries) {
    if (!existsSync(join(repoRoot, entry.path))) {
      errors.push(`workspace-map index target does not exist: ${entry.path}`)
    }
    const hrefTarget = resolve(mapsDir, entry.href.split('#', 1)[0]!)
    const labelTarget = resolve(repoRoot, entry.path)
    if (hrefTarget !== labelTarget) {
      errors.push(`workspace-map index href mismatch: ${entry.path} links to ${entry.href}`)
    }
  }

  for (const file of mapFiles) {
    const absolutePath = join(mapsDir, file)
    const repoPath = relative(repoRoot, absolutePath)
    const markdown = readFileSync(absolutePath, 'utf8')

    for (const link of localMarkdownLinks(markdown)) {
      const target = resolve(dirname(absolutePath), link)
      if (!existsSync(target)) errors.push(`${repoPath}: broken link target ${link}`)
    }

    for (const citedPath of citedRepoPaths(markdown)) {
      if (!existsSync(join(repoRoot, citedPath))) {
        errors.push(`${repoPath}: cited path does not exist: ${citedPath}`)
      }
    }

    if (file === 'WORKSPACE_MAP.md') continue
    const date = refreshedDate(markdown)
    if (!date) errors.push(`${repoPath}: missing valid Last refreshed date`)
    const indexEntry = indexEntries.find(entry => entry.path === repoPath)
    if (date && indexEntry && date !== indexEntry.date) {
      errors.push(`${repoPath}: Last refreshed ${date} does not match index ${indexEntry.date}`)
    }

    for (const section of REQUIRED_FOCUSED_SECTIONS) {
      if (!markdown.includes(`## ${section}`)) {
        warnings.push(`${repoPath}: missing recommended section "${section}"`)
      }
    }
  }

  return {
    errors: [...new Set(errors)].sort(),
    mapCount: mapFiles.length,
    warnings: [...new Set(warnings)].sort(),
  }
}

if (import.meta.main) {
  const repoRoot = resolve(process.argv[2] ?? process.cwd())
  const result = validateWorkspaceMaps(repoRoot)
  for (const warning of result.warnings) console.warn(`warning: ${warning}`)
  for (const error of result.errors) console.error(`error: ${error}`)
  if (result.errors.length > 0) {
    console.error(`workspace map lint failed: ${result.errors.length} error(s), ${result.warnings.length} warning(s)`)
    process.exitCode = 1
  } else {
    console.log(`workspace map lint passed: ${result.mapCount} map(s), ${result.warnings.length} warning(s)`)
  }
}
