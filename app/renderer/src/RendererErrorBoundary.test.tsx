import { expect, test } from 'bun:test'
import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  RendererErrorBoundary,
  type RendererErrorBoundaryProps,
  type RendererErrorBoundaryState,
  type RendererFault,
} from './RendererErrorBoundary.js'

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
