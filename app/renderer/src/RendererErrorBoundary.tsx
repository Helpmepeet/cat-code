import { Component, type ErrorInfo, type ReactNode } from 'react'

const MAX_FAULT_MESSAGE_LENGTH = 256

export type RendererFault = Readonly<{
  kind: 'component'
  message: string
}>

export type RendererErrorBoundaryProps = Readonly<{
  children: ReactNode
  onFault: (fault: RendererFault) => void
}>

export type RendererErrorBoundaryState = Readonly<{
  failed: boolean
}>

function safeFaultMessage(error: Error): string {
  const message = error.message.replace(/\s+/g, ' ').trim()
  return message.slice(0, MAX_FAULT_MESSAGE_LENGTH) || 'Renderer component failed'
}

/** Root fallback that reports bounded fault metadata through its parent. */
export class RendererErrorBoundary extends Component<
  RendererErrorBoundaryProps,
  RendererErrorBoundaryState
> {
  state: RendererErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): RendererErrorBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    // Reporting must never be able to fail the boundary itself: React treats an
    // error thrown from this lifecycle as unhandled, discards the fallback
    // below, and unmounts the whole tree. The reporter is injected rather than
    // reached for, so this covers a throwing caller as well as the case the
    // preload already swallows (a rate-rejected report).
    try {
      this.props.onFault({ kind: 'component', message: safeFaultMessage(error) })
    } catch {
      // A boundary that cannot report is still a boundary.
    }
  }

  recover = (): void => {
    this.setState({ failed: false })
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <main className="flex min-h-screen items-center justify-center bg-app-bg p-6 text-text-primary">
        <section className="max-w-md rounded-xl border border-tone-danger/30 bg-shell-chrome p-5">
          <h1 className="text-base font-semibold">Something went wrong</h1>
          <p className="mt-2 text-sm text-text-muted">
            Try again. If the problem continues, reload the window.
          </p>
          <button
            className="mt-4 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white"
            type="button"
            onClick={this.recover}
          >
            Try again
          </button>
        </section>
      </main>
    )
  }
}
