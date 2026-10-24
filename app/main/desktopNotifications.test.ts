import { describe, expect, test } from 'bun:test'
import { createDesktopNotifications, type DesktopNotificationHandle } from './desktopNotifications.js'
import { sessionDescriptorFixture } from '../shared/sessionDescriptor.fixture.js'
import type { ServerFrame } from '../shared/protocol.js'
import type { SessionDescriptor } from '../shared/hostApi.js'
import { createTranscriptState, projectServerFrames, selectNestedTranscriptRows } from '../renderer/src/transcriptProjector.js'
import { retryableTurn } from '../renderer/src/turnFailure.js'
import { PROTOCOL_VERSION } from '../shared/protocol.js'
import { buildPermissionOptions } from '../renderer/src/permissionPromptModel.js'
import { turnFailureCopy } from '../renderer/src/turnFailure.js'

function cardRows(frames: ServerFrame[]) {
  const ready: ServerFrame = {
    kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', engineSessionId: 'engine-a',
    payload: { type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false, abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [] },
  }
  return selectNestedTranscriptRows(projectServerFrames(createTranscriptState(), [ready, ...frames]), 'a')
}

function harness(descriptor: Partial<SessionDescriptor> = {}, sendSuccess = true) {
  const handles: Array<{ options: any; closed: boolean; emit: (event: string, ...args: any[]) => void }> = []
  const sent: any[] = [], opened: any[] = []
  let badge = '', visible = false, retryBlocked = false
  const prefs = { notify: 'all' as 'all' | 'waiting' | 'off', dockBadge: true }
  const coordinator = createDesktopNotifications({
    getSession: id => sessionDescriptorFixture({ appSessionId: id, cwd: '/projects/cat-code', title: 'Fix tests', ...descriptor }),
    isVisible: () => visible, getPreferences: () => prefs,
    isRetryBlocked: () => retryBlocked,
    createNotification: options => {
      const listeners = new Map<string, (...args: any[]) => void>()
      const h = { options, closed: false, emit: (event: string, ...args: any[]) => listeners.get(event)?.({}, ...args) }
      handles.push(h)
      return { on(event, cb) { listeners.set(event, cb); return this }, show() {}, close() { h.closed = true; h.emit('close') } } as DesktopNotificationHandle
    },
    setBadge: text => { badge = text }, openSession: (...args) => { opened.push(args) }, send: (...args) => { sent.push(args); return sendSuccess },
  })
  const frame = (value: any, id = 'a') => coordinator.receive(id, { sessionId: id, ...value } as ServerFrame)
  const event = (value: any, replay = false, id = 'a') => frame({ kind: 'event', event: value, ...(replay ? { replay: true } : {}) }, id)
  const request = (id = 'r', tool = 'Bash', input: any = { command: 'pwd' }) => ({ requestId: id, request: { subtype: 'can_use_tool' as const, tool_use_id: `tool-${id}`, tool_name: tool, input, permission_suggestions: [] } })
  const permission = (id = 'r', tool = 'Bash', input?: any) => event({ type: 'permission.requested', request: request(id, tool, input) })
  let serial = 0
  const message = (message: any, replay = false) => event({ type: 'message', message: message && { uuid: `frame-${++serial}`, ...(message.type === 'result' ? { is_error: false } : {}), ...message } }, replay)
  return { coordinator, frame, event, request, permission, message, handles, sent, opened, prefs, badge: () => badge, visible: (value: boolean) => { visible = value }, blockRetry: (value: boolean) => { retryBlocked = value } }
}

