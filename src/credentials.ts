import type { AsyncEntry } from "@napi-rs/keyring";
import { KEYRING_ACCOUNT, KEYRING_SERVICE } from "./constants.js";
import { UserFacingError } from "./errors.js";
import { normalizeNaverEmail } from "./validation.js";

export interface CredentialRecord {
  schema: 1;
  email: string;
  appPassword: string;
}

export class CredentialStore {
  private entryPromise: Promise<AsyncEntry> | undefined;

  private entry(): Promise<AsyncEntry> {
    this.entryPromise ??= import("@napi-rs/keyring").then(({ AsyncEntry }) =>
      new AsyncEntry(KEYRING_SERVICE, KEYRING_ACCOUNT));
    return this.entryPromise;
  }

  async load(): Promise<CredentialRecord | null> {
    try {
      const raw = await (await this.entry()).getPassword(AbortSignal.timeout(5_000));
      if (!raw) return null;

      const parsed: unknown = JSON.parse(raw);
      if (!isCredentialRecord(parsed)) {
        throw new UserFacingError(
          "CREDENTIAL_CORRUPT",
          "저장된 네이버 메일 연결 정보가 손상되었습니다. 연결을 해제하고 다시 설정해 주세요."
        );
      }
      return {
        schema: 1,
        email: normalizeNaverEmail(parsed.email),
        appPassword: parsed.appPassword
      };
    } catch (error) {
      if (error instanceof UserFacingError) throw error;
      if (error instanceof SyntaxError) {
        throw new UserFacingError(
          "CREDENTIAL_CORRUPT",
          "저장된 네이버 메일 연결 정보가 손상되었습니다. 연결을 해제하고 다시 설정해 주세요."
        );
      }
      throw new UserFacingError(
        "KEYRING_UNAVAILABLE",
        process.platform === "darwin"
          ? "Mac 키체인에 접근할 수 없습니다. 키체인 잠금을 해제하고 접근 요청을 확인한 뒤 다시 시도해 주세요."
          : "Windows 자격 증명 관리자에 접근할 수 없습니다. Windows 로그인 상태를 확인한 뒤 다시 시도해 주세요."
      );
    }
  }

  async save(email: string, appPassword: string): Promise<void> {
    const normalizedEmail = normalizeNaverEmail(email);
    if (appPassword.length < 4 || appPassword.length > 256 || /[\r\n\0]/u.test(appPassword)) {
      throw new UserFacingError("INVALID_APP_PASSWORD", "올바른 네이버 애플리케이션 비밀번호를 입력해 주세요.");
    }

    const record: CredentialRecord = {
      schema: 1,
      email: normalizedEmail,
      appPassword
    };

    try {
      await (await this.entry()).setPassword(JSON.stringify(record), AbortSignal.timeout(5_000));
    } catch {
      throw new UserFacingError(
        "KEYRING_UNAVAILABLE",
        process.platform === "darwin"
          ? "Mac 키체인에 저장하지 못했습니다. 키체인 잠금을 해제하고 접근 요청에서 허용한 뒤 다시 시도해 주세요."
          : "Windows 자격 증명 관리자에 저장하지 못했습니다. Windows 로그인 상태와 회사의 보안 정책을 확인한 뒤 다시 시도해 주세요."
      );
    }
  }

  async remove(): Promise<boolean> {
    try {
      return await (await this.entry()).deletePassword(AbortSignal.timeout(5_000));
    } catch {
      throw new UserFacingError(
        "KEYRING_UNAVAILABLE",
        "운영체제 보안 저장소에서 연결 정보를 삭제하지 못했습니다."
      );
    }
  }
}

function isCredentialRecord(value: unknown): value is CredentialRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<CredentialRecord>;
  return (
    record.schema === 1 &&
    typeof record.email === "string" &&
    typeof record.appPassword === "string" &&
    record.appPassword.length >= 4 &&
    record.appPassword.length <= 256
  );
}
