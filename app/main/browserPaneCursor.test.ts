import { expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { browserCursorScript } from './browserPaneCursor.js'

function page() {
  const window = new Window({ settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } })
  window.document.body.innerHTML = '<button>Save</button>'
  return window
}

test('cursor is a fixed-size, non-interactive arrow hidden from page text and accessibility', async () => {
  const window = page()
  try {
    window.eval(browserCursorScript({ x: 120, y: 80, color: { r: 100, g: 110, b: 120 } }))
    const host = window.document.querySelector('cat-code-browser-cursor')!
    expect(host.getAttribute('aria-hidden')).toBe('true')
    expect(host.hasAttribute('inert')).toBe(true)
    expect(host.shadowRoot?.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 24 30')
    expect(host.shadowRoot?.querySelector('path')?.getAttribute('d')).toContain('L7 17 L12 27')
    const css = [...host.shadowRoot!.adoptedStyleSheets[0]!.cssRules].map(rule => rule.cssText).join('\n')
    expect(css).toContain('position: fixed !important')
    expect(css).toContain('left: 119px !important; top: 79px !important')
    expect(css).toContain('width: 24px !important; height: 30px !important')
    expect(css).toContain('pointer-events: none !important')
    expect(css).toContain('fill: rgb(100, 110, 120)')
    expect(window.document.body.innerText).toBe('Save')
    expect(window.document.documentElement.textContent).toBe('Save')
  } finally { await window.happyDOM.close() }
})

test('moving the cursor reuses its host and arrow, and clearing removes only the cursor', async () => {
  const window = page()
  try {
    const draw = (x: number, y: number) => window.eval(browserCursorScript({ x, y, color: { r: 20, g: 30, b: 40 } }))
    draw(0, 0)
    const host = window.document.querySelector('cat-code-browser-cursor')!
    const arrow = host.shadowRoot!.querySelector('svg')
    draw(300, 200)
    expect(window.document.querySelectorAll('cat-code-browser-cursor')).toHaveLength(1)
    expect(window.document.querySelector('cat-code-browser-cursor')).toBe(host)
    expect(host.shadowRoot!.querySelector('svg')).toBe(arrow)
    expect(host.shadowRoot!.adoptedStyleSheets[0]!.cssRules[0]!.cssText).toContain('left: 299px !important; top: 199px !important')
    window.eval(browserCursorScript(null))
    window.eval(browserCursorScript(null))
    expect(window.document.querySelector('cat-code-browser-cursor')).toBeNull()
    expect(window.document.querySelector('button')?.textContent).toBe('Save')
    draw(20, 30)
    expect(window.document.querySelectorAll('cat-code-browser-cursor')).toHaveLength(1)
  } finally { await window.happyDOM.close() }
})
