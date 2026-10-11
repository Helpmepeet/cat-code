// Hidden contract checks; this file is denied to model/tool processes.
export const queueChecks = ['dependencyOrder','priorityOrder','fifoAfterRetry','futureAvailability','allDependencies',
  'unknownDependency','cycleRejection','invalidSubmissions','idempotentReplay','detachedReads','detachedEvents',
  'appendFailure','staleFence','expiredAck','retryDelay','lateExpiry','exhaustion','cancellation','cascade',
  'terminalAcks','invalidTimes','replaySequence','journalRoundtrip','journalTornTail','journalCorruption'] as const

export const queueOracleProgram = `
import {Queue} from './src/queue.ts';
import {FileJournal} from './src/journal.ts';
import {writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
const checks={};
const assert=(v)=>{if(!v)throw Error('contract')};
const eq=(a,b)=>assert(JSON.stringify(a)===JSON.stringify(b));
const throws=(f)=>{let did=false;try{f()}catch{did=true}assert(did)};
const test=(name,f)=>{try{f();checks[name]=true}catch{checks[name]=false}};
function memory(){const records=[];let fail=false;return {records,setFail:(v)=>fail=v,read:()=>structuredClone(records),append:(e)=>{if(fail)throw Error('disk full');records.push(structuredClone(e))}}}
function make(){const j=memory();return [new Queue(j),j]}
test('dependencyOrder',()=>{const[q]=make();q.enqueue({id:'b',dependsOn:['a'],priority:9});q.enqueue({id:'a'});const a=q.claim(0,20);eq(a.id,'a');assert(q.complete('a',a.lease.token,1));eq(q.claim(2,20).id,'b')});
test('priorityOrder',()=>{const[q]=make();q.enqueue({id:'a',priority:2});q.enqueue({id:'b',priority:9});q.enqueue({id:'c',priority:9});eq([q.claim(0,50).id,q.claim(0,50).id,q.claim(0,50).id],['b','c','a'])});
test('fifoAfterRetry',()=>{const[q]=make();q.enqueue({id:'a'});const a=q.claim(0,10);q.fail('a',a.lease.token,1);q.enqueue({id:'b'});eq(q.claim(101,10).id,'a')});
test('futureAvailability',()=>{const[q]=make();q.enqueue({id:'a',availableAt:10});eq(q.claim(9,1),undefined);eq(q.claim(10,1).id,'a')});
test('allDependencies',()=>{const[q]=make();q.enqueue({id:'a'});q.enqueue({id:'b'});q.enqueue({id:'c',dependsOn:['a','b'],priority:100});const a=q.claim(0,10);q.complete(a.id,a.lease.token,1);const b=q.claim(1,10);eq(b.id,'b');eq(q.claim(2,10),undefined);q.complete(b.id,b.lease.token,2);eq(q.claim(3,10).id,'c')});
test('unknownDependency',()=>{const[q]=make();q.enqueue({id:'b',dependsOn:['a']});eq(q.claim(0,10),undefined);q.enqueue({id:'a'});eq(q.claim(0,10).id,'a')});
test('cycleRejection',()=>{const[q,j]=make();q.enqueue({id:'a',dependsOn:['b']});q.enqueue({id:'b',dependsOn:['c']});const before=j.records.length;throws(()=>q.enqueue({id:'c',dependsOn:['a']}));eq(j.records.length,before);eq(q.get('c'),undefined);throws(()=>q.enqueue({id:'self',dependsOn:['self']}))});
test('invalidSubmissions',()=>{const[q,j]=make();for(const s of [{id:''},{id:'a',key:''},{id:'a',dependsOn:['x','x']},{id:'a',dependsOn:['']},{id:'a',maxAttempts:0},{id:'a',priority:0.5},{id:'a',availableAt:-1}])throws(()=>q.enqueue(s));eq(j.records.length,0);q.enqueue({id:'a'});throws(()=>q.enqueue({id:'a'}));eq(j.records.length,1)});
test('idempotentReplay',()=>{const[q,j]=make();q.enqueue({id:'a',key:'dedup'});const a=q.claim(0,10);q.complete('a',a.lease.token,1);const next=new Queue(j),before=j.records.length;eq(next.enqueue({id:'other',key:'dedup',maxAttempts:0}).id,'a');eq(j.records.length,before);eq(next.get('a').status,'succeeded')});
test('detachedReads',()=>{const[q]=make();const deps=['parent'];const a=q.enqueue({id:'a',dependsOn:deps});deps.push('bad');a.dependsOn.push('bad2');q.enqueue({id:'parent'});const p=q.claim(0,10);p.lease.until=999;p.status='succeeded';const read=q.get('a');read.dependsOn.length=0;eq(q.get('a').dependsOn,['parent']);eq(q.get('parent').lease.until,10);eq(q.get('parent').status,'running')});
test('detachedEvents',()=>{const records=[];const j={read:()=>[],append:e=>records.push(e)};const q=new Queue(j);q.enqueue({id:'a'});records[0].job.status='cancelled';records[0].job.dependsOn.push('bad');eq(q.get('a').status,'queued');eq(q.get('a').dependsOn,[])});
test('appendFailure',()=>{const[q,j]=make();q.enqueue({id:'a'});j.setFail(true);throws(()=>q.claim(0,10));eq(q.get('a').status,'queued');eq(q.get('a').attempts,0);throws(()=>q.enqueue({id:'b'}));eq(q.get('b'),undefined);j.setFail(false);const a=q.claim(0,10);eq(a.attempts,1);eq(j.records.map(e=>e.seq),[1,2]);j.setFail(true);throws(()=>q.complete('a',a.lease.token,1));eq(q.get('a').status,'running')});
test('staleFence',()=>{const[q,j]=make();q.enqueue({id:'a'});const first=q.claim(0,10);const next=new Queue(j),second=next.claim(110,10);assert(second.lease.token!==first.lease.token);const before=j.records.length;eq(next.complete('a',first.lease.token,111),false);eq(next.fail('a',first.lease.token,111),false);eq(j.records.length,before);assert(next.complete('a',second.lease.token,111))});
test('expiredAck',()=>{const[q,j]=make();q.enqueue({id:'a'});const a=q.claim(0,10),before=j.records.length;eq(q.complete('a',a.lease.token,10),false);eq(q.fail('a',a.lease.token,10),false);eq(j.records.length,before);eq(q.get('a').status,'running')});
test('retryDelay',()=>{const[q,j]=make();q.enqueue({id:'a'});let a=q.claim(0,10);q.fail('a',a.lease.token,2);eq(q.get('a').availableAt,102);eq(q.get('a').lease,undefined);const r=new Queue(j);eq(r.claim(101,10),undefined);a=r.claim(102,10);eq(a.attempts,2);r.fail('a',a.lease.token,103);eq(r.get('a').availableAt,303);eq(r.claim(302,10),undefined);eq(r.claim(303,10).attempts,3)});
test('lateExpiry',()=>{const[q]=make();q.enqueue({id:'a'});q.claim(0,10);const a=q.claim(1000,20);eq(a.id,'a');eq(a.attempts,2);eq(a.lease.until,1020)});
test('exhaustion',()=>{const[q]=make();q.enqueue({id:'a',maxAttempts:1});q.claim(0,10);eq(q.claim(10,10),undefined);eq(q.get('a').status,'failed');eq(q.get('a').lease,undefined);q.enqueue({id:'b',maxAttempts:1});const b=q.claim(11,10);q.fail('b',b.lease.token,12);eq(q.get('b').status,'failed');eq(q.claim(1000,10),undefined)});
test('cancellation',()=>{const[q,j]=make();q.enqueue({id:'a'});const a=q.claim(0,10);assert(q.cancel('a',1));eq(q.get('a').lease,undefined);eq(q.complete('a',a.lease.token,2),false);const before=j.records.length;eq(q.cancel('a',2),false);eq(q.cancel('unknown',2),false);eq(j.records.length,before)});
test('cascade',()=>{const[q]=make();q.enqueue({id:'c',dependsOn:['b'],priority:20});q.enqueue({id:'b',dependsOn:['a'],priority:10});q.enqueue({id:'a'});q.enqueue({id:'independent'});q.cancel('a',0);eq(q.claim(1,10).id,'independent');eq(q.get('b').status,'blocked');eq(q.get('c').status,'blocked')});
test('terminalAcks',()=>{const[q,j]=make();q.enqueue({id:'a'});const a=q.claim(0,10);q.complete('a',a.lease.token,1);const before=j.records.length;eq(q.complete('a',a.lease.token,2),false);eq(q.fail('a',a.lease.token,2),false);eq(q.claim(100,10),undefined);eq(j.records.length,before)});
test('invalidTimes',()=>{const[q,j]=make();q.enqueue({id:'a'});const before=j.records.length;for(const n of [-1,0.5,NaN,Infinity]){throws(()=>q.claim(n,10));throws(()=>q.complete('a','x',n));throws(()=>q.fail('a','x',n));throws(()=>q.cancel('a',n))}for(const lease of [0,-1,0.5])throws(()=>q.claim(0,lease));throws(()=>q.claim(Number.MAX_SAFE_INTEGER,1));eq(j.records.length,before)});
test('replaySequence',()=>{const[q,j]=make();q.enqueue({id:'a'});q.enqueue({id:'b'});const records=structuredClone(j.records);records[1].seq=4;throws(()=>new Queue({read:()=>records,append:()=>{throw Error('replay wrote')}}));const before=j.records.length;new Queue(j);eq(j.records.length,before)});
let fileNumber=0;const file=()=>join(process.env.TASK_ORACLE_TMP,'journal-'+fileNumber+++'.jsonl');
test('journalRoundtrip',()=>{const path=file(),j=new FileJournal(path);eq(j.read(),[]);const q=new Queue(j);q.enqueue({id:'a',key:'k'});const a=q.claim(0,10);const r=new Queue(new FileJournal(path));eq(r.get('a').lease,a.lease);assert(r.complete('a',a.lease.token,1));eq(new Queue(new FileJournal(path)).get('a').status,'succeeded');assert(readFileSync(path,'utf8').endsWith('\\n'))});
test('journalTornTail',()=>{const path=file(),q=new Queue(new FileJournal(path));q.enqueue({id:'a'});const valid=readFileSync(path,'utf8');writeFileSync(path,valid+'{"seq":2');let r=new Queue(new FileJournal(path));eq(r.get('a').status,'queued');r.enqueue({id:'b'});eq(new FileJournal(path).read().map(e=>e.seq),[1,2]);const complete=readFileSync(path,'utf8');writeFileSync(path,complete+JSON.stringify({seq:3,job:r.get('a')}));eq(new FileJournal(path).read().length,2);r=new Queue(new FileJournal(path));r.enqueue({id:'c'});eq(new FileJournal(path).read().map(e=>e.job.id),['a','b','c'])});
test('journalCorruption',()=>{const path=file(),j=new FileJournal(path);writeFileSync(path,'not json\\n');throws(()=>j.read());const[q,m]=make();q.enqueue({id:'a'});q.enqueue({id:'b'});m.records[1].seq=9;writeFileSync(path,m.records.map(e=>JSON.stringify(e)).join('\\n')+'\\n');throws(()=>j.read())});
console.log(JSON.stringify(checks));
`
