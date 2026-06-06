import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * Curated keyword -> subsystem map table. One entry per `docs/maps/*.md`
 * (excluding WORKSPACE_MAP.md itself). Keywords are lowercase substring tokens
 * drawn from each map's scope line; kept specific to avoid false positives on
 * generic words. Order is significant: it is the tie-breaker after hit count.
 */
export const KEYWORD_MAP: ReadonlyArray<{ map: string; keywords: string[] }> = [
  {
    map: 'codex-core.md',
    keywords: [
      'codex',
      'openai',
      'gpt',
      'cache routing',
      'account pool',
      'lease',
      'responses adapter',
      'request building',
    ],
  },
  {
    map: 'auth-accounts-oauth.md',
    keywords: [
      'oauth',
      'login',
      'account',
      'keychain',
      'secure storage',
      'auth source',
      'profile switch',
    ],
  },
  {
    map: 'bridge-remote-cli.md',
    keywords: [
      'bridge',
      'remote control',
      'ccr',
      'structured cli',
      'upstream proxy',
      'direct-connect',
      'remote session',
      'transport',
    ],
  },
  {
    map: 'tools-permissions.md',
    keywords: [
      'permission',
      'sandbox',
      'mcp tool',
      'approval',
      'policy gate',
      'tool registration',
      'input validation',
    ],
  },
  {
    map: 'terminal-ui-state.md',
    keywords: [
      'repl',
      'ink',
      'prompt input',
      'keybinding',
      'dialog',
      'terminal ui',
      'message render',
    ],
  },
  {
    map: 'prompt-system.md',
    keywords: [
      'system prompt',
      'instruction injection',
      'output style',
      'prompt context',
      'prompt policy',
      'prompt surface',
    ],
  },
  {
    map: 'agent-mode.md',
    keywords: [
      'agent mode',
      'worker role',
      'role prompt',
      'worker identity',
      'deployment-aware',
      'orchestration',
    ],
  },
  {
    map: 'tasks-workers.md',
    keywords: [
      'background task',
      'shell task',
      'task panel',
      'worker lifecycle',
      'retained agent',
      'teammate task',
    ],
  },
  {
    map: 'dedicated-app.md',
    keywords: [
      'dedicated app',
      'app runtime',
      'app-runtime',
      'shell wiring',
      'terminal-vs-app',
    ],
  },
  {
    map: 'query-provider-runtime.md',
    keywords: [
      'query loop',
      'provider routing',
      'model selection',
      'context assembly',
      'api client',
      'retry',
      'compaction',
    ],
  },
  {
    map: 'config-persistence.md',
    keywords: [
      'settings',
      'config file',
      'transcript',
      'memory',
      'migration',
      'session restore',
      'persistence',
      'managed policy',
    ],
  },
  {
    map: 'plugins-skills-commands.md',
    keywords: [
      'slash command',
      'skill',
      'plugin',
      'marketplace',
      'workflow',
      'command source',
    ],
  },
  {
    map: 'ide-lsp.md',
    keywords: [
      'ide integration',
      'lsp',
      'language server',
      'diagnostic',
      'ide connection',
    ],
  },
  {
    map: 'native-client-integrations.md',
    keywords: [
      'chrome',
      'browser automation',
      'computer-use',
      'native shim',
      'desktop',
      'mobile',
      'voice',
    ],
  },
  {
    map: 'proactive-assistant-services.md',
    keywords: [
      'proactive',
      'kairos',
      'auto dream',
      'magicdocs',
      'magic docs',
      'assistant summary',
      'dreamtask',
      'push notification',
    ],
  },
  {
    map: 'build-release-testing.md',
    keywords: [
      'build script',
      'release note',
      'updater',
      'feature gate',
      'lint',
      'compile',
      'upgrade',
    ],
  },
  {
    map: 'analytics-diagnostics.md',
    keywords: [
      'analytics',
      'telemetry',
      'growthbook',
      'diagnostic',
      'doctor',
      'cost tracking',
      'logging',
    ],
  },
]

const MAX_MATCHES = 2

