import { randomBytes } from "node:crypto";
import { stat, realpath } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { relative, sep } from "node:path";
import { LIMITS } from "./constants.js";
import { UserFacingError } from "./errors.js";
import type { OutgoingMessage } from "./naver-client.js";
import { normalizeRecipients, safeAttachmentFilename } from "./validation.js";
import { fingerprintFile } from "./file-integrity.js";
import { assertSafeAttachmentFile, assertSafeAttachmentMetadata } from "./attachment-security.js";

export interface PrepareSendInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  attachmentPaths?: string[];
}

export interface SendPreview {
  from: string;
  planId: string;
  expiresAt: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  textPreview: string;
  textCharacters: number;
  attachments: Array<{ path: string; filename: string; bytes: number }>;
  warning: string;
}

interface StoredPlan {
  account: string;
  expiresAt: number;
  message: OutgoingMessage;
  preview: SendPreview;
}

export interface PreparedSendPlan {
  preview: SendPreview;
}

export class SendPlanStore {
  private readonly plans = new Map<string, StoredPlan>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly ttlMs = LIMITS.sendPlanTtlMs) {}

  get activeCount(): number {
    this.prune();
    return this.plans.size;
  }

  async prepare(input: PrepareSendInput, account: string): Promise<PreparedSendPlan> {
    this.prune();
    if (this.plans.size >= LIMITS.sendPlansMax) {
      throw new UserFacingError("TOO_MANY_SEND_PLANS", "발송 확인 대기 중인 초안이 너무 많습니다. 기존 초안이 만료된 뒤 다시 준비해 주세요.");
    }
    const to = normalizeRecipients(input.to, "받는 사람");
    const cc = normalizeRecipients(input.cc ?? [], "참조");
    const bcc = normalizeRecipients(input.bcc ?? [], "숨은 참조");
    const recipientCount = new Set([...to, ...cc, ...bcc]).size;
    if (!to.length) {
      throw new UserFacingError("RECIPIENT_REQUIRED", "받는 사람을 한 명 이상 지정해 주세요.");
    }
    if (recipientCount > LIMITS.recipientsTotal) {
      throw new UserFacingError(
        "TOO_MANY_RECIPIENTS",
        `전체 수신자는 최대 ${LIMITS.recipientsTotal}명까지 지정할 수 있습니다.`
      );
    }

    const subject = sanitizeHeader(input.subject, "제목", LIMITS.subjectChars);
    const text = input.text.replace(/\r\n?/gu, "\n").replace(/\0/gu, "").trim();
    if (!text.length || text.length > LIMITS.outgoingBodyChars) {
      throw new UserFacingError(
        "INVALID_BODY",
        `본문은 1자 이상 ${LIMITS.outgoingBodyChars.toLocaleString()}자 이하여야 합니다.`
      );
    }

    const attachmentPaths = input.attachmentPaths ?? [];
    if (attachmentPaths.length > LIMITS.smtpAttachments) {
      throw new UserFacingError(
        "TOO_MANY_ATTACHMENTS",
        `첨부파일은 최대 ${LIMITS.smtpAttachments}개까지 보낼 수 있습니다.`
      );
    }

    const attachments: OutgoingMessage["attachments"] = [];
    const previewAttachments: SendPreview["attachments"] = [];
    let totalAttachmentBytes = 0;
    for (const requestedPath of attachmentPaths) {
      if (!isAbsolute(requestedPath)) {
        throw new UserFacingError("ABSOLUTE_PATH_REQUIRED", "첨부파일은 절대 경로로 지정해 주세요.");
      }
      let resolved: string;
      try {
        resolved = await realpath(requestedPath);
        assertSafeOutgoingAttachmentPath(resolved);
        const info = await stat(resolved);
        if (!info.isFile()) throw new Error("not a regular file");
        totalAttachmentBytes += info.size;
        if (totalAttachmentBytes > LIMITS.smtpAttachmentBytes) {
          throw new UserFacingError(
            "ATTACHMENTS_TOO_LARGE",
            `전체 첨부파일 크기는 ${Math.floor(LIMITS.smtpAttachmentBytes / 1024 / 1024)}MB 이하여야 합니다.`
          );
        }
        const filename = safeAttachmentFilename(basename(resolved), "attachment");
        assertSafeAttachmentMetadata(filename, "application/octet-stream");
        await assertSafeAttachmentFile(resolved);
        const fingerprint = await fingerprintFile(resolved, LIMITS.smtpAttachmentBytes);
        attachments.push({ path: resolved, filename, fingerprint });
        previewAttachments.push({ path: resolved, filename, bytes: info.size });
      } catch (error) {
        if (error instanceof UserFacingError) throw error;
        throw new UserFacingError("ATTACHMENT_UNREADABLE", "첨부파일을 읽을 수 없거나 일반 파일이 아닙니다.");
      }
    }

    const planId = randomBytes(18).toString("base64url");
    const expiresAt = Date.now() + this.ttlMs;
    const preview: SendPreview = {
      from: account,
      planId,
      expiresAt: new Date(expiresAt).toISOString(),
      to,
      cc,
      bcc,
      subject,
      textPreview: text,
      textCharacters: text.length,
      attachments: previewAttachments,
      warning:
        "아직 발송되지 않았습니다. 대화에 표시된 전체 내용을 검토한 뒤 새 메시지에서 발송을 명시적으로 확인해야 합니다."
    };
    this.plans.set(planId, {
      account,
      expiresAt,
      message: { to, cc, bcc, subject, text, attachments },
      preview
    });
    this.scheduleExpiry();

    return { preview };
  }

  status(planId: string): { status: "prepared" | "expired"; expiresAt?: string } {
    this.prune();
    const plan = this.plans.get(planId);
    if (!plan) return { status: "expired" };
    return { status: "prepared", expiresAt: new Date(plan.expiresAt).toISOString() };
  }

  take(planId: string, account: string): OutgoingMessage {
    this.prune();
    const plan = this.plans.get(planId);
    if (!plan) {
      throw new UserFacingError(
        "SEND_PLAN_EXPIRED",
        "발송 준비 정보가 없거나 만료되었습니다. prepare_send로 다시 미리보기를 만들어 주세요."
      );
    }
    // Single use prevents duplicate delivery on repeated tool calls.
    this.plans.delete(planId);
    this.scheduleExpiry();
    if (plan.account !== account) {
      throw new UserFacingError("SEND_ACCOUNT_CHANGED", "연결된 계정이 변경되었습니다. 보내는 주소를 확인하고 발송 미리보기를 다시 만들어 주세요.");
    }
    return plan.message;
  }

  clear(): void {
    this.plans.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private scheduleExpiry(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const deadline = Math.min(...Array.from(this.plans.values(), (plan) => plan.expiresAt));
    if (!Number.isFinite(deadline)) return;
    this.timer = setTimeout(() => { this.prune(); this.scheduleExpiry(); }, Math.max(1, deadline - Date.now()));
    this.timer.unref();
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, plan] of this.plans) {
      if (plan.expiresAt <= now) this.plans.delete(token);
    }
  }
}

