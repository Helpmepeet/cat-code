import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

const root = join(import.meta.dir, '../../..')
const fixtureRoot = mkdtempSync(join(tmpdir(), 'mcp-authority-review-'))
process.env.CLAUDE_CONFIG_DIR = join(fixtureRoot, 'config')
const project = join(fixtureRoot, 'project')
const childProject = join(project, 'child')
const marker = join(fixtureRoot, 'started')
mkdirSync(project)
mkdirSync(childProject)
mkdirSync(join(project, '.cat-code', 'agents'), {recursive:true})
writeFileSync(join(project, '.cat-code', 'agents', 'review-fixture.md'), '---\nname: review-fixture\ndescription: Deterministic review fixture\ntools: Read\nmcpServers:\n  - pending\n---\nReport the fixture result.\n')
const script = join(fixtureRoot, 'fixture.ts')
writeFileSync(script, `import { writeFileSync } from 'node:fs'; import { createInterface } from 'node:readline';
writeFileSync(${JSON.stringify(marker)}, String(process.pid));
for await (const line of createInterface({ input: process.stdin })) {
 const m = JSON.parse(line); if (m.id === undefined) continue;
 const result = m.method === 'initialize' ? {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'review',version:'1'}} : {tools:[{name:'ping',description:'fixture',inputSchema:{type:'object',properties:{}}}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
}`)
writeFileSync(join(project, '.mcp.json'), JSON.stringify({mcpServers:{pending:{command:process.execPath,args:[script]}}}))
writeFileSync(join(childProject, '.mcp.json'), JSON.stringify({mcpServers:{shared:{command:process.execPath,args:[script]}}}))

const configModule = await import(root + '/src/utils/config.ts')
mock.module(root + '/src/utils/config.ts', () => ({...configModule,getCurrentProjectConfig:()=>({}),getGlobalConfig:()=>({}),saveCurrentProjectConfig:()=>{},saveGlobalConfig:()=>{}}))
const cwdModule = await import(root + '/src/utils/cwd.ts')
let activeCwd = project
mock.module(root + '/src/utils/cwd.ts', () => ({
 ...cwdModule,
 getCwd:()=>activeCwd,
 runWithCwdOverride:async (cwd:string, fn:()=>Promise<unknown>)=>{
  const previous=activeCwd; activeCwd=cwd
  try{return await fn()}finally{activeCwd=previous}
 },
}))
const settingsModule = await import(root + '/src/utils/settings/settings.ts')
mock.module(root + '/src/utils/settings/settings.ts', () => ({...settingsModule,getInitialSettings:()=>({}),getSettings_DEPRECATED:()=>({}),getSettingsForSource:()=>null}))
const settingsConstants = await import(root + '/src/utils/settings/constants.ts')
mock.module(root + '/src/utils/settings/constants.ts', () => ({...settingsConstants,isSettingSourceEnabled:()=>true}))
const managedPath = await import(root + '/src/utils/settings/managedPath.ts')
mock.module(root + '/src/utils/settings/managedPath.ts', () => ({...managedPath,getManagedFilePath:()=>join(fixtureRoot,'absent-policy')}))
const pluginModule = await import(root + '/src/utils/plugins/pluginLoader.ts')
mock.module(root + '/src/utils/plugins/pluginLoader.ts', () => ({...pluginModule,loadAllPluginsCacheOnly:async()=>({enabled:[],errors:[]}),loadAllPlugins:async()=>({enabled:[],disabled:[],errors:[]})}))

const contextModule = await import(root + '/src/context.ts')
mock.module(root + '/src/context.ts', () => ({...contextModule,getUserContext:async()=>({}),getSystemContext:async()=>({})}))

let childTools: string[] = []
let childClients: any[] = []
const queryModule = await import(root + '/src/query.ts')
const { createAssistantMessage } = await import(root + '/src/utils/messages.ts')
mock.module(root + '/src/query.ts', () => ({...queryModule,query:async function* (p:any) { childTools=p.toolUseContext.options.tools.map((t:any)=>t.name); childClients=p.toolUseContext.options.mcpClients; yield createAssistantMessage({content:'fixture complete'}) }}))

const { getClaudeCodeMcpConfigs, getMcpConfigByName } = await import(root + '/src/services/mcp/config.ts')
const { createAppRuntimeMcpLifecycle } = await import(root + '/src/app-runtime/createAppRuntimeMcpLifecycle.ts')
const { createStore } = await import(root + '/src/state/store.ts')
const { getEmptyToolPermissionContext } = await import(root + '/src/Tool.ts')
const { AgentTool } = await import(root + '/src/tools/AgentTool/AgentTool.tsx')
const { getAgentDefinitionsWithOverrides } = await import(root + '/src/tools/AgentTool/loadAgentsDir.ts')
const { getDefaultAppState } = await import(root + '/src/state/AppState.tsx')
const { resetMcpConnectionAcquisitionStateForTest } = await import(root + '/src/services/mcp/client.ts')
const { resetStateForTests, switchSession } = await import(root + '/src/bootstrap/state.ts')
const { asSessionId } = await import(root + '/src/types/ids.ts')
;(globalThis as any).MACRO={VERSION:'review',FEEDBACK_CHANNEL:'test'}

