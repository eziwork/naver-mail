import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { UserFacingError } from "./errors.js";

export interface FileFingerprint {
  bytes: number;
  mtimeMs: number;
  sha256: string;
}

export async function fingerprintFile(path: string, maxBytes: number): Promise<FileFingerprint> {
  const before = await stat(path);
  if (!before.isFile()) {
    throw new UserFacingError("ATTACHMENT_UNREADABLE", "첨부파일이 일반 파일이 아닙니다.");
  }
  if (before.size > maxBytes) {
    throw new UserFacingError("ATTACHMENTS_TOO_LARGE", "첨부파일 크기가 허용 한도를 초과합니다.");
  }

  const hash = createHash("sha256");
  let bytes = 0;
  for await (const rawChunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
    bytes += chunk.length;
    if (bytes > maxBytes) {
      throw new UserFacingError("ATTACHMENTS_TOO_LARGE", "첨부파일 크기가 허용 한도를 초과합니다.");
    }
    hash.update(chunk);
  }

  const after = await stat(path);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes !== after.size) {
    throw new UserFacingError(
      "ATTACHMENT_CHANGED",
      "첨부파일을 확인하는 동안 내용이 변경되었습니다. 파일 저장이 끝난 뒤 다시 준비해 주세요."
    );
  }

  return {
    bytes,
    mtimeMs: after.mtimeMs,
    sha256: hash.digest("hex")
  };
}

export async function readVerifiedFile(
  path: string,
  expected: FileFingerprint,
  maxBytes: number
): Promise<Buffer> {
  const before = await stat(path);
  if (!before.isFile() || before.size > maxBytes) {
    throw new UserFacingError("ATTACHMENT_CHANGED", "첨부파일 상태가 발송 미리보기와 달라졌습니다.");
  }

  const chunks: Buffer[] = [];
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const rawChunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
    bytes += chunk.length;
    if (bytes > maxBytes) {
      throw new UserFacingError("ATTACHMENT_CHANGED", "첨부파일 크기가 발송 한도를 초과했습니다.");
    }
    chunks.push(chunk);
    hash.update(chunk);
  }

  const after = await stat(path);
  const sha256 = hash.digest("hex");
  if (
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    bytes !== expected.bytes ||
    after.mtimeMs !== expected.mtimeMs ||
    sha256 !== expected.sha256
  ) {
    throw new UserFacingError(
      "ATTACHMENT_CHANGED",
      "발송 미리보기 이후 첨부파일이 변경되었습니다. prepare_send로 다시 확인해 주세요."
    );
  }
  return Buffer.concat(chunks, bytes);
}
