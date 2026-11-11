import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SubagentDock } from './SubagentDock.js'
import { SubagentSidePanel } from './SubagentSidePanel.js'
import { ComputerPane } from './ComputerPane.js'
import { layoutBrowser, runLayoutBrowser } from './layoutBrowser.testSupport.js'
import type { SubagentDockRow } from './subagentDockState.js'

const css = (name: string) => readFileSync(new URL(`./${name}.css`, import.meta.url), 'utf8')
const noop = () => {}

// A real browser catches inherited type, SVG colour and flex sizing that SSR cannot.
test.skipIf(!layoutBrowser)('side-pane chrome retains the approved type, selection borders, icon sizing and tooltip placement', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'side-pane-chrome-'))
  try {
    const worker: SubagentDockRow = {
      agentId: 'chrome-worker', runKey: 'run', toolUseId: 'tool', name: 'Bloodstone', task: 'Check the pane', type: null,
      state: 'running', model: 'GPT-6.1 Sol', recordedAccount: null, usageLabel: null, verdict: null, resultSummary: null,
      blockReason: null, launchOrder: 0, terminalAt: null, resumedAt: null, lastSeenAt: 0, missingSince: null, settleUntil: null,
      stateWord: '', account: null, rowModel: null, stripLines: [null, null], chipLines: [null, null], settling: false, runToolUseIds: [],
    }
    const dock = renderToStaticMarkup(<SubagentDock state={{ active: [], finished: [], chipFaces: [], nextUpdateAt: null }}
      collapsed onCollapsedChange={noop} onClearFinished={noop} onOpenWorker={noop} onOpenWorkers={noop}
      views={[{ kind: 'browser', label: 'Browser', detail: 'workbench.html' }]} selectedKind="browser"
      files={[{ path: '/repo/workbench.html', name: 'workbench.html', parent: '/repo' }]} />)
    const workerPanel = renderToStaticMarkup(<SubagentSidePanel worker={worker} workers={[worker]} agent={null}
      steps={[]} incomplete={false} cwd={null} onSwitch={noop} onClose={noop} />)
    const computerPanel = renderToStaticMarkup(<ComputerPane steps={[]} selectedId={null} onSelect={noop} onClose={noop} />)
    const theme = css('theme')
    const dockBase = theme.slice(theme.indexOf('.subagent-dock {'), theme.indexOf('@keyframes subagent-resume-wash'))
    const file = join(scratch, 'fixture.html')
    writeFileSync(file, `<!doctype html><html data-appearance="dark"><style>
      :root { color-scheme:dark; --font-sans:Arial,sans-serif; --font-mono:monospace; --text-primary:#f4f4f5; --text-muted:#a1a1aa; --text-subtle:#98989f; --text-faint:#838389; --text-ghost:#75757b; --peer:#818cf8; --accent:#f472b6; --shell-seam:rgba(255,255,255,.06); --shell-hover:rgba(255,255,255,.045); --shell-active:rgba(255,255,255,.06); --subagent-dock-fill:#212123; --subagent-row-attached:#2a2a2d; --elev-menu:0 18px 44px rgba(0,0,0,.6); --elev-popover:0 14px 38px rgba(0,0,0,.5); }
      * { box-sizing:border-box } body { margin:0; font:16px/1.5 Arial,sans-serif; color:var(--text-primary) }
      button { border:0; margin:0; padding:0; background:none; font:inherit; color:inherit }
      .dock-parent { position:relative; width:480px; height:520px }
      .visual-pane { position:absolute; left:480px; top:0; width:520px!important; max-width:none!important }
      .visual-files { --files-top:440px; --files-left:20px; --files-width:420px; --files-height:150px; }
      ${['subagentSidePanel', 'filePane', 'filePaneFiles', 'subagentDock', 'fileTypeIcon', 'computerPane', 'toolOutputPanel', 'sidePaneShell'].map(css).join('\n')}
      ${dockBase}
    </style><div class="dock-parent">${dock}</div><div class="subagent-shared-slot visual-pane">${workerPanel}${computerPanel}</div>
    <div class="file-pane-files visual-files"><input class="file-pane-files-search"><div class="file-pane-files-list"><button class="file-pane-file-row"><span class="file-pane-file-name">workbench.html</span></button></div></div>
    <pre id="result"></pre><script>
      const q = selector => document.querySelector(selector);
      const style = (selector, keys) => { const s=getComputedStyle(q(selector)); return Object.fromEntries(keys.map(key=>[key,s[key]])); };
      const browser = q('.dock-slot[data-dock-view="browser"]'); browser.focus({preventScroll:true, focusVisible:true});
      const tip = browser.querySelector('.subagent-dock-tip').getBoundingClientRect(), anchor = browser.getBoundingClientRect();
      const result = {
        dock:style('.subagent-dock',['fontSize','lineHeight']),
        selected:style('.subagent-dock-panel [data-dock-view="browser"]',['borderTopColor','boxShadow']),
        button:style('.dock-slot[data-dock-view="browser"]',['color']),
        icon:style('.dock-slot[data-dock-view="browser"] svg',['width','height','color']),
        tip:style('.dock-slot[data-dock-view="browser"] .subagent-dock-tip',['display']),
        tipGap:tip.top-anchor.bottom, tipRight:tip.right-anchor.right,
        file:style('.dock-file',['lineHeight']), fileIcon:style('.file-type-icon',['flexShrink','color']),
        fileParent:style('.file-pane-file-parent',['direction']),
        header:style('.subagent-side-header',['fontSize','lineHeight','height']),
        name:style('.subagent-side-name',['fontSize','fontWeight','color']),
        model:style('.subagent-side-model',['fontSize','fontWeight','color']),
        close:style('.subagent-side-close svg',['width','height','strokeWidth']),
        computer:style('.computer-pane-header',['paddingLeft','gap'])
      };
      q('.file-pane-files-search').focus({preventScroll:true});
      result.filesMenu=style('.file-pane-files',['boxShadow']);
      result.filesInput=style('.file-pane-files-search',['height','lineHeight','boxShadow']);
      result.filesRow=style('.file-pane-files .file-pane-file-row',['borderRadius','gap']);
      q('#result').textContent = JSON.stringify(result);
    </script></html>`)
    const run = runLayoutBrowser(file, join(scratch, 'profile'), 1200)
    const output = run.stdout.match(/<pre id="result">(.*?)<\/pre>/)?.[1]
    expect(output, run.diagnostics).toBeDefined()
    const result = JSON.parse(output!)
    expect(result.dock).toEqual({ fontSize: '13px', lineHeight: '18.2px' })
    expect(result.selected).toEqual({ borderTopColor: 'rgba(255, 255, 255, 0.06)', boxShadow: 'none' })
    expect(result.icon).toEqual({ width: '13px', height: '13px', color: result.button.color })
    expect(result.button.color).toBe('rgb(244, 244, 245)')
    expect(result.tip.display).toBe('block')
    expect(result.tipGap).toBeCloseTo(9, 1)
    expect(result.tipRight).toBeCloseTo(4, 1)
    expect(result.file.lineHeight).toBe('16.8px')
    expect(result.fileIcon).toEqual({ flexShrink: '1', color: 'rgb(224, 160, 112)' })
    expect(result.fileParent.direction).toBe('ltr')
    expect(result.header).toEqual({ fontSize: '13px', lineHeight: '18.2px', height: '40px' })
    expect(result.name).toEqual({ fontSize: '12.5px', fontWeight: '600', color: 'rgb(129, 140, 248)' })
    expect(result.model).toEqual({ fontSize: '10.5px', fontWeight: '500', color: 'rgb(131, 131, 137)' })
    expect(result.close).toEqual({ width: '14px', height: '14px', strokeWidth: '2px' })
    expect(result.computer).toEqual({ paddingLeft: '14px', gap: '6px' })
    expect(result.filesMenu.boxShadow).toBe('rgba(0, 0, 0, 0.5) 0px 14px 38px 0px')
    expect(result.filesInput).toEqual({ height: '34px', lineHeight: 'normal', boxShadow: 'none' })
    expect(result.filesRow).toEqual({ borderRadius: '7px', gap: '9px' })
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
