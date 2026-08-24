import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AccentThemeProvider } from './AccentThemeProvider.js'
import { App } from './App.js'
import { CodeThemeProvider } from './CodeThemeProvider.js'
import { ReasoningLayoutProvider } from './ReasoningLayoutProvider.js'
import { ToastHost } from './ToastHost.js'
import { ToolCardStyleProvider } from './ToolCardStyleProvider.js'
import { ToolsExpandedProvider } from './ToolsExpandedProvider.js'
import { RendererErrorBoundary } from './RendererErrorBoundary.js'
import { getBridge } from './bridge.js'
import { installReactDevPerformanceTrackFilter } from './reactDevPerformanceTrack.js'
import './theme.css'

// Before the first render: React's dev build otherwise retains a native copy of
// every component's props for every commit, which is fatal to a long streaming
// session. See reactDevPerformanceTrack.ts for the mechanism.
if (import.meta.env?.DEV) {
  installReactDevPerformanceTrackFilter()
}

const root = document.getElementById('root')
if (!root) {
  throw new Error('missing #root')
}

// ToastHost wraps the app at the composition root so `useToast()` is a live
// API for every W4 domain (P4-1). It renders nothing until a toast fires.
//
// `AccentThemeProvider` sits ABOVE `ToastHost` rather than beside the other view
// preferences, because its wrapper is what carries `data-accent`: anything
// rendered outside it keeps the default pink no matter what the user picked, and
// a toast is exactly the kind of chrome that would silently miss the accent.
createRoot(root).render(
  <StrictMode>
    <RendererErrorBoundary
      onFault={fault => reportFault(fault.kind, fault.message)}
    >
      <AccentThemeProvider>
        <ToastHost>
          <ReasoningLayoutProvider>
            <CodeThemeProvider>
              <ToolsExpandedProvider>
                <ToolCardStyleProvider>
                  <App />
                </ToolCardStyleProvider>
              </ToolsExpandedProvider>
            </CodeThemeProvider>
          </ReasoningLayoutProvider>
        </ToastHost>
      </AccentThemeProvider>
    </RendererErrorBoundary>
  </StrictMode>,
)

// Both handlers run only after something has already failed, so neither may
// raise a second fault of its own: a throw here re-enters `error` and turns one
// failure into a loop.
function reportFault(
  kind: 'javascript' | 'promise' | 'component',
  message: string,
): void {
  try {
    getBridge().reportRendererFault(kind, message)
  } catch {
    // Diagnostics only.
  }
}

window.addEventListener('error', event => {
  reportFault('javascript', event.message)
})
window.addEventListener('unhandledrejection', event => {
  const message = event.reason instanceof Error ? event.reason.message : String(event.reason)
  reportFault('promise', message)
})
