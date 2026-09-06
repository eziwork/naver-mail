import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, parse } from "node:path";
import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { convert as htmlToText } from "html-to-text";
import iconv from "iconv-lite";
import type {
  ImapFlow,
  ListResponse,
  MessageAddressObject,
  MessageEnvelopeObject,
  MessageStructureObject,
  SearchObject
} from "imapflow";
import type { CredentialRecord } from "./credentials.js";
import { LIMITS, UNTRUSTED_MAIL_NOTICE } from "./constants.js";
import {
  protectDownloadedFile,
  assertSafeAttachmentFile,
  assertSafeAttachmentMetadata
} from "./attachment-security.js";
import { UserFacingError } from "./errors.js";
import { safeAttachmentFilename, toKstDate } from "./validation.js";
import { withImap } from "./naver-client.js";
import { downloadsDirectory } from "./platform.js";

export interface SearchMailInput {
  mailbox: string;
  query?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  subject?: string | undefined;
  since?: string | undefined;
  before?: string | undefined;
  readStatus: "any" | "read" | "unread";
  limit: number;
  cursor?: string | undefined;
}

interface AttachmentPart {
  part: string;
  filename: string;
  contentType: string;
  size: number | null;
}

export async function listMailboxes(credentials: CredentialRecord) {
  return withImap(credentials, async (client) => {
    let mailboxes: ListResponse[];
    try {
      mailboxes = await client.list({
        statusQuery: { messages: true, unseen: true }
      });
    } catch {
      mailboxes = await client.list();
    }

    return mailboxes.map((mailbox) => ({
      path: mailbox.path,
      name: mailbox.name,
      specialUse: mailbox.specialUse ?? null,
      selectable: !mailbox.flags.has("\\Noselect"),
      subscribed: mailbox.subscribed,
      messages: mailbox.status?.messages ?? null,
      unread: mailbox.status?.unseen ?? null
    }));
  });
}

export async function searchMail(credentials: CredentialRecord, input: SearchMailInput) {
  return withImap(credentials, async (client) => {
    const lock = await client.getMailboxLock(input.mailbox, {
      readOnly: true,
      acquireTimeout: LIMITS.lockTimeoutMs,
      description: "search_mail"
    });

    try {
      const criteria = buildSearchCriteria(input);
      const found = await client.search(criteria, { uid: true });
      const allUids = (found || []).sort((a, b) => b - a);
      const cursorUid = input.cursor ? decodeCursor(input.cursor, input.mailbox) : null;
      const eligible = cursorUid === null ? allUids : allUids.filter((uid) => uid < cursorUid);
      const pageUids = eligible.slice(0, input.limit);

      if (!pageUids.length) {
        return {
          warning: UNTRUSTED_MAIL_NOTICE,
          mailbox: input.mailbox,
          messages: [],
          nextCursor: null,
          hasMore: false
        };
      }

      const messages = await client.fetchAll(
        pageUids,
        {
          uid: true,
          envelope: true,
          flags: true,
          internalDate: true,
          size: true
        },
        { uid: true }
      );
      const byUid = new Map(messages.map((message) => [message.uid, message]));
      const ordered = pageUids
        .map((uid) => byUid.get(uid))
        .filter((message) => message !== undefined)
        .map((message) => ({
          uid: message.uid,
          subject: message.envelope?.subject ?? "(제목 없음)",
          from: formatAddresses(message.envelope?.from),
          to: formatAddresses(message.envelope?.to),
          date: toIso(message.envelope?.date ?? message.internalDate),
          read: message.flags?.has("\\Seen") ?? false,
          flagged: message.flags?.has("\\Flagged") ?? false,
          answered: message.flags?.has("\\Answered") ?? false,
          size: message.size ?? null
        }));

      const hasMore = eligible.length > pageUids.length;
      const lastUid = pageUids.at(-1);
      return {
        warning: UNTRUSTED_MAIL_NOTICE,
        mailbox: input.mailbox,
        messages: ordered,
        nextCursor: hasMore && lastUid !== undefined ? encodeCursor(input.mailbox, lastUid) : null,
        hasMore
      };
    } finally {
      lock.release();
    }
  });
}

