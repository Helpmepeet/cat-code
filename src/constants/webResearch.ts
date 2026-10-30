import { TOOL_SEARCH_TOOL_NAME } from '../tools/ToolSearchTool/constants.js'
import { WEB_FETCH_TOOL_NAME } from '../tools/WebFetchTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from '../tools/WebSearchTool/prompt.js'

export function getWebResearchGuidance(enabledTools: ReadonlySet<string>): string | null {
  if (!enabledTools.has(WEB_SEARCH_TOOL_NAME)) return null

  const discovery = enabledTools.has(TOOL_SEARCH_TOOL_NAME)
    ? `If ${WEB_SEARCH_TOOL_NAME} is deferred, load it with ${TOOL_SEARCH_TOOL_NAME} using "select:${WEB_SEARCH_TOOL_NAME}". Deferred does not mean unavailable.\n\n`
    : ''
  const reading = enabledTools.has(WEB_FETCH_TOOL_NAME)
    ? `Read supplied URLs directly with ${WEB_FETCH_TOOL_NAME}. Use it to verify exact quotes or details a search result does not establish.`
    : 'Request fuller source text before relying on an exact quote or details the search result does not establish.'

  return `# Web research
You must use ${WEB_SEARCH_TOOL_NAME} before answering or choosing an implementation when:
- The user asks you to search, look up, verify online, find sources, or get the latest information.
- The task depends on changeable external facts that supplied or already-read sources do not establish: current releases, version-sensitive APIs, prices, availability, events, or rules.
- You are uncertain about an external fact or unfamiliar library/error, or recommendations depend on current options, and available material does not settle it.
- Public sources needed as evidence have not been supplied or located.

Use provided material, already-read sources, repository source, and installed dependencies directly for self-contained edits and stable explanations they already settle. Check the installed or chosen version before researching an external software contract. Honor requests to stay offline.

${discovery}Use targeted queries, prefer primary sources and official documentation, and check dates and versions. Keep queries limited to the public information needed for the task. ${reading} If results are thin, off-target, or conflicting, refine the query or check another source before concluding. Stop when the needed claims are supported. Cite sources you actually consulted, distinguish evidence from inference, and state what remains unverified if search fails.`
}
