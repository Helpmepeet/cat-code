/**
 * Renderer-side view of the preload bridge. Type-only imports of the protocol
 * (P0-3 discipline: no engine runtime enters the renderer bundle). The concrete
 * `window.catcode` object is injected by the preload via contextBridge.
 */

import type { CatCodeBridge } from '../../shared/protocol.js'

declare global {
  interface Window {
    catcode: CatCodeBridge
  }
}

export function getBridge(): CatCodeBridge {
  return window.catcode
}
