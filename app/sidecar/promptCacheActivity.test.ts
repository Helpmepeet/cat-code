import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getSessionProvider, setSessionProvider } from '../../src/bootstrap/state.js'
import type { AppSessionEvent } from '../../src/app-runtime/sessionEvents.js'
import { EMPTY_USAGE } from '../../src/services/api/logging.js'
import { getDefaultAppState, type AppState } from '../../src/state/AppStateStore.js'
import { createStore } from '../../src/state/store.js'
import type { AssistantMessage, Message } from '../../src/types/message.js'
import type { RunControlsSnapshot } from '../shared/protocol.js'
import { CODEX_CACHE_IDLE_ESTIMATE_MS } from '../shared/promptCacheEstimate.js'
import { SDK_MESSAGE_FIXTURE } from '../renderer/src/sdkMessageFixtures.js'
import { createSidecarRunControlsDomain } from './runControlsDomain.js'

const MODEL = 'gpt-6.1-sol'
const AT = Date.parse('2026-10-08T08:00:00.000Z')
let previousProvider: ReturnType<typeof getSessionProvider>
beforeEach(() => { previousProvider = getSessionProvider(); setSessionProvider('openai') })
afterEach(() => setSessionProvider(previousProvider))

function snapshot(state: AppState): RunControlsSnapshot {
  const model = state.mainLoopModel ?? MODEL
  return {
    model: { current: model, currentLabel: model, contextWindow: 200_000,
      selected: model, provider: 'openai', providerSwitchLocked: true,
      options: [] },
    effort: { current: 'high', selected: 'high', supported: true, options: ['high'] },
    fast: { active: false, supportedByModel: false, available: false, unavailableReason: null },
    autoCompact: { enabled: true, threshold: 187_000, warningThreshold: 167_000 },
  }
}

function response(model = MODEL, parent: string | null = null): AppSessionEvent {
  const fixture = SDK_MESSAGE_FIXTURE.assistant[0]!.message
  return { type: 'message', message: { ...fixture, parent_tool_use_id: parent,
    message: { ...fixture.message, model, usage: { input_tokens: 2_000, output_tokens: 2, service_tier: null } } } }
}

function stream(event: typeof SDK_MESSAGE_FIXTURE.stream_event[number]['message']['event']): AppSessionEvent {
  return { type: 'message', message: { ...SDK_MESSAGE_FIXTURE.stream_event[0]!.message, event } }
}

function historical(at: number, model = MODEL): AssistantMessage {
  return { type: 'assistant', uuid: 'historical-response', timestamp: new Date(at).toISOString(),
    message: { model, content: [], usage: { ...EMPTY_USAGE, input_tokens: 2_000 } } }
}

function setup(initialMessages: Message[] = [], initialCacheObservation?: { model: string; expiresAt: number }) {
  let now = AT
  const store = createStore<AppState>({ ...getDefaultAppState(), mainLoopModel: MODEL })
  const domain = createSidecarRunControlsDomain(store, {
    buildSnapshot: snapshot, initialMessages, initialCacheObservation, now: () => now,
  })
  return { domain, store, advance: (at: number) => { now = at } }
}

test('an old restored API response is already estimated expired without a new request', () => {
  const old = AT - CODEX_CACHE_IDLE_ESTIMATE_MS - 1
  const { domain } = setup([historical(old)])
  expect(domain.getSnapshot().cacheExpiresAt).toBe(AT - 1)
  expect(domain.getSnapshot().cacheExpired).toBe(true)
})

test('validated transcript diagnostics seed a zero-usage restore without borrowing another model', () => {
  const early = { ...historical(AT - CODEX_CACHE_IDLE_ESTIMATE_MS - 1),
    message: { ...historical(AT).message, usage: EMPTY_USAGE } }
  const observation = { model: MODEL, expiresAt: AT - 1 }
  expect(setup([early], observation).domain.getSnapshot().cacheExpired).toBe(true)
  expect(setup([early], { ...observation, model: 'gpt-6-luna' }).domain.getSnapshot().cacheExpiresAt).toBeNull()
  expect(setup([historical(AT)], observation).domain.getSnapshot().cacheExpired).toBe(false)
})

