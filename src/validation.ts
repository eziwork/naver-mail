import { extname, basename } from "node:path";
import { z } from "zod/v4";
import { LIMITS } from "./constants.js";
import { UserFacingError } from "./errors.js";

const BASIC_EMAIL = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/u;
const NAVER_EMAIL = /^[^\s<>@,;]+@naver\.com$/iu;

export const mailboxSchema = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.mailboxChars)
  .refine((value) => !value.includes("\0"), "메일함 이름에 허용되지 않는 문자가 있습니다.");

export const uidSchema = z.number().int().positive();

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "날짜는 YYYY-MM-DD 형식이어야 합니다.")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00+09:00`)), "유효하지 않은 날짜입니다.");

export function normalizeNaverEmail(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  const email = trimmed.includes("@") ? trimmed : `${trimmed}@naver.com`;
  if (!NAVER_EMAIL.test(email) || email.length > 254) {
    throw new UserFacingError("INVALID_NAVER_EMAIL", "개인 네이버 메일 주소(@naver.com)를 입력해 주세요.");
  }
  return email;
}

export function normalizeRecipient(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!BASIC_EMAIL.test(email) || email.length > 254) {
    throw new UserFacingError("INVALID_RECIPIENT", `유효하지 않은 수신자 주소가 있습니다: ${safeLabel(raw)}`);
  }
  return email;
}

export function normalizeRecipients(values: string[], field: string): string[] {
  if (values.length > LIMITS.recipientsPerField) {
    throw new UserFacingError(
      "TOO_MANY_RECIPIENTS",
      `${field} 수신자는 최대 ${LIMITS.recipientsPerField}명까지 지정할 수 있습니다.`
    );
  }
  const unique = new Map<string, string>();
  for (const value of values) {
    const normalized = normalizeRecipient(value);
    unique.set(normalized, normalized);
  }
  return [...unique.values()];
}

export function toKstDate(value: string): Date {
  return new Date(`${value}T00:00:00+09:00`);
}

export function safeAttachmentFilename(raw: string | undefined, fallback: string): string {
  const source = basename(raw?.trim() || fallback)
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/gu, "_")
    .replace(/[. ]+$/u, "")
    .slice(0, 140);

  const candidate = source || fallback;
  const stem = candidate.slice(0, Math.max(1, candidate.length - extname(candidate).length));
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(stem)) {
    return `_${candidate}`;
  }
  return candidate;
}

export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  if (!domain) return "연결됨";
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"*".repeat(Math.max(3, local.length - visible.length))}@${domain}`;
}

function safeLabel(value: string): string {
  return value.replace(/[\r\n\t]/gu, " ").slice(0, 80);
}
