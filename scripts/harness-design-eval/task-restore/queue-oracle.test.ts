import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { queueFiles } from './queue-fixture.js'
import { queueChecks, queueOracleProgram } from './queue-oracle.js'
import { grade } from './grade.js'

// Grader authoring gate: a broken implementation must fail behavior checks;
// an independent contract implementation must pass them before model runs.
// This protects the oracle from impossible expectations or syntax errors.
// Reference code is a test file denied by the agent sandbox, never a seed.
const referenceQueue = `import type {Job,Journal,Submission} from './types';
const copy=<T>(v:T):T=>structuredClone(v);
const time=(n:number)=>{if(!Number.isSafeInteger(n)||n<0)throw Error('time')};
const terminal=(s:string)=>['failed','cancelled','blocked','succeeded'].includes(s);
export class Queue {
 private jobs=new Map<string,Job>();private seq=0;
 constructor(private journal:Journal){for(const e of journal.read()){if(e.seq!==this.seq+1)throw Error('seq');this.seq=e.seq;this.jobs.set(e.job.id,copy(e.job))}}
 get(id:string){const j=this.jobs.get(id);return j?copy(j):undefined}
 private save(j:Job){const next=copy(j);this.journal.append({seq:this.seq+1,job:copy(next)});this.seq++;this.jobs.set(next.id,next);return copy(next)}
 enqueue(s:Submission):Job{
  if(s.key){const old=[...this.jobs.values()].find(j=>j.key===s.key);if(old)return copy(old)}
  const dep=s.dependsOn??[],priority=s.priority??0,availableAt=s.availableAt??0,maxAttempts=s.maxAttempts??3;
  if(typeof s.id!=='string'||!s.id||this.jobs.has(s.id)||s.key!==undefined&&(typeof s.key!=='string'||!s.key)||!Array.isArray(dep)||dep.some(d=>typeof d!=='string'||!d)||new Set(dep).size!==dep.length||!Number.isSafeInteger(priority)||!Number.isSafeInteger(maxAttempts)||maxAttempts<1)throw Error('submission');time(availableAt);
  const path=new Set<string>(),done=new Set<string>();
  const visit=(id:string)=>{if(path.has(id))throw Error('cycle');if(done.has(id))return;path.add(id);for(const d of id===s.id?dep:this.jobs.get(id)?.dependsOn??[])visit(d);path.delete(id);done.add(id)};visit(s.id);
  return this.save({id:s.id,...(s.key?{key:s.key}:{}),dependsOn:copy(dep),priority,availableAt,maxAttempts,attempts:0,status:'queued',order:this.seq+1})
 }
 private retry(j:Job,at:number){const n=copy(j);delete n.lease;if(j.attempts>=j.maxAttempts)n.status='failed';else{n.status='queued';n.availableAt=at+100*2**(j.attempts-1)}return this.save(n)}
 claim(now:number,leaseMs:number){time(now);time(leaseMs);if(leaseMs===0)throw Error('lease');time(now+leaseMs);
  for(const j of [...this.jobs.values()])if(j.status==='running'&&j.lease!.until<=now)this.retry(j,j.lease!.until);
  let changed=true;while(changed){changed=false;for(const j of [...this.jobs.values()])if(j.status==='queued'&&j.dependsOn.some(d=>['failed','cancelled','blocked'].includes(this.jobs.get(d)?.status??''))){this.save({...j,status:'blocked'});changed=true}}
  const j=[...this.jobs.values()].filter(j=>j.status==='queued'&&j.availableAt<=now&&j.dependsOn.every(d=>this.jobs.get(d)?.status==='succeeded')).sort((a,b)=>b.priority-a.priority||a.order-b.order)[0];
  if(!j)return;return this.save({...j,status:'running',attempts:j.attempts+1,lease:{token:j.id+':'+(j.attempts+1),until:now+leaseMs}})
 }
 complete(id:string,token:string,now:number){time(now);const j=this.get(id);if(j?.status!=='running'||j.lease?.token!==token||now>=j.lease.until)return false;delete j.lease;this.save({...j,status:'succeeded'});return true}
 fail(id:string,token:string,now:number){time(now);const j=this.get(id);if(j?.status!=='running'||j.lease?.token!==token||now>=j.lease.until)return false;this.retry(j,now);return true}
 cancel(id:string,now:number){time(now);const j=this.get(id);if(!j||terminal(j.status))return false;delete j.lease;this.save({...j,status:'cancelled'});return true}
}
`
const referenceJournal = `import {existsSync,readFileSync,openSync,closeSync,writeSync,fsyncSync,truncateSync} from 'node:fs';
import type {Event,Journal} from './types';
export class FileJournal implements Journal {
 constructor(readonly path:string){}
 read():Event[]{if(!existsSync(this.path))return [];const text=readFileSync(this.path,'utf8'),end=text.lastIndexOf('\\n')+1;if(!end)return [];const rows=text.slice(0,end-1).split('\\n').map(x=>JSON.parse(x));for(let i=0;i<rows.length;i++)if(rows[i].seq!==i+1)throw Error('seq');return rows}
 append(e:Event){const rows=this.read();if(e.seq!==rows.length+1)throw Error('seq');if(existsSync(this.path)){const text=readFileSync(this.path,'utf8');truncateSync(this.path,Buffer.byteLength(text.slice(0,text.lastIndexOf('\\n')+1)))}const fd=openSync(this.path,'a');try{writeSync(fd,JSON.stringify(e)+'\\n');fsyncSync(fd)}finally{closeSync(fd)}}
}
`

