// Probe file access is default-deny; only runtime, engine, stage, and scratch
// paths are readable, and writes stay inside the stage or scratch.
import { cpSync, mkdtempSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function sandboxProfile(stage: string, engine: string, opts: {
  network?: boolean
  scratch?: string
  frozenEngines?: string[]
  runtimeBinaries?: string[]
  runtimeLibraries?: string[]
} = {}): string {
  const deny = [
    '/Users/pt/cat-code', '/Users/pt/workspace-map-study', '/Users/pt/.cat-code', '/Users/pt/.claude',
    '/Users/pt/.codex', '/Users/pt/.agents', '/Users/Shared/ccw',
  ].map(p => `(subpath "${p}")`).join(' ')
  // Every frozen engine's docs and top-level notes (they carry maps), and the
  // whole of any engine other than the one this run uses.
  const frozenEngines = opts.frozenEngines ?? readdirSync('/Users/Shared/cce').map(n => join('/Users/Shared/cce', n))
  const others = frozenEngines.filter(p => p !== engine).map(p => `(subpath "${p}")`).join(' ')
  const metadataPaths = new Set(['/', '/private', '/private/tmp', '/Users', '/Users/Shared', '/System', '/usr', '/bin', '/sbin', '/dev'])
  for (const path of [stage, engine, opts.scratch ?? '/private/tmp/ccp-disabled', ...(opts.runtimeBinaries ?? []), ...(opts.runtimeLibraries ?? [])]) {
    for (let parent = path; parent !== dirname(parent); parent = dirname(parent)) metadataPaths.add(parent)
  }
  const metadata = [...metadataPaths].map(p => `(literal "${p}")`).join(' ')
  const runtimeBinaries = (opts.runtimeBinaries ?? []).map(p => `(literal "${p}")`).join(' ')
  // dyld resolves Homebrew opt symlinks before matching, so allow only the lib
  // directories reported for selected binaries by otool, not a Homebrew prefix.
  const runtimeLibraryDirs = [...new Set((opts.runtimeLibraries ?? []).map(dirname))].map(p => `(subpath "${p}")`).join(' ')
  // Real network CLIs could only fail here; a task that needs one gets a stub on PATH.
  // Exec checks apply to the resolved binary, so the Homebrew symlink target counts.
  const cli = ['(literal "/opt/homebrew/bin/gh")', '(literal "/usr/local/bin/gh")', '(regex #"^/opt/homebrew/Cellar/gh/")', '(regex #"^/usr/local/Cellar/gh/")'].join(' ')
  return `(version 1)(allow default)${opts.network ? '' : '(deny network-outbound (remote ip))'}
(deny file-read*)
(deny file-write*)
(deny process-exec ${cli})
(allow file-read-metadata ${metadata})
(allow file-read* (literal "/") (subpath "${engine}") (subpath "/System") (subpath "/usr/bin") (subpath "/usr/lib") (subpath "/usr/libexec") (subpath "/usr/share") (subpath "/bin") (subpath "/sbin") (literal "/dev/null"))
(deny file-read* (subpath "${engine}/docs") (regex #"^${engine}/[^/]*\\.md$"))
(deny file-read* ${deny} ${others})
(allow file-read* (subpath "${stage}") (subpath "${opts.scratch ?? '/private/tmp/ccp-disabled'}") ${runtimeBinaries} ${runtimeLibraryDirs})
(allow file-write* (subpath "${stage}") (subpath "${opts.scratch ?? '/private/tmp/ccp-disabled'}") (literal "/dev/null"))`
}

/** Neutral scratch dir for interceptor code and records, outside every denied path. */
export function probeScratch(): { dir: string; interceptor: string } {
  const dir = mkdtempSync('/private/tmp/ccp-')
  const interceptor = join(dir, 'preload.ts')
  cpSync(join(import.meta.dir, 'interceptor.ts'), interceptor)
  return { dir, interceptor }
}
