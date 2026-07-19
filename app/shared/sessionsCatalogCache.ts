/**
 * The cold-launch sessions-catalog baseline cache — the ONE fact both planes must
 * agree on (the sidecar WRITES it, Electron main READS it), kept here so the two
 * derivations can never drift apart.
 *
 * The file is a single global `SessionsCatalogSnapshot` JSON, written beside the
 * durable registry: `<config-home>/desktop/sessions-catalog.json`. Main derives
 * that dir host-side via `defaultRegistryDir()` (`app/host/registry.ts:179`,
 * already `<config-home>/desktop`) and only appends the filename; the sidecar,
 * which runs the engine, joins the engine's own config home
 * (`getClaudeConfigHomeDir()`, `src/utils/envUtils.ts:15`) with this subdir. Both
 * read `CLAUDE_CONFIG_DIR ?? ~/.cat-code`, so the two paths resolve to one file.
 *
 * Pure constants only — NO `electron`, NO engine, NO node imports — so both the
 * host plane and the sidecar plane can import it without crossing a trust boundary.
 */

/**
 * Registry-dir basename under the config home. Must equal the literal
 * `app/host/registry.ts:179` uses for `defaultRegistryDir()` (`'desktop'`); the
 * sidecar re-derives the dir from the engine config home and appends this.
 */
export const SESSIONS_CATALOG_CACHE_SUBDIR = 'desktop'

/** The single global baseline cache filename (beside `registry.json`). */
export const SESSIONS_CATALOG_CACHE_FILENAME = 'sessions-catalog.json'
