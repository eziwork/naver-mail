import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeAttachmentMetadata } from "../src/attachment-security.js";

test("blocks executable, script, shortcut, and macro attachment names", () => {
  for (const name of ["invoice.exe", "update.ps1", "shortcut.lnk", "report.docm"]) {
    assert.throws(() => assertSafeAttachmentMetadata(name, "application/octet-stream"), /보안을 위해 저장할 수 없습니다/u);
  }
});

test("allows ordinary document metadata", () => {
  assert.doesNotThrow(() => assertSafeAttachmentMetadata("contract.pdf", "application/pdf"));
});
