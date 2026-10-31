import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { layoutBrowser, runLayoutBrowser } from './layoutBrowser.testSupport.js'

// Happy DOM cannot measure the margins that were lost behind BoundedMarkdown's wrappers.
test.skipIf(!layoutBrowser)('Markdown preview spacing reaches blocks inside and across measured leaves', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'file-markdown-layout-'))
  try {
    const theme = readFileSync(new URL('./theme.css', import.meta.url), 'utf8')
    const start = theme.indexOf('  .md-prose {')
    expect(start).toBeGreaterThan(0)
    const prose = theme.slice(start, theme.indexOf('\n}', start))
    const pane = readFileSync(new URL('./filePane.css', import.meta.url), 'utf8')
    const file = join(scratch, 'fixture.html')
    writeFileSync(file, `<!doctype html><style>
      :root { --font-sans:Arial; --conversation-ink:black }
      * { box-sizing:border-box; margin:0; padding:0 }
      body { width:560px }
      ${prose}
      ${pane}
    </style><div class="file-pane-markdown-column"><div data-pane-height-owner>
      <div data-markdown-leaf="first"><div class="md-prose">
        <p id="intro">Introductory paragraph.</p><h2 id="heading">Entities</h2>
        <p id="body">Each entity has a key.</p><ul id="list"><li>Customer</li><li>Sale</li></ul>
      </div></div>
      <div data-markdown-leaf="second"><div class="md-prose">
        <h2 id="next">Next section</h2><p id="next-body">A new measured unit.</p>
      </div></div>
      <div data-markdown-leaf="third"><div class="md-prose"><h3 id="subheading">Details</h3></div></div>
      <div data-markdown-leaf="fourth"><div class="md-prose"><p id="details">Keep this text close to its heading.</p></div></div>
    </div></div><pre id="result"></pre><script>
      const box = id => document.getElementById(id).getBoundingClientRect();
      const gap = (before, after) => box(after).top - box(before).bottom;
      const column = document.querySelector('.file-pane-markdown-column');
      document.getElementById('result').textContent = JSON.stringify({
        heading:gap('intro','heading'), afterHeading:gap('heading','body'), blocks:gap('body','list'),
        nextHeading:gap('list','next'), nextSubheading:gap('next-body','subheading'),
        afterSplitHeading:gap('subheading','details'),
        columnWidth:column.getBoundingClientRect().width,
        padding:getComputedStyle(column).padding,
        measuredHeight:document.querySelector('[data-markdown-leaf="first"]').getBoundingClientRect().height,
        contentHeight:box('list').bottom - box('intro').top
      });
    </script>`)
    const run = runLayoutBrowser(file, join(scratch, 'profile'), 800)
    const output = run.stdout.match(/<pre id="result">(.*?)<\/pre>/)?.[1]
    expect(output, run.diagnostics).toBeDefined()
    const result = JSON.parse(output!)
    expect(result.heading).toBeCloseTo(15 * 1.18 * 1.5, 1)
    expect(result.afterHeading).toBeCloseTo(7.5, 1)
    expect(result.blocks).toBeCloseTo(12.75, 1)
    expect(result.nextHeading).toBeCloseTo(result.heading, 1)
    expect(result.nextSubheading).toBeCloseTo(15 * 1.05 * 1.35, 1)
    expect(result.afterSplitHeading).toBeCloseTo(7.5, 1)
    expect(result.columnWidth).toBe(560)
    expect(result.padding).toBe('20px 24px 40px')
    expect(result.measuredHeight).toBeCloseTo(result.contentHeight, 1)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}, 30_000)
