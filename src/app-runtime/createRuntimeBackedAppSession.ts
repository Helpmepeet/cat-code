import { randomUUID } from 'crypto'
import type { SDKStatus } from '../entrypoints/agentSdkTypes.js'
import { getSessionId } from '../bootstrap/state.js'
import type { AppSessionController } from './AppSessionController.js'
import {
  createQueryEngineAppSession,
  type QueryEngineAppSessionConfig,
} from './createQueryEngineAppSession.js'
import { createQueryEngineSessionController } from './createQueryEngineSessionController.js'
import { attachThreadGoalScheduler } from './attachThreadGoalScheduler.js'
import { saveThreadGoal } from '../utils/sessionStorage.js'

export type RuntimeBackedAppSessionOptions = {
  queryEngineConfig: QueryEngineAppSessionConfig
  /**
   * Set when an outer control plane already drives turns for this session. The
   * native goal loop then yields instead of creating a second scheduler.
   */
  hasExternalScheduler?: () => boolean
}

export function createRuntimeBackedAppSession({
  queryEngineConfig,
  hasExternalScheduler,
}: RuntimeBackedAppSessionOptions) {
  // `setSDKStatus` is a push callback, not a yielded message, so it needs the
  // controller that does not exist yet when the session is built. Captured by
  // reference and read at call time; the engine cannot fire it before the turn
  // starts, which is long after the assignment below.
  //
  // Without this the desktop never learns a compaction is running: the callback
  // is optional and the sidecar left it unset, so the engine's own compaction
  // signal (`src/services/compact/compact.ts` `setSDKStatus('compacting')`, and
  // `null` in its `finally`) was produced nowhere on this path. The terminal's
  // stream-json entrypoint wires the identical message (`src/cli/print.ts`).
  let controller: AppSessionController | null = null
  const supplied = queryEngineConfig.setSDKStatus
  const session = createQueryEngineAppSession({
    ...queryEngineConfig,
    includePartialMessages: true,
    setSDKStatus: (status: SDKStatus) => {
      supplied?.(status)
      controller?.emitMessage({
        type: 'system',
        subtype: 'status',
        status,
        session_id: getSessionId(),
        uuid: randomUUID(),
      })
    },
  })
  controller = createQueryEngineSessionController(session)

  // The goal loop attaches HERE because this factory is the one seam the
  // desktop sidecar uses. Before this, submitted turns returned idle: `/goal`
  // was terminal-only behaviour dressed as a harness guarantee. The scheduler
  // is the same module the terminal drives, so the runtimes cannot drift apart.
  attachThreadGoalScheduler({
    controller,
    ownerId: `app-runtime:${getSessionId()}`,
    getGoal: () => queryEngineConfig.getAppState().threadGoal ?? null,
    saveGoal: nextGoal => {
      saveThreadGoal(nextGoal)
      queryEngineConfig.setAppState(prev =>
        prev.threadGoal?.goalId === nextGoal.goalId
          ? { ...prev, threadGoal: nextGoal }
          : prev,
      )
    },
    ...(hasExternalScheduler ? { hasExternalScheduler } : {}),
  })

  return controller
}
