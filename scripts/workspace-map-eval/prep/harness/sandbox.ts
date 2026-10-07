// Shared isolation for probe processes: no outbound IP, and no file access to
// live state, the study's own folder, other staged copies, or engine docs.
// SBPL applies the last matching rule, so the stage allow comes after the denies.
import { cpSync, mkdtempSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export function sandboxProfile(stage: string, engine: string, opts: { network?: boolean } = {}): string {
  const deny = [
    '/Users/pt/cat-code', '/Users/pt/workspace-map-study', '/Users/pt/.cat-code', '/Users/pt/.claude',
    '/Users/pt/.codex', '/Users/pt/.agents', '/Users/Shared/ccw',
  ].map(p => `(subpath "${p}")`).join(' ')
  // Every frozen engine's docs and top-level notes (they carry maps), and the
  // whole of any engine other than the one this run uses.
  const others = readdirSync('/Users/Shared/cce').map(n => join('/Users/Shared/cce', n)).filter(p => p !== engine).map(p => `(subpath "${p}")`).join(' ')
  // Real network CLIs could only fail here; a task that needs one gets a stub on PATH.
  // Exec checks apply to the resolved binary, so the Homebrew symlink target counts.
  const cli = ['(literal "/opt/homebrew/bin/gh")', '(literal "/usr/local/bin/gh")', '(regex #"^/opt/homebrew/Cellar/gh/")', '(regex #"^/usr/local/Cellar/gh/")'].join(' ')
  return `(version 1)(allow default)${opts.network ? '' : '(deny network-outbound (remote ip))'}
(deny file-read* file-write* ${deny} ${others} (regex #"^/Users/Shared/cce/[^/]+/docs(/|$)") (regex #"^/Users/Shared/cce/[^/]+/[^/]*\\.md$"))
(deny process-exec ${cli})
(allow file-read* file-write* (subpath "${stage}"))`
}

/** Neutral scratch dir for interceptor code and records, outside every denied path. */
export function probeScratch(): { dir: string; interceptor: string } {
  const dir = mkdtempSync('/private/tmp/ccp-')
  const interceptor = join(dir, 'preload.ts')
  cpSync(join(import.meta.dir, 'interceptor.ts'), interceptor)
  return { dir, interceptor }
}
