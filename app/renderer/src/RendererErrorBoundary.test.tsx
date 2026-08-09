/**
 * Acceptance for the 2026-08-09 black-window incident
 * (`docs/reports/2026-08-09-renderer-black-window-delivery-ack-rate-cap.md`).
 *
 * A delivery-acknowledgement batch overflowed the shared inbound rate budget and
 * threw on a React effect stack. The boundary caught it, then reported the fault
 * through the SAME spent budget, so the report threw from `componentDidCatch` —
 * which React treats as unhandled. The fallback below never rendered and the
 * whole tree unmounted to a black window.
 *
 * The invariant these tests pin: reporting a fault can fail, and the boundary
 * still holds. The suite is SSR-only (no happy-dom; adding a DOM needs sign-off,
 * see `replayBatchRender.test.tsx`), so the lifecycle is exercised directly
 * rather than by mounting a throwing child.
 */
import { expect, test } from 'bun:test'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RendererErrorBoundary } from './RendererErrorBoundary.js'

function withBridge(bridge: unknown, run: () => void): void {
  const globals = globalThis as { window?: unknown }
  const previous = globals.window
  globals.window = bridge === undefined ? undefined : { catcode: bridge }
  try {
    run()
  } finally {
    globals.window = previous
  }
}

test('a fault report rejected by the rate guard does not fail the boundary', () => {
  const boundary = new RendererErrorBoundary({ children: null })
  let attempted = false
  withBridge(
    {
      reportRendererFault(): void {
        attempted = true
        // Exactly what the preload guard raises once the shared window is spent.
        throw new Error('renderer IPC rate exceeds 120 frames per 1000ms')
      },
    },
    () => {
      expect(() => {
        boundary.componentDidCatch(new Error('overflow'), { componentStack: '' })
      }).not.toThrow()
    },
  )
  expect(attempted).toBe(true)
})

test('a missing bridge does not fail the boundary either', () => {
  const boundary = new RendererErrorBoundary({ children: null })
  withBridge(undefined, () => {
    expect(() => {
      boundary.componentDidCatch(new Error('overflow'), { componentStack: '' })
    }).not.toThrow()
  })
})

test('the failed state renders the recovery surface rather than nothing', () => {
  const boundary = new RendererErrorBoundary({ children: null })
  boundary.state = RendererErrorBoundary.getDerivedStateFromError()
  expect(boundary.state.failed).toBe(true)
  const markup = renderToStaticMarkup(boundary.render() as ReactElement)
  expect(markup).toContain('Cat Code needs to reload')
})
