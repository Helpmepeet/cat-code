import { getLocalMonthYear } from 'src/constants/common.js'
import type { APIProvider } from '../../utils/model/providers.js'

export const WEB_SEARCH_TOOL_NAME = 'WebSearch'

export function getWebSearchPrompt(provider?: APIProvider): string {
  const providerGuidance = provider === 'openai'
    ? 'Use OpenAI search with the invoking GPT model and its OpenAI account. include_domains and freshness are supported; exclude_domains is not supported.'
    : provider === 'bedrock'
      ? 'Native web search is unavailable on this Bedrock connection. Report that limitation; the tool does not switch accounts or search providers.'
      : provider
        ? 'Use Claude search with the invoking Claude model and its configured account. Use include_domains or exclude_domains, not both. Omit freshness; put the desired time period in query and verify source dates.'
        : "Use the invoking model's native search: OpenAI for GPT and Claude search for supported Claude connections. OpenAI supports include_domains and freshness; Claude supports include_domains or exclude_domains, not both, and does not support freshness."
  return `
- Search the web and use retrieved sources to inform responses.
- ${providerGuidance}
- Searches stay with the invoking provider. Native account, availability, and request failures are returned as errors; no automatic backend substitution occurs.
- Use this for current documentation, package/API references, GitHub or repository docs, changelogs, issue/error lookup, and general web research.
- Results include source titles and URLs, with available excerpts or a generated summary. A summary is not a directly read page. Use an appropriate source-reading tool to inspect pages and discussions.
- Start with the default cap of 10 results. max_results limits returned links up to 100; the provider may return fewer. For deeper research, refine queries and inspect relevant sources.
- Use include_domains when the relevant site is known, such as official docs or GitHub repository documentation.
- Request OpenAI freshness only when a date cutoff is needed. Current-information questions can use dates in query; verify dates in the sources.
- Full-page content, extended mode, and character-limit options are not supported by this tool. Read sources with a suitable page or service tool.
- Cite relevant source URLs as markdown hyperlinks. Cite only sources actually returned or read, distinguish excerpts and generated summaries from directly read content, and state remaining uncertainty.
- The current month is ${getLocalMonthYear()}. Use the current year when searching for recent information, documentation, changelogs, or current events.

When WebSearch results informed the answer, include a "Sources:" section. In it, list relevant URLs from the search results as markdown hyperlinks: [Title](URL). Do not cite sources that were not returned by WebSearch or otherwise read with a tool.
`
}
