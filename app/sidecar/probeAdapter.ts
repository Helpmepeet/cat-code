/**
 * P1-0 probe adapter.
 *
 * The P1-0 gate is the EMPTY topology: prove the pipe carries a raw `SDKMessage`
 * (incl. a `tool_use` block) intact sidecar→main→renderer, with no live model
 * turn (that is P1-2, the first credentialed turn). This adapter is the minimal
 * `AppSessionControllerAdapter` that the real `AppSessionController` — the exact
 * class `createRuntimeBackedWebAppSession` /
 * `createQueryEngineSessionController` wrap — drives.
 *
 * On `runTurn` it yields a hand-built assistant `SDKMessage` carrying a `text`
 * block AND a `tool_use` block. Running it through `controller.submit()`
 * exercises the real `emit()` → `subscribe()` path, so the frame that reaches
 * the renderer is produced by the real controller plumbing, not a fake emitter.
 *
 * P1-1 keeps this adapter only behind `CATCODE_SIDECAR_PROBE=1`; normal startup
 * uses `createRuntimeBackedWebAppSession({ queryEngineConfig })` over the same
 * controller seam.
 */

import type {
  AppSessionControllerAdapter,
} from '../../src/app-runtime/AppSessionController.js'
import type { SDKMessage } from '../../src/entrypoints/agentSdkTypes.js'

/**
 * A realistic assistant message with a text + tool_use block, matching the
 * shape a real engine turn emits (`assistant` message → `message.content: [...]`).
 * The `tool_use` block is the P1-0 gate: it must survive the transport intact,
 * which the flattening mapper would drop (TRANSPORT-DECISION.md §2).
 */
export function buildProbeToolUseMessage(): SDKMessage {
  return {
    type: 'assistant',
    uuid: 'probe-uuid-1',
    session_id: 'p1-0-probe',
    message: {
      id: 'msg_probe_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-probe',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
      content: [
        {
          type: 'text',
          text: "I'll read that file.",
        },
        {
          type: 'tool_use',
          id: 'toolu_probe_1',
          name: 'Read',
          input: { file_path: '/etc/hosts' },
        },
      ],
    },
    // Cast at the fixture boundary only: the engine's generated `SDKMessage`
    // union types `message.content` as `unknown[]`, so a literal fixture cannot
    // be inferred as an exact union member without this single, contained cast.
  } as unknown as SDKMessage
}

export function createProbeAdapter(): AppSessionControllerAdapter {
  return {
    async *runTurn() {
      yield buildProbeToolUseMessage()
    },
  }
}
