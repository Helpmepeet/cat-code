// No-map transformation of an exported tree, shared by the copy builder and by
// stand-in data derived from repository content (e.g. a pull request diff).
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

// CLAUDE.md map clauses removed for the no-map setup.
export const MAP_PATTERN = /docs\/maps|WORKSPACE_MAP|workspace map|maps:lint|focused maps?|use the map|maintained maps|\bdesktop map\b/i
export function noMapClaude(text: string): string {
  let t = text
  t = t.replace(/- `docs\/maps\/`: navigation maintained against source\. (Dated plans)/, '- $1')
  t = t.replace(/For repository work, read \[the workspace map\]\(docs\/maps\/WORKSPACE_MAP\.md\)\nonce at the start, even when files or an owner are supplied\. Then start with\nthose files or use the map to find the owner\. Read only relevant focused maps\nand references, not the whole repository\./,
    'For repository work, start with the supplied files or find the owner in source.\nRead only relevant references, not the whole repository.')
  // Older routing text (before commit 0a317f92) reduces to the same no-map text,
  // so a diff across that commit shows no map-only change.
  t = t.replace(/Start with supplied files or a known owner\. For unfamiliar areas,\n\[the workspace map\]\(docs\/maps\/WORKSPACE_MAP\.md\) routes to focused maps and source\.\nRead references as relevant to the task, not as a required tour of the repository\./,
    'For repository work, start with the supplied files or find the owner in source.\nRead only relevant references, not the whole repository.')
  t = t.replace(/- Desktop runtime: \[desktop map\]\(docs\/maps\/web-app-runtime\.md\)\.\n/, '')
  t = t.replace(/ and `bun run maps:lint`/, '')
  t = t.replace(/\n  \[Test routing and build caveats\]\(docs\/maps\/build-release-testing\.md\) give details\./, '')
  t = t.replace(/maintained maps and root entrypoints are updated in place\./, 'root entrypoints are updated in place.')
  return t
}

export const MAP_TOOLING = ['scripts/mapRoutingNudge.ts', 'scripts/mapRoutingNudge.test.ts', 'scripts/workspaceMapLint.ts', 'scripts/workspaceMapLint.test.ts', 'scripts/workspaceMapRefreshState.ts', 'scripts/workspaceMapRefreshState.test.ts']

/** Applies every no-map change except the scrub; returns notes. Throws if CLAUDE.md keeps a map clause. */
export function noMapTree(repo: string): string[] {
  const notes: string[] = []
  const claudePath = join(repo, 'CLAUDE.md')
  if (existsSync(claudePath)) {
    const edited = noMapClaude(readFileSync(claudePath, 'utf8'))
    const left = edited.split('\n').filter(l => MAP_PATTERN.test(l))
    if (left.length) throw new Error(`no-map CLAUDE.md still has map clauses:\n${left.join('\n')}`)
    writeFileSync(claudePath, edited)
  }
  rmSync(join(repo, 'docs/maps'), { recursive: true, force: true })
  for (const f of MAP_TOOLING) if (existsSync(join(repo, f))) { rmSync(join(repo, f)); notes.push(`removed map tooling ${f}`) }
  const pkgPath = join(repo, 'package.json')
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (pkg.scripts?.['maps:lint']) { delete pkg.scripts['maps:lint']; notes.push('package.json: removed maps:lint script') }
    for (const [k, v] of Object.entries(pkg.scripts ?? {})) {
      if (typeof v === 'string' && v.includes('maps:lint')) { pkg.scripts[k] = v.replace('bun run maps:lint && ', ''); notes.push(`package.json: ${k} no longer runs maps:lint`) }
    }
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  }
  return notes
}

/** noMapTree, then the full no-map scrub; throws on residual map text. */
export function noMapTreeScrubbed(repo: string, report: string): string[] {
  const notes = noMapTree(repo)
  try { execFileSync('bun', [join(import.meta.dir, 'scrubMaps.ts'), repo, '--setup', 'nomap', '--report', report], { encoding: 'utf8' }) }
  catch (e: any) { throw new Error(`scrubMaps left map text (see ${report}): ${e.stdout ?? e}`) }
  return notes
}
