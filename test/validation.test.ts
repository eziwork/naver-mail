import assert from "node:assert/strict";
import test from "node:test";
import { maskEmail, normalizeNaverEmail, safeAttachmentFilename } from "../src/validation.js";

test("normalizes a Naver ID to an email address", () => {
  assert.equal(normalizeNaverEmail("Example"), "example@naver.com");
  assert.equal(normalizeNaverEmail("User@NAVER.COM"), "user@naver.com");
});

test("rejects a non-Naver account", () => {
  assert.throws(() => normalizeNaverEmail("user@example.com"), /@naver\.com/u);
});

test("sanitizes incoming filenames consistently across platforms", () => {
  assert.equal(safeAttachmentFilename("..\\CON.txt", "file"), "_CON.txt");
  assert.equal(safeAttachmentFilename("../CON.txt", "file"), "_CON.txt");
  assert.equal(safeAttachmentFilename("C:\\downloads\\report.pdf", "file"), "report.pdf");
  assert.equal(safeAttachmentFilename("/downloads/report.pdf", "file"), "report.pdf");
  assert.equal(safeAttachmentFilename("a<b>:c?.pdf", "file"), "a_b__c_.pdf");
});

test("masks stored account identifiers", () => {
  assert.equal(maskEmail("example@naver.com"), "ex*****@naver.com");
});
