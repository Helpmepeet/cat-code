import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPreviewDocumentRunner } from './previewDocumentRunner.js'

test.skipIf(process.platform !== 'darwin')('document sandbox blocks file writes and a listening network destination, excludes tokens, reuses idle workers and reaps on abort', async () => {
  const root=await mkdtemp(join(tmpdir(),'catcode-document-gate-'))
  const path=join(root,'unchanged.txt');await writeFile(path,'original')
  const server=createServer(socket=>socket.end())
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  const port=(server.address() as {port:number}).port
  const runner=createPreviewDocumentRunner({command:process.execPath,args:[join(import.meta.dir,'previewDocumentRunner.fixture.ts')],cwd:root})
  const previous=process.env.PREVIEW_DOCUMENT_TEST_SECRET
  process.env.PREVIEW_DOCUMENT_TEST_SECRET='must-not-be-in-parser-env'
  const input=(value:unknown)=>({format:'csv' as const,bytes:Buffer.from(JSON.stringify(value))})
  try {
    // Positive control: the destination is listening and reachable outside the sandbox.
    await new Promise<void>((resolve,reject)=>{const socket=connect(port,'127.0.0.1',()=>{socket.destroy();resolve()});socket.once('error',reject)})
    const first=await runner.read(input({port,path}))
    expect(first.ok).toBe(true)
    if(!first.ok) throw new Error('Sandbox could not start; run outside the outer process sandbox')
    const observed=JSON.parse(first.table.rows[0]![0]!.text)
    expect(observed).toMatchObject({write:false,network:false})
    expect(observed.secret).toBeUndefined()
    expect(await readFile(path,'utf8')).toBe('original')
    const again=await runner.read(input({port,path}))
    expect(again.ok&&JSON.parse(again.table.rows[0]![0]!.text).pid).toBe(observed.pid)
    const hanging=runner.read(input({hang:true}))
    // Replacing a busy parse must kill it before a new worker can answer.
    await Bun.sleep(50)
    const replacement=runner.read(input({port,path}))
    expect(await hanging).toEqual({ok:false,reason:'cancelled'})
    const next=await replacement
    expect(next.ok).toBe(true)
    if(!next.ok) throw new Error('Replacement could not start')
    const pid=JSON.parse(next.table.rows[0]![0]!.text).pid
    expect(pid).not.toBe(observed.pid)
    expect(()=>process.kill(observed.pid,0)).toThrow()
    await runner.abort()
    expect(()=>process.kill(pid,0)).toThrow()
  } finally {
    await runner.abort();server.close();await rm(root,{recursive:true,force:true})
    if(previous===undefined)delete process.env.PREVIEW_DOCUMENT_TEST_SECRET
    else process.env.PREVIEW_DOCUMENT_TEST_SECRET=previous
  }
})
