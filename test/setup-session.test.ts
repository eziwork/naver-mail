import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SetupServer } from "../src/setup-session.js";

async function poll(url:string) {
  for(let i=0;i<100;i++) {
    const state=await (await fetch(url+"/api/status")).json() as {state:string;checks:Record<string,string>;account?:string;error?:{code:string;message:string}};
    if(state.state!=="checking")return state;
    await delay(10);
  }
  throw new Error("Setup did not settle");
}
function post(url:string, overrides:Record<string,string>={}) {
  return fetch(url+"/api/connect",{method:"POST",headers:{origin:new URL(url).origin},body:new URLSearchParams({email:"fixture@naver.com",appPassword:"fixture-only-password",acknowledge:"yes",...overrides})});
}
test("setup reports separate checks, prevents duplicate submissions and never returns a password",async()=>{
  let verifyCount=0,saved=0,release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const setup=new SetupServer({save:async(email,password)=>{assert.equal(email,"fixture@naver.com");assert.equal(password,"fixture-only-password");saved++;}}, {
    openBrowser:async()=>false,
    verify:async(_credentials,progress)=>{verifyCount++;progress?.("imap");await gate;progress?.("smtp");}
  });
  try {
    const opened=await setup.open();assert.equal(opened.browserOpened,false);assert.ok(opened.url);
    const started=await post(opened.url);assert.equal(started.status,202);
    assert.doesNotMatch(await started.text(),/fixture-only-password/u);
    assert.equal((await post(opened.url)).status,409);
    assert.equal(verifyCount,1);release();
    const state=await poll(opened.url);assert.equal(state.state,"connected");
    assert.deepEqual(state.checks,{imap:"done",smtp:"done",storage:"done"});assert.equal(saved,1);
    assert.equal((await post(opened.url)).status,200);assert.equal(saved,1);
  } finally {release();await setup.close();}
});
test("setup rejects foreign origins and invalid input without contacting Naver",async()=>{
  let calls=0;
  const setup=new SetupServer({save:async()=>{}},{openBrowser:async()=>false,verify:async()=>{calls++;}});
  try {
    const {url}=await setup.open();assert.ok(url);
    assert.equal((await fetch(url+"/api/connect",{method:"POST",headers:{origin:"https://example.invalid"},body:new URLSearchParams({})})).status,403);
    assert.equal((await post(url,{email:"bad@example.com"})).status,400);
    assert.equal(calls,0);
    const page=await fetch(url);assert.match(page.headers.get("content-security-policy")!,/script-src 'self'/u);
    assert.equal((await fetch(url+"/assets/unknown.js")).status,404);
  }finally{await setup.close();}
});
test("setup authentication and keyring errors identify the failed stage",async()=>{
  const setup=new SetupServer({save:async()=>{throw new Error("private-keyring-data");}},{openBrowser:async()=>false,verify:async(_c,p)=>{p?.("imap");p?.("smtp");}});
  try {
    const {url}=await setup.open();assert.ok(url);await post(url);const state=await poll(url);
    assert.equal(state.state,"failed");assert.equal(state.checks.storage,"error");
    assert.doesNotMatch(JSON.stringify(state),/private-keyring-data|fixture-only-password/u);
  }finally{await setup.close();}
});
test("closing setup during verification prevents credential writes",async()=>{
  let saved=0,release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const setup=new SetupServer({save:async()=>{saved++;}},{openBrowser:async()=>false,verify:async()=>gate});
  const {url}=await setup.open();assert.ok(url);await post(url);await setup.close();release();await delay(20);assert.equal(saved,0);
});
test("setup expires and releases its listener",async()=>{
  const setup=new SetupServer({save:async()=>{}},{openBrowser:async()=>false,ttlMs:30});
  const {url}=await setup.open();assert.ok(url);await delay(70);assert.equal(setup.isActive,false);assert.equal(setup.status()?.state,"expired");
});

test("reopening preserves deadline and reports page arrival independently of launcher",async()=>{
  const setup=new SetupServer({save:async()=>{}},{openBrowser:async()=>true});
  try {
    const first=await setup.open();assert.ok(first.url);assert.equal(first.pageOpened,false);
    await fetch(first.url);await delay(10);
    const second=await setup.open();assert.equal(second.url,first.url);assert.equal(second.expiresAt,first.expiresAt);
    assert.equal(second.pageOpened,true);assert.equal(setup.status()?.expiresAt,first.expiresAt);
  }finally{await setup.close();}
});
test("completed setup reopens the same session during its grace period",async()=>{
  const setup=new SetupServer({save:async()=>{}},{openBrowser:async()=>false,verify:async(_c,p)=>{p?.("imap");p?.("smtp");},completionGraceMs:1000});
  try {
    const first=await setup.open();assert.ok(first.url);await post(first.url);await poll(first.url);
    const again=await setup.open();assert.equal(again.url,first.url);assert.equal(setup.status()?.state,"connected");
  }finally{await setup.close();}
});
test("expiry during checking prevents saving even when verification later resolves",async()=>{
  let writes=0,release!:()=>void;
  const gate=new Promise<void>(r=>{release=r;});
  const setup=new SetupServer({save:async()=>{writes++;}},{openBrowser:async()=>false,ttlMs:80,verify:async()=>gate});
  try {
    const {url}=await setup.open();assert.ok(url);await post(url);await delay(140);release();await delay(10);
    assert.equal(writes,0);assert.equal(setup.isActive,false);assert.equal(setup.status()?.state,"expired");
  }finally{release();await setup.close();}
});
