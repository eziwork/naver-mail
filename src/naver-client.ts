import { basename } from "node:path";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import type { CredentialRecord } from "./credentials.js";
import { LIMITS, NAVER_IMAP, NAVER_SMTP, PLUGIN_NAME, PLUGIN_VERSION } from "./constants.js";
import { UserFacingError } from "./errors.js";
import { assertOperationActive, operationSignals } from "./operation.js";
import { readVerifiedFile, type FileFingerprint } from "./file-integrity.js";

export interface OutgoingAttachment {
  path: string;
  filename?: string;
  fingerprint: FileFingerprint;
}

export interface OutgoingMessage {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  attachments: OutgoingAttachment[];
}

export function createImapClient(credentials: CredentialRecord, verifyOnly = false): ImapFlow {
  return new ImapFlow({
    host: NAVER_IMAP.host,
    port: NAVER_IMAP.port,
    secure: true,
    auth: {
      user: credentials.email,
      pass: credentials.appPassword
    },
    clientInfo: {
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      vendor: "Eziwork"
    },
    logger: false,
    disableAutoIdle: true,
    verifyOnly,
    connectionTimeout: LIMITS.connectionTimeoutMs,
    greetingTimeout: LIMITS.greetingTimeoutMs,
    socketTimeout: LIMITS.socketTimeoutMs,
    maxLineLength: 1024 * 1024,
    maxLiteralSize: LIMITS.messageLiteralBytes,
    maxResponseSize: LIMITS.messageResponseBytes,
    maxLockHoldTime: 30_000,
    tls: {
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
      servername: NAVER_IMAP.host
    }
  });
}

export async function withImap<T>(
  credentials: CredentialRecord,
  callback: (client: ImapFlow) => Promise<T>
): Promise<T> {
  const client = createImapClient(credentials);
  const signal = operationSignals.getStore();
  const abort = () => client.close();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    assertOperationActive();
    await client.connect();
    return await callback(client);
  } finally {
    signal?.removeEventListener("abort", abort);
    if (client.usable) {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    } else {
      client.close();
    }
  }
}

export async function testNaverCredentials(credentials: CredentialRecord, progress: (stage: "imap" | "smtp") => void = () => undefined): Promise<void> {
  progress("imap");
  await verifyImap(credentials);
  progress("smtp");
  await verifySmtp(credentials);
}

async function verifyImap(credentials: CredentialRecord): Promise<void> {
  const client = createImapClient(credentials, true);
  const signal = operationSignals.getStore();
  const abort = () => client.close();
  signal?.addEventListener("abort", abort, {once: true});
  try {
    assertOperationActive();
    await client.connect();
  } finally {
    signal?.removeEventListener("abort", abort);
    if (client.usable) {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    } else {
      client.close();
    }
  }
}

async function verifySmtp(credentials: CredentialRecord): Promise<void> {
  const transporter = createSmtpTransport(credentials, true);
  const signal = operationSignals.getStore();
  const abort = () => transporter.close();
  signal?.addEventListener("abort", abort, {once: true});
  try {
    assertOperationActive();
    const ok = await transporter.verify();
    if (!ok) {
      throw new UserFacingError("SMTP_VERIFY_FAILED", "네이버 SMTP 연결을 확인하지 못했습니다.");
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    transporter.close();
  }
}

export async function sendNaverMail(
  credentials: CredentialRecord,
  message: OutgoingMessage,
  transportFactory: typeof createSmtpTransport = createSmtpTransport
): Promise<{ sent: boolean; deliveryStatus: "sent" | "partial" | "rejected"; messageId: string; accepted: string[]; rejected: string[] }> {
  const verifiedAttachments = [];
  for (const attachment of message.attachments) {
    const content = await readVerifiedFile(
      attachment.path,
      attachment.fingerprint,
      LIMITS.smtpAttachmentBytes
    );
    verifiedAttachments.push({
      filename: attachment.filename ?? basename(attachment.path),
      content
    });
  }

  const transporter = transportFactory(credentials, false);
  const signal = operationSignals.getStore();
  const abort = () => transporter.close();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    assertOperationActive();
    const info = await transporter.sendMail({
      from: credentials.email,
      to: message.to,
      cc: message.cc.length ? message.cc : undefined,
      bcc: message.bcc.length ? message.bcc : undefined,
      subject: message.subject,
      text: message.text,
      attachments: verifiedAttachments,
      disableFileAccess: true,
      disableUrlAccess: true
    });

    const accepted = normalizeAddresses(info.accepted);
    const rejected = normalizeAddresses(info.rejected);
    if (!accepted.length && !rejected.length) throw new UserFacingError("SEND_RESULT_UNKNOWN", "수신 서버의 발송 결과를 확인하지 못했습니다. 자동으로 다시 보내지 말고 네이버 보낸메일함과 수신 여부를 확인해 주세요.");
    return {
      sent: accepted.length > 0,
      deliveryStatus: !accepted.length ? "rejected" : rejected.length ? "partial" : "sent",
      messageId: typeof info.messageId === "string" ? info.messageId : "",
      accepted,
      rejected
    };
  } catch (error) {
    // After SMTP dispatch a disconnect may occur after the server accepted DATA.
    // A missing acknowledgement is never proof that delivery failed.
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (["EAUTH", "EENVELOPE", "EMESSAGE"].includes(code) || error instanceof UserFacingError) throw error;
    throw new UserFacingError("SEND_RESULT_UNKNOWN", "발송 결과를 확인할 수 없습니다. 중복 발송을 막기 위해 자동으로 다시 보내지 않습니다. 네이버 보낸메일함과 수신 여부를 확인해 주세요.");
  } finally {
    signal?.removeEventListener("abort", abort);
    transporter.close();
  }
}

function createSmtpTransport(credentials: CredentialRecord, _verifyOnly: boolean) {
  const options: SMTPTransport.Options = {
    host: NAVER_SMTP.host,
    port: NAVER_SMTP.port,
    secure: false,
    requireTLS: true,
    auth: {
      user: credentials.email,
      pass: credentials.appPassword
    },
    name: "localhost",
    connectionTimeout: LIMITS.connectionTimeoutMs,
    greetingTimeout: LIMITS.greetingTimeoutMs,
    socketTimeout: LIMITS.socketTimeoutMs,
    disableUrlAccess: true,
    disableFileAccess: true,
    tls: {
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
      servername: NAVER_SMTP.host
    }
  };
  return nodemailer.createTransport(options);
}

function normalizeAddresses(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => {
      if (typeof value === "string") return value;
      if (typeof value === "object" && value !== null && "address" in value) {
        const address = (value as { address?: unknown }).address;
        return typeof address === "string" ? address : "";
      }
      return "";
    })
    .filter(Boolean);
}
