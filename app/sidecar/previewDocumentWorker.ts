import { MAX_DOCUMENT_INPUT_BYTES, MAX_DOCUMENT_OUTPUT_BYTES, parsePreviewDocumentWorkerRequest } from '../shared/previewDocument.js'
import { parsePreviewDocument } from './previewDocumentParser.js'

async function reply(line: string): Promise<void> {
  const input = parsePreviewDocumentWorkerRequest(JSON.parse(line))
  if (!input) throw new Error('Invalid document request')
  const result = JSON.stringify(parsePreviewDocument(input))
  if (Buffer.byteLength(result) > MAX_DOCUMENT_OUTPUT_BYTES) throw new Error('Document output limit')
  await new Promise<void>((resolve, reject) => process.stdout.write(`${result}\n`, error => error ? reject(error) : resolve()))
}
async function main(): Promise<void> {
  let pending = ''
  const decoder = new TextDecoder()
  for await (const chunk of Bun.stdin.stream()) {
    pending += decoder.decode(chunk, { stream: true })
    if (pending.length > Math.ceil(MAX_DOCUMENT_INPUT_BYTES / 3) * 4 + 1_024) throw new Error('Document input limit')
    let newline: number
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      if (line.length) await reply(line)
    }
  }
  pending += decoder.decode()
  if (pending.trim()) throw new Error('Unterminated document request')
}
void main().catch(() => { process.stderr.write('[preview-document-worker] failed\n'); process.exit(1) })
