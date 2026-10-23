import { expect, test } from 'bun:test'
import { AppSessionController } from './AppSessionController.js'
import type { InlineCommandOperation } from './inlineCommand.js'
import type { AppPermissionRequest, AppSessionEvent } from './sessionEvents.js'

const source = { engineSessionId: 'session', messageUuid: 'assistant', contentBlockIndex: 0, fenceOrdinal: 0 }
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const permission = (requestId: string): AppPermissionRequest => ({ requestId, request: {
  subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'true' }, tool_use_id: requestId,
} })

test('inline execution overlaps turns and holds mutation admission through settlement', async () => {
  const turn = deferred()
  const command = deferred()
  const events: AppSessionEvent[] = []
  let operation!: InlineCommandOperation
  let mainSignal!: AbortSignal
  const controller = new AppSessionController({
    async *runTurn({ signal }) { mainSignal = signal; await turn.promise },
    async *runInlineCommand(args) { operation = args.operation; await command.promise },
  })
  controller.subscribe(event => events.push(event))
  const running = controller.submit('continue')
  expect(controller.canStartInlineCommand()).toBe(true)
  const inline = controller.submitInlineCommand(source, () => {})
  expect(controller.isTurnActive()).toBe(true)
  expect(controller.isInlineCommandActive()).toBe(true)
  await expect(controller.submitInlineCommand(source, () => {})).rejects.toThrow('busy')
  expect(() => controller.reserveHandoff('handoff')).toThrow('inline command')
  expect(() => controller.rewindBeforeUserMessage('input')).toThrow('still active')
  expect(() => controller.forkBeforeUserMessage('input')).toThrow('still active')
  operation.onProgress({ runId: operation.runId, source, command: 'true', cwd: '/tmp', status: 'success', output: '', exitCode: 0 })
  expect(controller.isInlineCommandActive()).toBe(true)
  expect(controller.stopInlineCommand(operation.runId)).toBe(false)
  expect(controller.canStartInlineCommand()).toBe(true)
  expect(mainSignal.aborted).toBe(false)
  turn.resolve()
  await running
  let idle = false
  const waiting = controller.waitUntilIdle().then(() => { idle = true })
  await Promise.resolve()
  expect(idle).toBe(false)
  // A new ordinary turn is admitted while the command is still settling.
  await controller.submit('next')
  command.resolve()
  await inline
  await waiting
  expect(controller.isInlineCommandActive()).toBe(false)
  expect(controller.canStartInlineCommand()).toBe(true)
  expect(events.filter(event => event.type === 'turn.status')).toHaveLength(4)
})

test('command Stop cancels only command permissions; session abort cancels both owners', async () => {
  let operation!: InlineCommandOperation
  const controller = new AppSessionController({
    async *runTurn({ onPermissionRequest, signal }) {
      const response = await onPermissionRequest(permission('main'), signal)
      expect(response.behavior).toBe('deny')
    },
    async *runInlineCommand({ operation: current, onPermissionRequest }) {
      operation = current
      // Even an adapter omitting its signal must retain command ownership.
      const response = await onPermissionRequest(permission('inline'))
      expect(response.behavior).toBe('deny')
    },
  })
  const running = controller.submit('permission')
  expect(controller.getPendingPermissionRequests()).toHaveLength(1)
  expect(controller.canStartInlineCommand()).toBe(true)
  const inline = controller.submitInlineCommand(source, () => {})
  expect(controller.getPendingPermissionRequests()).toHaveLength(2)
  controller.stopInlineCommand(operation.runId)
  await inline
  expect(controller.getPendingPermissionRequests().map(request => request.requestId)).toEqual(['main'])
  const another = controller.submitInlineCommand(source, () => {})
  controller.abort('Session closing')
  await Promise.all([running, another])
  expect(controller.getPendingPermissionRequests()).toHaveLength(0)
  expect(controller.isInlineCommandActive()).toBe(false)
})
