import { getLocalMonthYear } from 'src/constants/common.js'

export const WEB_SEARCH_TOOL_NAME = 'WebSearch'

export function getWebSearchPrompt(): string {
  const currentMonthYear = getLocalMonthYear()
  return `
- Search the web and use compact results to inform responses.
- Use this for current documentation, package/API references, GitHub or repository docs, changelogs, issue/error lookup, and general web research.
- Results include titles, URLs, dates when available, authors when available, and bounded highlights. Full page text and summaries are not returned in v1.
- Use targeted queries. For recent docs or current events, include the current year when it helps.
- Use include_domains when the relevant site is known, such as official docs or GitHub repository documentation.
- Use freshness when recency matters.

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