/**
 * Parse the `| [`x.md`](x.md) | scope... |` scope table in WORKSPACE_MAP.md into
 * a Map from bare filename (e.g. `"codex-core.md"`) to trimmed scope text. The
 * header row and any WORKSPACE_MAP.md self-row are ignored. Single regex over
 * lines; no markdown library.
 */
export function parseMapScopes(workspaceMapText: string): Map<string, string> {
  const scopes = new Map<string, string>()
  // Matches: | [`<file>.md`](...) | <scope> |
  const rowRegex = /^\|\s*\[`([^`]+\.md)`\][^|]*\|\s*(.*?)\s*\|/
  for (const line of workspaceMapText.split('\n')) {
    const match = rowRegex.exec(line)
    if (!match) continue
    const file = match[1]
    if (file === 'WORKSPACE_MAP.md') continue
    scopes.set(file, match[2].trim())
  }
  return scopes
}

// Keyed by WORKSPACE_MAP.md path so two different checkouts with coincidentally
// equal mtimes never reuse each other's scopes.
const scopeCache = new Map<string, { mtimeMs: number; scopes: Map<string, string> }>()

function getScopes(workspaceMapPath: string): Map<string, string> {
  let mtimeMs: number
  try {
    mtimeMs = statSync(workspaceMapPath).mtimeMs
  } catch {
    return new Map()
  }
  const cached = scopeCache.get(workspaceMapPath)
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.scopes
  }
  let scopes: Map<string, string>
  try {
    scopes = parseMapScopes(readFileSync(workspaceMapPath, 'utf8'))
  } catch {
    return new Map()
  }
  scopeCache.set(workspaceMapPath, { mtimeMs, scopes })
  return scopes
}

// A keyword matches as a whole word when it has no internal spaces/hyphens
// (single token): `lease` must not match `please`, `repl` not `reply`, `ink`
// not `thinking`. Multi-word phrases (e.g. "cache routing", "direct-connect")
// are specific enough that plain substring containment is sufficient.
function keywordMatches(lowered: string, keyword: string): boolean {
  if (/[\s-]/.test(keyword)) {
    return lowered.includes(keyword)
  }
  // Word-boundary match for single tokens. Escape regex metacharacters in the
  // keyword (e.g. `c++` style would break an unescaped pattern).
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${escaped}\\b`).test(lowered)
}

/**
 * Match a user prompt against the keyword->map table. Returns at most 2 matched
 * maps (most-specific first, by hit count then table order), each joined to its
 * scope from WORKSPACE_MAP.md. Returns `[]` immediately (no file reads) when the
 * project has no `docs/maps/` directory.
 */
export function matchSubsystemMaps(
  promptText: string,
  opts: { projectRoot: string },
): Array<{ map: string; scope: string }> {
  const mapsDir = path.join(opts.projectRoot, 'docs', 'maps')
  if (!existsSync(mapsDir)) return []

  const lowered = promptText.toLowerCase()
  const hits: Array<{ map: string; count: number; order: number }> = []
  KEYWORD_MAP.forEach((entry, order) => {
    let count = 0
    for (const keyword of entry.keywords) {
      if (keywordMatches(lowered, keyword)) count++
    }
    if (count >= 1) hits.push({ map: entry.map, count, order })
  })
  if (hits.length === 0) return []

  hits.sort((a, b) => b.count - a.count || a.order - b.order)
  const top = hits.slice(0, MAX_MATCHES)

  const scopes = getScopes(path.join(mapsDir, 'WORKSPACE_MAP.md'))
  return top.map(hit => ({ map: hit.map, scope: scopes.get(hit.map) ?? '' }))
}

/**
 * Format the injected reminder text from matched maps. Returns `null` when there
 * are no matches.
 */
export function buildMapContextReminder(
  matches: Array<{ map: string; scope: string }>,
): string | null {
  if (matches.length === 0) return null
  const areaWords = matches.map(m => m.map.replace(/\.md$/, '')).join(', ')
  const bullets = matches
    .map(m => `- docs/maps/${m.map}${m.scope ? ` — ${m.scope}` : ''}`)
    .join('\n')
  return [
    `This prompt looks related to: ${areaWords}.`,
    'Relevant Cat Code subsystem map(s) — read before broad source search:',
    bullets,
    "Use the map's routing table to pick first files instead of searching blind.",
  ].join('\n')
}