async function check(reference: boolean) {
  const root = mkdtempSync('/private/tmp/queue-oracle-check-')
  try {
    for (const [path, body] of Object.entries(queueFiles)) {
      mkdirSync(join(root,path,'..'),{recursive:true});writeFileSync(join(root,path),body)
    }
    mkdirSync(join(root,'scratch'))
    if(reference){writeFileSync(join(root,'src/queue.ts'),referenceQueue);writeFileSync(join(root,'src/journal.ts'),referenceJournal)}
    const child = Bun.spawn([process.execPath,'--eval',queueOracleProgram],{cwd:root,env:{PATH:process.env.PATH!,TASK_ORACLE_TMP:join(root,'scratch')},stdout:'pipe',stderr:'pipe'})
    const [stdout,stderr,exit] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
    if(exit!==0)throw Error(stderr)
    return JSON.parse(stdout.trim()) as Record<string,boolean>
  } finally {rmSync(root,{recursive:true})}
}

test('queue contract oracle rejects the broken seed at independent lifecycle boundaries',async()=>{
  const result=await check(false)
  for(const name of ['dependencyOrder','cycleRejection','idempotentReplay','appendFailure','staleFence','retryDelay','cascade','journalTornTail'])expect(result[name]).toBe(false)
})
test('queue contract oracle accepts an independent complete implementation',async()=>{
  const result=await check(true)
  expect(Object.keys(result).sort()).toEqual([...queueChecks].sort())
  expect(Object.entries(result).filter(([,passed])=>!passed)).toEqual([])
})

// A valid explanation must not fail solely for using the specification's own
// "final fragment" wording instead of the grader's initial synonym list.
test('queue documentation accepts final-fragment recovery wording',()=>{
  const root=mkdtempSync('/private/tmp/queue-doc-grade-')
  try {
    for(const [path,body] of Object.entries(queueFiles)){mkdirSync(join(root,path,'..'),{recursive:true});writeFileSync(join(root,path),body)}
    writeFileSync(join(root,'README.md'),'Dependencies block until successful. Lease fencing rejects stale workers. Retry timing follows backoff. Idempotency survives restart. Append before updating memory. An unterminated final fragment is ignored during reads and removed before append; complete records are preserved.')
    expect(grade(root,'queue-resume',Object.fromEntries(queueChecks.map(k=>[k,true])),true,true).complete).toBe(true)
  } finally {rmSync(root,{recursive:true})}
})