afterAll(async()=>{await resetMcpConnectionAcquisitionStateForTest();mock.restore()})

test('public AgentTool does not start a project server excluded by the desktop explicit-approval lifecycle',async()=>{
 resetStateForTests()
 switchSession(asSessionId(randomUUID()), join(fixtureRoot, 'sessions'))
 const approved = await getClaudeCodeMcpConfigs({},Promise.resolve({}),{projectMcpApproval:'explicit-only'})
 expect(Object.keys(approved.servers)).toEqual([])
 expect(getMcpConfigByName('pending')?.scope).toBe('project')
 const store = createStore({...getDefaultAppState(),toolPermissionContext:getEmptyToolPermissionContext()} as any)
 const lifecycle = createAppRuntimeMcpLifecycle(store)
 await lifecycle.prepare()
 lifecycle.start()
 await Bun.sleep(10)
 expect(existsSync(marker)).toBe(false)
 const agentDefinitions=await getAgentDefinitionsWithOverrides(project)
 const agent=agentDefinitions.activeAgents.find((a:any)=>a.agentType==='review-fixture')
 expect(agent?.source).toBe('projectSettings')
 expect(agent?.mcpServers).toEqual(['pending'])
 expect(agent?.requiredMcpServers).toBeUndefined()
 const options={commands:[],debug:false,verbose:false,mainLoopModel:'claude-haiku-4-5-20251001',tools:[],thinkingConfig:{type:'disabled'},mcpClients:[],mcpResources:{},getMcpRuntimeSnapshot:lifecycle.getSnapshot,isNonInteractiveSession:true,agentDefinitions}
 const context:any={options,abortController:new AbortController(),readFileState:new Map(),getAppState:store.getState,setAppState:store.setState,setInProgressToolUseIDs:()=>{},setResponseLength:()=>{},toolUseId:'fixture'}
 await AgentTool.call({subagent_type:'review-fixture',prompt:'Report the fixture result.',description:'Review fixture'}, context, async()=>({behavior:'allow',updatedInput:{}}) as any, undefined as any)
 expect(existsSync(marker)).toBe(false)
 expect(childTools).not.toContain('mcp__pending__ping')
 expect(lifecycle.getSnapshot().clients).toEqual([])
 console.log(JSON.stringify({agentSource:agent.source,parsedMcpServers:agent.mcpServers,explicitlyApprovedServers:Object.keys(approved.servers),childTools,fixtureStarted:existsSync(marker),desktopClients:lifecycle.getSnapshot().clients.length}))
 await lifecycle.dispose()
},15000)

test('public AgentTool binds a named MCP server to the inherited approved client across cwd changes',async()=>{
 resetStateForTests()
 switchSession(asSessionId(randomUUID()), join(fixtureRoot, 'sessions-authorized'))
 childTools=[]; childClients=[]
 const approvedClient:any={type:'connected',name:'shared',config:{command:process.execPath,args:['approved-fixture.ts'],scope:'project'},capabilities:{tools:{}},client:{request:async()=>({tools:[{name:'ping',description:'approved fixture',inputSchema:{type:'object',properties:{}}}]})},cleanup:async()=>{}}
 const snapshot:any={clients:[approvedClient],tools:[],commands:[],resources:{}}
 const agent:any={agentType:'authorized-fixture',source:'built-in',baseDir:'built-in',whenToUse:'fixture',tools:[],mcpServers:['shared'],getSystemPrompt:()=> 'fixture'}
 const permissionContext={...getEmptyToolPermissionContext(),additionalWorkingDirectories:new Map([[childProject,{path:childProject,source:'session'}]])}
 const store=createStore({...getDefaultAppState(),toolPermissionContext:permissionContext} as any)
 const options={commands:[],debug:false,verbose:false,mainLoopModel:'claude-haiku-4-5-20251001',tools:[],thinkingConfig:{type:'disabled'},mcpClients:[approvedClient],mcpResources:{},getMcpRuntimeSnapshot:()=>snapshot,isNonInteractiveSession:true,agentDefinitions:{activeAgents:[agent],allAgents:[agent]}}
 const context:any={options,abortController:new AbortController(),readFileState:new Map(),getAppState:store.getState,setAppState:store.setState,setInProgressToolUseIDs:()=>{},setResponseLength:()=>{},toolUseId:'authorized-fixture'}
 await AgentTool.call({subagent_type:'authorized-fixture',prompt:'Report the fixture result.',description:'Authorized fixture',cwd:childProject},context,async()=>({behavior:'allow',updatedInput:{}}) as any,undefined as any)
 expect(existsSync(marker)).toBe(false)
 expect(childTools).toContain('mcp__shared__ping')
 expect(childClients.filter(client=>client.name==='shared')).toContain(approvedClient)
 expect(childClients.filter(client=>client.name==='shared').every(client=>client===approvedClient)).toBe(true)
},15000)
