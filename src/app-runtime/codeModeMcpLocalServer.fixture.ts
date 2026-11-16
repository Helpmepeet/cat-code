import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const root = process.env.CODE_MODE_TEST_ROOT!
if (!root || process.env.HOME !== root) throw new Error('Isolated MCP server required')
const server = new Server({ name: 'isolated-records', version: '1' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const refreshed = await readFile(join(root, 'schema-refreshed'), 'utf8').then(() => true, () => false)
  return { tools: ['records', 'save'].map(name => ({
  name, description: `Synthetic ${name} integration tool`,
  annotations: { readOnlyHint: name === 'records', destructiveHint: false },
  inputSchema: { type: 'object', properties: { key: { type: 'string', enum: refreshed ? (process.env.CODE_MODE_MCP_NARROW === '1' ? ['replacement'] : ['sample', 'replacement']) : ['sample'] } }, required: ['key'], additionalProperties: false },
})) }
})
server.setRequestHandler(CallToolRequestSchema, async request => {
  const narrowed = process.env.CODE_MODE_MCP_NARROW === '1' &&
    await readFile(join(root, 'schema-refreshed'), 'utf8').then(() => true, () => false)
  if (narrowed && request.params.arguments?.key !== 'replacement') {
    return { isError: true, content: [{ type: 'text', text: 'CURRENT_SCHEMA_VALIDATION: key must be replacement' }] }
  }
  if (!['records', 'save'].includes(request.params.name) || request.params.arguments?.key !== 'sample') throw new Error('Invalid fixture request')
  await appendFile(join(root, 'mcp-calls.jsonl'), `${JSON.stringify({ ...request.params, serverPrincipal: process.env.CODE_MODE_MCP_SERVER_PRINCIPAL })}\n`)
  if (request.params.name === 'records' && process.env.CODE_MODE_MCP_GENERATION === '1') await appendFile(join(root, 'replacement-invocations'), 'called\n')
  if (request.params.name === 'save') await writeFile(join(root, 'workspace', 'mcp-effect.txt'), 'saved-by-real-mcp')
  if (request.params.name === 'save' && process.env.CODE_MODE_MCP_GENERATION === '1') await writeFile(join(root, 'schema-refreshed'), '2')
  return { content: [{ type: 'text', text: 'PRE_HOOK_PRIVATE_TEXT' }], structuredContent: { marker: 'PRE_HOOK_PRIVATE_DATA', rows: ['one', 'two'], count: 2 }, _meta: { secret: 'MCP_META_PRIVATE' } }
})
await server.connect(new StdioServerTransport())
