import type { NotificationConstructorOptions } from 'electron'
import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SidecarClientMessage as ClientMessage, ServerFrame } from '../shared/protocol.js'
import type { HostEvent, SessionDescriptor } from '../shared/hostApi.js'
import type { NotificationPreferences } from '../shared/notificationPreferences.js'
import { buildAllowResponse, buildDenyResponse, type PermissionRequest } from '../renderer/src/permissionState.js'
import { buildPermissionOptions, selectPermissionPreview } from '../renderer/src/permissionPromptModel.js'
import { PLAN_APPROVE_OPTIONS } from '../renderer/src/planState.js'
import { narrowAskQuestions } from '../renderer/src/askQuestionState.js'
import { OPEN_ACCOUNTS_LABEL, RETRY_LABEL, USAGE_LIMIT_TITLE, retrySendBlocked, turnResultFailureCopy } from '../renderer/src/turnFailure.js'

import { createDesktopNotificationRetry } from './desktopNotificationRetry.js'

import { DESKTOP_NOTIFICATION_TITLES } from '../shared/notificationCopy.js'
export { DESKTOP_NOTIFICATION_TITLES } from '../shared/notificationCopy.js'

export interface DesktopNotificationHandle {
  on(event: 'click' | 'close' | 'action' | 'reply' | 'failed', listener: (...args: unknown[]) => void): unknown
  show(): void
  close(): void
}
export type DesktopNotificationDependencies = {
  getSession(id: string): SessionDescriptor | undefined
  isVisible(id: string): boolean
  isRetryBlocked?(id: string): boolean
  getPreferences(): NotificationPreferences
  createNotification(options: NotificationConstructorOptions): DesktopNotificationHandle | null
  setBadge(text: string): void
  openSession(id: string, accounts?: boolean): void
  send(id: string, message: ClientMessage): unknown
  onError?(error: unknown): void
}
type Prompt = Extract<ClientMessage, { type: 'app.submit' }>['prompt']
type Notice = { options: NotificationConstructorOptions; waiting: boolean; requestId?: string; retryResultId?: string; actions?: (() => void)[]; reply?: (text: string) => void }
type State = { pending: Map<string, PermissionRequest>; stopped: boolean; active: boolean; inputEnabled: boolean; aborted: boolean; retryFacts: ReturnType<typeof createDesktopNotificationRetry>; retryBlocked?: boolean; assistant: string; providerCode?: string; providerMessage?: string; errorStatus?: number; notice?: Notice; terminalNotice?: Notice; handle?: DesktopNotificationHandle }

