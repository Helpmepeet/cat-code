import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { CodeThemeProvider } from './CodeThemeProvider.js'
import { ReasoningLayoutProvider } from './ReasoningLayoutProvider.js'
import { ToastHost } from './ToastHost.js'
import './theme.css'

const root = document.getElementById('root')
if (!root) {
  throw new Error('missing #root')
}

// ToastHost wraps the app at the composition root so `useToast()` is a live
// API for every W4 domain (P4-1). It renders nothing until a toast fires.
createRoot(root).render(
  <StrictMode>
    <ToastHost>
      <ReasoningLayoutProvider>
        <CodeThemeProvider>
          <App />
        </CodeThemeProvider>
      </ReasoningLayoutProvider>
    </ToastHost>
  </StrictMode>,
)
