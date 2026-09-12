import { existsSync, writeFileSync } from 'node:fs'

const [enteredFile, releaseFile] = process.argv.slice(2)
if (!enteredFile || !releaseFile) throw new Error('missing hook fixture arguments')
await Bun.stdin.text()
writeFileSync(enteredFile, String(process.pid))
while (!existsSync(releaseFile)) await Bun.sleep(20)
