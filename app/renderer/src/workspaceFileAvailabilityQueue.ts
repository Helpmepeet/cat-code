import { useCallback, useEffect, useSyncExternalStore } from 'react'

const MAX_CONCURRENT = 4
const MAX_CHAT_PATHS = 2_000
const MAX_CHATS = 2_000
const listeners = new Set<() => void>()
const pathListeners = new Map<string, Set<() => void>>()
type Entry = { value?: boolean; generation: number; pending?: Promise<boolean | null> }
type Chat = { paths: Map<string, Entry>; writes: Set<string> }
const chats = new Map<string, Chat>()
let running = 0
const waiting: Array<() => void> = []

function chatFor(sessionId: string): Chat {
  let chat = chats.get(sessionId)
  if (!chat) {
    chat = { paths: new Map(), writes: new Set() }
    chats.set(sessionId, chat)
    if (chats.size > MAX_CHATS) chats.delete(chats.keys().next().value!)
  }
  return chat
}
function entryFor(sessionId: string, path: string): Entry | null {
  const chat = chatFor(sessionId)
  let entry = chat.paths.get(path)
  if (!entry) {
    if (chat.paths.size >= MAX_CHAT_PATHS) {
      const oldest = [...chat.paths].find(([, value]) => !value.pending)?.[0]
      if (oldest === undefined) return null
      chat.paths.delete(oldest)
    }
    entry = { generation: 0 }
    chat.paths.set(path, entry)
  }
  return entry
}
function emit(sessionId: string, path?: string): void {
  for (const listener of listeners) listener()
  if (path !== undefined) {
    for (const listener of pathListeners.get(`${sessionId}\0${path}`) ?? []) listener()
  } else {
    for (const [key, subscribed] of pathListeners) if (key.startsWith(`${sessionId}\0`)) {
      for (const listener of subscribed) listener()
    }
  }
}
export function subscribeWorkspaceFileAvailability(listener: () => void, sessionId?: string, path?: string): () => void {
  if (sessionId === undefined || path === undefined) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  const key = `${sessionId}\0${path}`
  let subscribed = pathListeners.get(key)
  if (!subscribed) { subscribed = new Set(); pathListeners.set(key, subscribed) }
  subscribed.add(listener)
  return () => {
    subscribed.delete(listener)
    if (subscribed.size === 0) pathListeners.delete(key)
  }
}
export function peekWorkspaceFileAvailability(sessionId: string, path: string): boolean | undefined {
  return chats.get(sessionId)?.paths.get(path)?.value
}

/** All renderer availability consumers share admission; busy is never absence. */
export function requestWorkspaceFileAvailability(
  sessionId: string,
  path: string,
  options: { fresh?: boolean } = {},
): Promise<boolean | null> {
  const cached = chats.get(sessionId)?.paths.get(path)
  if (cached?.pending) return cached.pending
  if (!options.fresh && cached?.value !== undefined) return Promise.resolve(cached.value)
  if (waiting.length >= MAX_CHAT_PATHS) return Promise.resolve(null)
  const entry = entryFor(sessionId, path)
  if (!entry) return Promise.resolve(null)
  const generation = entry.generation
  entry.pending = (async () => {
    if (running >= MAX_CONCURRENT) await new Promise<void>(resolve => waiting.push(resolve))
    else running++
    await Promise.resolve()
    try {
      if (generation !== entry.generation) return null
      const result = await window.catcode.checkWorkspaceFileAvailability(sessionId, path)
      const value = result === 'available' ? true : result === 'missing' ? false : null
      if (generation !== entry.generation) return null
      if (value !== null) entry.value = value
      return value
    } catch { return null }
    finally {
      entry.pending = undefined
      const next = waiting.shift()
      if (next) next()
      else running--
      emit(sessionId, path)
    }
  })()
  return entry.pending
}

export function invalidateWorkspaceFileAvailability(sessionId: string, path: string): void {
  const entry = chats.get(sessionId)?.paths.get(path)
  if (!entry || entry.value === true) return
  entry.value = undefined
  entry.generation++
  emit(sessionId, path)
}

/** A pending and a completed write each invalidate once, even across pane remounts. */
export function recordWorkspaceFileWrite(sessionId: string, path: string, version: string): void {
  const chat = chatFor(sessionId)
  const key = `${version}\0${path}`
  if (chat.writes.has(key)) return
  chat.writes.add(key)
  if (chat.writes.size > MAX_CHAT_PATHS) chat.writes.delete(chat.writes.keys().next().value!)
  invalidateWorkspaceFileAvailability(sessionId, path)
}

export function disposeWorkspaceFileAvailability(sessionId: string): void {
  const chat = chats.get(sessionId)
  if (!chat) return
  for (const entry of chat.paths.values()) entry.generation++
  chats.delete(sessionId)
  emit(sessionId)
}

export function useWorkspaceFileAvailability(sessionId: string, path: string | null, enabled = true): boolean | undefined {
  const subscribe = useCallback((listener: () => void) => enabled && path !== null
    ? subscribeWorkspaceFileAvailability(listener, sessionId, path) : () => {}, [enabled, sessionId, path])
  const snapshot = useCallback(() => path === null ? undefined : peekWorkspaceFileAvailability(sessionId, path), [sessionId, path])
  const value = useSyncExternalStore(subscribe, snapshot, snapshot)
  useEffect(() => {
    if (!enabled || path === null || value !== undefined) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = () => {
      void requestWorkspaceFileAvailability(sessionId, path).then(result => {
        if (active && result === null) timer = setTimeout(check, 500)
      })
    }
    check()
    return () => { active = false; clearTimeout(timer) }
  }, [enabled, sessionId, path, value])
  return value
}
