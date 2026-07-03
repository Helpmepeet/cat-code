import { AppSessionController } from '../../src/app-runtime/AppSessionController.js'
import { createQueryEngineAppSessionConfigFromSetup } from '../../src/app-runtime/createQueryEngineAppSessionConfigFromSetup.js'
import { createQueryEngineSessionController } from '../../src/app-runtime/createQueryEngineSessionController.js'
import { createRuntimeBackedWebAppSession } from '../../src/app-runtime/createRuntimeBackedWebAppSession.js'
import { getDefaultAppState } from '../../src/state/AppStateStore.js'
import { getTools } from '../../src/tools.js'
import { createStore } from '../../src/state/store.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from '../../src/utils/fileStateCache.js'
import { createProbeAdapter } from './probeAdapter.js'
import { P1_1_CWD } from '../shared/sessionConfig.js'

export { P1_1_CWD } from '../shared/sessionConfig.js'

export function createNormalSidecarQueryEngineConfig() {
  const appStateStore = createStore(getDefaultAppState())
  const tools = getTools(appStateStore.getState().toolPermissionContext)

  return createQueryEngineAppSessionConfigFromSetup({
    cwd: P1_1_CWD,
    tools,
    commands: [],
    mcpTools: [],
    mcpCommands: [],
    mcpClients: [],
    mcpResources: {},
    agents: [],
    getAppState: appStateStore.getState,
    setAppState: appStateStore.setState,
    readFileCache: createFileStateCacheWithSizeLimit(
      READ_FILE_STATE_CACHE_SIZE,
    ),
  })
}

export function createSidecarSessionController({
  probe,
}: {
  probe: boolean
}): AppSessionController {
  if (probe) {
    return createQueryEngineSessionController({
      submitMessage(prompt, options) {
        return createProbeAdapter().runTurn({
          prompt,
          options: { uuid: options?.uuid, isMeta: options?.isMeta },
          signal: new AbortController().signal,
          onPermissionRequest: async () => ({
            behavior: 'deny',
            message: 'probe: no permission handler',
          }),
        })
      },
    })
  }

  // Derive the model-visible tool list from the SAME permission context the
  // runtime enforces (QueryEngine reads getAppState().toolPermissionContext),
  // so what the model sees and what canUseTool allows never diverge. P1-2
  // shipped `tools: []`, which made every live turn text-only — the model
  // could not emit a tool_use at all (found in P1-3).
  const queryEngineConfig = createNormalSidecarQueryEngineConfig()

  return createRuntimeBackedWebAppSession({ queryEngineConfig })
}
