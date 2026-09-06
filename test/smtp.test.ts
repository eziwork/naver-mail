import assert from "node:assert/strict";
import test from "node:test";
import { sendNaverMail } from "../src/naver-client.js";
import { UserFacingError } from "../src/errors.js";

const credentials = {schema: 1 as const, email: "fixture@naver.com", appPassword: "fixture-only"};
const message = {to: ["a@example.com", "b@example.com"], cc: [], bcc: [], subject: "fixture", text: "fixture", attachments: []};
function fixture(result: unknown, failure?: Error) {
  let sends = 0, closes = 0;
  const factory = (() => ({
    sendMail: async () => { sends++; if (failure) throw failure; return result; },
    close: () => { closes++; }
  })) as unknown as NonNullable<Parameters<typeof sendNaverMail>[2]>;
  return {factory, counts: () => ({sends, closes})};
}

test("SMTP partial acceptance reports accepted and rejected recipients without replay", async () => {
  const transport = fixture({accepted: ["a@example.com"], rejected: ["b@example.com"], messageId: "fixture"});
  const result = await sendNaverMail(credentials, message, transport.factory);
  assert.equal(result.sent, true);
  assert.equal(result.deliveryStatus, "partial");
  assert.deepEqual(result.rejected, ["b@example.com"]);
  assert.deepEqual(transport.counts(), {sends: 1, closes: 1});
});

test("SMTP disconnect after dispatch is uncertain and never retried", async () => {
  const transport = fixture(undefined, Object.assign(new Error("fixture socket disconnected"), {code: "ECONNRESET"}));
  await assert.rejects(sendNaverMail(credentials, message, transport.factory), (error: unknown) => error instanceof UserFacingError && error.code === "SEND_RESULT_UNKNOWN");
  assert.deepEqual(transport.counts(), {sends: 1, closes: 1});
});

test("SMTP explicit authentication failure stays distinct from uncertain delivery", async () => {
  const failure = Object.assign(new Error("fixture authentication failed"), {code: "EAUTH"});
  const transport = fixture(undefined, failure);
  await assert.rejects(sendNaverMail(credentials, message, transport.factory), error => error === failure);
  assert.deepEqual(transport.counts(), {sends: 1, closes: 1});
});

test("SMTP empty acknowledgement cannot claim success", async () => {
  const transport = fixture({accepted: [], rejected: []});
  await assert.rejects(sendNaverMail(credentials, message, transport.factory), (error: unknown) => error instanceof UserFacingError && error.code === "SEND_RESULT_UNKNOWN");
});

test("SMTP rejection of all recipients is not reported as sent", async () => {
  const transport = fixture({accepted: [], rejected: ["a@example.com", "b@example.com"]});
  const result = await sendNaverMail(credentials, message, transport.factory);
  assert.equal(result.sent, false); assert.equal(result.deliveryStatus, "rejected");
});
