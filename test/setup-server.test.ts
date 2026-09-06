import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { testing } from "../src/setup-server.js";

test("setup page provides an accessible local four-step connection flow", () => {
  const html = testing.renderForm("/setup/test-token");
  for (const step of [1,2,3,4]) assert.ok(html.includes('data-step="'+step+'"'));
  assert.match(html, /aria-current="step"/u);
  assert.match(html, /name="appPassword"/u);
  assert.match(html, /name="acknowledge"/u);
  assert.match(html, /setup\/test-token\/assets\/setup\.js/u);
  assert.match(html, /<script[^>]+defer/u);
  assert.doesNotMatch(html, /<script[^>]*>[^<]+<\/script>/u);
});
test("guide asset routing only accepts allow-listed leaf names", () => {
  assert.ok(testing.guideAssetForPath("/setup/token/assets/imap-smtp-enable.png", "/setup/token"));
  assert.equal(testing.guideAssetForPath("/setup/token/assets/unknown.png", "/setup/token"), null);
  assert.equal(testing.guideAssetForPath("/setup/token/assets/../secret", "/setup/token"), null);
  assert.equal(testing.guideAssetForPath("/setup/other/assets/imap-smtp-enable.png", "/setup/token"), null);
});

test("setup POST origin accepts same-origin browser metadata and rejects cross-site requests", () => {
  assert.equal(
    testing.isSameOriginRequest(
      { headers: { origin: "http://127.0.0.1:4321", "sec-fetch-site": "same-origin" } } as never,
      "127.0.0.1:4321"
    ),
    true
  );
  assert.equal(
    testing.isSameOriginRequest(
      { headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } } as never,
      "127.0.0.1:4321"
    ),
    false
  );
});

test("bundled guide screenshots are valid PNG files", async () => {
  const names = [
    "two-factor-security.png",
    "pop3-options.png",
    "imap-smtp-enable.png",
    "application-password.png"
  ];
  for (const name of names) {
    const bytes = await readFile(new URL(`../assets/guide/${name}`, import.meta.url));
    assert.deepEqual(Array.from(bytes.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  }
});

