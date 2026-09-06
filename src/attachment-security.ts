import { open, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { UserFacingError } from "./errors.js";
import { applyMacQuarantine } from "./platform.js";

const BLOCKED_EXTENSIONS = new Set([
  ".app", ".bat", ".cmd", ".com", ".cpl", ".dll", ".exe", ".gadget", ".hta", ".inf",
  ".ins", ".iso", ".jar", ".js", ".jse", ".lnk", ".msc", ".msi", ".msp", ".mst",
  ".pif", ".ps1", ".ps1xml", ".ps2", ".ps2xml", ".psc1", ".psc2", ".reg", ".scr",
  ".sct", ".sh", ".sys", ".vb", ".vbe", ".vbs", ".ws", ".wsc", ".wsf", ".wsh",
  ".docm", ".dotm", ".xlsm", ".xltm", ".xlam", ".pptm", ".potm", ".ppam", ".ppsm"
  , ".dmg", ".pkg", ".command", ".scpt", ".applescript", ".workflow"
]);

const BLOCKED_CONTENT_TYPES = new Set([
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/x-executable",
  "application/x-sh",
  "application/x-bat",
  "application/java-archive",
  "application/vnd.microsoft.portable-executable"
]);

export function assertSafeAttachmentMetadata(filename: string, contentType: string): void {
  const extension = extname(filename).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(extension) || BLOCKED_CONTENT_TYPES.has(contentType.toLowerCase())) {
    throw new UserFacingError(
      "DANGEROUS_ATTACHMENT_BLOCKED",
      "실행 파일, 스크립트, 바로가기 또는 매크로 포함 문서는 보안을 위해 저장할 수 없습니다."
    );
  }
}

export async function assertSafeAttachmentFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    const isPe = bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a;
    const isElf = bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    const isLnk = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00]));
    const isMachO = bytes.length >= 4 && [0xfeedface,0xfeedfacf,0xcefaedfe,0xcffaedfe,0xcafebabe,0xbebafeca,0xcafebabf,0xbfbafeca].includes(bytes.readUInt32BE(0));
    if (isPe || isElf || isLnk || isMachO) {
      throw new UserFacingError("DANGEROUS_ATTACHMENT_BLOCKED", "실행 가능한 형식의 첨부파일이 감지되어 저장을 차단했습니다.");
    }
  } finally {
    await handle.close();
  }
}

export async function protectDownloadedFile(path:string,sourceLabel:string) {
  if(process.platform==="darwin") {
    try { await applyMacQuarantine(path); }
    catch { throw new UserFacingError("QUARANTINE_FAILED","Mac 보안 표시를 적용하지 못해 첨부파일 저장을 취소했습니다."); }
    return {markOfWebApplied:false,quarantineApplied:true};
  }
  return {markOfWebApplied:await applyMarkOfWeb(path,sourceLabel),quarantineApplied:false};
}

export async function applyMarkOfWeb(path: string, sourceLabel: string): Promise<boolean> {
  if (process.platform !== "win32") return false;
  try {
    const safeSource = sourceLabel.replace(/[\r\n\0]/gu, "").slice(0, 300);
    await writeFile(
      `${path}:Zone.Identifier`,
      `[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=${safeSource}\r\n`,
      { encoding: "utf8", flag: "w" }
    );
    return true;
  } catch {
    throw new UserFacingError(
      "MARK_OF_WEB_FAILED",
      "Windows 보안 표시를 적용하지 못해 첨부파일 저장을 취소했습니다."
    );
  }
}

export const testing = { BLOCKED_EXTENSIONS, BLOCKED_CONTENT_TYPES };
