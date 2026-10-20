import type { BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'

const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const prototypeData = ['summary', 'daily', 'models', 'daily_models', 'tools', 'daily_tools', 'builds', 'hours', 'concurrency', 'permissions', 'auto_daily', 'effort', 'daily_effort', 'sessions', 'session_totals', 'daily_sources', 'session_detail', 'daily_skills', 'daily_integrations']
const d3Url = 'https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js'

/** Only the prototype's known read-only assets are exposed, on an ephemeral loopback port. */
export async function startPrototypeServer(repository: string) {
  const root = join(repository, 'docs/analytics/2026-10-18-analytics-prototype')
  const paths = new Map<string, string>([
    ['preview/harness.html', 'text/html'], ['page/index.html', 'text/html'],
    ['page/cc.css', 'text/css'], ['page/cc.js', 'text/javascript'],
    ...prototypeData.map(id => [`data/catcode-${id}.json`, 'application/json'] as const),
  ])
  const assets = new Map<string, { body: Buffer; type: string }>()
  for (const [path, type] of paths) {
    const body = await readFile(join(root, path))
    if (body.byteLength > 4 * 1024 * 1024) throw new Error(`Oversized prototype asset: ${path}`)
    assets.set('/' + path, { body, type })
  }
  let requests = 0
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const asset = assets.get(url.pathname)
    if (++requests > 10000 || request.method !== 'GET' || !asset) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, {
      'Content-Type': `${asset.type}; charset=utf-8`,
      'Content-Length': asset.body.byteLength,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'self' data:; script-src 'self' 'unsafe-inline' ${d3Url}; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; img-src 'self' data:; frame-src 'none'; form-action 'none'; base-uri 'none'`,
    }).end(asset.body)
  })
  server.requestTimeout = 5000
  server.headersTimeout = 5000
  server.maxConnections = 8
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing prototype loopback address')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeAllConnections() }),
  }
}

/** Physical SVG text bounds; explicit axis classes take precedence over the bottom-band fallback. */
export const axisMetricsScript = (prototype = false) => `(() => {
  const proto=${prototype},q=s=>document.querySelector(s);
  const selectors=proto?{daily:'#x-chart svg',cache:'#cache-rate svg',skills:'#skills-chart svg',integrations:'#integrations-chart svg',activity:'#activity .cc-chart svg',builds:'#build-scatter svg'}:{daily:'.usage-daily-svg',cache:'[aria-label="Cache"] .uad-card:first-child .uad-chart',skills:'.uas-integrations .uas-card:first-child .uas-chart svg',integrations:'.uas-integrations .uas-card:nth-child(2) .uas-chart svg',activity:'.uad-heatmap',builds:'.uad-builds'};
  return Object.fromEntries(Object.entries(selectors).map(([key,selector])=>{
    const svg=q(selector),box=svg?.getBoundingClientRect();
    const marked=svg?.querySelector('.uad-x-axis-label,.uas-x-axis-label,.usage-x-axis-label');
    const labels=svg?[...svg.querySelectorAll('text')].filter(e=>{
      if(e.closest('.uad-tooltip,.usage-daily-tooltip,.uas-tip-position,.cc-tip')||e.closest('svg')!==svg)return false;
      if(e.matches('.usage-chart-annotation,.uad-build-label,.cc-peak'))return false;
      const explicit=e.matches('.uad-x-axis-label,.uas-x-axis-label,.usage-x-axis-label');
      const height=svg.viewBox.baseVal.height||svg.height.baseVal.value,y=parseFloat(e.getAttribute('y'));
      const s=getComputedStyle(e),r=e.getBoundingClientRect();
      return (marked?explicit:Number.isFinite(y)&&y>=height-22&&y<=height) && s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0'&&r.width>0&&r.height>0;
    }).map(e=>{const r=e.getBoundingClientRect();return {text:e.textContent,rect:{x:r.x,y:r.y,width:r.width,height:r.height}}}):[];
    const unavailable=!proto&&(
      key==='activity'&&/detail is unavailable for this range/.test(q('[aria-label="Activity"] .uad-empty')?.textContent||'')||
      key==='skills'&&/No skill uses recorded\\./.test(q('.uas-integrations .uas-card:first-child')?.textContent||'')||
      key==='integrations'&&/No integration calls recorded\\./.test(q('.uas-integrations .uas-card:nth-child(2)')?.textContent||'')||
      key==='builds'&&/No (?:eligible )?build (?:observations|results)/i.test(q('[aria-label="Reliability"]')?.textContent||'')
    );
    return [key,{selector,rendered:!!box&&box.width>0&&box.height>0,unavailable,labels}];
  }));
})()`

export const profileMetricsScript = `(() => {
  const fill=document.querySelector('.uad-profile-fill'),line=document.querySelector('.uad-profile-line');
  if(!fill)return {available:false};
  const match=(fill.getAttribute('fill')||'').match(/#([^)"']+)/),gradient=match?document.getElementById(match[1]):null;
  const label=document.querySelector('.uad-heatmap text');
  return {
    available:true,fill:getComputedStyle(fill).fill,lineStroke:line?getComputedStyle(line).stroke:null,
    font:label?{family:getComputedStyle(label).fontFamily,size:getComputedStyle(label).fontSize,weight:getComputedStyle(label).fontWeight}:null,
    stops:[...(gradient?.querySelectorAll('stop')||[])].map(stop=>({offset:stop.getAttribute('offset'),stopColor:getComputedStyle(stop).stopColor,stopOpacity:getComputedStyle(stop).stopOpacity})),
  };
})()`

/** Runs in Chromium; measures layout rather than comparing frozen data values or Y domains. */
export const designMetricsScript = (prototype: boolean) => `(() => {
  const proto=${prototype}, q=s=>document.querySelector(s), all=s=>[...document.querySelectorAll(s)];
  const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};
  const style=e=>{if(!e)return null;const s=getComputedStyle(e);return {font:s.fontFamily,size:s.fontSize,weight:s.fontWeight,lineHeight:s.lineHeight,letterSpacing:s.letterSpacing,display:s.display,width:s.width,alignItems:s.alignItems,justifyItems:s.justifyItems,justifyContent:s.justifyContent,alignSelf:s.alignSelf,justifySelf:s.justifySelf,minHeight:s.minHeight,maxHeight:s.maxHeight,maxWidth:s.maxWidth,columns:s.gridTemplateColumns,radius:s.borderRadius,padding:s.padding,margin:s.margin,gap:s.gap,background:s.backgroundColor,color:s.color,shadow:s.boxShadow}};
  const measure=s=>{const e=q(s);return {selector:s,rect:rect(e),style:style(e)}};
  const page=q(proto?'.app-page':'.usage-page'),content=q(proto?'.cc':'.usage-content');
  const cards=all(proto?'.cc-card':'.usage-metric,.usage-daily-explorer,.usage-daily-detail,.uad-card,.uas-card');
  const sections=all(proto?'.cc-section':'.usage-analytics-details,.uas');
  const keyed=selectors=>Object.fromEntries(Object.entries(selectors).map(([key,selector])=>[key,measure(selector)]));
  const summaryKeys=['requests','sessions','cache','toolErrors','latestBuild'];
  const summarySelectors=proto?['[data-kpi="requests"] .cc-kpi-value','[data-kpi="sessions"] .cc-kpi-value','[data-scroll="cache"] .cc-kpi-value','[data-kpi="errorRate"] .cc-kpi-value','.cc-build-rate']:['.usage-metric-requests .usage-metric-row > strong','.usage-metric-sessions .usage-metric-row > strong','.usage-metric-cache .usage-metric-row > strong','.usage-metric-errorRate .usage-metric-row > strong','.usage-latest-build .usage-metric-row > strong'];
  const summaryValues=summarySelectors.map(measure);
  const element=e=>({rect:rect(e),style:style(e)});
  const summaryLayout=Object.fromEntries(summaryKeys.slice(0,4).map((key,i)=>{
    const value=q(summarySelectors[i]),button=value?.closest('button'),row=button?.querySelector(proto?'.cc-kpi-row':'.usage-metric-row');
    const spark=button?.querySelector(proto?'.cc-spark':'.usage-metric-row svg');
    return [key,{button:element(button),row:element(row),value:element(value),spark:element(spark),sparkSvg:element(proto?spark?.querySelector('svg'):spark)}];
  }));
  const trioSelectors=Object.fromEntries(['top10','subagents','compaction','median'].map((key,i)=>[key,proto?'#sessions .cc-trio > div:nth-child('+(i+2)+') .cc-stat-value':'.uas-figures > div:nth-child('+(i+1)+') dd']));
  for(const [keys,prototypeRoot,appRoot] of [
    [['cacheServed','cacheFresh'],'#cache-models .cc-trio','[aria-label="Cache"] .uad-stats'],
    [['callsSucceeded','callsFailed','callsRetried'],'#model-calls .cc-trio','.uad-reliability-grid > .uad-card:first-child .uad-stats'],
    [['autoDecisions','autoReview','autoBlocked'],'#auto-card .cc-trio','.uad-auto-card .uad-stats'],
  ]) keys.forEach((key,i)=>{trioSelectors[key]=(proto?prototypeRoot:appRoot)+' > div:nth-child('+(i+1)+') '+(proto?'.cc-stat-value':'dd')});
  const inspectorKeys=['requests','sessions','peak','tokens','cache','toolErrors'];
  const sectionSelectors=proto?{cache:'#cache h2',activity:'#activity h2',models:'#models h2',sessions:'#sessions h2',extensions:'#extensions h2',reliability:'#reliability h2'}:{cache:'[aria-label="Cache"] h2',activity:'[aria-label="Activity"] h2',models:'[aria-label="Models"] h2',sessions:'.uas[aria-label="Sessions"] h2',extensions:'.uas[aria-label="Skills and integrations"] h2',reliability:'[aria-label="Reliability"] h2'};
  const typography={
    hero:measure(proto?'#x-total':'.usage-hero-number'),
    inspectorTitle:measure(proto?'#i-title':'.usage-detail-header h3'),
    inspectorStats:keyed(Object.fromEntries(inspectorKeys.map((key,i)=>[key,proto?'#inspector .cc-stat:nth-child('+(i+1)+') .cc-stat-value':'.usage-daily-stats > div:nth-child('+(i+1)+') dd']))),
    sectionTitles:keyed(sectionSelectors),
    trioValues:keyed(trioSelectors),
    bigValues:keyed(proto?{skills:'#skills-card .cc-big',integrations:'#integrations-card .cc-big'}:{skills:'.uas-integrations .uas-card:first-child .uas-big',integrations:'.uas-integrations .uas-card:nth-child(2) .uas-big'}),
    summaryValues:Object.fromEntries(summaryKeys.map((key,i)=>[key,summaryValues[i]])),
    sessionNumbers:keyed(proto?{tokens:'#sessions-table .cc-s-row > td:nth-child(2) .cc-s-num',errors:'#sessions-table .cc-s-row > td:nth-child(5) .cc-s-num'}:{tokens:'.uas-session-row > td:nth-child(2) .uas-session-number',errors:'.uas-session-row > td:nth-child(5) .uas-session-number'}),
    summarySparks:keyed(proto?{requests:'#spark-requests',sessions:'#spark-sessions',cache:'#spark-cache',toolErrors:'#spark-toolerr',latestBuild:'.cc-build-chart'}:{requests:'.usage-metric-requests .usage-metric-row svg',sessions:'.usage-metric-sessions .usage-metric-row svg',cache:'.usage-metric-cache .usage-metric-row svg',toolErrors:'.usage-metric-errorRate .usage-metric-row svg',latestBuild:'.usage-build-chart'}),
  };
  return {
    viewport:[innerWidth,innerHeight],range:proto?window.dash?.params?.().range:q('.usage-page')?.dataset.range,page:rect(page),content:rect(content),sidebar:rect(q(proto?'.app-side':'aside[aria-label="Primary"]')),
    summaryLayout,
    integrationHeaderGaps:Object.fromEntries(['skills','integrations'].map((key,i)=>{
      const card=q(proto?'#'+key+'-card':'.uas-integrations .uas-card:nth-child('+(i+1)+')');
      const header=card?.querySelector(proto?'.cc-card-head':'.uas-integration-header'),total=card?.querySelector(proto?'.cc-big':'.uas-big'),chart=card?.querySelector(proto?'.cc-chart svg':'.uas-chart svg');
      const h=rect(header),t=rect(total),c=rect(chart);
      return [key,{header:h,total:t,chart:c,qualifiers:[...(header?.querySelectorAll('.uas-note')||[])].map(e=>e.textContent),headerToChart:h&&c?c.y-(h.y+h.height):null,totalToChart:t&&c?c.y-(t.y+t.height):null}];
    })),
    fontsReady:document.fonts.status,
    gutters:{left:content.getBoundingClientRect().left-page.getBoundingClientRect().left,right:page.getBoundingClientRect().right-content.getBoundingClientRect().right},
    keyCards:Object.fromEntries(Object.entries(proto?{daily:'#overview .cc-card',sessions:'#sessions-card',skills:'#skills-card',integrations:'#integrations-card'}:{daily:'.usage-daily-explorer',sessions:'.uas[aria-label="Sessions"] .uas-card',skills:'.uas-integrations .uas-card:first-child',integrations:'.uas-integrations .uas-card:nth-child(2)'}).map(([key,selector])=>[key,measure(selector)])),
    spanCards:keyed(proto?{daily:'#explorer',inspector:'#inspector',cache:'#cache .cc-card:first-child',cacheModels:'#cache-models'}:{daily:'.usage-daily-explorer',inspector:'.usage-daily-detail',cache:'.uad-cache-grid > .uad-card:first-child',cacheModels:'.uad-cache-grid > .uad-card:last-child'}),
    layoutGroups:keyed(proto?{summary:'.cc-strip',daily:'#overview > .cc-bento',cache:'#cache > .cc-bento',integrations:'#extensions > .cc-bento',figures:'.cc-quad'}:{summary:'.usage-cards',daily:'.usage-daily-grid',cache:'.uad-cache-grid',integrations:'.uas-integrations',figures:'.uas-figures'}),
    fixedCharts:keyed(proto?{cache:'#cache-rate svg',skills:'#skills-chart svg',integrations:'#integrations-chart svg'}:{cache:'[aria-label="Cache"] .uad-card:first-child .uad-chart',skills:'.uas-integrations .uas-card:first-child .uas-chart svg',integrations:'.uas-integrations .uas-card:nth-child(2) .uas-chart svg'}),
    unavailable:proto?{}:{
      skills:/No skill uses recorded\\./.test(q('.uas-integrations .uas-card:first-child')?.textContent||''),
      integrations:/No integration calls recorded\\./.test(q('.uas-integrations .uas-card:nth-child(2)')?.textContent||''),
      calls:/Model call outcomes are unavailable\\./.test(q('.uad-reliability-grid > .uad-card:first-child')?.textContent||''),
      auto:/Auto-mode observations are unavailable\\./.test(q('.uad-auto-card')?.textContent||''),
      sessions:/No contributing sessions recorded\\./.test(q('.uas[aria-label="Sessions"]')?.textContent||''),
    },
    cardSamples:cards.slice(0,20).map(e=>({label:e.querySelector('h3,.cc-eyebrow,.uas-eyebrow')?.textContent,rect:rect(e),style:style(e)})),
    sectionSpacing:sections.map((e,i)=>({label:e.querySelector('h2')?.textContent,rect:rect(e),gapBefore:i?e.getBoundingClientRect().top-sections[i-1].getBoundingClientRect().bottom:null,heading:style(e.querySelector('h2'))})),
    summary:measure(proto?'.cc-strip':'.usage-cards'),summaryValues,typography,
    summaryCards:keyed(proto?{requests:'[data-kpi="requests"]',sessions:'[data-kpi="sessions"]',cache:'[data-scroll="cache"]',toolErrors:'[data-kpi="errorRate"]',latestBuild:'#latest-build'}:{requests:'.usage-metric-requests',sessions:'.usage-metric-sessions',cache:'.usage-metric-cache',toolErrors:'.usage-metric-errorRate',latestBuild:'.usage-latest-build'}),
    heading:measure(proto?'.cc-h1':'#usage-title'),
    charts:(proto?['#x-chart svg','#cache-rate svg','#skills-chart svg','#integrations-chart svg']:['.usage-daily-svg','[aria-label="Cache"] .uad-card:first-child .uad-chart','.uas-integrations .uas-card:first-child .uas-chart svg','.uas-integrations .uas-card:nth-child(2) .uas-chart svg']).map(measure),
    chartTextSamples:all(proto?'#x-chart text,#skills-chart text,#integrations-chart text':'.usage-daily-svg text,.uas-integrations .uas-chart text').slice(0,24).map(e=>({text:e.textContent,rect:rect(e),style:style(e)})),
    sessions:measure(proto?'#sessions-table':'.uas-sessions'),
    sessionColumns:all(proto?'#sessions-table thead th':'.uas-sessions thead th').map(e=>({label:e.textContent,display:getComputedStyle(e).display,rect:rect(e)})),
    modelsColumns:all(proto?'#models-table thead th':'.uad-table-wrap thead th').map(e=>({label:e.textContent,display:getComputedStyle(e).display,rect:rect(e)})),
    sessionFigures:measure(proto?'.cc-quad':'.uas-figures'),
    sessionConstraints:keyed(proto?{scroll:'.cc-sessions-wrap',title:'.cc-s-title',cell:'.cc-sessions td:first-child',tools:'.cc-sd-tool'}:{scroll:'.uas-table-scroll',title:'.uas-title',cell:'.uas-session-row > th',tools:'.uas-tool'}),
    grids:all(proto?'.cc-bento':'.uas-integrations,.usage-daily-grid,.uad-cache-grid').map(e=>({rect:rect(e),columns:getComputedStyle(e).gridTemplateColumns,gap:getComputedStyle(e).gap})),
    overflow:page?{scroll:page.scrollWidth,client:page.clientWidth}:null,
    axisLabels:(${axisMetricsScript(prototype)}),
    activityProfile:proto?null:(${profileMetricsScript}),
  };
})()`

export function typographyDeltas(app: Record<string, any>, prototype: Record<string, any>): Record<string, any> {
  const difference = (a: unknown, b: unknown) => {
    const left = typeof a === 'number' ? a : typeof a === 'string' ? parseFloat(a) : NaN
    const right = typeof b === 'number' ? b : typeof b === 'string' ? parseFloat(b) : NaN
    return Number.isFinite(left) && Number.isFinite(right) ? left - right : null
  }
  return Object.fromEntries([...new Set([...Object.keys(app), ...Object.keys(prototype)])].map(key => {
    const a = app[key], p = prototype[key]
    if (a?.selector || p?.selector) return [key, {
      missing: { app: !a?.rect, prototype: !p?.rect },
      size: difference(a?.style?.size, p?.style?.size),
      weight: difference(a?.style?.weight, p?.style?.weight),
      lineHeight: difference(a?.style?.lineHeight, p?.style?.lineHeight),
      letterSpacing: difference(a?.style?.letterSpacing, p?.style?.letterSpacing),
      width: difference(a?.rect?.width, p?.rect?.width),
      height: difference(a?.rect?.height, p?.rect?.height),
    }]
    return [key, typographyDeltas(a ?? {}, p ?? {})]
  }))
}

export type DesignFailure = { path: string; actual: unknown; expected: unknown; tolerance?: number; reason: string }
export function evaluateAxisCollisions(groups: Record<string, any>): DesignFailure[] {
  const failures: DesignFailure[] = []
  for (const key of ['daily', 'cache', 'skills', 'integrations', 'activity', 'builds']) {
    const group = groups[key], path = `axisLabels.${key}`
    if (group?.unavailable === true) continue
    if (!group?.rendered || !Array.isArray(group.labels) || !group.labels.length) {
      failures.push({ path, actual: { rendered: group?.rendered ?? false, labels: group?.labels?.length ?? 0 }, expected: 'Rendered bottom-axis labels or explicit unavailable state', reason: 'Missing required axis measurement' })
      continue
    }
    if (group.labels.length > 256) failures.push({ path, actual: group.labels.length, expected: '<=256', reason: 'Unbounded axis-label population' })
    const labels = group.labels.slice(0, 256).filter((label: any) => label?.rect && [label.rect.x, label.rect.y, label.rect.width, label.rect.height].every(Number.isFinite) && label.rect.width > 0 && label.rect.height > 0).sort((a: any, b: any) => a.rect.x - b.rect.x)
    if (labels.length !== Math.min(256, group.labels.length)) failures.push({ path, actual: group.labels.slice(0, 256), expected: 'Finite positive text bounds', reason: 'Invalid axis-label measurement' })
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i], b = labels[j]
      const overlapX = Math.min(a.rect.x + a.rect.width, b.rect.x + b.rect.width) - b.rect.x
      if (overlapX <= 1) break
      const overlapY = Math.min(a.rect.y + a.rect.height, b.rect.y + b.rect.height) - Math.max(a.rect.y, b.rect.y)
      if (overlapY > 1) failures.push({ path, actual: { left: a, right: b, overlapX, overlapY }, expected: 'No rendered text overlap exceeding 1px', tolerance: 1, reason: 'Bottom-axis labels collide' })
      if (failures.length >= 256) return failures
    }
  }
  return failures
}
/** Excludes data-driven heights, wrapping, ink, visible series and summary breakpoints. */
export function evaluateDesign(app: Record<string, any>, prototype: Record<string, any>): DesignFailure[] {
  const failures: DesignFailure[] = []
  const number = (v: unknown) => typeof v === 'number' ? v : typeof v === 'string' && /^-?[\d.]+(?:px)?$/.test(v) ? parseFloat(v) : NaN
  const fail = (path: string, actual: unknown, expected: unknown, reason: string, tolerance?: number) => failures.push({ path, actual: actual ?? null, expected: expected ?? null, reason, ...(tolerance === undefined ? {} : { tolerance }) })
  const near = (path: string, actual: unknown, expected: unknown, tolerance: number) => {
    const a = number(actual), p = number(expected)
    if (!Number.isFinite(a) || !Number.isFinite(p)) fail(path, actual, expected, 'Missing or nonnumeric required measurement')
    else if (Math.abs(a - p) > tolerance + 1e-7) fail(path, a, p, 'Stable design measurement differs', tolerance)
  }
  const required = (path: string, a: any, p: any) => {
    if (!a?.style || !p?.style || !(number(a?.rect?.width) > 0) || !(number(a?.rect?.height) > 0) || !(number(p?.rect?.width) > 0) || !(number(p?.rect?.height) > 0)) { fail(path, a?.rect, p?.rect, 'Missing or unrendered required design node'); return false }
    return true
  }
  const font = (path: string, a: any, p: any) => {
    if (!required(path, a, p)) return
    near(path + '.fontSize', a.style.size, p.style.size, .1)
    const weight = (value: unknown) => value === 'normal' ? 400 : value === 'bold' ? 700 : value
    near(path + '.fontWeight', weight(a.style.weight), weight(p.style.weight), 0)
    for (const property of ['lineHeight', 'letterSpacing']) {
      // Normal line boxes vary with font metrics; compare only explicit pixel lengths.
      if (Number.isFinite(number(a.style[property])) && Number.isFinite(number(p.style[property]))) near(`${path}.${property}`, a.style[property], p.style[property], .1)
    }
  }
  font('heading', app.heading, prototype.heading)
  font('typography.hero', app.typography?.hero, prototype.typography?.hero)
  font('typography.inspectorTitle', app.typography?.inspectorTitle, prototype.typography?.inspectorTitle)
  const groups: Record<string, string[]> = {
    inspectorStats: ['requests', 'sessions', 'peak', 'tokens', 'cache', 'toolErrors'],
    sectionTitles: ['cache', 'activity', 'models', 'sessions', 'extensions', 'reliability'],
    trioValues: ['sessions', 'top10', 'subagents', 'compaction', 'median', 'cacheServed', 'cacheFresh', 'callsSucceeded', 'callsFailed', 'callsRetried', 'autoDecisions', 'autoReview', 'autoBlocked'],
    bigValues: ['skills', 'integrations'],
    summaryValues: ['requests', 'sessions', 'cache', 'toolErrors', 'latestBuild'],
    sessionNumbers: ['tokens', 'errors'],
  }
  for (const [group, keys] of Object.entries(groups)) for (const key of keys) {
    // Only explicit unavailable states excuse absent data-dependent values.
    if (group === 'trioValues' && (key.startsWith('calls') && app.unavailable?.calls === true || key.startsWith('auto') && app.unavailable?.auto === true)) continue
    if (group === 'sessionNumbers' && app.unavailable?.sessions === true) continue
    font(`typography.${group}.${key}`, app.typography?.[group]?.[key], prototype.typography?.[group]?.[key])
  }
  for (const key of ['requests', 'sessions', 'cache', 'toolErrors']) {
    const a = app.summaryLayout?.[key], p = prototype.summaryLayout?.[key], path = `summaryLayout.${key}`
    if (!required(`${path}.value`, a?.value, p?.value) || !required(`${path}.spark`, a?.spark, p?.spark)) continue
    near(`${path}.prototype.sparkToValueGap`, number(p.spark.rect.x) - number(p.value.rect.x) - number(p.value.rect.width), 8, .1)
    // The app deliberately centers the spark in the space right of the value; the row's 8px gap stays as the minimum.
    const leftFree = number(a.spark.rect.x) - number(a.value.rect.x) - number(a.value.rect.width) - 8
    const rightFree = number(a.row?.rect?.x) + number(a.row?.rect?.width) - number(a.spark.rect.x) - number(a.spark.rect.width)
    near(`${path}.app.sparkCenterOffset`, leftFree - rightFree, 0, 1)
  }
  const components = (v: unknown): number[] => typeof v === 'string' ? v.trim().split(/\s+/).map(number) : []
  const edges = (v: unknown) => {
    const n = components(v)
    return n.length === 1 ? [n[0], n[0], n[0], n[0]] : n.length === 2 ? [n[0], n[1], n[0], n[1]] : n.length === 3 ? [n[0], n[1], n[2], n[1]] : n.length === 4 ? n : [NaN]
  }
  for (const [group, keys] of [
    ['keyCards', ['daily', 'sessions', 'skills', 'integrations']],
    ['spanCards', ['inspector', 'cache', 'cacheModels']],
    ['summaryCards', ['requests', 'sessions', 'cache', 'toolErrors', 'latestBuild']],
  ] as const) for (const key of keys) {
    const a = app[group]?.[key], p = prototype[group]?.[key], path = `${group}.${key}`
    if (!required(path, a, p)) continue
    for (const property of ['radius', 'padding']) {
      const av = edges(a.style[property]), pv = edges(p.style[property])
      for (let i = 0; i < 4; i++) near(`${path}.${property}.${i}`, av[i], pv[i], .1)
    }
  }
  for (const key of ['summary', 'daily', 'cache', 'integrations', 'figures']) {
    const a = app.layoutGroups?.[key], p = prototype.layoutGroups?.[key]
    if (!required(`layoutGroups.${key}`, a, p)) continue
    const av = components(a.style.gap), pv = components(p.style.gap)
    for (let i = 0; i < 2; i++) near(`layoutGroups.${key}.gap.${i}`, av[i] ?? av[0], pv[i] ?? pv[0], .1)
  }
  near('gutters.left', app.gutters?.left, prototype.gutters?.left, .1)
  // The native app reserves a 4px scrollbar; the prototype uses overlay scrollbars.
  const inset = number(app.gutters?.right) - number(prototype.gutters?.right)
  if (!Number.isFinite(inset) || Math.min(Math.abs(inset), Math.abs(inset - 4)) > .1 + 1e-7) fail('gutters.right', app.gutters?.right, prototype.gutters?.right, 'Expected equal gutter or approved +4px native scrollbar inset', .1)
  for (const [key, height] of [['cache', 210], ['skills', 220], ['integrations', 220]] as const) {
    if (app.unavailable?.[key] === true) continue
    const a = app.fixedCharts?.[key], p = prototype.fixedCharts?.[key]
    if (!required(`fixedCharts.${key}`, a, p)) continue
    near(`fixedCharts.${key}.prototypeHeight`, p.rect.height, height, 1)
    near(`fixedCharts.${key}.height`, a.rect.height, p.rect.height, 1)
  }
  if (!['7d', '30d', 'all'].includes(app.range)) fail('range', app.range, '7d, 30d or all', 'Missing required range for qualification-aware spacing checks')
  if (app.range === '7d') for (const key of ['skills', 'integrations']) {
    if (app.unavailable?.[key] === true) continue
    const a = app.integrationHeaderGaps?.[key], p = prototype.integrationHeaderGaps?.[key]
    if (!a?.header || !p?.header || !Array.isArray(a.qualifiers)) fail(`integrationHeaderGaps.${key}`, a ?? null, p ?? null, 'Missing required integration header measurement')
    else if (a.qualifiers.length === 0) {
      near(`integrationHeaderGaps.${key}.totalToChart`, a.totalToChart, p.totalToChart, .1)
      near(`integrationHeaderGaps.${key}.headerToChart`, a.headerToChart, 16, .1)
    }
  }
  const width = number(app.content?.width), pw = number(prototype.content?.width)
  near('content.width', width, pw, 1)
  if (width >= 1000 && pw >= 1000) for (const [key, span, offset] of [['daily', 8, 0], ['inspector', 4, 8], ['cache', 8, 0], ['cacheModels', 4, 8]] as const) {
    const a = app.spanCards?.[key], p = prototype.spanCards?.[key]
    if (!required(`spanCards.${key}`, a, p)) continue
    for (const [side, card, metrics, w] of [['app', a, app, width], ['prototype', p, prototype, pw]] as const) {
      near(`spanCards.${key}.${side}.width`, card.rect.width, (w + 14) * span / 12 - 14, 1)
      near(`spanCards.${key}.${side}.offset`, number(card.rect.x) - number(metrics.content?.x), (w + 14) * offset / 12, 1)
    }
  }
  return [...failures, ...evaluateAxisCollisions(app.axisLabels ?? {})]
}

export async function runAnalyticsMatrix(window: BrowserWindow, outDir: string): Promise<void> {
  const { app, BrowserWindow: PrototypeWindow } = await import('electron')
  const server = await startPrototypeServer(resolve(app.getAppPath(), '..'))
  let prototype: BrowserWindow
  try {
    prototype = new PrototypeWindow({ show: false, frame: false, width: 1440, height: 1000, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: `analytics-prototype-${Date.now()}` } })
  } catch (error) {
    await server.close()
    throw error
  }
  let prototypeShown = false
  try {
  prototype.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  prototype.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(server.origin + '/')) event.preventDefault() })
  prototype.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(server.origin + '/') && details.url !== d3Url && !details.url.startsWith('data:') }))
  prototype.on('show', () => { prototypeShown = true; prototype.destroy() })
  const widths = (process.env.CATCODE_CAPTURE_WIDTHS ?? '1440,1280,900').split(',').map(Number)
  if (!widths.length || new Set(widths).size !== widths.length || widths.some(width => ![1440, 1280, 900].includes(width))) throw new Error('Invalid matrix widths')
  const results: any[] = []
  const interactions: any[] = []
  const comparisons: any[] = []
  const fidelityInteractions: any[] = []
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
      fidelity:{
        latencyRows:[...page.querySelectorAll('.uad-latency-chart g[tabindex]')].map(e=>e.getAttribute('aria-label')),
        activityProfile:page.querySelector('.uad-profile-line')?.getAttribute('d'),
        activityLegend:[...page.querySelectorAll('[aria-label="Activity"] .uad-legend li')].map(e=>e.textContent),
        modelChips:[...page.querySelectorAll('.uad-model-chips button')].map(e=>({label:e.textContent,pressed:e.getAttribute('aria-pressed'),swatch:getComputedStyle(e,'::before').backgroundColor,swatchOpacity:getComputedStyle(e,'::before').opacity})),
        tooltips:[...page.querySelectorAll('.uas-tip,.uad-tooltip,.usage-daily-tooltip')].map(e=>e.textContent),
        sessionSort:[...page.querySelectorAll('.uas-sessions thead th')].map(e=>({label:e.textContent,sort:e.getAttribute('aria-sort'),arrow:getComputedStyle(e.querySelector('button'),'::after').content})),
        sessionErrorMeters:page.querySelectorAll('.uas-error-meter').length,
        sourceShares:[...page.querySelectorAll('.uas-composition-list li')].map(e=>e.textContent),
        pinnedRule:page.querySelector('.usage-daily-pin-rule')?.outerHTML,
      },
      reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,
      profileAppearance:(${profileMetricsScript})
    };
  })()`)
  const photograph = async (name: string) => {
    if (window.isVisible() || prototypeShown || prototype.isVisible()) throw new Error('matrix window became visible')
    const image = await window.webContents.capturePage()
    if (image.isEmpty()) throw new Error(`capture produced no pixels: ${name}`)
    writeFileSync(join(outDir, `${name}.png`), image.toPNG())
  }
  const capturePrototype = async (name: string, width: number, appearance: string, range: string) => {
    const viewport = await js<number[]>(`[innerWidth,innerHeight]`)
    prototype.setContentSize(viewport[0]!, viewport[1]!)
    let loadTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        prototype.loadURL(`${server.origin}/preview/harness.html?app=1&side=288&range=${range}${appearance === 'dark' ? '&dark' : ''}`),
        new Promise<never>((_, reject) => { loadTimer = setTimeout(() => reject(new Error(`Prototype navigation timed out: ${name}`)), 30000) }),
      ])
    } finally {
      if (loadTimer) clearTimeout(loadTimer)
    }
    const pjs = <T = any>(source: string): Promise<T> => prototype.webContents.executeJavaScript(source)
    let ready = false
    for (let attempt = 0; attempt < 300; attempt++) {
      const state = await pjs(`({ready:window.__ready===true && !!document.querySelector('#x-chart svg') && !!document.querySelector('#skills-chart svg') && !!document.querySelector('#integrations-chart svg'),error:window.__err||null})`)
      if (state.error) throw new Error(`Prototype ${name}: ${state.error}`)
      if (state.ready) { ready = true; break }
      await settle(100)
    }
    if (!ready) throw new Error(`Prototype did not become ready: ${name}; check d3 CDN availability`)
    await pjs(`document.fonts.ready.then(()=>true)`)
    await settle(450)
    await js(`document.querySelector('.usage-page').scrollTop=0`)
    await js(`document.fonts.ready.then(()=>true)`)
    await settle(100)
    const appMetrics = await js(designMetricsScript(false))
    // Native frame/scrollbar insets can differ; match the design's content box, not outer pixels.
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await pjs(`({width:innerWidth,content:document.querySelector('.cc').getBoundingClientRect().width})`)
      const correction = appMetrics.content.width - current.content
      if (Math.abs(correction) <= 1) break
      prototype.setContentSize(Math.round(current.width + correction), viewport[1]!)
      await settle(200)
    }
    const prototypeMetrics = await pjs(designMetricsScript(true))
    const scroll = await pjs(`(()=>{const e=document.querySelector('.app-page');return {height:e.scrollHeight,client:e.clientHeight}})()`)
    const frames: string[] = []
    for (let position = 0, tile = 0; ; position += Math.max(1, scroll.client - 160), tile++) {
      const top = Math.max(0, Math.min(position, scroll.height - scroll.client))
      await pjs(`document.querySelector('.app-page').scrollTop=${top}`)
      await settle(100)
      if (prototypeShown || prototype.isVisible() || window.isVisible()) throw new Error('Comparison window became visible')
      const image = await prototype.webContents.capturePage()
      if (image.isEmpty()) throw new Error(`capture produced no pixels: prototype-${name}`)
      const frame = `prototype-${name}-${String(tile).padStart(2, '0')}.png`
      writeFileSync(join(outDir, frame), image.toPNG())
      frames.push(frame)
      if (top >= scroll.height - scroll.client) break
    }
    const delta = (a: number | undefined, b: number | undefined) => a === undefined || b === undefined ? null : a - b
    const fontSize = (value: any) => value?.style ? parseFloat(value.style.size) : undefined
    return {
      name, width, prototypeFrames: frames, appMetrics, prototypeMetrics,
      designFailures: evaluateDesign(appMetrics, prototypeMetrics),
      deltas: {
        contentWidth: delta(appMetrics.content?.width, prototypeMetrics.content?.width),
        sidebarWidth: delta(appMetrics.sidebar?.width, prototypeMetrics.sidebar?.width),
        summaryHeight: delta(appMetrics.summary.rect?.height, prototypeMetrics.summary.rect?.height),
        headingSize: delta(fontSize(appMetrics.heading), fontSize(prototypeMetrics.heading)),
        gutters: { left: delta(appMetrics.gutters.left, prototypeMetrics.gutters.left), right: delta(appMetrics.gutters.right, prototypeMetrics.gutters.right) },
        cards: Object.keys(appMetrics.keyCards).map(key => ({ key, radius: delta(parseFloat(appMetrics.keyCards[key].style?.radius), parseFloat(prototypeMetrics.keyCards[key].style?.radius)), padding: { app: appMetrics.keyCards[key].style?.padding, prototype: prototypeMetrics.keyCards[key].style?.padding } })),
        summaryFonts: appMetrics.summaryValues.map((value: any, i: number) => ({ index: i, size: delta(fontSize(value), fontSize(prototypeMetrics.summaryValues[i])), lineHeight: { app: value.style?.lineHeight, prototype: prototypeMetrics.summaryValues[i]?.style?.lineHeight } })),
        typography: typographyDeltas(appMetrics.typography, prototypeMetrics.typography),
        chartHeights: appMetrics.charts.map((chart: any, i: number) => ({ app: chart.selector, prototype: prototypeMetrics.charts[i]?.selector, delta: delta(chart.rect?.height, prototypeMetrics.charts[i]?.rect?.height) })),
      },
      interpretation: {
        differentData: 'Values, chart Y domains, labels and data-dependent wrapping are not equality assertions.',
        approved: ['retained-history counts and caps', 'exact whole-range figures', 'privacy-safe labels', 'accent-derived sequential ramp', 'approved categorical ink', 'intentional breakpoint changes', 'glass surfaces'],
        glass: 'Prototype has no glass mode; compare geometry while treating app glass ink and surfaces as intentional.',
        alignment: '288px sidebar and content width matched; prototype viewport may differ by native frame/scrollbar inset. Both viewports and residual content delta are recorded.',
      },
    }
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
      comparisons.push({ ...await capturePrototype(name, width, appearance, range), appFrames: frames })
      writeFileSync(join(outDir, 'prototype-comparisons.json'), JSON.stringify(comparisons, null, 2))
      writeFileSync(join(outDir, 'matrix.json'), JSON.stringify(results, null, 2))
      process.stdout.write(`[capture] ${name} ${frames.length} tiles\n`)
    }
  }
  await click('.usage-range button:first-child')
  const check = async (label: string, action: () => Promise<void>, assertion: string, fidelity = false) => {
    const before = await snapshot()
    await action()
    const assertionPassed = await js<boolean>(assertion)
    const after = await snapshot()
    const axisLabels = await js(axisMetricsScript())
    const designFailures = evaluateAxisCollisions(axisLabels)
    const target = fidelity ? fidelityInteractions : interactions
    target.push({ label, passed: assertionPassed && designFailures.length === 0, assertionPassed, before, after, axisLabels, designFailures })
    await photograph(`${fidelity ? 'fidelity-' : ''}interaction-${target.length}`)
    writeFileSync(join(outDir, fidelity ? 'fidelity-interactions.json' : 'interactions.json'), JSON.stringify(target, null, 2))
  }
  await check('daily day pin', () => click('.usage-daily-hit'), `document.querySelector('.usage-daily-hit').getAttribute('aria-pressed')==='true' && !!document.querySelector('.usage-pinned')`)
  await check('same day unpin', () => click('.usage-daily-hit'), `!document.querySelector('.usage-pinned')`)
  await check('Tokens by source', () => click('.usage-daily-group button:nth-child(2)'), `document.querySelector('.usage-daily-group button:nth-child(2)').getAttribute('aria-selected')==='true' && document.querySelectorAll('.usage-daily-chip').length===3`)
  await check('hide series', () => click('.usage-daily-chip'), `document.querySelector('.usage-daily-chip').getAttribute('aria-pressed')==='false'`)
  await check('session row expansion', () => click('.uas-session-row'), `document.querySelector('.uas-session-row').getAttribute('aria-expanded')==='true' && !!document.querySelector('.uas-detail')`)
  await check('session errors ranking', () => click('.uas-switch button:nth-child(2)'), `document.querySelector('.uas-switch button:nth-child(2)').getAttribute('aria-pressed')==='true'`)
  await check('concurrency toggle', () => click('[aria-label="Activity view"] button:nth-child(2)'), `!!document.querySelector('.uad-concurrency') && !!document.querySelector('[aria-label="Ten-minute concurrency heatmap"]')`)
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
  const hover = async (selector: string, fraction = .5) => {
    const point = await js<{ x: number; y: number }>(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing hover target: '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width*${fraction},y:r.top+r.height/2}})()`)
    window.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(point.x), y: Math.round(point.y) })
    await settle(150)
  }
  const metric = async (label: string) => {
    await js(`(()=>{const e=[...document.querySelectorAll('.usage-daily-metrics button')].find(e=>e.textContent===${JSON.stringify(label)});if(!e)throw new Error('Missing metric');e.click()})()`)
    await settle(100)
  }
  await click('.usage-range button:first-child')
  await check('Tool run latency row', () => hover('.uad-latency-chart g[aria-label^="Tool run:"]'), `document.querySelector('.uad-latency-readout').textContent.startsWith('Tool run:') && !!document.querySelector('.uad-latency-chart .uad-tooltip')`, true)
  await check('hourly activity smooth profile', async () => { await click('[aria-label="Activity view"] button:first-child'); await hover('.uad-profile-line') }, `!!document.querySelector('.uad-profile-fill') && document.querySelector('.uad-profile-line').getAttribute('d').includes('C')`, true)
  await check('concurrency fixed level legend', () => click('[aria-label="Activity view"] button:nth-child(2)'), `(()=>{const section=document.querySelector('[aria-label="Activity"]');return [...section.querySelectorAll('.uad-legend li')].map(e=>e.textContent).join(',')==='1,2,3,4,5+' && !!section.querySelector('[aria-label="Ten-minute concurrency heatmap"]')})()`, true)
  await check('model chip hover and off swatch', async () => { await hover('.uad-model-chips button'); await click('.uad-model-chips button') }, `(()=>{const e=document.querySelector('.uad-model-chips button');const s=getComputedStyle(e,'::before');return e.getAttribute('aria-pressed')==='false' && s.content!=='none' && s.backgroundColor==='rgba(0, 0, 0, 0)' && s.boxShadow!=='none' && getComputedStyle(e).opacity==='1'})()`, true)
  await check('integration midpoint tooltip', () => hover('.uas-integrations .uas-card:nth-child(2) .uas-pick'), `!!document.querySelector('.uas-integrations .uas-card:nth-child(2) .uas-tip') && !!document.querySelector('.uas-integrations .uas-card:nth-child(2) .uas-crosshair line') && document.querySelectorAll('.uas-integrations .uas-card:nth-child(2) .uas-crosshair circle').length>0`, true)
  await check('session error meter and sort arrow', () => click('.uas-switch button:nth-child(2)'), `(()=>{const th=[...document.querySelectorAll('.uas-sessions thead th')].find(e=>e.textContent==='Tool errors');return !!document.querySelector('.uas-error-meter rect[width]:not([width="0"])') && th.getAttribute('aria-sort')==='descending' && getComputedStyle(th.querySelector('button'),'::after').content.includes('↓')})()`, true)
  await check('expanded session composition shares', async () => {
    await js(`(()=>{const e=document.querySelector('.uas-session-row');e.scrollIntoView({block:'center'});if(e.getAttribute('aria-expanded')!=='true')e.click()})()`)
    await settle(100)
    await hover('.uas-detail .uas-composition rect')
  }, `!!document.querySelector('.uas-detail .uas-composition rect') && document.querySelectorAll('.uas-detail .uas-composition-list .uas-key').length>0 && document.querySelector('.uas-detail .uas-composition-list').textContent.includes('%') && !!document.querySelector('.uas-source-tip')`, true)
  await check('daily line pinned rule', async () => {
    await metric('Sessions')
    await js(`(()=>{const e=document.querySelector('.usage-daily-hit');e.scrollIntoView({block:'center'});if(e.getAttribute('aria-pressed')!=='true')e.dispatchEvent(new MouseEvent('click',{bubbles:true}))})()`)
    await hover('.usage-daily-hit rect')
  }, `!!document.querySelector('.usage-daily-pin-rule') && !!document.querySelector('.usage-daily-tooltip') && !!document.querySelector('.usage-daily-hit[aria-pressed="true"]')`, true)
  await check('daily stacked tooltip total', async () => {
    await metric('Tokens')
    await click('.usage-daily-group button:nth-child(2)')
    await hover('.usage-daily-hit rect')
  }, `document.querySelector('.usage-daily-tooltip')?.textContent.includes('Total')===true`, true)
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
  const thresholds: any[] = []
  for (const contentWidth of [639, 640, 641, 759, 760, 761]) {
    await prepareSurface(contentWidth + 344, 'light', false)
    await click('.usage-range button:first-child')
    for (let attempt = 0; attempt < 3; attempt++) {
      const size = await js<number[]>(`[innerWidth,innerHeight,document.querySelector('.usage-content').getBoundingClientRect().width]`)
      if (Math.abs(contentWidth - size[2]!) <= .5) break
      window.setContentSize(Math.round(size[0]! + contentWidth - size[2]!), size[1]!)
      await settle(200)
    }
    await settle(450)
    await js(`document.querySelector('.usage-page').scrollTop=0`)
    const name = `threshold-content-${contentWidth}`
    await photograph(name)
    thresholds.push({ targetContentWidth: contentWidth, ...await capturePrototype(name, contentWidth + 344, 'light', '7d'), appFrames: [name + '.png'] })
    writeFileSync(join(outDir, 'prototype-thresholds.json'), JSON.stringify(thresholds, null, 2))
  }
  const designFailures = [
    ...[...comparisons, ...thresholds].flatMap(comparison => comparison.designFailures.map((failure: DesignFailure) => ({ state: comparison.name, ...failure, appFrames: comparison.appFrames, prototypeFrames: comparison.prototypeFrames }))),
    ...[...interactions.map((item, i) => ({ ...item, frame: `interaction-${i + 1}.png` })), ...fidelityInteractions.map((item, i) => ({ ...item, frame: `fidelity-interaction-${i + 1}.png` }))].flatMap(item => item.designFailures.map((failure: DesignFailure) => ({ state: `interaction:${item.label}`, ...failure, appFrames: [item.frame], prototypeFrames: [] }))),
  ]
  writeFileSync(join(outDir, 'design-failures.json'), JSON.stringify(designFailures, null, 2))
  writeFileSync(join(outDir, 'result.json'), JSON.stringify({
    ok: results.length === widths.length * 12 && comparisons.length === results.length && interactions.length === 13 && fidelityInteractions.length === 9 && interactions.every(item => item.passed) && fidelityInteractions.every(item => item.passed) && designFailures.length === 0 && !window.isVisible() && !prototypeShown && !prototype.isVisible(),
    designFailures,
    combinations: results.length, interactions: interactions.length,
    prototypeComparisons: comparisons.length, fidelityInteractions: fidelityInteractions.length,
    thresholdProbes: thresholds.length,
    failedInteractions: interactions.filter(item => !item.passed).map(item => item.label),
    failedFidelityInteractions: fidelityInteractions.filter(item => !item.passed).map(item => item.label),
    lifecycle: { appVisible: window.isVisible(), prototypeEverShown: prototypeShown, prototypeVisible: prototype.isVisible() },
  }, null, 2))
  } finally {
    if (!prototype.isDestroyed()) prototype.destroy()
    await server.close()
  }
}
