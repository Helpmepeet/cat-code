import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { layoutBrowser, runLayoutBrowser } from './layoutBrowser.testSupport.js'

// Happy DOM does not lay out flexboxes or evaluate container queries.
test.skipIf(!layoutBrowser)('the output panel docks at its chosen width, gives its body the full height, and stacks when narrow', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'tool-output-layout-'))
  try {
    const css = [
      readFileSync(new URL('./subagentSidePanel.css', import.meta.url), 'utf8'),
      readFileSync(new URL('./toolOutputPanel.css', import.meta.url), 'utf8'),
    ].join('\n')
    const file = join(scratch, 'fixture.html')
    writeFileSync(file, `<!doctype html><style>
      * { box-sizing:border-box } body { margin:0 }
      #pane { display:flex; height:800px }
      .session-pane { display:flex; flex:1; min-height:0; flex-direction:column }
      .parent-transcript { flex:1; min-height:0; overflow:auto }
      ${css}
    </style><div id="pane"><div class="subagent-workspace"><div class="subagent-workspace-layout">
      <div class="subagent-parent"><main class="session-pane"><div class="parent-transcript">Parent transcript</div></main></div>
      <aside class="tool-output-panel" aria-label="Full output">
        <div class="tool-output-resize"></div>
        <header class="tool-output-header"><div class="tool-output-identity"><div class="tool-output-line"><span class="tool-output-target">bun test</span></div></div><button class="tool-output-close">x</button></header>
        <div class="tool-output-toolbar"><label class="tool-output-search"><input></label><button class="tool-output-tool">Wrap</button></div>
        <div class="tool-output-scroller" id="body">${Array.from({ length: 200 }, (_, i) => `<div class="tool-output-row"><span class="tool-output-gutter">${i + 1}</span><span class="tool-output-code">${i === 3 ? 'x'.repeat(400) : `line ${i + 1}`}</span></div>`).join('')}</div>
      </aside>
    </div></div></div><pre id="result"></pre><script>
      const pane = document.querySelector('#pane');
      const panel = document.querySelector('aside');
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom }; };
      const body = document.querySelector('#body');
      function snapshot() {
        return { pane:rect('#pane'), parent:rect('.subagent-parent'), panel:rect('aside'), body:rect('#body'),
          header:rect('.tool-output-header'), handle:getComputedStyle(document.querySelector('.tool-output-resize')).display,
          scrollsX:body.scrollWidth > body.clientWidth, scrollsY:body.scrollHeight > body.clientHeight,
          gutterSticky:getComputedStyle(document.querySelector('.tool-output-gutter')).position };
      }
      pane.style.width = '1400px';
      panel.style.setProperty('--tool-output-width', '700px');
      const wide = snapshot();
      // A width remembered from a bigger window must not crowd the transcript.
      pane.style.width = '1000px';
      const crowded = snapshot();
      pane.style.width = '700px';
      const narrow = snapshot();
      document.querySelector('#result').textContent = JSON.stringify({ wide, crowded, narrow });
    </script>`)
    const run = runLayoutBrowser(file, join(scratch, 'profile'), 1500)
    const output = run.stdout.match(/<pre id="result">(.*?)<\/pre>/)?.[1]
    expect(output, run.diagnostics).toBeDefined()
    const result = JSON.parse(output!)

    // Docked beside the transcript at the chosen width, full height.
    expect(result.wide.panel.width).toBe(700)
    expect(result.wide.parent.width).toBe(700)
    expect(result.wide.panel.x).toBe(result.wide.parent.right)
    expect(result.wide.panel.height).toBe(800)
    // The body is everything under the chrome, not a short box inside it.
    expect(result.wide.body.bottom).toBe(result.wide.panel.bottom)
    expect(result.wide.body.height).toBeGreaterThan(650)
    expect(result.wide.scrollsY).toBe(true)
    expect(result.wide.scrollsX).toBe(true)
    expect(result.wide.gutterSticky).toBe('sticky')
    expect(result.wide.handle).toBe('block')

    // The transcript keeps its reserve when the window shrinks.
    expect(result.crowded.panel.width).toBe(560)
    expect(result.crowded.parent.width).toBe(440)

    // Under the worker panel's breakpoint the slot stacks and the handle goes.
    expect(result.narrow.panel.width).toBe(700)
    expect(result.narrow.panel.y).toBeGreaterThanOrEqual(result.narrow.parent.bottom)
    expect(result.narrow.panel.bottom).toBeLessThanOrEqual(result.narrow.pane.bottom)
    expect(result.narrow.parent.height).toBeGreaterThan(100)
    expect(result.narrow.body.height).toBeGreaterThan(100)
    expect(result.narrow.handle).toBe('none')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}, 30_000)
