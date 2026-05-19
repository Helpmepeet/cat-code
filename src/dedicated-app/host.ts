import { dedicatedAppPlaceholderState } from './placeholderState.js'
import { renderDedicatedAppDocument } from './renderDocument.js'

export function serveDedicatedApp({
  port = Number(Bun.env.CAT_CODE_DEDICATED_APP_PORT ?? 3457),
  hostname = Bun.env.CAT_CODE_DEDICATED_APP_HOST ?? '127.0.0.1',
}: {
  port?: number
  hostname?: string
} = {}): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port,
    hostname,
    fetch(request) {
      const url = new URL(request.url)

      if (url.pathname === '/state.json') {
        return Response.json(dedicatedAppPlaceholderState)
      }

      if (url.pathname === '/' || url.pathname === '/index.html') {
        return new Response(
          renderDedicatedAppDocument(dedicatedAppPlaceholderState),
          {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          },
        )
      }

      return new Response('Not found', { status: 404 })
    },
  })
}

if (import.meta.main) {
  const server = serveDedicatedApp()
  console.log(`Dedicated app scaffold listening on ${server.url}`)
}
