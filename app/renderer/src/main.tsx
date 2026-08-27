import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AccentThemeProvider } from './AccentThemeProvider.js'
import { App } from './App.js'
import { CodeThemeProvider } from './CodeThemeProvider.js'
import { ColorSchemeProvider } from './ColorSchemeProvider.js'
import { GlassModeProvider } from './GlassModeProvider.js'
import { ReasoningLayoutProvider } from './ReasoningLayoutProvider.js'
import { ToastHost } from './ToastHost.js'
import { ProseArrivalProvider } from './ProseArrivalProvider.js'
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
//
// `GlassModeProvider` renders no wrapper at all. Its target is the document
// element, which is above `#root`, so unlike the accent it covers the tree from
// wherever it sits and its position here carries no meaning.
//
// `ColorSchemeProvider` stamps that same document element, and its position
// carries no meaning either. Both stamp in the LAYOUT phase, and every layout
// effect runs before the browser paints, so no frame can show one stamp without
// the other whichever lands first. This comment previously claimed the nesting
// order was what kept the dark glass ground off a light window; it never could
// be, because the appearance stamp was a passive effect at the time and passive
// effects run after paint. The phase is the guarantee, not the nesting.
createRoot(root).render(
  <StrictMode>
    <RendererErrorBoundary
      onFault={fault => reportFault(fault.kind, fault.message)}
    >
      <ColorSchemeProvider>
        <GlassModeProvider>
          <AccentThemeProvider>
            <ToastHost>
              <ReasoningLayoutProvider>
                <CodeThemeProvider>
                  <ToolsExpandedProvider>
                    <ToolCardStyleProvider>
                      <ProseArrivalProvider>
                        <App />
                      </ProseArrivalProvider>
                    </ToolCardStyleProvider>
                  </ToolsExpandedProvider>
                </CodeThemeProvider>
              </ReasoningLayoutProvider>
            </ToastHost>
          </AccentThemeProvider>
        </GlassModeProvider>
      </ColorSchemeProvider>
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
