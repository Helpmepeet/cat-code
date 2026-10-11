// Evaluation-only, cold-process reader. No API/configuration from the user is
// inherited; the parent freezes a verified prefix into isolated scratch state.
globalThis.fetch = Object.assign(
  async () => { throw new Error('Offline audit forbids network') },
  { preconnect: () => { throw new Error('Offline audit forbids network') } },
)
const { loadTranscriptFile, buildConversationChain } = await import('../../src/utils/sessionStorage.js')
const { composition } = await import('./audit.js')
const { messages } = await loadTranscriptFile(process.argv[2]!, { strict: true, keepAllLeaves: true })
const leaf = messages.get(process.argv[3]! as never)
if (!leaf) throw new Error('Missing verified boundary predecessor')
const chain = buildConversationChain(messages, leaf)
// The production reader restores parallel sibling/results; linearize its
// selected ordering only for the local composition proxy, never on disk.
const projected = new Map<string, Record<string, unknown>>()
let parent: string | null = null
for (const row of chain) {
  projected.set(row.uuid, { ...row, parentUuid: parent })
  parent = row.uuid
}
console.log(JSON.stringify({ ...composition({ logicalParentUuid: parent }, projected), reconstruction: 'production selected transcript prefix; current wire-cap proxy' }))
