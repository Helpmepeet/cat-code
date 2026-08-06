import { Component, type ErrorInfo, type ReactNode } from 'react'
import { getBridge } from './bridge.js'

type Props = { children: ReactNode }
type State = { failed: boolean }

/** Root fallback: fails closed to a recoverable renderer view and emits only a
 * bounded error category/message through the fixed diagnostics channel. */
export class RendererErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    getBridge().reportRendererFault('component', error.message)
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <main className="flex min-h-screen items-center justify-center bg-app-bg p-6 text-text-primary">
        <section className="max-w-md rounded-xl border border-tone-danger/30 bg-shell-chrome p-5">
          <h1 className="text-base font-semibold">Cat Code needs to reload</h1>
          <p className="mt-2 text-sm text-text-muted">
            The renderer encountered an unexpected error. Reload the window; diagnostics are kept locally.
          </p>
        </section>
      </main>
    )
  }
}
