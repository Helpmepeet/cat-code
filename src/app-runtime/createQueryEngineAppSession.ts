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
}

export function createQueryEngineAppSession(
  config: QueryEngineAppSessionConfig,
): QueryEngineSessionLike {
  let currentPermissionHandler: AppPermissionRequestHandler | undefined
  const abortController = config.abortController ?? createAbortController()
  const engine = new QueryEngine({
    ...config,
    abortController,
    canUseTool: createAppRuntimeCanUseTool({
      baseCanUseTool: config.canUseTool,
      createRequestId: config.createRequestId,
      getPermissionRequestHandler: () => currentPermissionHandler,
    }),
  })

  return {
    async *submitMessage(prompt, options?: QueryEngineSessionOptions) {
      currentPermissionHandler = options?.onPermissionRequest
      try {
        yield* engine.submitMessage(prompt, {
          uuid: options?.uuid,
          isMeta: options?.isMeta,
        })
      } finally {
        currentPermissionHandler = undefined
      }
    },
    interrupt() {
      abortController.abort()
    },
  }
}
