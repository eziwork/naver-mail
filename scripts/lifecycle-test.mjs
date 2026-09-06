import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const testRoot=await mkdtemp(join(tmpdir(),'naver-mail-lifecycle-'));
const idleMs=process.argv.includes('--real-idle')?30_000:1_000;
const workers=new Set();const clients=[];
const workerInfo=async()=>{try{return JSON.parse(await readFile(join(testRoot,'worker.json'),'utf8'));}catch{return null;}};
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
try{
  for(let i=0;i<2;i++){
    const transport=new StdioClientTransport({command:join(root,'bin','naver-mail-bridge'),args:[],cwd:root,stderr:'pipe',env:{...process.env,CODEX_MCP_NODE_PATH:process.execPath,NAVER_MAIL_TEST_ROOT:testRoot,NAVER_MAIL_TEST_IDLE_MS:String(idleMs)}});
    const client=new Client({name:`lifecycle-${i}`,version:'0.2.0'});await client.connect(transport);clients.push({client,transport});
  }
  const tools=await Promise.all(clients.map(({client})=>client.listTools()));
  assert.deepEqual(tools.map(t=>t.tools.length),[12,12]);assert.equal(await workerInfo(),null,'discovery must not start Node');
  const started=performance.now();
  const results=await Promise.all(clients.map(({client})=>client.callTool({name:'send_plan_status',arguments:{planId:'nonexistent-audit-plan-000000'}})));
  const coldMs=Math.round(performance.now()-started);
  for(const result of results){assert.ok(!result.isError,JSON.stringify(result));assert.equal(JSON.parse(result.content[0].text).status,'expired');}
  const first=await workerInfo();assert.ok(first?.pid);workers.add(first.pid);
  await delay(idleMs+2_000);
  assert.equal(alive(first.pid),false,'Node must stop with stdio clients still connected');
  assert.equal(await workerInfo(),null);
  assert.equal((await clients[0].client.listTools()).tools.length,12);assert.equal(await workerInfo(),null);
  const resumed=await clients[0].client.callTool({name:'send_plan_status',arguments:{planId:'nonexistent-audit-plan-000000'}});assert.ok(!resumed.isError,JSON.stringify(resumed));
  const second=await workerInfo();assert.ok(second?.pid);workers.add(second.pid);assert.notEqual(first.pid,second.pid);
  // Kill only the disposable fixture worker, then verify recovery on the next request.
  process.kill(second.pid);await delay(250);
  const recovered=await clients[1].client.callTool({name:'send_plan_status',arguments:{planId:'nonexistent-audit-plan-000000'}});assert.ok(!recovered.isError,JSON.stringify(recovered));
  const third=await workerInfo();assert.ok(third?.pid);workers.add(third.pid);
  console.log(JSON.stringify({passed:true,clients:2,tools:12,idleMs,coldMs,discoveryNodeCount:0,idleNodeCount:0,recoveredAfterWorkerCrash:true}));
}finally{
  await Promise.allSettled(clients.map(({client})=>client.close()));
  for(const pid of workers){if(alive(pid)){try{process.kill(pid);}catch{}}}
  await delay(250);
  const resolved=join(tmpdir(),'naver-mail-lifecycle-');
  if(!testRoot.startsWith(resolved))throw new Error('Unexpected test directory');
  await rm(testRoot,{recursive:true,force:true});
}
