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
 * still holds. The reporter is now INJECTED (`onFault`) rather than reached for
 * through the bridge, so a throwing reporter is the direct expression of that
 * incident; a missing bridge is the `main.tsx` call site's concern. The suite is
 * SSR-only (no happy-dom; adding a DOM needs sign-off, see
 * `replayBatchRender.test.tsx`), so the lifecycle is exercised directly rather
 * than by mounting a throwing child.
 */
import { expect, test } from 'bun:test'
import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  RendererErrorBoundary,
  type RendererErrorBoundaryProps,
  type RendererErrorBoundaryState,
  type RendererFault,
} from './RendererErrorBoundary.js'

/** `setState` outside a real mount is a no-op, so apply it directly. */
class MountedRendererErrorBoundary extends RendererErrorBoundary {
  override setState<K extends keyof RendererErrorBoundaryState>(
    nextState:
      | RendererErrorBoundaryState
      | Pick<RendererErrorBoundaryState, K>
      | null
      | ((
          previous: Readonly<RendererErrorBoundaryState>,
          props: Readonly<RendererErrorBoundaryProps>,
        ) =>
          | RendererErrorBoundaryState
          | Pick<RendererErrorBoundaryState, K>
          | null),
    callback?: () => void,
  ): void {
    const update =
      typeof nextState === 'function'
        ? nextState(this.state, this.props)
        : nextState
    if (update) this.state = { ...this.state, ...update }
    callback?.()
  }
}

test('reports a bounded component fault, renders recovery, and resets from Try again', () => {
  const faults: RendererFault[] = []
  const boundary = new MountedRendererErrorBoundary({
    children: <p>Recovered child</p>,
    onFault: fault => faults.push(fault),
  })

  boundary.state = RendererErrorBoundary.getDerivedStateFromError()
  boundary.componentDidCatch(new Error(`  ${'x'.repeat(300)}\n`), {
    componentStack: '',
  })

  expect(faults).toEqual([{ kind: 'component', message: 'x'.repeat(256) }])

  const fallback = boundary.render() as ReactElement<{
    children: ReactElement<{ children: ReactNode[] }>
  }>
  expect(renderToStaticMarkup(fallback)).toContain('Try again')

  const button = fallback.props.children.props.children[2] as ReactElement<{
    onClick: () => void
  }>
  button.props.onClick()

  expect(boundary.state).toEqual({ failed: false })
  expect(renderToStaticMarkup(boundary.render())).toContain('Recovered child')
})

test('a fault report rejected by the rate guard does not fail the boundary', () => {
  let attempted = false
  const boundary = new RendererErrorBoundary({
    children: null,
    onFault: () => {
      attempted = true
      // Exactly what the preload guard raises once the shared window is spent.
      throw new Error('renderer IPC rate exceeds 120 frames per 1000ms')
    },
  })

  expect(() => {
    boundary.componentDidCatch(new Error('overflow'), { componentStack: '' })
  }).not.toThrow()
  expect(attempted).toBe(true)
})

test('the failed state renders the recovery surface rather than nothing', () => {
  const boundary = new RendererErrorBoundary({ children: null, onFault: () => {} })
  boundary.state = RendererErrorBoundary.getDerivedStateFromError()
  expect(boundary.state.failed).toBe(true)
  const markup = renderToStaticMarkup(boundary.render() as ReactElement)
  expect(markup).toContain('Something went wrong')
})