test('real main-thread assistant activity warms the estimate and re-emits it', () => {
  const { domain, advance } = setup([historical(AT - CODEX_CACHE_IDLE_ESTIMATE_MS - 1)])
  let notifications = 0
  const unsubscribe = domain.subscribe(() => { notifications++ })
  domain.observeSessionEvent!(response())
  expect(notifications).toBe(1)
  expect(domain.getSnapshot().cacheExpired).toBe(false)
  expect(domain.getSnapshot().cacheExpiresAt).toBe(AT + CODEX_CACHE_IDLE_ESTIMATE_MS)
  advance(AT + CODEX_CACHE_IDLE_ESTIMATE_MS)
  expect(domain.getSnapshot().cacheExpired).toBe(true)
  unsubscribe()
})

test('subagent traffic is ignored, but an ineligible completed main response leaves expiry unknown', () => {
  const { domain } = setup([historical(AT - CODEX_CACHE_IDLE_ESTIMATE_MS - 1)])
  domain.observeSessionEvent!(response(MODEL, 'child-tool'))
  expect(domain.getSnapshot().cacheExpired).toBe(true)
  const short = response()
  if (short.type === 'message' && short.message.type === 'assistant') short.message.message.usage = { input_tokens: 20 }
  domain.observeSessionEvent!(short)
  domain.observeSessionEvent!({ type: 'turn.status', activeTurn: false })
  expect(domain.getSnapshot().cacheExpired).toBeNull()
})

test('a main response on a different model cannot leave the old model warning', () => {
  const { domain } = setup([historical(AT - CODEX_CACHE_IDLE_ESTIMATE_MS - 1)])
  domain.observeSessionEvent!(response('gpt-6-luna'))
  expect(domain.getSnapshot().cacheExpiresAt).toBeNull()
})

test('Codex zero early usage is replaced by final stream usage, warming an expired session', () => {
  const { domain } = setup([historical(AT - CODEX_CACHE_IDLE_ESTIMATE_MS - 1)])
  domain.observeSessionEvent!(stream({ type: 'message_start', message: {
    id: 'msg-cache', type: 'message', role: 'assistant', model: MODEL, content: [],
    stop_reason: null, stop_sequence: null, usage: EMPTY_USAGE,
  } }))
  const early = response()
  if (early.type === 'message' && early.message.type === 'assistant') early.message.message.usage = { input_tokens: 0 }
  domain.observeSessionEvent!(early)
  expect(domain.getSnapshot().cacheExpired).toBe(true)
  domain.observeSessionEvent!(stream({
    type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { input_tokens: 200, cache_read_input_tokens: 2_000, output_tokens: 4 },
  }))
  domain.observeSessionEvent!(stream({ type: 'message_stop' }))
  expect(domain.getSnapshot().cacheExpired).toBe(false)
  expect(domain.getSnapshot().cacheExpiresAt).toBe(AT + CODEX_CACHE_IDLE_ESTIMATE_MS)
})

test('model/effort changes and an account invalidation clear the old estimate', () => {
  const { domain, store } = setup([historical(AT - CODEX_CACHE_IDLE_ESTIMATE_MS - 1)])
  const unsubscribe = domain.subscribe(() => {})
  store.setState(state => ({ ...state, effortValue: 'low' }))
  expect(domain.getSnapshot().cacheExpiresAt).toBeNull()
  domain.observeSessionEvent!(response())
  domain.clearCacheEstimate!()
  expect(domain.getSnapshot().cacheExpiresAt).toBeNull()
  domain.observeSessionEvent!(response())
  store.setState(state => ({ ...state, mainLoopModel: 'gpt-6-luna' }))
  expect(domain.getSnapshot().cacheExpiresAt).toBeNull()
  unsubscribe()
})

test('missing, future, error and wrong-model history leaves expiry unknown', () => {
  for (const initial of [[], [historical(AT + 1)], [historical(AT, 'gpt-6-luna')],
    [{ ...historical(AT), isApiErrorMessage: true }], [{ ...historical(AT), timestamp: undefined }]]) {
    expect(setup(initial as Message[]).domain.getSnapshot().cacheExpiresAt).toBeNull()
  }
})

test('a newer unusable response does not borrow the older response deadline', () => {
  const old = historical(AT - CODEX_CACHE_IDLE_ESTIMATE_MS - 1)
  expect(setup([old, { ...historical(AT), timestamp: undefined }]).domain.getSnapshot().cacheExpired).toBeNull()
  expect(setup([old, historical(AT, 'gpt-6-luna')]).domain.getSnapshot().cacheExpired).toBeNull()
})

