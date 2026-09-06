import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AsyncEntry } from "@napi-rs/keyring";

const service = `com.eziwork.codex.naver-mail.self-test.${randomUUID()}`;
const entry = new AsyncEntry(service, "temporary");
const value = randomUUID();

try {
  await entry.setPassword(value, AbortSignal.timeout(5_000));
  assert.equal(await entry.getPassword(AbortSignal.timeout(5_000)), value);
} finally {
  await entry.deletePassword(AbortSignal.timeout(5_000)).catch(() => false);
}

assert.equal(await entry.getPassword(AbortSignal.timeout(5_000)) == null, true);
process.stdout.write("OS keyring self-test passed and temporary credential was removed.\n");