export async function getMail(credentials: CredentialRecord, mailbox: string, uid: number, includeLinks = false) {
  return withImap(credentials, async (client) => {
    const lock = await client.getMailboxLock(mailbox, {readOnly: true, acquireTimeout: LIMITS.lockTimeoutMs, description: "get_mail"});
    try { return await getMailWithClient(client, mailbox, uid, includeLinks); }
    finally { lock.release(); }
  });
}

async function getMailWithClient(client: ImapFlow, mailbox: string, uid: number, includeLinks: boolean) {
  const message = await client.fetchOne(
    uid,
    {
      uid: true,
      envelope: true,
      flags: true,
      internalDate: true,
      size: true,
      headers: ["authentication-results", "received-spf", "dkim-signature"],
      bodyStructure: true
    },
    { uid: true }
  );
  if (!message || !message.bodyStructure) {
    throw new UserFacingError("MAIL_NOT_FOUND", "해당 메일을 찾을 수 없습니다. 검색 결과를 새로 확인해 주세요.");
  }

  const bodyPart = findPreferredBody(message.bodyStructure);
  let body = "";
  let truncated = false;
  if (bodyPart) {
    const part = bodyPart.part || "1";
    const downloaded = await client.download(uid, part, {
      uid: true,
      maxBytes: LIMITS.bodyBytes,
      chunkSize: 64 * 1024
    });
    const buffer = await readStream(downloaded.content, LIMITS.bodyBytes);
    truncated = downloaded.meta.expectedSize > buffer.length || buffer.length >= LIMITS.bodyBytes;
    const decoded = decodeText(buffer, downloaded.meta.charset ?? bodyPart.parameters?.charset);
    body = bodyPart.type.toLowerCase() === "text/html"
      ? convertHtml(decoded, includeLinks)
      : cleanPlainText(decoded, includeLinks);
  }

  const promptInjectionRisk = detectPromptInjectionRisk(body);

  return {
    warning: UNTRUSTED_MAIL_NOTICE,
    mailbox,
    uid,
    subject: message.envelope?.subject ?? "(제목 없음)",
    from: formatAddresses(message.envelope?.from),
    replyTo: formatAddresses(message.envelope?.replyTo),
    to: formatAddresses(message.envelope?.to),
    cc: formatAddresses(message.envelope?.cc),
    date: toIso(message.envelope?.date ?? message.internalDate),
    messageId: message.envelope?.messageId ?? null,
    inReplyTo: message.envelope?.inReplyTo ?? null,
    read: message.flags?.has("\\Seen") ?? false,
    flagged: message.flags?.has("\\Flagged") ?? false,
    size: message.size ?? null,
    body,
    bodyTruncated: truncated,
    security: {
      contentTrust: "untrusted-external-data",
      senderAuthentication: assessSenderAuthentication(message.headers),
      promptInjectionRisk,
      externalLinks: includeLinks ? "included-by-explicit-request" : "hidden-by-default"
    },
    attachments: listAttachmentParts(message.bodyStructure)
  };
}

export async function getMailBatch(
  credentials: CredentialRecord, mailbox: string, uids: number[], includeLinks = false,
  execute: typeof withImap = withImap
) {
  return execute(credentials, async (client) => {
    const lock = await client.getMailboxLock(mailbox, {readOnly: true, acquireTimeout: LIMITS.lockTimeoutMs, description: "get_mail_batch"});
    try {
      const messages = [];
      for (const uid of uids) messages.push(await getMailWithClient(client, mailbox, uid, includeLinks));
      return {warning: UNTRUSTED_MAIL_NOTICE, mailbox, messages};
    } finally { lock.release(); }
  });
}

