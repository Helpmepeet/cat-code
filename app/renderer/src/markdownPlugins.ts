import rehypeHighlight from 'rehype-highlight'

// Shared transcript/preview syntax highlighting. `detect:false` colors only
// explicitly-languaged fences; `ignoreMissing:true` leaves unknown languages as
// plain text instead of throwing during renderer or SSR rendering.
export const REHYPE_PLUGINS: [
  typeof rehypeHighlight,
  { detect: boolean; ignoreMissing: boolean },
][] = [[rehypeHighlight, { detect: false, ignoreMissing: true }]]
