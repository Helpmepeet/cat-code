import { writeFileSync } from 'node:fs'
import { connect } from 'node:net'
const decoder = new TextDecoder()
let pending = ''
for await (const chunk of Bun.stdin.stream()) {
  pending += decoder.decode(chunk,{stream:true})
  let index: number
  while((index=pending.indexOf('\n'))>=0) {
    const line=pending.slice(0,index);pending=pending.slice(index+1)
    const request=JSON.parse(line)
    const value=JSON.parse(Buffer.from(request.bytes,'base64').toString('utf8'))
    if(value.hang) { process.on('SIGTERM',()=>{}); await new Promise(()=>{}) }
    let write=false, network=false
    try { writeFileSync(value.path,'changed');write=true } catch {}
    network=await new Promise<boolean>(resolve=>{
      const socket=connect(value.port,'127.0.0.1')
      socket.once('connect',()=>{socket.destroy();resolve(true)})
      socket.once('error',()=>resolve(false))
      socket.setTimeout(1000,()=>{socket.destroy();resolve(false)})
    })
    const text=JSON.stringify({pid:process.pid,write,network,secret:process.env.PREVIEW_DOCUMENT_TEST_SECRET})
    process.stdout.write(JSON.stringify({ok:true,kind:'table',table:{rows:[[{text}]],columnCount:1,rowOffset:0,columnOffset:0,totalRows:1,truncated:false,sourceTruncated:false,sheets:[],merges:[]}})+'\n')
  }
}
