import { expect, test } from 'bun:test'
import { AppSessionController } from '../../src/app-runtime/AppSessionController.js'
import { SidecarServer } from './sidecarServer.js'
import { FrameDecoder, encodeFrame } from '../shared/framing.js'
import { MAX_OUTBOUND_FRAME_BYTES } from '../shared/limits.js'
import { PROTOCOL_VERSION, type ServerFrame } from '../shared/protocol.js'
import { sessionDescriptorFixture } from '../shared/sessionDescriptor.fixture.js'
import { createDesktopNotifications } from '../main/desktopNotifications.js'
import { createTranscriptState, projectServerFrames, selectNestedTranscriptRows } from '../renderer/src/transcriptProjector.js'
import { retryableTurn } from '../renderer/src/turnFailure.js'

test.each([false, true])('real submit ordering retains the shared Retry candidate, native first=%s', async nativeFirst => {
  const sessionId = '00000000-0000-4000-8000-000000000001'
  const frames: ServerFrame[] = []
  const sent: unknown[] = []
  const notices: Array<{ actions?: unknown }> = []
  let action: ((...args: unknown[]) => void) | undefined
  let finish!: () => void
  const closed = new Promise<void>(resolve => { finish = resolve })
  const controller = new AppSessionController({
    async *runTurn() {
      yield { type: 'result', uuid: 'production-result', subtype: 'error_during_execution', is_error: true, errors: [] } as never
    },
  })
  const coordinator = createDesktopNotifications({
    getSession: () => sessionDescriptorFixture({ appSessionId: sessionId, cwd: '/isolated/project', status: 'ready' }),
    isAppFocused: () => false,
    getPreferences: () => ({ notify: 'all', dockBadge: true }),
    createNotification: options => {
      notices.push(options)
      return { on(event, listener) { if (event === 'action') action = listener; return this }, show() {}, close() {} }
    },
    setBadge() {}, openSession() {},
    send: (_id, message) => { sent.push(message); return true },
  })
  const server = new SidecarServer({ sessionId, engineSessionId: 'engine', controller, log() {} })
  const decoder = new FrameDecoder(MAX_OUTBOUND_FRAME_BYTES)
  const connection = server.addConnection({
    write(data) {
      for (const decoded of decoder.push(Buffer.from(data))) {
        if (decoded.kind !== 'frame') continue
        const frame = decoded.payload as ServerFrame
        frames.push(frame)
        coordinator.receive(sessionId, frame)
        if (frame.kind === 'event' && frame.event.type === 'turn.status' && !frame.event.activeTurn) finish()
      }
    },
    end() {},
  })
  try {
    server.handleData(connection, encodeFrame({
      protocolVersion: PROTOCOL_VERSION, sessionId,
      message: { type: 'app.submit', requestId: 'submit', prompt: 'The actual submitted text' },
    }))
    await closed
    const candidate = retryableTurn(selectNestedTranscriptRows(projectServerFrames(createTranscriptState(), frames), sessionId))!
    expect(candidate?.text).toBe('The actual submitted text')
    expect(notices.at(-1)?.actions).toEqual([{ type: 'button', text: 'Retry' }])
    if (nativeFirst) {
      action?.({}, 0)
      expect(coordinator.retry(sessionId, candidate.resultId)).toBe(false)
    } else {
      expect(coordinator.retry(sessionId, candidate.resultId)).toBe(true)
      action?.({}, 0)
    }
    expect(sent).toEqual([expect.objectContaining({ type: 'app.submit', prompt: candidate.text })])
  } finally {
    coordinator.dispose()
    server.close()
  }
})
