// Isolated worker with fake credential methods; never opens a real keyring/browser.
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, copyFile, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const root=resolve(process.env.NAVER_MAIL_PACKAGE_ROOT??'.');
const fixture=await mkdtemp(join(tmpdir(),'naver-setup-life-'));
const plugin=join(fixture,'plugin'), stateDir=join(fixture,'state');
await mkdir(join(plugin,'bin'),{recursive:true});await mkdir(join(plugin,'dist'));
const binary=process.platform==='win32'?'naver-mail-bridge.exe':'naver-mail-bridge';
await copyFile(join(root,'bin',binary),join(plugin,'bin',binary));
const launcher=join(fixture,'launcher.mjs');
await writeFile(launcher,`import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
const child=spawn(process.argv[2],[],{detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
writeFileSync(process.argv[3],String(child.pid));process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
child.once('exit',()=>process.exit(0));process.stdin.once('end',()=>child.stdin.end());`);
const moduleUrl=name=>pathToFileURL(join(root,'dist',name)).href;
await writeFile(join(plugin,'dist','daemon.js'),`
import {CredentialStore} from ${JSON.stringify(moduleUrl('credentials.js'))};
import {SetupServer} from ${JSON.stringify(moduleUrl('setup-session.js'))};
CredentialStore.prototype.load=async()=>null;
CredentialStore.prototype.save=async()=>{throw new Error('unexpected credential write');};
const open=SetupServer.prototype.open;
SetupServer.prototype.open=function(){this.options.openBrowser=async()=>false;this.options.ttlMs=90000;return open.call(this);};
await import(${JSON.stringify(moduleUrl('worker.js'))});
`);
const clients=[];let worker;
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
async function connect() {
  const transport=new StdioClientTransport({command:process.execPath,args:[launcher,join(plugin,'bin',binary),join(fixture,'bridge.pid')],cwd:plugin,env:{...process.env,CODEX_MCP_NODE_PATH:process.execPath,NAVER_MAIL_TEST_ROOT:stateDir,NAVER_MAIL_TEST_IDLE_MS:'1000'}});
  const client=new Client({name:'setup-lifecycle-fixture',version:'0.2.1'});await client.connect(transport);clients.push(client);return {client,transport};
}
try {
  const first=await connect();
  const opened=JSON.parse((await first.client.callTool({name:'open_setup',arguments:{}})).content[0].text);
  assert.ok(opened.url);
  worker=JSON.parse(await readFile(join(stateDir,'worker.json'),'utf8'));
  await fetch(opened.url);
  if(process.platform!=='win32') process.kill(-Number(await readFile(join(fixture,'bridge.pid'),'utf8')),'SIGTERM');
  await first.client.close();
  await delay(2500);
  assert.ok(alive(worker.pid),'setup must survive host/process-group shutdown and idle timer');
  assert.equal((await fetch(opened.url+'/api/status')).status,200);
  const second=await connect();
  const reopened=JSON.parse((await second.client.callTool({name:'open_setup',arguments:{}})).content[0].text);
  assert.equal(reopened.url,opened.url);assert.equal(reopened.expiresAt,opened.expiresAt);assert.equal(reopened.pageOpened,true);
  assert.equal(JSON.parse(await readFile(join(stateDir,'worker.json'),'utf8')).pid,worker.pid);
  await fetch(opened.url+'/api/close',{method:'POST',headers:{origin:new URL(opened.url).origin},body:new URLSearchParams({close:'yes'})});
  await delay(2500);assert.equal(alive(worker.pid),false);
  console.log(JSON.stringify({passed:true,platform:process.platform,setupSurvivesHostExit:true,reusedSession:true,idleCleanup:true,processGroupTest:process.platform!=='win32'}));
} finally {
  await Promise.allSettled(clients.map(c=>c.close()));
  if(worker&&alive(worker.pid))process.kill(worker.pid);
  await delay(300);
  if(!fixture.startsWith(join(tmpdir(),'naver-setup-life-')))throw new Error('Unsafe fixture cleanup');
  await rm(fixture,{recursive:true,force:true});
}
