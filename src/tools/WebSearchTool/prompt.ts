import { getLocalMonthYear } from 'src/constants/common.js'

export const WEB_SEARCH_TOOL_NAME = 'WebSearch'

export function getWebSearchPrompt(): string {
  const currentMonthYear = getLocalMonthYear()
  return `
- Search the web and use retrieved sources to inform responses. Search works without an API key.
- Use this for current documentation, package/API references, GitHub or repository docs, changelogs, issue/error lookup, and general web research.
- Results include titles, URLs, dates and authors when available, and highlights or page text.
- Start with the default 10 results and compact highlights. Increase max_results up to 100 for broader coverage. Use content "text" to read fuller sources, with max_characters up to 50000 per result (default 10000 for text, 2000 for highlights). Page text can be incomplete if the source cannot be fully retrieved.
- Use targeted queries. For recent docs or current events, include the current year when it helps.
- Use include_domains when the relevant site is known, such as official docs or GitHub repository documentation.
- Use freshness when recency matters.
- Use mode "standard" by default. Use "extended" when results are thin or the task needs deeper reading; it defaults to 20 results and page text. With EXA_API_KEY configured, it also uses Exa deep search. Keyless extended mode uses ordinary search with broader coverage and more content.
- Free keyless access is rate-limited. Report a returned rate-limit error accurately; it does not mean internet access or all search tools are unavailable.

CRITICAL REQUIREMENT - You MUST follow this:
  - After answering the user's question, include a "Sources:" section at the end of your response when WebSearch results informed the answer.
  - In the Sources section, list relevant URLs from the search results as markdown hyperlinks: [Title](URL).
  - Do not cite sources that were not returned by WebSearch or otherwise read with a tool.

Usage notes:
  - Domain filtering supports include_domains and exclude_domains.
  - Freshness supports day, week, month, year, or any.
  - The current month is ${currentMonthYear}. Use the current year when searching for recent information, documentation, changelogs, or current events.
`
}
