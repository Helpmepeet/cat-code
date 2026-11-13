type CursorPoint = { x: number; y: number; color: { r: number; g: number; b: number } }

/** A decorative, fixed-size pointer, not a DevTools rectangle or a page hit target. */
export function browserCursorScript(point: CursorPoint | null): string {
  return `(() => {
    const point = ${JSON.stringify(point)};
    let host = document.querySelector('cat-code-browser-cursor');
    if (!point) { host?.remove(); return; }
    if (!host?.shadowRoot) {
      host?.remove();
      host = document.createElement('cat-code-browser-cursor');
      host.setAttribute('aria-hidden', 'true');
      host.setAttribute('inert', '');
      const shadow = host.attachShadow({ mode: 'open' });
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 30');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M1 1 L1 23 L7 17 L12 27 L17 24 L12 15 L21 15 Z');
      path.setAttribute('stroke', 'white');
      path.setAttribute('stroke-width', '1.5');
      path.setAttribute('stroke-linejoin', 'round');
      svg.append(path);
      shadow.append(svg);
      shadow.adoptedStyleSheets = [new CSSStyleSheet()];
      document.documentElement.append(host);
    }
    const { x, y, color } = point;
    // A constructed shadow sheet avoids page CSS and inline-style CSP restrictions.
    host.shadowRoot.adoptedStyleSheets[0].replaceSync(\`
      :host { all: initial !important; position: fixed !important;
        display: block !important; left: \${x - 1}px !important; top: \${y - 1}px !important;
        width: 24px !important; height: 30px !important; margin: 0 !important;
        padding: 0 !important; border: 0 !important; background: none !important;
        pointer-events: none !important; z-index: 2147483647 !important; }
      svg { display: block; width: 24px; height: 30px; pointer-events: none;
        fill: rgb(\${color.r}, \${color.g}, \${color.b}); }
    \`);
  })()`
}
