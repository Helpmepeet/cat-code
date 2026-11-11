import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { layoutBrowser, runLayoutBrowser } from './layoutBrowser.testSupport.js'

// Run the actual component in Chromium: DOM mocks cannot measure density or
// prove that parsing an HTML-only email leaves custom elements inactive.
test.skipIf(!layoutBrowser)('email results stay compact, fit a narrow pane and keep HTML inert in Chromium', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'email-tool-layout-'))
  const source = fileURLToPath(new URL('.', import.meta.url))
  const modules = resolve(source, '../../node_modules')
  try {
    const entry = join(scratch, 'entry.ts')
    writeFileSync(entry, `
      import { createElement as h } from ${JSON.stringify(join(modules, 'react/index.js'))};
      import { createRoot } from ${JSON.stringify(join(modules, 'react-dom/client.js'))};
      import { flushSync } from ${JSON.stringify(join(modules, 'react-dom/index.js'))};
      import { EmailToolResult } from ${JSON.stringify(join(source, 'EmailToolResult.tsx'))};
      import { ToolCardStyleContext } from ${JSON.stringify(join(source, 'toolCardStyle.ts'))};
      window.activeEmailContent = false;
      customElements.define('email-hostile-test', class extends HTMLElement { constructor() { super(); window.activeEmailContent = true; } });
      const messages = Array.from({length:5}, (_,i) => ({id:'m'+i,from:'Example team <team@example.invalid>',subject:'Long project notes and follow-up details that must fit without moving the time outside the transcript',date:'2026-11-11 13:14',internalDateIso:'2026-11-11T13:14:30+07:00',labels:['UNREAD','INBOX']}));
      const make = (name, stdout) => ({id:name,frameId:name,sessionId:'fixture',messageId:name,blockIndex:0,parentToolUseId:null,kind:'tool-use',toolUseId:name,toolName:name,toolFamily:'mcp',input:{},status:'success',agentCompletion:null,children:[],result:{isError:false,diff:null,content:JSON.stringify({tool:name.slice('mcp__gmail__'.length),service:'gmail',risk:'read',exit_code:0,stdout})}});
      const search = make('mcp__gmail__gmail_search', {messages,count:5,has_more:false,nextPageToken:''});
      const html = '<div>Hello <b>Peet</b><br>Project notes</div><script>window.activeEmailContent=true<'+ '/script><style>body{display:none}</style><img src="http://127.0.0.1:9/pixel"><email-hostile-test>Extra text</email-hostile-test>';
      const message = make('mcp__gmail__gmail_get_message',{message:{id:'html',payload:{mimeType:'text/html',body:{data:btoa(html).replaceAll('+','-').replaceAll('/','_')}}}});
      const component = (row, operation) => h(ToolCardStyleContext.Provider,{value:{style:'lines',setStyle(){}}},h(EmailToolResult,{row,identity:{provider:'gmail',operation},defaultExpanded:true,originalOutput:'Original output'}));
      flushSync(() => {
        createRoot(document.getElementById('wide')).render(component(search,'search'));
        createRoot(document.getElementById('narrow')).render(component({...search,toolUseId:'narrow'},'search'));
        createRoot(document.getElementById('html-email')).render(component(message,'message'));
      });
      const wide = document.querySelector('#wide .email-tool');
      const narrow = document.querySelector('#narrow .email-tool');
      const narrowBox = narrow.getBoundingClientRect();
      const timeBoxes = [...narrow.querySelectorAll('.email-message-time')].map(node=>node.getBoundingClientRect());
      document.getElementById('result').textContent = JSON.stringify({
        height:wide.getBoundingClientRect().height,
        rowHeight:wide.querySelector('.email-message-head').getBoundingClientRect().height,
        narrowWidth:narrowBox.width,
        narrowOverflow:narrow.scrollWidth > narrow.clientWidth,
        timesInside:timeBoxes.every(box=>box.right <= narrowBox.right+1),
        body:document.querySelector('#html-email .email-body').textContent,
        activeEmailContent:window.activeEmailContent,
        activeNodes:document.querySelectorAll('#html-email img,#html-email iframe,#html-email script,#html-email style,#html-email email-hostile-test').length
      });
    `)
    const built = await Bun.build({ entrypoints: [entry], outdir: join(scratch, 'build'), target: 'browser', format: 'iife', minify: false })
    expect(built.success, built.logs.join('\n')).toBe(true)
    const script = pathToFileURL(built.outputs.find(output => output.path.endsWith('.js'))!.path).href
    const css = readFileSync(join(source, 'emailTools.css'), 'utf8')
    const file = join(scratch, 'fixture.html')
    writeFileSync(file, `<!doctype html><html><head><style>
      * { box-sizing:border-box; } body { margin:0; font:14px/1.5 Arial,sans-serif; }
      button { font:inherit; border:0; background:none; color:inherit; }
      :root { --font-sans:Arial,sans-serif; --font-mono:monospace; --text-primary:#f4f4f5; --text-muted:#a1a1aa; --conversation-ink:#dedede; --shell-seam:#333; --shell-hover:#222; --tone-good:#4ade80; --tone-danger:#f87171; --tone-warn:#fbbf24; }
      .wide { width:836px; } .narrow { width:320px; }
      ${css}
      </style></head><body><div id="wide" class="wide"></div><div id="narrow" class="narrow"></div><div id="html-email" class="wide"></div><pre id="result"></pre><script src="${script}"></script></body></html>`)
    const run = runLayoutBrowser(file, join(scratch, 'profile'), 1100)
    const output = run.stdout.match(/<pre id="result">(.*?)<\/pre>/)?.[1]
    expect(output, run.diagnostics).toBeDefined()
    const result = JSON.parse(output!)
    expect(result.height).toBeLessThan(310)
    expect(result.rowHeight).toBeLessThan(38)
    expect(result.narrowWidth).toBe(320)
    expect(result.narrowOverflow).toBe(false)
    expect(result.timesInside).toBe(true)
    expect(result.body).toContain('Hello Peet')
    expect(result.body).toContain('Project notes')
    expect(result.body).not.toContain('activeEmailContent=true')
    expect(result.activeEmailContent).toBe(false)
    expect(result.activeNodes).toBe(0)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}, 30_000)
