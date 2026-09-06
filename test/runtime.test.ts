import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SendPlanStore } from "../src/send-plan.js";
import { OperationQueue, requestSignals } from "../src/operation.js";
import { getMailBatch } from "../src/mail-service.js";
import type { withImap } from "../src/naver-client.js";

test("expired drafts are evicted by a timer without a status call",async()=>{
  const store=new SendPlanStore(25);
  await store.prepare({to:["fixture@example.com"],subject:"test",text:"private fixture"},"a@naver.com");
  await delay(60);
  assert.equal((store as unknown as {plans:Map<string,unknown>}).plans.size,0);
});
test("drafts include full body and are bound to the sending account",async()=>{
  const store=new SendPlanStore();const body="body ".repeat(400);
  const prepared=await store.prepare({to:["fixture@example.com"],subject:"test",text:body},"a@naver.com");
  assert.equal(prepared.preview.textPreview,body.trim());assert.equal(prepared.preview.from,"a@naver.com");
  assert.throws(()=>store.take(prepared.preview.planId,"b@naver.com"),/계정/u);assert.equal(store.activeCount,0);
});
test("cancelled queued operations never execute after the queue advances",async()=>{
  const queue=new OperationQueue();let release!:()=>void,executed=false;
  const first=queue.run(()=>new Promise<void>(r=>{release=r;}));await delay(1);
  const abort=new AbortController();
  const second=requestSignals.run(abort.signal,()=>queue.run(async()=>{executed=true;}));
  abort.abort();release();await first;await assert.rejects(second,/취소/u);await queue.drain();assert.equal(executed,false);assert.equal(queue.pending,0);
});
test("batch reads use one connection and one read-only mailbox lock",async()=>{
  let connections=0,locks=0,releases=0;const fetched:number[]=[];
  const client={
    getMailboxLock:async(_mailbox:string,options:{readOnly:boolean})=>{locks++;assert.equal(options.readOnly,true);return {release:()=>{releases++;}};},
    fetchOne:async(uid:number)=>{fetched.push(uid);return {uid,bodyStructure:{type:"multipart/mixed",childNodes:[]},flags:new Set(),envelope:{}};}
  };
  const execute=(async(_credentials,callback)=>{connections++;return callback(client as never);}) as typeof withImap;
  const result=await getMailBatch({schema:1,email:"fixture@naver.com",appPassword:"fixture"},"INBOX",[10,11,12],false,execute);
  assert.equal(connections,1);assert.equal(locks,1);assert.equal(releases,1);assert.deepEqual(fetched,[10,11,12]);assert.equal(result.messages.length,3);
});
