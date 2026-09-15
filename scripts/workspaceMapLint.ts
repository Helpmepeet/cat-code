#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export type MapLintResult = {
  errors: string[]
  mapCount: number
  warnings: string[]
}

export type WorkspaceMapValidationOptions = {
  /**
   * Optional immutable source tree used for source-owner citations. Map files
   * and their local links remain read from `repoRoot`, so uncommitted map work
   * can be checked against a committed source snapshot without hiding it.
   */
  sourceRoot?: string
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

function pathExistsWithinRoot(root: string, relativePath: string): boolean {
  const canonicalRoot = realpathSync(root)
  const candidate = resolve(canonicalRoot, relativePath)
  const relativePathToRoot = relative(canonicalRoot, candidate)
  if (relativePathToRoot === '..' || relativePathToRoot.startsWith(`..${sep}`) || isAbsolute(relativePathToRoot)) {
    return false
  }
  if (!existsSync(candidate)) return false
  try {
    const canonicalCandidate = realpathSync(candidate)
    const canonicalRelative = relative(canonicalRoot, canonicalCandidate)
    return canonicalRelative === '' || (!canonicalRelative.startsWith(`..${sep}`) && canonicalRelative !== '..' && !isAbsolute(canonicalRelative))
  } catch {
    return false
  }
}

export function validateWorkspaceMaps(
  repoRoot: string,
  options: WorkspaceMapValidationOptions = {},
): MapLintResult {
  const errors: string[] = []
  const warnings: string[] = []
  const canonicalRepoRoot = realpathSync(repoRoot)
  const mapsDir = join(canonicalRepoRoot, 'docs', 'maps')
  const workspacePath = join(mapsDir, 'WORKSPACE_MAP.md')
  const sourceRoot = options.sourceRoot ? resolve(options.sourceRoot) : repoRoot

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
    if (!existsSync(join(canonicalRepoRoot, entry.path))) {
      errors.push(`workspace-map index target does not exist: ${entry.path}`)
    }
    const hrefTarget = resolve(mapsDir, entry.href.split('#', 1)[0]!)
    const labelTarget = resolve(canonicalRepoRoot, entry.path)
    if (hrefTarget !== labelTarget) {
      errors.push(`workspace-map index href mismatch: ${entry.path} links to ${entry.href}`)
    }
  }

  for (const file of mapFiles) {
    const absolutePath = join(mapsDir, file)
    const repoPath = relative(canonicalRepoRoot, absolutePath)
    const markdown = readFileSync(absolutePath, 'utf8')

    for (const link of localMarkdownLinks(markdown)) {
      const target = resolve(dirname(absolutePath), link)
      if (!pathExistsWithinRoot(canonicalRepoRoot, relative(canonicalRepoRoot, target))) {
        errors.push(`${repoPath}: broken link target ${link}`)
      }
    }

    for (const citedPath of citedRepoPaths(markdown)) {
      const citationRoot = citedPath.startsWith('docs/maps/') ? repoRoot : sourceRoot
      if (!pathExistsWithinRoot(citationRoot, citedPath)) {
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
