import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fingerprintFile, readVerifiedFile } from "../src/file-integrity.js";

test("binds an approved attachment preview to exact file bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "naver-mail-integrity-"));
  const file = join(directory, "attachment.txt");
  try {
    await writeFile(file, "approved content", { encoding: "utf8" });
    const fingerprint = await fingerprintFile(file, 1024);
    assert.equal((await readVerifiedFile(file, fingerprint, 1024)).toString("utf8"), "approved content");

    await writeFile(file, "modified content", { encoding: "utf8" });
    await assert.rejects(readVerifiedFile(file, fingerprint, 1024), /변경/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