const BANNER_TEXT_LIMIT = 1000
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function bannerText(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, BANNER_TEXT_LIMIT) : ''
}
function textBlocks(value: unknown): string {
  if (!Array.isArray(value)) return bannerText(value)
  let text = ''
  for (const block of value) {
    if (record(block) && block.type === 'text' && typeof block.text === 'string') {
      const separator = text ? '\n' : ''
      text += separator + block.text.slice(0, Math.max(0, BANNER_TEXT_LIMIT - text.length - separator.length))
      if (text.length >= BANNER_TEXT_LIMIT) break
    }
  }
  return text
}
/** Receives the supervisor's live feed, never the renderer's replay buffer. */
export function createDesktopNotifications(deps: DesktopNotificationDependencies) {
  const sessions = new Map<string, State>()
  let disposed = false
  let lastBadge: string | undefined
  const close = (s: State) => { const handle = s.handle; s.handle = undefined; handle?.close() }
  const badge = () => {
    let waiting = 0
    if (!disposed && deps.getPreferences().dockBadge) {
      for (const [id, s] of sessions) if ((s.pending.size || s.stopped) && deps.getSession(id)) waiting++
    }
    const text = waiting ? String(waiting) : ''
    if (text === lastBadge) return
    deps.setBadge(text)
    lastBadge = text
  }
  const clear = (s: State) => { close(s); s.notice = undefined; s.terminalNotice = undefined }
  const submit = (id: string, prompt: Prompt) => deps.send(id, { type: 'app.submit', requestId: randomUUID(), prompt })
  function retry(id: string, resultId: string): boolean {
    const s = sessions.get(id)
    const session = deps.getSession(id)
    if (disposed || !s || !session || s.aborted || deps.isRetryBlocked?.(id) || retrySendBlocked({ status: session.status, inputEnabled: s.inputEnabled }, !s.active) || s.active) return false
    const candidate = s.retryFacts.claim(resultId)
    if (!candidate) return false
    clear(s)
    try { return submit(id, candidate.text) !== false }
    catch (error) { deps.onError?.(error); return false }
  }
  function show(id: string, s: State, notice: Notice, quiet = false) {
    clear(s)
    s.notice = notice
    s.retryBlocked = !!notice.retryResultId && deps.isRetryBlocked?.(id) === true
    const actions = s.retryBlocked ? [] : notice.actions
    const prefs = deps.getPreferences()
    if (disposed || deps.isVisible(id) || prefs.notify === 'off' || (prefs.notify === 'waiting' && !notice.waiting)) return
    const session = deps.getSession(id)
    if (!session) return
    let handle: DesktopNotificationHandle | null
    try {
      const project = session.binding?.kind === 'managed' ? 'Chats' : basename(session.cwd)
      handle = deps.createNotification({ ...notice.options, ...(s.retryBlocked ? { actions: [] } : {}), body: bannerText(notice.options.body), subtitle: `${project} · ${session.title ?? session.name ?? 'Cat Code'}`, silent: quiet || !notice.waiting })
    } catch (error) { deps.onError?.(error); return }
    if (!handle) return
    s.handle = handle
    const valid = () => !disposed && sessions.get(id) === s && s.handle === handle && s.notice === notice && !!deps.getSession(id) && (!notice.requestId || s.pending.has(notice.requestId))
    const consume = (action: () => void) => { if (!valid()) return; clear(s); action() }
    handle.on('click', () => consume(() => deps.openSession(id)))
    handle.on('action', (_event, index) => { if (typeof index === 'number' && Number.isInteger(index) && index >= 0 && actions?.[index]) consume(actions[index]!) })
    handle.on('reply', (_event, text) => { if (typeof text === 'string' && text.trim() && notice.reply) consume(() => notice.reply!(text.trim())) })
    handle.on('close', () => { if (s.handle === handle) s.handle = undefined })
    handle.on('failed', (_event, error) => { if (s.handle === handle) close(s); deps.onError?.(error) })
    try { handle.show() } catch (error) { close(s); deps.onError?.(error) }
  }
  function permission(id: string, s: State, request: PermissionRequest) {
    const { requestId, request: input } = request
    const answer = (response: ReturnType<typeof buildAllowResponse> | ReturnType<typeof buildDenyResponse>) => deps.send(id, { type: 'permission.response', requestId, response: response.behavior === 'allow' ? { ...response, updatedInput: {} } : response })
    let title: string = DESKTOP_NOTIFICATION_TITLES.approval
    let body = input.tool_name
    let actions: (() => void)[] = []
    let labels: string[] = []
    let reply: Notice['reply']
    if (input.tool_name === 'AskUserQuestion') {
      title = DESKTOP_NOTIFICATION_TITLES.question
      const questions = narrowAskQuestions(input.input)
      body = questions.map(q => q.question).join('\n')
      // Narrowing must not turn a malformed multi-question request into a partial answer.
      if (questions.length === 1 && Array.isArray(input.input.questions) && input.input.questions.length === 1 && !questions[0]!.multiSelect) {
        labels = questions[0]!.options.map(o => o.label)
        actions = labels.map((_, index) => () => deps.send(id, { type: 'askUserQuestion.answer', requestId, answers: [{ optionIndices: [index] }] }))
        reply = text => deps.send(id, { type: 'askUserQuestion.answer', requestId, answers: [{ optionIndices: [], other: text }] })
      }
    } else if (input.tool_name === 'ExitPlanMode') {
      title = DESKTOP_NOTIFICATION_TITLES.plan
      body = typeof input.input.plan === 'string' ? input.input.plan : ''
      labels = PLAN_APPROVE_OPTIONS.map(o => o.label)
      actions = PLAN_APPROVE_OPTIONS.map((_, optionIndex) => () => deps.send(id, { type: 'notification.planApprove', requestId, optionIndex }))
    } else {
      const preview = selectPermissionPreview(input.tool_name, input.input)
      body = preview ? preview.kind === 'field' ? preview.value : preview.path : input.tool_name
      const options = buildPermissionOptions(input)
      labels = options.map(o => o.pre + (o.code ?? '') + (o.post ?? ''))
      actions = options.map(o => () => answer(o.effect === 'deny' ? buildDenyResponse() : buildAllowResponse(request, o.suggestionIndex === undefined ? [] : [o.suggestionIndex])))
    }
    show(id, s, { requestId, waiting: true, options: { title, body, actions: labels.map(text => ({ type: 'button', text })), hasReply: !!reply, ...(reply ? { replyPlaceholder: 'Other answer' } : {}) }, actions, reply })
  }
  function terminal(id: string, s: State, notice: Notice) {
    // Result precedes turn closure. Do not make Retry or follow-up submission
    // available while the controller would still queue it into the old turn.
    if (s.active) s.terminalNotice = notice
    else show(id, s, notice)
  }
  function receive(id: string, frame: ServerFrame) {
    if (disposed || !deps.getSession(id)) return
    let s = sessions.get(id)
    if (!s) { s = { pending: new Map(), stopped: false, active: false, inputEnabled: true, aborted: false, retryFacts: createDesktopNotificationRetry(), assistant: '' }; sessions.set(id, s) }
    if (frame.kind === 'event' && frame.replay) {
      if (frame.event.type === 'message' && record(frame.event.message)) s.retryFacts.observe(frame)
      return
    }
    if (frame.kind === 'transcript.reset') {
      clear(s)
      s.stopped = false
      s.retryFacts.reset(false)
      s.assistant = ''
      s.providerCode = undefined
      s.providerMessage = undefined
      s.errorStatus = undefined
    } else if (frame.kind === 'ready') {
      s.pending = new Map(frame.payload.pendingPermissionRequests.map(r => [r.requestId, r]))
      if (!s.notice?.requestId || !s.pending.has(s.notice.requestId)) clear(s)
      s.active = frame.payload.activeTurn
      s.inputEnabled = frame.payload.inputEnabled
      if (s.active) s.stopped = false
      s.aborted = frame.payload.abort.status !== 'idle'
    } else if (frame.kind === 'lifecycle') {
      clear(s); sessions.delete(id)
    } else if (frame.kind === 'event') {
      const event = frame.event
      if (event.type === 'permission.requested') { s.pending.set(event.request.requestId, event.request); permission(id, s, event.request) }
      else if (event.type === 'permission.resolved') { s.pending.delete(event.request.requestId); if (s.notice?.requestId === event.request.requestId) clear(s) }
      else if (event.type === 'abort.status' && event.abort.status !== 'idle') { s.aborted = true; clear(s); s.stopped = false }
      else if (event.type === 'turn.status') {
        const freshTurn = event.activeTurn && !s.active
        s.active = event.activeTurn
        s.inputEnabled = !event.activeTurn
        if (freshTurn) { clear(s); s.stopped = false; s.aborted = false; s.retryFacts.startTurn(); s.assistant = ''; s.providerCode = undefined; s.providerMessage = undefined; s.errorStatus = undefined }
        else if (!event.activeTurn && s.terminalNotice) {
          const notice = s.terminalNotice
          show(id, s, notice)
        }
      } else if (event.type === 'message') {
        // Only bounded banner text and the latest turn's retry facts are retained.
        const m: unknown = event.message
        if (!record(m) || m.parent_tool_use_id || m.isReplay) return
        const content = record(m.message) ? m.message.content : undefined
        const projected = s.retryFacts.observe(frame, s.active)
        if (m.type === 'assistant') {
          const text = textBlocks(content)
          if (text) s.assistant = text
          if (typeof m.error === 'string') { s.providerCode = bannerText(m.error); s.providerMessage = text }
          else if (projected?.length) s.errorStatus = undefined
        }
        if (m.type === 'stream_event' && record(m.event) && m.event.type === 'content_block_delta' &&
          record(m.event.delta) && m.event.delta.type === 'text_delta' &&
          typeof m.event.delta.text === 'string' && m.event.delta.text.length > 0) s.errorStatus = undefined
        if (m.type === 'system' && m.subtype === 'api_retry' && typeof m.error_status === 'number') s.errorStatus = m.error_status
        if (m.type === 'result' && typeof m.subtype === 'string' && typeof m.is_error === 'boolean') {
          clear(s)
          if (s.aborted || ['interrupted', 'handoff', 'aborted'].includes(m.subtype)) { s.stopped = false; badge(); return }
          if (m.is_error || m.subtype !== 'success') {
            s.stopped = true
            const copy = turnResultFailureCopy({ subtype: m.subtype, providerCode: s.providerCode, providerMessage: s.providerMessage, errorStatus: s.errorStatus, durationMs: typeof m.duration_ms === 'number' ? m.duration_ms : undefined, totalCostUsd: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : undefined })
            const candidate = s.retryFacts.candidate()
            const accounts = copy.title === USAGE_LIMIT_TITLE
            terminal(id, s, { waiting: true, ...(candidate && !accounts ? { retryResultId: candidate.resultId } : {}), options: { title: copy.title, body: copy.detail, actions: accounts || candidate ? [{ type: 'button', text: accounts ? OPEN_ACCOUNTS_LABEL : RETRY_LABEL }] : [] }, actions: accounts ? [() => deps.openSession(id, true)] : candidate ? [() => { if (!retry(id, candidate.resultId)) deps.openSession(id) }] : [] })
          } else {
            s.stopped = false
            const duration = typeof m.duration_ms === 'number' && Number.isFinite(m.duration_ms) && m.duration_ms >= 0 ? `${Math.round(m.duration_ms / 1000)}s · ` : ''
            terminal(id, s, { waiting: false, options: { title: DESKTOP_NOTIFICATION_TITLES.finished, body: duration + (s.assistant || bannerText(m.result)), hasReply: true, replyPlaceholder: 'Reply' }, reply: text => submit(id, text) })
          }
        }
      }
    }
    badge()
  }
  return {
    receive,
    retry,
    retryBlockedChanged() {
      for (const [id, s] of sessions) {
        if (s.handle && s.notice?.retryResultId && s.retryBlocked !== (deps.isRetryBlocked?.(id) === true)) {
          show(id, s, s.notice, true)
        }
      }
    },
    receiveHostEvent(event: HostEvent) {
      if (event.type === 'session-removed' || (event.type === 'session-status' && (event.session.parked || event.session.status === 'spawning' || event.session.status === 'exited' || event.session.status === 'disconnected'))) {
        const id = event.type === 'session-removed' ? event.appSessionId : event.session.appSessionId
        const s = sessions.get(id); if (s) clear(s); sessions.delete(id); badge()
      }
    },
    visibilityChanged() { for (const [id, s] of sessions) if (deps.isVisible(id)) close(s); badge() },
    preferencesChanged() { for (const s of sessions.values()) if (deps.getPreferences().notify === 'off' || (deps.getPreferences().notify === 'waiting' && !s.notice?.waiting)) close(s); badge() },
    dispose() { disposed = true; for (const s of sessions.values()) clear(s); sessions.clear(); badge() },
  }
}
