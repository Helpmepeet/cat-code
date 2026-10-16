import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const chrome = process.env.CHROME_BIN ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].find(path => existsSync(path))

// Happy DOM does not lay out flexboxes or evaluate container queries.
test.skipIf(!chrome)('panel stays reachable when opened in a narrow pane and when an open pane shrinks', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'subagent-panel-layout-'))
  try {
    const css = readFileSync(new URL('./subagentSidePanel.css', import.meta.url), 'utf8')
    const file = join(scratch, 'fixture.html')
    writeFileSync(file, `<!doctype html><style>
      * { box-sizing:border-box } body { margin:0 }
      #pane { display:flex; height:700px }
      .session-pane { display:flex; flex:1; min-height:0; flex-direction:column }
      .parent-transcript { flex:1; min-height:0; overflow:auto }
      textarea { flex:none; height:80px; width:100%; min-width:0 }
      ${css}
    </style><style id="original">
      .subagent-workspace-layout { flex-direction:row }
      .subagent-side-panel { flex:0 0 480px; width:480px; border-left:1px solid; border-top:0 }
    </style><div id="pane"><div class="subagent-workspace"><div class="subagent-workspace-layout">
      <div class="subagent-parent"><main class="session-pane"><div class="parent-transcript">Parent transcript</div><textarea aria-label="Reply"></textarea></main></div>
    </div></div></div><pre id="result"></pre><script>
      const pane = document.querySelector('#pane');
      const layout = document.querySelector('.subagent-workspace-layout');
      const panel = '<aside class="subagent-side-panel"><header class="subagent-side-header"><div class="subagent-side-identity"><div class="subagent-side-line"><span class="subagent-side-name">worker with a long name</span></div><div class="subagent-side-line"><span class="subagent-side-task">A long task description</span><span class="subagent-side-model">Sonnet</span></div></div><nav class="subagent-side-faces"><button class="subagent-side-switch">A</button><button class="subagent-side-switch">B</button></nav><button class="subagent-side-close" aria-label="Close subagent panel">×</button></header><div class="subagent-side-body">Steps</div></aside>';
      function snapshot() {
        const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom }; };
        const close = document.querySelector('.subagent-side-close');
        close.focus({ preventScroll:true });
        const r = close.getBoundingClientRect();
        return { pane:rect('#pane'), parent:rect('.subagent-parent'), transcript:rect('.parent-transcript'), composer:rect('textarea'), panel:rect('aside'), close:rect('.subagent-side-close'), reachable:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2) === close, focused:document.activeElement === close };
      }
      pane.style.width = '360px';
      layout.insertAdjacentHTML('beforeend', panel);
      const broken = snapshot();
      document.querySelector('#original').remove();
      const openedNarrow = snapshot();
      pane.style.width = '1200px';
      const wide = snapshot();
      pane.style.width = '360px';
      const resizedNarrow = snapshot();
      document.querySelector('.subagent-side-close').addEventListener('click', () => document.querySelector('aside').remove());
      document.querySelector('.subagent-side-close').click();
      const closedParent = document.querySelector('.subagent-parent').getBoundingClientRect();
      document.querySelector('#result').textContent = JSON.stringify({ broken, openedNarrow, wide, resizedNarrow, closedHeight:closedParent.height });
    </script>`)
    const run = spawnSync(chrome!, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${join(scratch, 'profile')}`, '--window-size=1400,900', '--dump-dom', `file://${file}`], { encoding: 'utf8', timeout: 20_000 })
    expect(run.error).toBeUndefined()
    expect(run.status, run.stderr).toBe(0)
    const output = run.stdout.match(/<pre id="result">(.*?)<\/pre>/)?.[1]
    expect(output).toBeDefined()
    const result = JSON.parse(output!)
    expect(result.broken.parent.width).toBe(0)
    expect(result.broken.close.x).toBe(434)
    expect(result.broken.close.right).toBe(460)
    expect(result.broken.reachable).toBe(false)
    for (const geometry of [result.openedNarrow, result.resizedNarrow]) {
      expect(geometry.parent.width).toBe(360)
      expect(geometry.parent.height).toBe(350)
      expect(geometry.transcript.height).toBeGreaterThan(100)
      expect(geometry.composer.height).toBe(80)
      expect(geometry.panel.y).toBeGreaterThanOrEqual(geometry.parent.bottom)
      expect(geometry.panel.bottom).toBeLessThanOrEqual(geometry.pane.bottom)
      expect(geometry.close.right).toBeLessThanOrEqual(geometry.pane.right)
      expect(geometry.reachable).toBe(true)
      expect(geometry.focused).toBe(true)
    }
    expect(result.wide.panel.width).toBe(480)
    expect(result.wide.parent.width).toBe(720)
    expect(result.wide.panel.x).toBe(result.wide.parent.right)
    expect(result.closedHeight).toBe(700)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}, 30_000)
