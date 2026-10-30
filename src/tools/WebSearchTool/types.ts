export type WebSearchFreshness = 'day' | 'week' | 'month' | 'year' | 'any'
export type WebSearchMode = 'standard' | 'extended'
export type WebSearchProvider = 'claude' | 'openai' | 'exa'

export type WebSearchInput = {
  query: string
  max_results?: number
  include_domains?: string[]
  exclude_domains?: string[]
  freshness?: WebSearchFreshness
  mode?: WebSearchMode
  content?: 'highlights' | 'text'
  max_characters?: number
}

export type WebSearchResult = {
  title: string
  url: string
  publishedDate?: string
  author?: string
  highlights?: string[]
  text?: string
}

export type WebSearchOutput = {
  query: string
  results: WebSearchResult[]
  durationSeconds: number
  summary?: string
  provider?: WebSearchProvider
  fallbackReason?: string
}
