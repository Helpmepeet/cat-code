import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  MAX_TOASTS,
  ToastHost,
  toastReducer,
  type Toast,
} from './ToastHost.js'

function mkToast(id: string, message = id): Toast {
  return { id, message, tone: 'default', duration: 3200 }
}

test('add enqueues a toast', () => {
  const state = toastReducer([], { type: 'add', toast: mkToast('a') })
  expect(state.map(t => t.id)).toEqual(['a'])
})

test('dismiss removes the addressed toast; an unknown id is a no-op (same ref)', () => {
  const start = [mkToast('a'), mkToast('b')]
  expect(toastReducer(start, { type: 'dismiss', id: 'a' }).map(t => t.id)).toEqual([
    'b',
  ])
  // Reference-stable no-op for a missing id (avoids a needless re-render).
  expect(toastReducer(start, { type: 'dismiss', id: 'z' })).toBe(start)
})

test('the queue is capped newest-wins (oldest dropped past MAX_TOASTS)', () => {
  let state: Toast[] = []
  for (let i = 0; i < MAX_TOASTS + 2; i += 1) {
    state = toastReducer(state, { type: 'add', toast: mkToast(`t${i}`) })
  }
  expect(state).toHaveLength(MAX_TOASTS)
  // The two oldest were dropped; the newest is retained.
  expect(state[0].id).toBe('t2')
  expect(state[state.length - 1].id).toBe(`t${MAX_TOASTS + 1}`)
})

test('ToastHost renders its children and no viewport until a toast fires', () => {
  // SSR runs no effects/timers, so no toast is ever added — the host is a
  // transparent wrapper with an empty (unrendered) viewport.
  const html = renderToStaticMarkup(
    <ToastHost>
      <div>child content</div>
    </ToastHost>,
  )
  expect(html).toContain('child content')
  expect(html).not.toContain('aria-label="Notifications"')
})
