import { isEnvTruthy } from './envUtils.js'

/**
 * Whether this build has bfs/ugrep embedded in the bun binary (ant-native only).
 *
 * When true:
 * - `find` and `grep` in Claude's Bash shell are shadowed by shell functions
 *   that invoke the bun binary with argv0='bfs' / argv0='ugrep' (same trick
 *   as embedded ripgrep)
 * - The dedicated Glob/Grep tools are removed from the tool registry
 * - Prompt guidance steering Claude away from find/grep is omitted
 *
 * Set as a build-time define in scripts/build-with-plugins.ts for ant-native builds.
 */
export function hasEmbeddedSearchTools(): boolean {
  if (!hasEmbeddedRipgrep()) return false
  const e = process.env.CLAUDE_CODE_ENTRYPOINT
  return (
    e !== 'sdk-ts' && e !== 'sdk-py' && e !== 'sdk-cli' && e !== 'local-agent'
  )
}

/**
 * Whether the current runtime advertises native argv0 ripgrep dispatch.
 * Unlike tool-surface selection, this capability does not depend on which
 * entrypoint is using the shared search helper.
 */
export function hasEmbeddedRipgrep(): boolean {
  return isEnvTruthy(process.env.EMBEDDED_SEARCH_TOOLS)
}

/**
 * Path to the bun binary that contains the embedded search tools.
 * Only meaningful when hasEmbeddedSearchTools() is true.
 */
export function embeddedSearchToolsBinaryPath(): string {
  return process.execPath
}
