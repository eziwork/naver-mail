import assert from "node:assert/strict";
import test from "node:test";
import { SendPlanStore } from "../src/send-plan.js";
import { LIMITS } from "../src/constants.js";
import { SetupServer } from "../src/setup-session.js";

test("draft capacity is bounded and clearing releases every draft", async () => {
  const store = new SendPlanStore();
  try {
    for(let i = 0; i < LIMITS.sendPlansMax; i++) await store.prepare({to:["fixture@example.com"],subject:"fixture",text:"fixture"},"fixture@naver.com");
    assert.equal(store.activeCount, LIMITS.sendPlansMax);
    await assert.rejects(store.prepare({to:["fixture@example.com"],subject:"fixture",text:"fixture"},"fixture@naver.com"), /너무 많/u);
    store.clear(); assert.equal(store.activeCount,0);
  } finally { store.clear(); }
});

test("reopening an exhausted setup session provides a fresh token", async () => {
  const setup = new SetupServer({save:async()=>{}},{openBrowser:async()=>false,verify:async()=>{throw Object.assign(new Error("fixture authentication failed"),{code:"EAUTH"});}});
  try {
    const initial = await setup.open(); assert.ok(initial.url);
    for(let i=0;i<LIMITS.setupAttempts;i++) {
      await fetch(initial.url+"/api/connect",{method:"POST",headers:{origin:new URL(initial.url).origin},body:new URLSearchParams({email:"fixture@naver.com",appPassword:"fixture-password",acknowledge:"yes"})});
      assert.equal(setup.status()?.state,"failed");
    }
    const next = await setup.open(); assert.ok(next.url); assert.notEqual(next.url,initial.url); assert.equal(setup.status()?.state,"waiting");
  } finally { await setup.close(); }
});
