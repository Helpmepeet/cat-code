import type { BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export async function runAnalyticsMatrix(window: BrowserWindow, outDir: string): Promise<void> {
  const widths = (process.env.CATCODE_CAPTURE_WIDTHS ?? '1440,1280,900').split(',').map(Number)
  if (!widths.length || new Set(widths).size !== widths.length || widths.some(width => ![1440, 1280, 900].includes(width))) throw new Error('Invalid matrix widths')
  const results: any[] = []
  const interactions: any[] = []
  const js = <T = any>(source: string): Promise<T> => window.webContents.executeJavaScript(source)
  const wait = async (source: string, label: string) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (await js(source)) return
      await settle(100)
    }
    throw new Error(`Timed out: ${label}`)
  }
  const click = async (selector: string) => {
    await js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error('Missing control: ' + ${JSON.stringify(selector)}); e.scrollIntoView({block:'center'}); e.dispatchEvent(new MouseEvent('click', {bubbles:true})); })()`)
    await settle(100)
  }
  const snapshot = () => js(`(() => {
    const page = document.querySelector('.usage-page'), content = document.querySelector('.usage-content');
    const rect = e => { const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; };
    return {
      range:page.dataset.range, appearance:document.documentElement.dataset.appearance,
      glass:document.documentElement.dataset.glass === 'on', viewport:[innerWidth,innerHeight],
      page:rect(page),content:rect(content),scrollWidth:page.scrollWidth,clientWidth:page.clientWidth,
      sidebar:rect(document.querySelector('aside[aria-label="Primary"]')),
      scrollbarWidth:page.offsetWidth-page.clientWidth,
      sidebarOcclusions:[...page.querySelectorAll('h1,h2,h3,button,table,svg')].filter(e=>{const r=e.getBoundingClientRect(),s=document.querySelector('aside[aria-label="Primary"]').getBoundingClientRect();return r.width && r.left<s.right-1 && r.right>s.left}).map(e=>({tag:e.tagName,label:e.getAttribute('aria-label')||e.textContent.slice(0,100),rect:rect(e)})),
      scrollHeight:page.scrollHeight,clientHeight:page.clientHeight,
      sections:[...page.querySelectorAll('h2,h3')].map(e=>e.textContent),
      charts:page.querySelectorAll('svg').length, latencyRows:page.querySelectorAll('.uad-latency-chart g[tabindex]').length,
      sessions:page.querySelectorAll('.uas-session-row').length,
      overflows:[...page.querySelectorAll('section,article,.usage-panel,.uas-card,.uad-card')].filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>({class:e.className,scroll:e.scrollWidth,client:e.clientWidth})),
      outside:[...page.querySelectorAll('h1,h2,h3,button,table,svg')].filter(e=>{const r=e.getBoundingClientRect();return r.width && (r.right>page.getBoundingClientRect().right+1 || r.left<page.getBoundingClientRect().left-1)}).map(e=>({tag:e.tagName,label:e.getAttribute('aria-label')||e.textContent.slice(0,100),rect:rect(e)})),
      palette:Array.from({length:8},(_,i)=>getComputedStyle(content).getPropertyValue('--usage-category-'+i).trim()),
      seriesColors:[...page.querySelectorAll('.usage-daily-chip circle')].map(e=>({label:e.closest('button').textContent,fill:getComputedStyle(e).fill})),
      latencyReadout:page.querySelector('.uad-latency-readout')?.textContent,
      cacheQualifications:[...page.querySelectorAll('.usage-cache-coverage')].map(e=>e.textContent),
      motion:[...page.querySelectorAll('.usage-daily-svg,.uad-card,.uas-card')].slice(0,8).map(e=>({class:e.getAttribute('class'),animation:getComputedStyle(e).animationName,duration:getComputedStyle(e).animationDuration})),
      reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches
    };
  })()`)
  const photograph = async (name: string) => {
    if (window.isVisible()) throw new Error('matrix window became visible')
    const image = await window.webContents.capturePage()
    if (image.isEmpty()) throw new Error(`capture produced no pixels: ${name}`)
    writeFileSync(join(outDir, `${name}.png`), image.toPNG())
  }
  window.setMinimumSize(852, 600)
  const prepareSurface = async (width: number, appearance: string, glass: boolean, sidebarWidth = 288) => {
    window.setSize(width, 1000)
    await js(`localStorage.setItem('catcode.appearance.v1',JSON.stringify({version:1,scheme:${JSON.stringify(appearance)}}));localStorage.setItem('catcode.glass.v1',JSON.stringify({version:1,enabled:${glass}}));localStorage.setItem('catcode.sidebarWidth.v1',JSON.stringify({version:1,width:${sidebarWidth}}));`)
    const loaded = new Promise<void>(resolve => window.webContents.once('did-finish-load', () => resolve()))
    window.webContents.reload()
    await loaded
    await wait(`Boolean(document.querySelector('[data-sidebar-nav-id="usage"]'))`, 'Analytics navigation')
    await click('[aria-label="Pin sidebar open"]')
    await click('[data-sidebar-nav-id="usage"]')
    await wait(`Boolean(document.querySelector('.usage-daily-svg') && document.querySelector('.uas-session-row') && document.querySelector('.uad-latency-chart'))`, 'collected Analytics fixture')
    await wait(`document.documentElement.dataset.appearance === ${JSON.stringify(appearance)} && (document.documentElement.dataset.glass === 'on') === ${glass}`, 'appearance providers')
  }
  for (const width of widths) for (const appearance of ['light', 'dark']) for (const glass of [false, true]) {
    await prepareSurface(width, appearance, glass)
    for (const range of ['7d', '30d', 'all']) {
      const name = `${width}-${appearance}-glass-${glass ? 'on' : 'off'}-${range}`
      const before = await snapshot()
      await click(`.usage-range button:nth-child(${range === '7d' ? 1 : range === '30d' ? 2 : 3})`)
      await wait(`document.querySelector('.usage-page').dataset.range === ${JSON.stringify(range)}`, 'range update')
      await settle(450)
      const state = await snapshot()
      if (state.range !== range || state.appearance !== appearance || state.glass !== glass) throw new Error(`Wrong matrix state: ${name}`)
      if (state.cacheQualifications.length !== 2 || state.cacheQualifications.some((label: string) => label !== 'Writes partly reported')) throw new Error(`Missing partial cache-write qualifications: ${name}`)
      const frames: string[] = []
      const step = state.clientHeight - 160
      for (let scroll = 0, tile = 0; ; scroll += step, tile++) {
        const position = Math.min(scroll, state.scrollHeight - state.clientHeight)
        await js(`document.querySelector('.usage-page').scrollTop=${position}`)
        await settle(100)
        const frame = `${name}-${String(tile).padStart(2, '0')}`
        await photograph(frame)
        frames.push(frame + '.png')
        if (position >= state.scrollHeight - state.clientHeight) break
      }
      results.push({ name, windowBounds: window.getBounds(), before, state, frames })
      writeFileSync(join(outDir, 'matrix.json'), JSON.stringify(results, null, 2))
      process.stdout.write(`[capture] ${name} ${frames.length} tiles\n`)
    }
  }
  await click('.usage-range button:first-child')
  const check = async (label: string, action: () => Promise<void>, assertion: string) => {
    const before = await snapshot()
    await action()
    const passed = await js<boolean>(assertion)
    const after = await snapshot()
    interactions.push({ label, passed, before, after })
    await photograph(`interaction-${interactions.length}`)
    writeFileSync(join(outDir, 'interactions.json'), JSON.stringify(interactions, null, 2))
  }
  await check('daily day pin', () => click('.usage-daily-hit'), `document.querySelector('.usage-daily-hit').getAttribute('aria-pressed')==='true' && !!document.querySelector('.usage-pinned')`)
  await check('same day unpin', () => click('.usage-daily-hit'), `!document.querySelector('.usage-pinned')`)
  await check('Tokens by source', () => click('.usage-daily-group button:nth-child(2)'), `document.querySelector('.usage-daily-group button:nth-child(2)').getAttribute('aria-selected')==='true' && document.querySelectorAll('.usage-daily-chip').length===3`)
  await check('hide series', () => click('.usage-daily-chip'), `document.querySelector('.usage-daily-chip').getAttribute('aria-pressed')==='false'`)
  await check('session row expansion', () => click('.uas-session-row'), `document.querySelector('.uas-session-row').getAttribute('aria-expanded')==='true' && !!document.querySelector('.uas-detail')`)
  await check('session errors ranking', () => click('.uas-switch button:nth-child(2)'), `document.querySelector('.uas-switch button:nth-child(2)').getAttribute('aria-pressed')==='true'`)
  await check('concurrency toggle', () => click('.uad-controls[aria-label="Activity view"] button:nth-child(2)'), `!!document.querySelector('.uad-concurrency') && !!document.querySelector('[aria-label="Ten-minute concurrency heatmap"]')`)
  await check('tool cross-filter', () => click('.uad-tools button'), `document.querySelector('.usage-daily-metrics [aria-selected="true"]').textContent==='Tool errors'`)
  await check('auto-mode cross-filter', () => click('.uad-routes [role="button"]'), `document.querySelector('.usage-daily-metrics [aria-selected="true"]').textContent==='Auto mode'`)
  await check('build selection', () => click('.uad-builds [role="button"]'), `!!document.querySelector('.uad-builds [aria-pressed="true"]')`)
  await check('latency hover readout', async () => {
    await js(`(() => { const row=document.querySelector('.uad-latency-chart g[tabindex]'); row.scrollIntoView({block:'center'}); row.dispatchEvent(new MouseEvent('mouseover',{bubbles:true})); })()`)
    await settle(100)
  }, `document.querySelector('.uad-latency-readout').textContent.includes('median') && document.querySelector('.uad-latency-readout').textContent.includes('p95') && document.querySelector('.uad-latency-readout').textContent.includes('samples')`)
  await check('session keyboard collapse', async () => {
    await js(`(() => { const row=document.querySelector('.uas-session-row[aria-expanded="true"]'); row.scrollIntoView({block:'center'}); row.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); })()`)
    await settle(100)
  }, `!document.querySelector('.uas-session-row[aria-expanded="true"]')`)
  window.webContents.debugger.attach('1.3')
  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  })
  await check('reduced motion', async () => {
    await click('.usage-range button:nth-child(2)')
    await settle(400)
  }, `matchMedia('(prefers-reduced-motion: reduce)').matches && [...document.querySelectorAll('.uad-card,.uas-card')].every(e=>getComputedStyle(e).animationName==='none' || getComputedStyle(e).animationDuration.split(',').every(s=>parseFloat(s)<=.001))`)
  window.webContents.debugger.detach()
  const extremes: any[] = []
  for (const [width, sidebarWidth] of [[852, 288], [984, 420], [852, 420]]) {
    await prepareSurface(width!, 'dark', false, sidebarWidth!)
    await click('.usage-range button:first-child')
    await settle(450)
    const state = await snapshot()
    const name = `extreme-${width}-sidebar-${sidebarWidth}`
    const frames: string[] = []
    for (let scroll = 0, tile = 0; ; scroll += state.clientHeight - 160, tile++) {
      const position = Math.min(scroll, state.scrollHeight - state.clientHeight)
      await js(`document.querySelector('.usage-page').scrollTop=${position}`)
      await settle(100)
      const frame = `${name}-${String(tile).padStart(2, '0')}`
      await photograph(frame)
      frames.push(frame + '.png')
      if (position >= state.scrollHeight - state.clientHeight) break
    }
    extremes.push({ name, windowBounds: window.getBounds(), state, frames })
    writeFileSync(join(outDir, 'extremes.json'), JSON.stringify(extremes, null, 2))
  }
  writeFileSync(join(outDir, 'result.json'), JSON.stringify({
    ok: results.length === widths.length * 12 && interactions.every(item => item.passed),
    combinations: results.length, interactions: interactions.length,
    failedInteractions: interactions.filter(item => !item.passed).map(item => item.label),
  }, null, 2))
}
