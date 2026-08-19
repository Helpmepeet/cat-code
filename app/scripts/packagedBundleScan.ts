/**
 * Stowaway scan for the packaged bundle (P5-1).
 *
 * The launch proof already fails when a REQUIRED resource is missing, so this
 * is the opposite check: nothing may be in the bundle that should not be. The
 * local-use contract deliberately has no artifact manifest — the operator can
 * inspect the build — so the one content question worth automating is whether a
 * credential, a private fixture, or a repository-only file rode along.
 *
 * Pure so it can be tested against a synthetic tree; `package-app.ts` runs it
 * against the real bundle and fails the build on any finding.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'

export type BundleScanFinding = Readonly<{
  path: string
  reason: string
}>

/**
 * Files that must never appear anywhere in the bundle, by path shape.
 *
 * `preload.dev.cjs` is here because it is the dev harness preload: shipping it
 * would put a second, more permissive preload inside a production bundle, which
 * SECURITY-MINIMUM does not allow even when nothing loads it.
 */
const DENIED_PATHS: ReadonlyArray<{ test: (relPath: string) => boolean; reason: string }> = [
  { test: p => segments(p).includes('node_modules'), reason: 'node_modules tree' },
  { test: p => segments(p).includes('.git'), reason: 'git metadata' },
  { test: p => segments(p).includes('.claude'), reason: 'agent harness directory' },
  { test: p => segments(p).includes('fixtures'), reason: 'test fixture' },
  { test: p => segments(p).includes('docs'), reason: 'repository documentation' },
  { test: p => basename(p) === 'preload.dev.cjs', reason: 'development harness preload' },
  { test: p => /\.(test|probe\.test)\.(ts|tsx|js|cjs|mjs)$/.test(p), reason: 'test source' },
  { test: p => /\.map$/.test(p), reason: 'source map' },
  { test: p => /(^|\/)\.env(\.|$)/.test(p), reason: 'environment file' },
  { test: p => /\.(pem|key|p12|pfx|keychain)$/.test(p), reason: 'key material' },
  { test: p => /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.|$)/.test(p), reason: 'ssh private key' },
  { test: p => basename(p) === 'default_app.asar', reason: "Electron's placeholder app" },
]

/**
 * Credential shapes, scanned in file CONTENT.
 *
 * Each pattern requires the high-entropy tail as well as the prefix. The engine
 * legitimately contains the bare prefixes as validation constants, so matching a
 * prefix alone would fail every build on the compiled sidecar and the check
 * would be turned off within a day.
 */
const SECRET_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, reason: 'private key block' },
  { pattern: /sk-ant-[a-z0-9-]*[A-Za-z0-9_-]{40,}/, reason: 'Anthropic API key' },
  { pattern: /sk-proj-[A-Za-z0-9_-]{40,}/, reason: 'OpenAI project key' },
  { pattern: /ghp_[A-Za-z0-9]{36}/, reason: 'GitHub token' },
  { pattern: /github_pat_[A-Za-z0-9_]{50,}/, reason: 'GitHub fine-grained token' },
  { pattern: /xox[baprs]-[A-Za-z0-9-]{20,}/, reason: 'Slack token' },
]

/** Extensions worth reading as text. The compiled sidecar is scanned too. */
const SCANNED_CONTENT = /\.(js|cjs|mjs|ts|tsx|json|html|css|txt|md|plist|sh)$/

function segments(relPath: string): string[] {
  return relPath.split(sep)
}

function walk(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(root, full, out)
    } else if (entry.isFile()) {
      out.push(relative(root, full))
    }
  }
}

/**
 * @param bundlePath the `.app` directory
 * @param sidecarBinary basename of the compiled sidecar, which is scanned for
 *   secrets despite having no text extension — a baked-in credential is exactly
 *   the thing that would hide there.
 */
export function scanPackagedBundle(
  bundlePath: string,
  sidecarBinary = 'cat-code-sidecar',
): BundleScanFinding[] {
  const files: string[] = []
  walk(bundlePath, bundlePath, files)

  const findings: BundleScanFinding[] = []
  for (const relPath of files) {
    for (const rule of DENIED_PATHS) {
      if (rule.test(relPath)) findings.push({ path: relPath, reason: rule.reason })
    }

    const isSidecar = basename(relPath) === sidecarBinary
    if (!isSidecar && !SCANNED_CONTENT.test(relPath)) continue

    const full = join(bundlePath, relPath)
    // A file too large to hold in memory is not something this build produces;
    // skipping it silently would be the wrong direction, so report it instead.
    let content: string
    try {
      content = readFileSync(full, 'latin1')
    } catch (error) {
      findings.push({ path: relPath, reason: `unreadable (${String(error)})` })
      continue
    }
    for (const rule of SECRET_PATTERNS) {
      if (rule.pattern.test(content)) findings.push({ path: relPath, reason: rule.reason })
    }
  }
  return findings
}

export function formatBundleScanFindings(findings: readonly BundleScanFinding[]): string {
  return findings.map(f => `  ${f.path}: ${f.reason}`).join('\n')
}
