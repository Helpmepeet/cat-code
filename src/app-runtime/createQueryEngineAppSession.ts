import { QueryEngine, type QueryEngineConfig } from '../QueryEngine.js'
import { createAbortController } from '../utils/abortController.js'
import {
  createAppRuntimeCanUseTool,
  type AppPermissionRequestHandler,
} from './appRuntimeCanUseTool.js'
import type {
  QueryEngineSessionLike,
  QueryEngineSessionOptions,
} from './createQueryEngineSessionController.js'

export type QueryEngineAppSessionConfig = Omit<
  QueryEngineConfig,
  'abortController' | 'canUseTool'
> & {
  abortController?: AbortController
  canUseTool?: QueryEngineConfig['canUseTool']
  createRequestId?: () => string
  createEngine?: (config: QueryEngineConfig) => QueryEngineSessionLike
}

export function createQueryEngineAppSession(
  config: QueryEngineAppSessionConfig,
): QueryEngineSessionLike {
  let currentPermissionHandler: AppPermissionRequestHandler | undefined
  const abortController = config.abortController ?? createAbortController()
  const engineConfig = {
    ...config,
    abortController,
    canUseTool: createAppRuntimeCanUseTool({
      baseCanUseTool: config.canUseTool,
      createRequestId: config.createRequestId,
      getPermissionRequestHandler: () => currentPermissionHandler,
    }),
  }
  const engine = config.createEngine?.(engineConfig) ?? new QueryEngine(engineConfig)

  return {
    async *submitMessage(prompt, options?: QueryEngineSessionOptions) {
      engine.refreshAbortController?.()
      currentPermissionHandler = options?.onPermissionRequest
      try {
        yield* engine.submitMessage(prompt, {
          uuid: options?.uuid,
          isMeta: options?.isMeta,
          origin: options?.origin,
          onInputPersisted: options?.onInputPersisted,
        })
      } finally {
        currentPermissionHandler = undefined
      }
    },
    interrupt() {
      engine.interrupt?.()
    },
    refreshAbortController() {
      return engine.refreshAbortController?.() ?? abortController
    },
  }
}
