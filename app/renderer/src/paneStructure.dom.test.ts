/**
 * Structural claims about the session pane that a string can only imply.
 *
 * The renderer's other suites are `renderToStaticMarkup`, so all they can see
 * is the ORDER of substrings in one flat document. That is enough to say the
 * waiting-message block is drawn between the scroller and the dock, and not
 * enough to say it is INSIDE the scroller — a band rendered as a sibling of the
 * scroller, one flex level up, satisfies every index comparison while
 * recreating the full-width dead band the D1a placement exists to delete
 * (demonstrated by mutation, 2026-08-26). Containment is a parent-child fact,
 * so it is asserted against a real parent and a real child.
 *
 * No JSX, and no component export: `renderer/src` `.tsx` files are governed by
 * the Fast Refresh component-boundary rule (`lint:fast-refresh`), which a test
 * module has no business tripping. `createElement` keeps this file `.ts`, the
 * way `proseArrivalPreview.dom.test.ts` does.
 *
 * What this file still cannot see: happy-dom has no layout engine, so
 * `getBoundingClientRect` is zeros and `scrollHeight`/`clientHeight` are never
 * computed. Anything about PIXELS — the size of the band, where the bubble's
 * right edge lands — is an operator observation against a real build, not a
 * test. The scroll assertions below stub those two numbers precisely because
 * the engine that would supply them does not exist here.
 */

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { createElement } from 'react'
import { createDomTestHarness } from './domTestHarness.js'
import type { DomTestHarness } from './domTestHarness.js'
import { SessionPane } from './SessionPane.js'
import { idleSessionPaneProps } from './sessionPaneTestProps.js'
import { createTranscriptState, projectServerFrame } from './transcriptProjector.js'
import { PROTOCOL_VERSION } from '../../shared/protocol.js'
import type { ServerFrame, SessionId } from '../../shared/protocol.js'
import type { SDKMessage } from '@cat-code/engine/session-events'

let harness: DomTestHarness

beforeAll(async () => {
  harness = await createDomTestHarness()
})

afterEach(async () => {
  await harness.unmountAll()
})

afterAll(async () => {
  await harness.teardown()
})

const SESSION: SessionId = 'session-1'

/** Two delivered rows, so the row column and the waiting block are siblings. */
function transcriptWithRows() {
  const frames: ServerFrame[] = [
    {
      kind: 'ready',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      engineSessionId: 'engine-session-1',
      payload: {
        type: 'app.ready',
        protocolVersion: PROTOCOL_VERSION,
        inputEnabled: true,
        activeTurn: false,
        abort: { status: 'idle' },
        goalSnapshot: null,
        pendingPermissionRequests: [],
      },
    },
    {
      kind: 'event',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      event: {
        type: 'message',
        message: {
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: 'delivered one' }] },
          uuid: '00000000-0000-4000-8000-0000000000a1',
        } as unknown as SDKMessage,
      },
    } as ServerFrame,
    {
      kind: 'event',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      event: {
        type: 'message',
        message: {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'delivered two' }] },
          uuid: '00000000-0000-4000-8000-0000000000a2',
        } as unknown as SDKMessage,
      },
    } as ServerFrame,
  ]
  return frames.reduce(projectServerFrame, createTranscriptState())
}

function paneWithWaiting(overrides: Record<string, unknown> = {}) {
  return createElement(SessionPane, {
    ...idleSessionPaneProps(),
    activeSessionId: SESSION,
    activeConnection: { status: 'ready', inputEnabled: false },
    transcript: transcriptWithRows(),
    queuedPrompts: [{ id: 'q-1', text: 'waiting one' }],
    onRecallQueuedPrompts: () => {},
    ...overrides,
  } as never)
}

function scrollerOf(container: HTMLElement): HTMLElement {
  const scroller = container.querySelector('.overflow-auto')
  if (!(scroller instanceof HTMLElement)) {
    throw new Error('no transcript scroller in the mounted pane')
  }
  return scroller
}

function waitingBlockOf(container: HTMLElement): HTMLElement {
  for (const node of container.querySelectorAll('div')) {
    if (!(node instanceof HTMLElement)) continue
    if (node.className.includes('items-end') && node.textContent?.includes('waiting one')) {
      return node
    }
  }
  throw new Error('no waiting-message block in the mounted pane')
}

/** Installs layout numbers happy-dom does not compute. Returns the undo. */
function stubScrollGeometry(values: {
  scrollHeight: number
  clientHeight: number
}): () => void {
  const proto = globalThis.HTMLElement.prototype
  const previous = {
    scrollHeight: Object.getOwnPropertyDescriptor(proto, 'scrollHeight'),
    clientHeight: Object.getOwnPropertyDescriptor(proto, 'clientHeight'),
  }
  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get: () => values.scrollHeight,
  })
  Object.defineProperty(proto, 'clientHeight', {
    configurable: true,
    get: () => values.clientHeight,
  })
  return () => {
    for (const key of ['scrollHeight', 'clientHeight'] as const) {
      const descriptor = previous[key]
      if (descriptor) Object.defineProperty(proto, key, descriptor)
      else delete (proto as unknown as Record<string, unknown>)[key]
    }
  }
}

test('the waiting-message block is a child of the transcript scroller, after the rows', async () => {
  const { container } = await harness.mount(paneWithWaiting())
  const scroller = scrollerOf(container)
  const block = waitingBlockOf(container)

  // Containment, not order. This is the assertion the SSR tests cannot make,
  // and the one that fails when the block is lifted out to a sibling band.
  expect(scroller.contains(block)).toBe(true)
  expect(block.parentElement).toBe(scroller)

  // And it trails the rows: `readTranscriptRowGeometry` reads the scroller's
  // FIRST element child as the row list, so the block must never be it.
  expect(scroller.firstElementChild).not.toBe(block)
  const rows = scroller.firstElementChild
  expect(rows?.textContent).toContain('delivered two')
  expect(rows?.textContent).not.toContain('waiting one')
})

test('a pane that opens on a remembered row stays there, with messages waiting', async () => {
  // The pane runs two scroll effects on mount: the restore (which places the
  // reader on the remembered row and reports "not at the bottom") and the
  // stick-to-bottom re-pin. They run in declaration order in ONE flush, so the
  // re-pin's `atBottom` is still the mount-time `true` unless it reads the ref
  // the restore has already written. Reading state instead threw the reader to
  // the end of the transcript every time a pane was bound.
  // happy-dom computes no layout, so the two numbers both effects read have to
  // be supplied, and they have to exist DURING the mount flush — which is why
  // they are installed on the prototype rather than on an element that does not
  // exist yet. A 1000px document in a 400px viewport: the restore lands at the
  // anchor row, a re-pin lands at 1000. Without them `scrollHeight` is 0 and
  // both outcomes are 0, which is a test that cannot fail.
  const restore = stubScrollGeometry({ scrollHeight: 1000, clientHeight: 400 })
  try {
    const { container } = await harness.mount(
      paneWithWaiting({
        scrollAnchor: {
          kind: 'row',
          rowKey: `${SESSION}:00000000-0000-4000-8000-0000000000a1:0:user-text`,
          offsetIntoRow: 0,
        },
      }),
    )
    expect(scrollerOf(container).scrollTop).not.toBe(1000)
  } finally {
    restore()
  }
})