test('compaction-preserved history cannot seed a new prefix, but a new response can', () => {
  const old = historical(AT - CODEX_CACHE_IDLE_ESTIMATE_MS - 1)
  const boundary: Message = {
    type: 'system', subtype: 'compact_boundary', uuid: 'boundary', timestamp: new Date(AT).toISOString(),
    content: 'compacted', level: 'info',
    compactMetadata: { preservedSegment: { headUuid: old.uuid, anchorUuid: old.uuid, tailUuid: old.uuid } },
  }
  expect(setup([old, boundary, old]).domain.getSnapshot().cacheExpiresAt).toBeNull()
  expect(setup([old, boundary, old, { ...historical(AT), uuid: 'new-api' }]).domain.getSnapshot().cacheExpired).toBe(false)
})

test.each(['effort', 'account', 'compaction'])('an invalidated %s request cannot renew from late assistant or terminal frames', reason => {
  const { domain, store } = setup([historical(AT - CODEX_CACHE_IDLE_ESTIMATE_MS - 1)])
  const unsubscribe = domain.subscribe(() => {})
  domain.observeSessionEvent!(stream({ type: 'message_start', message: { model: MODEL, usage: EMPTY_USAGE } }))
  if (reason === 'effort') store.setState(state => ({ ...state, effortValue: 'low' }))
  else if (reason === 'account') domain.clearCacheEstimate!()
  else domain.observeSessionEvent!({ type: 'message', message: { type: 'system', subtype: 'compact_boundary' } } as AppSessionEvent)
  domain.observeSessionEvent!(response())
  domain.observeSessionEvent!(stream({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 2_000 } }))
  domain.observeSessionEvent!(stream({ type: 'message_stop' }))
  expect(domain.getSnapshot().cacheExpiresAt).toBeNull()
  domain.observeSessionEvent!(stream({ type: 'message_start', message: { model: MODEL, usage: EMPTY_USAGE } }))
  domain.observeSessionEvent!(stream({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 2_000 } }))
  expect(domain.getSnapshot().cacheExpired).toBe(false)
  unsubscribe()
})

test.each([undefined, 0, 20, -1])('terminal usage %s cannot retain a superseded deadline', input_tokens => {
  const { domain } = setup([historical(AT - CODEX_CACHE_IDLE_ESTIMATE_MS - 1)])
  domain.observeSessionEvent!(stream({ type: 'message_start', message: { model: MODEL, usage: EMPTY_USAGE } }))
  domain.observeSessionEvent!(stream({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens } }))
  domain.observeSessionEvent!(stream({ type: 'message_stop' }))
  expect(domain.getSnapshot().cacheExpiresAt).toBeNull()
})

test('the account command auth refresh invalidates the estimate without a model change', () => {
  const { domain, store } = setup([historical(AT - CODEX_CACHE_IDLE_ESTIMATE_MS - 1)])
  const unsubscribe = domain.subscribe(() => {})
  store.setState(state => ({ ...state, authVersion: state.authVersion + 1 }))
  expect(domain.getSnapshot().cacheExpiresAt).toBeNull()
  unsubscribe()
})

test('a canonical unknown seed cannot be overridden by older initial-message evidence', () => {
  const store = createStore<AppState>({ ...getDefaultAppState(), mainLoopModel: MODEL })
  const domain = createSidecarRunControlsDomain(store, {
    buildSnapshot: snapshot,
    initialMessages: [historical(AT - CODEX_CACHE_IDLE_ESTIMATE_MS - 1)],
    initialCacheObservation: null,
    now: () => AT,
  })
  expect(domain.getSnapshot().cacheExpiresAt).toBeNull()
})

test('a cached Claude observation cannot bypass the custom-endpoint guard', () => {
  const previousUrl = process.env.ANTHROPIC_BASE_URL
  setSessionProvider('firstParty')
  process.env.ANTHROPIC_BASE_URL = 'https://cache-policy-unknown.invalid'
  try {
    const model = 'claude-sonnet-4-6'
    const store = createStore<AppState>({ ...getDefaultAppState(), mainLoopModel: model })
    const domain = createSidecarRunControlsDomain(store, {
      buildSnapshot: snapshot, initialCacheObservation: { model, expiresAt: AT - 1 },
    })
    expect(domain.getSnapshot().cacheExpiresAt).toBeNull()
  } finally {
    if (previousUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = previousUrl
  }
})