describe('desktop notifications', () => {
  test('composer-blocked retries are absent, rechecked, and refreshed without another sound', () => {
    const h = harness()
    h.blockRetry(true)
    h.message({ type: 'user', message: { content: 'Original input' } })
    h.message({ type: 'result', uuid: 'blocked-result', subtype: 'error_during_execution', is_error: true })
    expect(h.handles.at(-1)!.options.actions).toEqual([])
    expect(h.coordinator.retry('a', 'a:blocked-result:result')).toBe(false)
    h.blockRetry(false)
    h.coordinator.retryBlockedChanged()
    const allowed = h.handles.at(-1)!
    expect(allowed.options.actions).toEqual([{ type: 'button', text: 'Retry' }])
    expect(allowed.options.silent).toBe(true)
    h.blockRetry(true)
    h.coordinator.retryBlockedChanged()
    expect(allowed.closed).toBe(true)
    allowed.emit('action', 0)
    expect(h.handles.at(-1)!.options.actions).toEqual([])
    expect(h.sent).toHaveLength(0)
    h.blockRetry(false)
    expect(h.coordinator.retry('a', 'a:blocked-result:result')).toBe(true)
    expect(h.sent).toHaveLength(1)
  })
  test.each(['assistant', 'stream'] as const)('recovered overload does not mask a later usage failure after %s output', output => {
    const h = harness()
    const frames: ServerFrame[] = []
    const receive = (message: unknown) => {
      const frame = { kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', event: { type: 'message', message } } as ServerFrame
      frames.push(frame)
      h.frame(frame)
    }
    receive({ type: 'system', subtype: 'api_retry', uuid: 'retry', error: { message: 'Overloaded' }, error_status: 529, attempt: 1, retry_delay_ms: 1 })
    if (output === 'assistant') {
      receive({ type: 'assistant', uuid: 'recovered', message: { id: 'response', role: 'assistant', content: [{ type: 'text', text: 'Recovered' }] } })
    } else {
      receive({ type: 'stream_event', uuid: 'start', event: { type: 'message_start', message: { id: 'response' } } })
      receive({ type: 'stream_event', uuid: 'block', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
      receive({ type: 'stream_event', uuid: 'delta', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Recovered' } } })
    }
    receive({ type: 'assistant', uuid: 'limit', error: 'rate_limit', message: { id: 'failure', role: 'assistant', content: [{ type: 'text', text: 'Usage limit reached' }] } })
    receive({ type: 'result', uuid: 'failed', subtype: 'error_during_execution', is_error: true, errors: [] })
    const result = cardRows(frames).reverse().find(row => row.kind === 'result')!
    expect(result.kind).toBe('result')
    if (result.kind !== 'result') throw new Error('Missing projected result')
    const card = turnFailureCopy(result)
    expect(card.title).toBe('Usage limit reached')
    expect(h.handles.at(-1)!.options.title).toBe(card.title)
    expect(h.handles.at(-1)!.options.body).toBe(card.detail)
    expect(h.handles.at(-1)!.options.actions).toEqual([{ type: 'button', text: 'Open Accounts' }])
  })
  test('result-only failure details classify identically on the card and native banner', () => {
    const h = harness()
    const frame = {
      kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'a',
      event: { type: 'message', message: { type: 'result', uuid: 'limit', subtype: 'error_during_execution', is_error: true, errors: ['Usage limit reached'] } },
    } as ServerFrame
    h.frame(frame)
    const result = cardRows([frame]).find(row => row.kind === 'result')!
    if (result.kind !== 'result') throw new Error('Missing projected result')
    const card = turnFailureCopy(result)
    expect(card.title).toBe('This turn could not finish')
    expect(h.handles.at(-1)!.options.title).toBe(card.title)
    expect(h.handles.at(-1)!.options.body).toBe(card.detail)
    expect(h.handles.at(-1)!.options.actions).toEqual([])
  })
  test('a result does not enable Retry or Finished reply before authoritative turn closure', () => {
    for (const subtype of ['success', 'error_during_execution']) {
      const h = harness()
      const frames = [
        { kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', engineSessionId: 'engine',
          payload: { type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false, abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [] } },
        { kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', event: { type: 'message', message: { type: 'user', uuid: 'user', message: { role: 'user', content: 'Repeat this' } } } },
        { kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', event: { type: 'message', message: { type: 'result', uuid: 'result', subtype, is_error: subtype !== 'success' } } },
      ] as ServerFrame[]
      h.frame(frames[0])
      h.event({ type: 'turn.status', activeTurn: true })
      h.frame(frames[1])
      h.frame(frames[2])
      const candidate = retryableTurn(selectNestedTranscriptRows(projectServerFrames(createTranscriptState(), frames), 'a'))
      expect(h.handles).toHaveLength(0)
      if (candidate) expect(h.coordinator.retry('a', candidate.resultId)).toBe(false)
      h.event({ type: 'turn.status', activeTurn: false })
      expect(h.handles).toHaveLength(1)
      if (candidate) h.handles[0]!.emit('action', 0)
      else h.handles[0]!.emit('reply', 'Follow up')
      expect(h.sent).toHaveLength(1)
    }
  })
  test('counts off-tab sessions, not requests, including visible waiting; prefs are independent', () => {
    const h = harness(); h.permission(); h.permission('s')
    expect(h.badge()).toBe('1'); expect(h.handles[0]!.closed).toBe(true)
    h.event({ type: 'permission.requested', request: h.request() }, false, 'b')
    expect(h.badge()).toBe('2')
    h.visible(true); h.coordinator.visibilityChanged(); expect(h.handles.at(-1)!.closed).toBe(true)
    h.prefs.notify = 'off'; h.permission('t'); expect(h.handles.length).toBe(3); expect(h.badge()).toBe('2')
    h.prefs.dockBadge = false; h.coordinator.preferencesChanged(); expect(h.badge()).toBe('')
  })
  test('ready is authoritative without banners and replay cannot overwrite live status', () => {
    const h = harness(); h.frame({ kind: 'ready', payload: { pendingPermissionRequests: [h.request()], activeTurn: false, abort: { status: 'idle' } } })
    expect(h.badge()).toBe('1'); expect(h.handles).toHaveLength(0)
    h.event({ type: 'permission.resolved', request: h.request() }, true)
    h.message({ type: 'result', subtype: 'success' }, true); expect(h.badge()).toBe('1')
    h.frame({ kind: 'ready', payload: { pendingPermissionRequests: [], activeTurn: false, abort: { status: 'idle' } } }); expect(h.badge()).toBe('')
  })
  test('resolution closes only its banner; stale replacements and generations never send', () => {
    const h = harness(); h.permission(); const old = h.handles[0]!
    h.permission('s'); old.emit('action', 0); expect(h.sent).toHaveLength(0)
    h.event({ type: 'permission.resolved', request: h.request('s') }); expect(h.badge()).toBe('1')
    h.handles[1]!.emit('reply', 'deny'); expect(h.sent).toHaveLength(0)
    h.permission(); const last = h.handles.at(-1)!
    h.frame({ kind: 'lifecycle', status: 'exited' }); h.permission(); last.emit('action', 0); expect(h.sent).toHaveLength(0)
    h.coordinator.dispose(); h.handles.at(-1)!.emit('action', 0); expect(h.sent).toHaveLength(0); expect(h.badge()).toBe('')
  })
  test('permission option indices and single-use actions follow card semantics', () => {
    const h = harness()
    const request = { ...h.request(), request: { ...h.request().request, permission_suggestions: [{ type: 'setMode' as const, mode: 'acceptEdits' as const, destination: 'session' as const }] } }
    h.event({ type: 'permission.requested', request })
    expect(h.handles[0]!.options.actions).toEqual(buildPermissionOptions(request.request).map(o => ({ type: 'button', text: o.pre + (o.code ?? '') + (o.post ?? '') })))
    const n = h.handles[0]!; n.emit('action', -1); n.emit('action', 1.1); expect(h.sent).toHaveLength(0)
    n.emit('action', 1); n.emit('action', 1)
    expect(h.sent).toHaveLength(1); expect(h.sent[0][1].response.applySuggestions).toEqual([0])
    h.permission('plan', 'ExitPlanMode', { plan: 'Do it' }); h.handles.at(-1)!.emit('action', 1)
    expect(h.sent.at(-1)[1]).toEqual({ type: 'notification.planApprove', requestId: 'plan', optionIndex: 1 })
  })
  test('question options and custom reply are atomic; multi-question and multiselect open only', () => {
    const h = harness(); const question = { question: 'Which?', header: 'Pick', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }], multiSelect: false }
    h.permission('q', 'AskUserQuestion', { questions: [question] }); expect(h.handles.at(-1)!.options.hasReply).toBe(true)
    h.handles.at(-1)!.emit('action', 1); expect(h.sent.at(-1)[1].answers).toEqual([{ optionIndices: [1] }])
    h.permission('q2', 'AskUserQuestion', { questions: [question] }); h.handles.at(-1)!.emit('reply', 'Other'); expect(h.sent.at(-1)[1].answers).toEqual([{ optionIndices: [], other: 'Other' }])
    for (const questions of [[question, question], [{ ...question, multiSelect: true }]]) {
      h.permission('multi', 'AskUserQuestion', { questions }); expect(h.handles.at(-1)!.options.actions).toEqual([]); expect(h.handles.at(-1)!.options.hasReply).toBe(false)
      h.handles.at(-1)!.emit('click'); expect(h.opened.at(-1)[0]).toBe('a')
    }
  })
  test('finished uses duration/final text, silent reply; waiting preferences suppress it', () => {
    const h = harness(); h.message({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] } }); h.message({ type: 'result', subtype: 'success', duration_ms: 2300 })
    expect(h.handles[0]!.options.body).toBe('2s · Done'); expect(h.handles[0]!.options.silent).toBe(true); expect(h.badge()).toBe('')
    h.handles[0]!.emit('reply', 'Continue'); expect(h.sent[0][1].prompt).toBe('Continue')
    h.prefs.notify = 'waiting'; h.message({ type: 'result', subtype: 'success' }); expect(h.handles).toHaveLength(1)
    h.permission(); expect(h.handles.at(-1)!.options.silent).toBe(false)
  })
  test('images have no Retry and usage action alone opens Accounts', () => {
    const h = harness()
    h.message({ type: 'user', message: { content: [{ type: 'text', text: 'Look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } }] } })
    h.message({ type: 'result', subtype: 'error_during_execution', is_error: true })
    expect(h.handles.at(-1)!.options.actions).toEqual([])
    h.message({ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: 'Usage limit reached' }] } }); h.message({ type: 'result', subtype: 'error_during_execution', is_error: true })
    h.handles.at(-1)!.emit('click'); expect(h.opened.at(-1)).toEqual(['a'])
    h.message({ type: 'result', subtype: 'error_during_execution', is_error: true })
    h.handles.at(-1)!.emit('action', 0); expect(h.opened.at(-1)).toEqual(['a', true]); expect(h.sent).toHaveLength(0)
  })
  test('interrupted, aborted and lifecycle never finish; active turn fences Retry', () => {
    const h = harness(); h.message({ type: 'user', message: { content: 'hello' } }); h.message({ type: 'result', subtype: 'error_during_execution', is_error: true }); const retry = h.handles[0]!
    h.event({ type: 'turn.status', activeTurn: true }); retry.emit('action', 0); expect(h.sent).toHaveLength(0); expect(h.badge()).toBe('')
    h.event({ type: 'abort.status', abort: { status: 'requested' } }); h.message({ type: 'result', subtype: 'success' }); expect(h.handles).toHaveLength(1)
    h.event({ type: 'turn.status', activeTurn: true }); h.message({ type: 'result', subtype: 'interrupted' }); expect(h.handles).toHaveLength(1)
  })
  test('native failures preserve waiting and fence callbacks; host removal clears state', () => {
    const h = harness(); h.permission()
    const failed = h.handles[0]!; failed.emit('failed', 'unavailable')
    expect(failed.closed).toBe(true); expect(h.badge()).toBe('1')
    failed.emit('action', 0); expect(h.sent).toHaveLength(0)
    h.coordinator.receiveHostEvent({ type: 'session-removed', appSessionId: 'a' })
    expect(h.badge()).toBe('')
  })
  test('unsafe retry opens the session without inventing a prompt', () => {
    const h = harness()
    h.message({ type: 'user', message: { content: [null] } })
    h.message({ type: 'result', subtype: 'error_during_execution', is_error: true })
    expect(h.handles[0]!.options.actions).toEqual([])
    h.handles[0]!.emit('click')
    expect(h.sent).toHaveLength(0); expect(h.opened[0][0]).toBe('a')
  })
  test('six event designs have exact titles, subtitles and controls', () => {
    const h = harness()
    const controls = () => {
      const o = h.handles.at(-1)!.options
      expect(o.subtitle).toBe('cat-code · Fix tests')
      return { title: o.title, actions: o.actions ?? [], reply: o.hasReply ?? false, placeholder: o.replyPlaceholder }
    }
    const request = h.request()
    h.event({ type: 'permission.requested', request })
    expect(controls()).toEqual({ title: 'Needs approval', actions: buildPermissionOptions(request.request).map(o => ({ type: 'button', text: o.pre + (o.code ?? '') + (o.post ?? '') })), reply: false, placeholder: undefined })
    h.permission('q', 'AskUserQuestion', { questions: [{ question: 'Pick?', header: 'Pick', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }], multiSelect: false }] })
    expect(controls()).toEqual({ title: 'Question', actions: [{ type: 'button', text: 'A' }, { type: 'button', text: 'B' }], reply: true, placeholder: 'Other answer' })
    h.permission('p', 'ExitPlanMode', { plan: 'Do it' })
    expect(controls()).toEqual({ title: 'Plan ready', actions: [{ type: 'button', text: 'Approve & auto-accept edits' }, { type: 'button', text: 'Approve & ask per edit' }], reply: false, placeholder: undefined })
    h.message({ type: 'result', subtype: 'success' })
    expect(controls()).toEqual({ title: 'Finished', actions: [], reply: true, placeholder: 'Reply' })
    h.message({ type: 'user', message: { content: 'Fix it' } })
    h.message({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Connection reset'] })
    expect(controls()).toEqual({ title: 'This turn could not finish', actions: [{ type: 'button', text: 'Retry' }], reply: false, placeholder: undefined })
    h.message({ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: 'Usage limit reached' }] } })
    h.message({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Usage limit reached'] })
    expect(controls()).toEqual({ title: 'Usage limit reached', actions: [{ type: 'button', text: 'Open Accounts' }], reply: false, placeholder: undefined })
    const managed = harness({ binding: { kind: 'managed', storageId: 'x', storageRootId: 'y' } })
    managed.permission(); expect(managed.handles[0]!.options.subtitle).toBe('Chats · Fix tests')
  })
  test('ready preserves authoritative live permission banner, host spawning resets generation', () => {
    const h = harness(); h.permission()
    const original = h.handles[0]!
    h.frame({ kind: 'ready', payload: { pendingPermissionRequests: [h.request()], activeTurn: false, abort: { status: 'idle' } } })
    expect(original.closed).toBe(false); original.emit('action', 0); expect(h.sent).toHaveLength(1)
    h.message({ type: 'user', message: { content: 'old' } }); h.message({ type: 'result', subtype: 'error_during_execution', is_error: true })
    h.coordinator.receiveHostEvent({ type: 'session-status', session: sessionDescriptorFixture({ appSessionId: 'a', cwd: '/tmp', status: 'spawning' }) })
    expect(h.badge()).toBe('')
    h.message({ type: 'result', subtype: 'success' }); expect(h.handles.at(-1)!.options.body).toBe('')
  })
  test('injected and fresh turns clear prompt, slash prompts do not retry, child/replay never replace prompt', () => {
    for (const injected of [{ origin: { kind: 'peer', name: 'Bear' } }, { isSynthetic: true }]) {
      const h = harness(); h.message({ type: 'user', message: { content: 'old' } })
      h.message({ type: 'user', ...injected, message: { content: 'injected' } })
      h.message({ type: 'result', subtype: 'error_during_execution', is_error: true })
      expect(h.handles.at(-1)!.options.actions).toEqual([]); h.handles.at(-1)!.emit('click'); expect(h.sent).toHaveLength(0); expect(h.opened).toHaveLength(1)
    }
    const h = harness(); h.event({ type: 'turn.status', activeTurn: true })
    h.message({ type: 'user', origin: { kind: 'human' }, message: { content: '/help' } })
    h.message({ type: 'user', parent_tool_use_id: 'child', message: { content: 'child' } })
    h.message({ type: 'user', message: { content: 'replay' } }, true)
    h.message({ type: 'result', parent_tool_use_id: 'child', subtype: 'success' }); expect(h.handles).toHaveLength(0)
    h.message({ type: 'result', subtype: 'error_during_execution', is_error: true })
    h.event({ type: 'turn.status', activeTurn: false })
    h.handles.at(-1)!.emit('action', 0); expect(h.sent).toHaveLength(0)
    h.event({ type: 'turn.status', activeTurn: true }); h.message({ type: 'result', subtype: 'error_during_execution', is_error: true })
    h.event({ type: 'turn.status', activeTurn: false })
    h.handles.at(-1)!.emit('action', 0); expect(h.sent).toHaveLength(0)
  })
  test('malformed SDK blocks do not throw and retained display text is bounded', () => {
    const h = harness()
    for (const message of [null, {}, { type: 'user', message: { content: [null, 1, {}] } }, { type: 'assistant', message: { content: [null, { type: 'text', text: 1 }] } }]) h.message(message)
    h.message({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(10000) }] } })
    h.message({ type: 'result', subtype: 'success' }); expect(h.handles.at(-1)!.options.body).toHaveLength(1000)
    h.message({ type: 'assistant', error: 'bad', message: { content: [{ type: 'text', text: 'z'.repeat(10000) }] } })
    h.message({ type: 'result', subtype: 'error_during_execution', is_error: true }); expect(h.handles.at(-1)!.options.body.length).toBeLessThanOrEqual(1000)
  })
  test('native and card retries share source-projected result ID and a once claim', () => {
    for (const nativeFirst of [true, false]) {
      const h = harness()
      const ready = { kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', engineSessionId: 'engine-a', payload: { type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false, abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [] } } as ServerFrame
      const user = { type: 'user', uuid: 'operator-input', message: { role: 'user', content: 'Fix this' }, parent_tool_use_id: null }
      const result = { type: 'result', uuid: 'actual-result', subtype: 'error_during_execution', is_error: true, errors: [] }
      const frames = [ready, ...[user, result].map(message => ({ kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', event: { type: 'message', message } }))] as ServerFrame[]
      const candidate = retryableTurn(selectNestedTranscriptRows(projectServerFrames(createTranscriptState(), frames), 'a'))!
      expect(candidate).not.toBeNull(); expect(candidate.resultId).not.toBe(result.uuid)
      for (const frame of frames) h.frame(frame)
      expect(h.coordinator.retry('a', result.uuid)).toBe(false)
      const banner = h.handles.at(-1)!
      if (nativeFirst) {
        banner.emit('action', 0)
        expect(h.coordinator.retry('a', candidate.resultId)).toBe(false)
      } else {
        expect(h.coordinator.retry('a', candidate.resultId)).toBe(true)
        banner.emit('action', 0)
      }
      expect(h.sent).toHaveLength(1); expect(h.sent[0][1].prompt).toBe(candidate.text)
      expect(h.coordinator.retry('a', candidate.resultId)).toBe(false)
    }
  })
  test('same candidate exclusions as card: slash, image, mixed, injected and multipart text', () => {
    for (const input of [
      { content: '/help' },
      { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } }] },
      { content: [{ type: 'text', text: 'See' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } }] },
      { content: [{ type: 'text', text: 'First' }, { type: 'text', text: 'Second' }] },
      { content: 'Peer task', origin: { kind: 'peer', name: 'Bear' } },
    ]) {
      const h = harness()
      h.message({ type: 'user', origin: input.origin, message: { content: input.content } })
      h.message({ type: 'result', subtype: 'error_during_execution', is_error: true })
      expect(h.handles.at(-1)!.options.actions).toEqual([])
      h.handles.at(-1)!.emit('action', 0); expect(h.sent).toHaveLength(0)
      h.handles.at(-1)!.emit('click'); expect(h.opened).toEqual([['a']])
    }
  })
  test('initial replay seeds card retry but never banners; older replay cannot replace live candidate', () => {
    const h = harness()
    h.frame({ kind: 'ready', payload: { activeTurn: false, inputEnabled: true, abort: { status: 'idle' }, pendingPermissionRequests: [] } })
    h.message({ type: 'user', uuid: 'replay-user', message: { content: 'Restored input' } }, true)
    h.message({ type: 'result', uuid: 'replay-result', subtype: 'error_during_execution', is_error: true }, true)
    expect(h.handles).toHaveLength(0); expect(h.badge()).toBe('')
    expect(h.coordinator.retry('a', 'a:replay-result:result')).toBe(true)
    expect(h.sent[0][1].prompt).toBe('Restored input')
    h.event({ type: 'turn.status', activeTurn: true })
    expect(h.coordinator.retry('a', 'a:replay-result:result')).toBe(false)
    h.message({ type: 'user', uuid: 'live-user', message: { content: 'Current input' } })
    h.message({ type: 'result', uuid: 'live-result', subtype: 'error_auth_required', is_error: true })
    h.event({ type: 'turn.status', activeTurn: false })
    expect(h.handles.at(-1)!.options.actions).toEqual([{ type: 'button', text: 'Retry' }])
    h.message({ type: 'user', uuid: 'older-user', message: { content: 'Old input' } }, true)
    h.message({ type: 'result', uuid: 'older-result', subtype: 'error_during_execution', is_error: true }, true)
    expect(h.coordinator.retry('a', 'a:older-result:result')).toBe(false)
    expect(h.coordinator.retry('a', 'a:live-result:result')).toBe(true)
    expect(h.sent.at(-1)[1].prompt).toBe('Current input')
  })
  test('history replacement retires old banners and retries before seeding the new replay', () => {
    const h = harness()
    h.message({ type: 'user', uuid: 'old-user', message: { content: 'Discarded input' } })
    h.message({ type: 'result', uuid: 'old-result', subtype: 'error_during_execution', is_error: true })
    const old = h.handles.at(-1)!
    h.frame({ kind: 'transcript.reset' })
    expect(old.closed).toBe(true)
    expect(h.badge()).toBe('')
    old.emit('action', 0)
    expect(h.coordinator.retry('a', 'a:old-result:result')).toBe(false)
    expect(h.sent).toHaveLength(0)
    h.message({ type: 'user', uuid: 'retained-user', message: { content: 'Retained input' } }, true)
    h.message({ type: 'result', uuid: 'retained-result', subtype: 'error_during_execution', is_error: true }, true)
    expect(h.handles).toHaveLength(1)
    expect(h.coordinator.retry('a', 'a:retained-result:result')).toBe(true)
    expect(h.sent[0][1].prompt).toBe('Retained input')
  })
  test('max limits use shared seam titles and no retry controls', () => {
    const h = harness()
    h.message({ type: 'user', message: { content: 'Task' } })
    for (const [subtype, title] of [['error_max_turns', 'Stopped · max turns reached'], ['error_max_budget_usd', 'Stopped · budget limit reached'], ['error_max_structured_output_retries', 'Stopped · max output retries']]) {
      h.message({ type: 'result', subtype, is_error: true, duration_ms: 1250, total_cost_usd: 0.25 })
      expect(h.handles.at(-1)!.options.title).toBe(title)
      expect(h.handles.at(-1)!.options.body).toBe('1.3s · $0.2500')
      expect(h.handles.at(-1)!.options.actions).toEqual([])
    }
  })
  test('retry rechecks live input gates and claims once even when sending fails', () => {
    for (const sendSuccess of [true, false]) {
      const h = harness({ status: 'ready' }, sendSuccess)
      h.message({ type: 'user', message: { content: 'Operator task' } })
      h.message({ type: 'result', uuid: 'failed-turn', subtype: 'error_during_execution', is_error: true })
      const id = 'a:failed-turn:result'
      const ready = (activeTurn: boolean, inputEnabled: boolean) => h.frame({ kind: 'ready', payload: { activeTurn, inputEnabled, pendingPermissionRequests: [], abort: { status: 'idle' } } })
      ready(true, false); expect(h.coordinator.retry('a', id)).toBe(false)
      ready(false, false); expect(h.coordinator.retry('a', id)).toBe(false)
      ready(false, true); expect(h.coordinator.retry('a', id)).toBe(sendSuccess)
      expect(h.coordinator.retry('a', id)).toBe(false); expect(h.sent).toHaveLength(1)
    }
  })
})