export async function saveAttachment(
  credentials: CredentialRecord,
  mailbox: string,
  uid: number,
  part: string
) {
  return withImap(credentials, async (client) => {
    const lock = await client.getMailboxLock(mailbox, {
      readOnly: true,
      acquireTimeout: LIMITS.lockTimeoutMs,
      description: "save_attachment"
    });

    let outputPath: string | null = null;
    try {
      const message = await client.fetchOne(uid, { uid: true, bodyStructure: true }, { uid: true });
      if (!message || !message.bodyStructure) {
        throw new UserFacingError("MAIL_NOT_FOUND", "해당 메일을 찾을 수 없습니다.");
      }

      const attachments = listAttachmentParts(message.bodyStructure);
      const attachment = attachments.find((candidate) => candidate.part === part);
      if (!attachment) {
        throw new UserFacingError("ATTACHMENT_NOT_FOUND", "해당 첨부파일을 찾을 수 없습니다.");
      }
      if (attachment.size !== null && attachment.size > LIMITS.attachmentBytes) {
        throw new UserFacingError(
          "ATTACHMENT_TOO_LARGE",
          `보안을 위해 ${Math.floor(LIMITS.attachmentBytes / 1024 / 1024)}MB를 넘는 첨부파일은 저장하지 않습니다.`
        );
      }

      const outputDirectory = join(await downloadsDirectory(), "Naver Mail Attachments");
      await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
      const safeName = safeAttachmentFilename(attachment.filename, `attachment-${part}`);
      assertSafeAttachmentMetadata(safeName, attachment.contentType);
      const parsed = parse(safeName);
      outputPath = join(outputDirectory, `${parsed.name}-${randomUUID().slice(0, 8)}${parsed.ext}`);

      const downloaded = await client.download(uid, part, {
        uid: true,
        maxBytes: LIMITS.attachmentBytes + 1,
        chunkSize: 64 * 1024
      });
      if (downloaded.meta.expectedSize > LIMITS.attachmentBytes) {
        throw new UserFacingError("ATTACHMENT_TOO_LARGE", "첨부파일이 허용 크기를 초과합니다.");
      }

      let written = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          written += chunk.length;
          if (written > LIMITS.attachmentBytes) {
            callback(new UserFacingError("ATTACHMENT_TOO_LARGE", "첨부파일이 허용 크기를 초과합니다."));
            return;
          }
          callback(null, chunk);
        }
      });

      await pipeline(
        downloaded.content,
        limiter,
        createWriteStream(outputPath, { flags: "wx", mode: 0o600 })
      );
      await assertSafeAttachmentFile(outputPath);
      const protection = await protectDownloadedFile(
        outputPath,
        `imap://${mailbox}/uid/${uid}/part/${part}`
      );

      return {
        savedPath: outputPath,
        filename: safeName,
        contentType: attachment.contentType,
        bytes: written,
        ...protection,
        blockedTypes: "실행 파일·스크립트·바로가기·매크로 문서",
        warning: "첨부파일은 신뢰할 수 없는 외부 파일입니다. 운영체제 보안 표시를 유지하고 열기 전에 확인하세요."
      };
    } catch (error) {
      if (outputPath) {
        await rm(outputPath, { force: true }).catch(() => undefined);
      }
      throw error;
    } finally {
      lock.release();
    }
  });
}

export async function setReadStatus(
  credentials: CredentialRecord,
  mailbox: string,
  uid: number,
  read: boolean
) {
  return withImap(credentials, async (client) => {
    const lock = await client.getMailboxLock(mailbox, {
      acquireTimeout: LIMITS.lockTimeoutMs,
      description: "set_read_status"
    });
    try {
      const updated = read
        ? await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true, silent: true })
        : await client.messageFlagsRemove(uid, ["\\Seen"], { uid: true, silent: true });
      if (!updated) {
        throw new UserFacingError("MAIL_NOT_FOUND", "메일 상태를 변경하지 못했습니다.");
      }
      return { mailbox, uid, read };
    } finally {
      lock.release();
    }
  });
}

