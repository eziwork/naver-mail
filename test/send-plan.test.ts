import assert from "node:assert/strict";
import test from "node:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { SendPlanStore, testing } from "../src/send-plan.js";

test("creates a single-use send plan", async () => {
  const store = new SendPlanStore();
  const prepared = await store.prepare({
    to: ["USER@EXAMPLE.COM"],
    subject: "테스트",
    text: "안녕하세요."
  }, "fixture@naver.com");

  assert.equal(prepared.preview.to[0], "user@example.com");
  assert.equal(store.status(prepared.preview.planId).status, "prepared");
  const message = store.take(prepared.preview.planId, "fixture@naver.com");
  assert.equal(message.subject, "테스트");
  assert.throws(() => store.take(prepared.preview.planId, "fixture@naver.com"), /만료/u);
});

test("rejects header injection and invalid recipients", async () => {
  const store = new SendPlanStore();
  await assert.rejects(
    store.prepare({ to: ["not-an-email"], subject: "hello", text: "body" }, "fixture@naver.com"),
    /유효하지 않은 수신자/u
  );
  const prepared = await store.prepare({
    to: ["user@example.com"],
    subject: "Hello\r\nBcc: attacker@example.com",
    text: "body"
  }, "fixture@naver.com");
  assert.equal(prepared.preview.subject, "Hello  Bcc: attacker@example.com");
});

test("prepared plan expires from status after it is consumed", async () => {
  const store = new SendPlanStore();
  const prepared = await store.prepare({ to: ["user@example.com"], subject: "hello", text: "body" }, "fixture@naver.com");
  assert.equal(store.status(prepared.preview.planId).status, "prepared");
  store.take(prepared.preview.planId, "fixture@naver.com");
  assert.equal(store.status(prepared.preview.planId).status, "expired");
});

test("blocks outgoing attachments from application and credential directories", () => {
  assert.throws(
    () => testing.assertSafeOutgoingAttachmentPath(join(homedir(), "AppData", "Local", "secret.txt")),
    /자격 증명이나 애플리케이션 설정/u
  );
});

