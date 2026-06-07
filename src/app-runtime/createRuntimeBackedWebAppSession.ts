import {
  createQueryEngineAppSession,
  type QueryEngineAppSessionConfig,
} from './createQueryEngineAppSession.js'
import { createQueryEngineSessionController } from './createQueryEngineSessionController.js'

export type RuntimeBackedWebAppSessionOptions = {
  queryEngineConfig: QueryEngineAppSessionConfig
}

export function createRuntimeBackedWebAppSession({
  queryEngineConfig,
}: RuntimeBackedWebAppSessionOptions) {
  return createQueryEngineSessionController(
    createQueryEngineAppSession({
      ...queryEngineConfig,
      includePartialMessages: true,
    }),
  )
}