function buildSearchCriteria(input: SearchMailInput): SearchObject {
  const criteria: SearchObject = {};
  if (input.query) criteria.text = input.query;
  if (input.from) criteria.from = input.from;
  if (input.to) criteria.to = input.to;
  if (input.subject) criteria.subject = input.subject;
  if (input.since) criteria.since = toKstDate(input.since);
  if (input.before) criteria.before = toKstDate(input.before);
  if (input.readStatus === "read") criteria.seen = true;
  if (input.readStatus === "unread") criteria.seen = false;
  if (!Object.keys(criteria).length) criteria.all = true;
  return criteria;
}

function formatAddresses(addresses: MessageAddressObject[] | undefined): Array<{ name: string | null; address: string }> {
  return (addresses ?? [])
    .filter((address) => typeof address.address === "string" && address.address.length > 0)
    .map((address) => ({
      name: address.name?.trim() || null,
      address: address.address ?? ""
    }));
}

function toIso(value: Date | string | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function encodeCursor(mailbox: string, uid: number): string {
  return Buffer.from(JSON.stringify({ v: 1, mailbox, uid }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, mailbox: string): number {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { v?: unknown }).v !== 1 ||
      (parsed as { mailbox?: unknown }).mailbox !== mailbox ||
      !Number.isInteger((parsed as { uid?: unknown }).uid) ||
      Number((parsed as { uid?: unknown }).uid) <= 0
    ) {
      throw new Error("invalid cursor");
    }
    return Number((parsed as { uid: number }).uid);
  } catch {
    throw new UserFacingError("INVALID_CURSOR", "검색 커서가 유효하지 않습니다. 첫 페이지부터 다시 검색해 주세요.");
  }
}

