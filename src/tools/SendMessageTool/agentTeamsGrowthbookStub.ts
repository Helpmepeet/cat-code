/**
 * `--preload` helper for SendMessageTool.schemaGate.probe.test.ts ONLY.
 *
 * Pre-existing, unrelated bug this routes around: `agentSwarmsEnabled.ts`
 * imports `services/analytics/growthbook.ts`, whose own transitive import
 * graph reaches back into `tools/AgentTool/AgentTool.tsx`, which eagerly
 * calls `isAgentSwarmsEnabled()` at module-evaluation time (via `buildTool`'s
 * object-spread of a `get inputSchema()` getter, which forces the getter
 * immediately rather than deferring it). When Agent Teams is opted in from
 * process start (env var or `--agent-teams` set before the process launches),
 * that call reaches growthbook's killswitch read while growthbook.ts is
 * still mid-import, producing a TDZ crash:
 *   `ReferenceError: Cannot access 'envOverridesParsed' before initialization`
 * at `services/analytics/growthbook.ts:171`. Reproduces on unmodified HEAD via
 * `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 bun run src/entrypoints/cli.tsx --agent-teams --help`
 * and even via a bare `import '../../services/analytics/growthbook.js'` with
 * that env var set — nothing here is caused by SendMessageTool's schema gate.
 *
 * This stub breaks the cycle for the probe only: it replaces growthbook.ts
 * wholesale so AgentTool.tsx's eager killswitch read never touches the real
 * (circularly-reachable) module. It does not exercise or assert anything
 * about growthbook itself.
 */
import { mock } from 'bun:test'

mock.module('../../services/analytics/growthbook.js', () => ({
  onGrowthBookRefresh: () => () => {},
  hasGrowthBookEnvOverride: () => false,
  getAllGrowthBookFeatures: () => ({}),
  getGrowthBookConfigOverrides: () => ({}),
  setGrowthBookConfigOverride: () => {},
  clearGrowthBookConfigOverrides: () => {},
  getApiBaseUrlHost: () => undefined,
  initializeGrowthBook: () => Promise.resolve(),
  getFeatureValue_DEPRECATED: async (_name: string, def: unknown) => def,
  getFeatureValue_CACHED_MAY_BE_STALE: (_name: string, def: unknown) => def,
  getFeatureValue_CACHED_WITH_REFRESH: (_name: string, def: unknown) => def,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE: () => false,
  checkSecurityRestrictionGate: async () => false,
  checkGate_CACHED_OR_BLOCKING: async () => false,
  refreshGrowthBookAfterAuthChange: () => {},
  resetGrowthBook: () => {},
  refreshGrowthBookFeatures: async () => {},
  setupPeriodicGrowthBookRefresh: () => {},
  stopPeriodicGrowthBookRefresh: () => {},
  getDynamicConfig_BLOCKS_ON_INIT: async (_n: string, def: unknown) => def,
  getDynamicConfig_CACHED_MAY_BE_STALE: (_n: string, def: unknown) => def,
}))
