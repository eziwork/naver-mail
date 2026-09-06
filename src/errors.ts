export class UserFacingError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "UserFacingError";
    this.code = code;
  }
}

export interface PublicError {
  code: string;
  message: string;
}

export function publicError(error: unknown): PublicError {
  if (error instanceof UserFacingError) {
    return { code: error.code, message: error.message };
  }

  const code = getErrorCode(error).toUpperCase();
  const message = getErrorMessage(error).toLowerCase();

  if (
    code.includes("AUTH") ||
    code === "EAUTH" ||
    message.includes("authentication") ||
    message.includes("login failed") ||
    message.includes("invalid credentials")
  ) {
    return {
      code: "AUTH_FAILED",
      message:
        "네이버 메일 인증에 실패했습니다. IMAP/SMTP 사용 설정과 애플리케이션 비밀번호를 확인해 주세요."
    };
  }

  if (
    code.includes("CERT") ||
    code.includes("TLS") ||
    message.includes("certificate") ||
    message.includes("tls")
  ) {
    return {
      code: "TLS_FAILED",
      message: "네이버 메일 서버와 보안 연결을 만들지 못했습니다. PC 시간과 인증서 업데이트 상태를 확인해 주세요."
    };
  }

  if (
    code.includes("TIMEOUT") ||
    code === "ETIMEDOUT" ||
    message.includes("timeout") ||
    message.includes("timed out")
  ) {
    return {
      code: "NETWORK_TIMEOUT",
      message: "네이버 메일 서버 응답 시간이 초과되었습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요."
    };
  }

  if (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    message.includes("connection")
  ) {
    return {
      code: "NETWORK_ERROR",
      message: "네이버 메일 서버에 연결하지 못했습니다. 네트워크와 방화벽 설정을 확인해 주세요."
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: "요청을 안전하게 처리하지 못했습니다. 다시 시도해 주세요. 문제가 계속되면 플러그인을 재시작해 주세요."
  };
}

function getErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const value = (error as { code?: unknown }).code;
    return typeof value === "string" ? value : "";
  }
  return "";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}