function sanitizeHeader(value: string, label: string, maxLength: number): string {
  const clean = value.replace(/[\r\n\0]/gu, " ").trim();
  if (!clean.length || clean.length > maxLength) {
    throw new UserFacingError("INVALID_HEADER", `${label}은 1자 이상 ${maxLength}자 이하여야 합니다.`);
  }
  return clean;
}

function assertSafeOutgoingAttachmentPath(path: string): void {
  const userRoot = homedir();
  const relativePath = relative(userRoot, path);
  if (!relativePath || relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) {
    throw new UserFacingError(
      "ATTACHMENT_PATH_BLOCKED",
      "발송 첨부파일은 현재 사용자 홈 폴더의 일반 문서 위치에서만 선택할 수 있습니다."
    );
  }
  const normalized = `${sep}${relativePath.toLowerCase()}${sep}`;
  const sensitiveSegments = [
    `${sep}appdata${sep}`,
    `${sep}library${sep}`,
    `${sep}.ssh${sep}`,
    `${sep}.aws${sep}`,
    `${sep}.azure${sep}`,
    `${sep}.codex${sep}`,
    `${sep}.config${sep}`,
    `${sep}.gnupg${sep}`
  ];
  const sensitiveNames = new Set([".env", ".netrc", ".npmrc", ".pypirc", ".git-credentials", "id_rsa", "id_ed25519", "credentials", "credentials.json"]);
  if (sensitiveSegments.some((segment) => normalized.includes(segment)) || sensitiveNames.has(basename(path).toLowerCase())) {
    throw new UserFacingError(
      "SENSITIVE_ATTACHMENT_BLOCKED",
      "자격 증명이나 애플리케이션 설정이 포함될 가능성이 높은 경로는 첨부할 수 없습니다."
    );
  }
}

export const testing = { assertSafeOutgoingAttachmentPath };
