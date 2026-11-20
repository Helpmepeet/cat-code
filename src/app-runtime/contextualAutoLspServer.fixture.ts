import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js'

const documents = new Map<string, string>()
const connection = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout))
connection.onRequest('initialize', () => ({ capabilities: { textDocumentSync: 1, documentSymbolProvider: true } }))
connection.onNotification('textDocument/didOpen', ({ textDocument }) => {
  documents.set(textDocument.uri, textDocument.text)
})
connection.onRequest('textDocument/documentSymbol', ({ textDocument }) => {
  const text = documents.get(textDocument.uri)
  if (!text) return []
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: text.length } }
  return [{ name: 'symbol_from_' + text.trim(), kind: 13, range, selectionRange: range }]
})
connection.onRequest('shutdown', () => null)
connection.onNotification('exit', () => process.exit(0))
connection.listen()