function walkStructure(root: MessageStructureObject): MessageStructureObject[] {
  const result: MessageStructureObject[] = [];
  const visit = (node: MessageStructureObject) => {
    result.push(node);
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(root);
  return result;
}

function findPreferredBody(root: MessageStructureObject): MessageStructureObject | null {
  const nodes = walkStructure(root).filter((node) => {
    const hasFilename = Boolean(node.dispositionParameters?.filename ?? node.parameters?.name);
    return node.disposition?.toLowerCase() !== "attachment" && !hasFilename;
  });
  return (
    nodes.find((node) => node.type.toLowerCase() === "text/plain") ??
    nodes.find((node) => node.type.toLowerCase() === "text/html") ??
    null
  );
}

function listAttachmentParts(root: MessageStructureObject): AttachmentPart[] {
  return walkStructure(root)
    .filter((node) => {
      const disposition = node.disposition?.toLowerCase();
      const filename = node.dispositionParameters?.filename ?? node.parameters?.name;
      return Boolean(node.part && (disposition === "attachment" || disposition === "inline" || filename));
    })
    .map((node) => ({
      part: node.part ?? "",
      filename: safeAttachmentFilename(
        node.dispositionParameters?.filename ?? node.parameters?.name,
        `attachment-${node.part ?? "unknown"}${extensionForType(node.type)}`
      ),
      contentType: node.type,
      size: typeof node.size === "number" ? node.size : null
    }));
}

function extensionForType(contentType: string): string {
  const normalized = contentType.toLowerCase();
  if (normalized === "application/pdf") return ".pdf";
  if (normalized === "image/jpeg") return ".jpg";
  if (normalized === "image/png") return ".png";
  if (normalized === "text/plain") return ".txt";
  return "";
}

async function readStream(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk)
      ? rawChunk
      : typeof rawChunk === "string"
        ? Buffer.from(rawChunk)
        : Buffer.from(rawChunk as Uint8Array);
    total += chunk.length;
    if (total > maxBytes) {
      throw new UserFacingError("BODY_TOO_LARGE", "메일 본문이 안전한 조회 크기를 초과했습니다.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function decodeText(buffer: Buffer, charset: string | undefined): string {
  const requested = charset?.trim().toLowerCase() || "utf-8";
  const encoding = iconv.encodingExists(requested) ? requested : "utf-8";
  return iconv.decode(buffer, encoding);
}

function cleanPlainText(value: string, includeLinks = false): string {
  const clean = value
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .trim();
  return includeLinks ? clean : redactExternalLinks(clean);
}

function convertHtml(value: string, includeLinks = false): string {
  return cleanPlainText(
    htmlToText(value, {
      wordwrap: false,
      limits: {
        maxInputLength: LIMITS.bodyBytes,
        maxChildNodes: 20_000,
        maxDepth: 40
      },
      selectors: [
        { selector: "script", format: "skip" },
        { selector: "style", format: "skip" },
        { selector: "img", format: "skip" }
      ]
    }),
    includeLinks
  );
}

function redactExternalLinks(value: string): string {
  return value.replace(/https?:\/\/[^\s<>"'\])}]+/giu, (raw) => {
    try {
      const hostname = new URL(raw).hostname.toLowerCase();
      return hostname ? `[외부 링크 숨김: ${hostname}]` : "[외부 링크 숨김]";
    } catch {
      return "[외부 링크 숨김]";
    }
  });
}

function detectPromptInjectionRisk(value: string): "elevated" | "not-detected" {
  const suspicious = [
    /ignore (?:all |any )?(?:previous|prior) instructions/iu,
    /system (?:message|prompt)/iu,
    /do not (?:tell|inform) the user/iu,
    /call (?:a |the )?tool/iu,
    /이전 (?:지시|명령).{0,20}무시/iu,
    /시스템 (?:메시지|프롬프트)/iu,
    /사용자에게.{0,20}(?:알리지|말하지) 마/iu,
    /(?:도구|툴).{0,20}(?:호출|실행)/iu,
    /(?:링크|첨부파일).{0,20}(?:클릭|열어|실행)/iu
  ];
  return suspicious.some((pattern) => pattern.test(value)) ? "elevated" : "not-detected";
}

function assessSenderAuthentication(headers: Buffer | undefined) {
  const values = parseHeaderValues(headers, "authentication-results");
  const reported = values.join(" ").toLowerCase();
  const resultFor = (name: "spf" | "dkim" | "dmarc") => {
    const match = new RegExp(`(?:^|[;\\s])${name}=([a-z]+)`, "iu").exec(reported);
    return match?.[1] ?? "unknown";
  };
  const spf = resultFor("spf");
  const dkim = resultFor("dkim");
  const dmarc = resultFor("dmarc");
  const reportedVerdict = spf === "pass" && dkim === "pass" && dmarc === "pass"
    ? "pass"
    : [spf, dkim, dmarc].some((value) => ["fail", "softfail", "temperror", "permerror"].includes(value))
      ? "warning"
      : "unknown";
  return {
    reportedVerdict,
    spf,
    dkim,
    dmarc,
    source: "mail-server-reported; not independently verified by this plugin"
  };
}

function parseHeaderValues(headers: Buffer | undefined, target: string): string[] {
  if (!headers?.length) return [];
  const unfolded = headers.toString("utf8").replace(/\r?\n[\t ]+/gu, " ");
  return unfolded
    .split(/\r?\n/gu)
    .map((line) => {
      const separator = line.indexOf(":");
      if (separator < 1 || line.slice(0, separator).trim().toLowerCase() !== target) return "";
      return line.slice(separator + 1).trim();
    })
    .filter(Boolean);
}

// Exported for focused unit tests without connecting to a mailbox.
export const testing = {
  buildSearchCriteria,
  encodeCursor,
  decodeCursor,
  findPreferredBody,
  listAttachmentParts,
  cleanPlainText,
  convertHtml,
  redactExternalLinks,
  detectPromptInjectionRisk,
  assessSenderAuthentication
};
