import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { LIMITS, PLUGIN_NAME, PLUGIN_VERSION } from "./constants.js";
import { OperationQueue, requestSignals } from "./operation.js";
import { CredentialStore } from "./credentials.js";
import { publicError, UserFacingError } from "./errors.js";
import {
  getMail,
  getMailBatch,
  listMailboxes,
  saveAttachment,
  searchMail,
  setReadStatus
} from "./mail-service.js";
import { sendNaverMail, testNaverCredentials } from "./naver-client.js";
import { SendPlanStore } from "./send-plan.js";
import { SetupServer } from "./setup-server.js";
import { isoDateSchema, mailboxSchema, maskEmail, uidSchema } from "./validation.js";

export interface NaverMailServerBundle {
  server: McpServer;
  close(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface NaverMailRuntime {
  credentials: CredentialStore;
  setup: SetupServer;
  sendPlans: SendPlanStore;
  run<T>(callback: () => Promise<T>): Promise<T>;
  readonly pending: number;
  shutdown(): Promise<void>;
}

export function createNaverMailRuntime(): NaverMailRuntime {
  const credentials = new CredentialStore();
  const sendPlans = new SendPlanStore();
  const queue = new OperationQueue();
  const setup = new SetupServer(credentials, {
    commit: (email, password) => queue.run(async () => {
      await credentials.save(email, password);
      sendPlans.clear();
    })
  });
  return {
    credentials, setup, sendPlans,
    get pending() { return queue.pending; },
    run: <T>(callback: () => Promise<T>) => queue.run(callback),
    async shutdown() {
      await setup.close();
      await queue.drain();
      sendPlans.clear();
    }
  };
}

export function createNaverMailServer(sharedRuntime?: NaverMailRuntime): NaverMailServerBundle {
  const runtime = sharedRuntime ?? createNaverMailRuntime();
  const ownsRuntime = sharedRuntime === undefined;
  const { credentials, setup, sendPlans } = runtime;
  const toolCall = <T>(callback: () => Promise<T>) => formatToolCall(() => runtime.run(callback));
  const toolCallWithCredentials = <T>(
    store: CredentialStore,
    callback: (stored: Awaited<ReturnType<CredentialStore["load"]>> & {}) => Promise<T>
  ) => toolCall(async () => callback(await requireCredentials(store)));
  const server = new McpServer({
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION
  });

  server.registerTool(
    "connection_status",
    {
      title: "네이버 메일 연결 상태",
      description:
        "로컬 OS 보안 저장소에 네이버 메일 연결 정보가 있는지 확인합니다. verify=true일 때만 네이버 IMAP/SMTP 서버에 실제 연결 테스트를 수행합니다.",
      inputSchema: {
        verify: z.boolean().default(false).describe("네이버 서버까지 실제 연결을 테스트할지 여부")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ verify }, extra) => requestSignals.run(extra.signal, () => toolCall(async () => {
        const stored = await credentials.load();
        if (!stored) {
          return {
            connected: false,
            verified: false,
            setup: setup.status(),
            nextAction: "open_setup 도구를 호출해 로컬 연결 화면을 여세요."
          };
        }
        if (verify) await testNaverCredentials(stored);
        return {
          connected: true,
          verified: verify,
          account: maskEmail(stored.email),
          credentialStorage: process.platform === "darwin" ? "macOS Keychain" : "Windows Credential Manager",
          setup: setup.status()
        };
      }))
  );

  server.registerTool(
    "open_setup",
    {
      title: "네이버 메일 연결 화면 열기",
      description:
        "브라우저에 127.0.0.1 전용 일회성 설정 화면을 엽니다. 네이버 애플리케이션 비밀번호는 MCP 인수나 대화에 입력하지 않고 이 화면에서만 입력해야 합니다.",
      inputSchema: {
        reconfigure: z.boolean().default(false).describe("기존 연결이 있어도 다시 설정할지 여부")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ reconfigure }, extra) => requestSignals.run(extra.signal, () => toolCall(async () => {
        const stored = await credentials.load();
        if (stored && !reconfigure) {
          return {
            alreadyConnected: true,
            account: maskEmail(stored.email),
            nextAction: "재연결이 필요하면 reconfigure=true로 다시 호출하세요."
          };
        }
        const session = await setup.open();
        return {
          alreadyConnected: false,
          ...session,
          securityNotice:
            "애플리케이션 비밀번호는 열린 로컬 페이지에만 입력하세요. Codex 대화나 도구 인수에는 입력하지 마세요."
        };
      }))
  );

  server.registerTool(
    "disconnect_account",
    {
      title: "네이버 메일 연결 해제",
      description: "운영체제 보안 저장소에서 네이버 메일 연결 정보를 삭제합니다.",
      inputSchema: {
        confirm: z.literal(true).describe("연결 해제를 명시적으로 확인하는 값")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (_input, extra) => requestSignals.run(extra.signal, () => toolCall(async () => {
        await setup.close();
        sendPlans.clear();
        const removed = await credentials.remove();
        return { disconnected: true, credentialRemoved: removed };
      }))
  );

  server.registerTool(
    "list_mailboxes",
    {
      title: "네이버 메일함 목록",
      description: "받은메일함, 보낸메일함, 스팸함과 개인 메일함을 메시지 수와 함께 조회합니다.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (_input, extra) => requestSignals.run(extra.signal, () => toolCallWithCredentials(credentials, (stored) => listMailboxes(stored)))
  );

  server.registerTool(
    "search_mail",
    {
      title: "네이버 메일 검색",
      description:
        "선택한 네이버 메일함을 서버에서 검색하고 헤더 정보만 페이지 단위로 반환합니다. 본문은 get_mail로 필요한 메일만 별도 조회하세요.",
      inputSchema: {
        mailbox: mailboxSchema.default("INBOX").describe("list_mailboxes가 반환한 메일함 path"),
        query: z.string().trim().max(LIMITS.queryChars).optional().describe("헤더와 본문에서 찾을 검색어"),
        from: z.string().trim().max(254).optional().describe("보낸 사람 주소 또는 일부 문자열"),
        to: z.string().trim().max(254).optional().describe("받는 사람 주소 또는 일부 문자열"),
        subject: z.string().trim().max(LIMITS.queryChars).optional().describe("제목 검색어"),
        since: isoDateSchema.optional().describe("이 날짜 이후, YYYY-MM-DD"),
        before: isoDateSchema.optional().describe("이 날짜 이전, YYYY-MM-DD"),
        readStatus: z.enum(["any", "read", "unread"]).default("any"),
        limit: z.number().int().min(1).max(LIMITS.searchMax).default(LIMITS.searchDefault),
        cursor: z.string().max(2_000).optional().describe("이전 결과의 nextCursor")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input, extra) => requestSignals.run(extra.signal, () => toolCallWithCredentials(credentials, (stored) => searchMail(stored, input)))
  );

  server.registerTool(
    "get_mail",
    {
      title: "네이버 메일 본문 조회",
      description:
        "메일 본문을 읽음 처리하지 않는 IMAP PEEK 방식으로 조회합니다. HTML은 실행하지 않고 안전한 일반 텍스트로 변환하며 외부 이미지도 불러오지 않습니다.",
      inputSchema: {
        mailbox: mailboxSchema.describe("search_mail 결과의 mailbox"),
        uid: uidSchema.describe("search_mail 결과의 uid"),
        includeLinks: z.boolean().default(false).describe("외부 링크 URL을 본문에 포함할지 여부. 기본값 false 권장")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ mailbox, uid, includeLinks }, extra) => requestSignals.run(extra.signal, () => toolCallWithCredentials(credentials, (stored) => getMail(stored, mailbox, uid, includeLinks)))
  );

  server.registerTool(
    "get_mail_batch",
    {
      title: "네이버 메일 본문 묶음 조회",
      description:
        "search_mail로 선택한 메일을 최대 10건까지 한 번의 승인으로 조회합니다. 외부 링크는 기본적으로 숨기고, 발신 인증 결과와 프롬프트 인젝션 위험 신호를 함께 반환합니다.",
      inputSchema: {
        mailbox: mailboxSchema.describe("search_mail 결과의 mailbox"),
        uids: z.array(uidSchema).min(1).max(10).refine((values) => new Set(values).size === values.length, "UID는 중복할 수 없습니다."),
        includeLinks: z.boolean().default(false).describe("외부 링크 URL을 본문에 포함할지 여부. 기본값 false 권장")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ mailbox, uids, includeLinks }, extra) => requestSignals.run(extra.signal, () => toolCallWithCredentials(credentials, (stored) => getMailBatch(stored, mailbox, uids, includeLinks)))
  );

  server.registerTool(
    "save_attachment",
    {
      title: "네이버 메일 첨부파일 저장",
      description:
        "get_mail 결과의 첨부파일 part를 사용자 다운로드 폴더 아래 Naver Mail Attachments 폴더에 안전한 파일명으로 저장합니다.",
      inputSchema: {
        mailbox: mailboxSchema,
        uid: uidSchema,
        part: z.string().regex(/^\d+(?:\.\d+)*$/u).max(100).describe("get_mail 결과의 attachments[].part")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ mailbox, uid, part }, extra) => requestSignals.run(extra.signal, () => toolCallWithCredentials(credentials, (stored) => saveAttachment(stored, mailbox, uid, part)))
  );

  server.registerTool(
    "set_read_status",
    {
      title: "네이버 메일 읽음 상태 변경",
      description: "사용자가 명시적으로 요청한 메일의 읽음 또는 안 읽음 상태를 네이버 서버에 반영합니다.",
      inputSchema: {
        mailbox: mailboxSchema,
        uid: uidSchema,
        read: z.boolean()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ mailbox, uid, read }, extra) => requestSignals.run(extra.signal, () => toolCallWithCredentials(credentials, (stored) => setReadStatus(stored, mailbox, uid, read)))
  );

  server.registerTool(
    "prepare_send",
    {
      title: "네이버 메일 발송 미리보기 준비",
      description:
        "메일을 발송하지 않고 수신자, 제목, 본문과 첨부파일을 검증해 10분짜리 발송 계획을 만듭니다. 전체 미리보기를 대화에 표시한 뒤 새 사용자 메시지의 명시적 발송 확인이 필요합니다.",
      inputSchema: {
        to: z.array(z.string()).min(1).max(LIMITS.recipientsPerField),
        cc: z.array(z.string()).max(LIMITS.recipientsPerField).default([]),
        bcc: z.array(z.string()).max(LIMITS.recipientsPerField).default([]),
        subject: z.string().max(LIMITS.subjectChars),
        text: z.string().max(LIMITS.outgoingBodyChars),
        attachmentPaths: z.array(z.string()).max(LIMITS.smtpAttachments).default([])
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input, extra) => requestSignals.run(extra.signal, () => toolCallWithCredentials(credentials, async (stored) => ({ ...(await sendPlans.prepare(input, stored.email)).preview, confirmationRequired: true })))
  );

  server.registerTool(
    "send_plan_status",
    {
      title: "메일 발송 준비 상태",
      description: "대화에서 검토한 발송 계획이 아직 유효한지 확인합니다.",
      inputSchema: {
        planId: z.string().min(20).max(80)
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ planId }, extra) => requestSignals.run(extra.signal, () => toolCall(async () => sendPlans.status(planId)))
  );

  server.registerTool(
    "send_mail",
    {
      title: "네이버 메일 실제 발송",
      description:
        "prepare_send의 전체 미리보기를 본 사용자가 새 메시지에서 명시적으로 발송을 확인한 경우에만 planId로 SMTP 발송합니다. 발송은 취소할 수 없습니다.",
      inputSchema: {
        planId: z.string().min(20).max(80)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ planId }, extra) => requestSignals.run(extra.signal, () => toolCall(async () => {
        const stored = await requireCredentials(credentials);
        const message = sendPlans.take(planId, stored.email);
        const sent = await sendNaverMail(stored, message);
        return {
          ...sent,
          irreversible: true
        };
      }))
  );

  return {
    server,
    async close() {
      await server.close();
    },
    async shutdown() {
      await server.close();
      if (ownsRuntime) await runtime.shutdown();
    }
  };
}

async function requireCredentials(credentials: CredentialStore) {
  const stored = await credentials.load();
  if (!stored) {
    throw new UserFacingError(
      "NOT_CONNECTED",
      "네이버 메일이 연결되지 않았습니다. open_setup 도구로 로컬 설정 화면을 먼저 열어 주세요."
    );
  }
  return stored;
}

async function formatToolCall<T>(callback: () => Promise<T>) {
  try {
    const value = await callback();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }]
    };
  } catch (error) {
    const safe = publicError(error);
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify({ error: safe }, null, 2) }]
    };
  }
}
