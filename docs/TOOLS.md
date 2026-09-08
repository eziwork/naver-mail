# 12개 MCP 도구

[README](../README.md) · [설계](ARCHITECTURE.md) · [개발 문서](DEVELOPMENT.md)

도구 이름과 입력 형식은 기존 버전과 같습니다. 정확한 스키마의 원본은 [src/server.ts](../src/server.ts)이며 빌드 시 `dist/tool-catalog.json`을 생성합니다. 이 문서의 입력 표기는 주요 필드의 요약입니다. MCP 클라이언트는 `tools/list`의 실제 스키마를 사용하세요.

성공 결과는 MCP `content`의 텍스트에 JSON으로 담깁니다. 일반적인 도구 오류는 `isError:true`와 `{ "error": { ... } }` 구조입니다. Rust 중계·전송 계층 오류는 MCP 오류로 나타날 수도 있습니다. 비밀번호를 받는 MCP 도구는 없습니다.

| 도구 | 입력 | 역할과 주의점 |
| --- | --- | --- |
| `connection_status` | `verify` 기본 false | OS 키링의 연결 여부 확인. true일 때만 네이버 IMAP·SMTP 인증. `setup` 상태도 반환 |
| `open_setup` | `reconfigure` 기본 false | 30분 로컬 연결 화면. 브라우저 실행 결과와 수동 연결 주소 반환. 재설정은 true |
| `disconnect_account` | `confirm:true` | OS 저장 계정 삭제, 설정 세션 종료, 발송 계획 무효화 |
| `list_mailboxes` | 없음 | 메일함 path와 메시지 수 조회 |
| `search_mail` | `mailbox`, `query`, `from`, `to`, `subject`, `since`, `before`, `readStatus`, `limit`, `cursor` | 헤더 위주 검색·페이지 조회. mailbox 기본 INBOX, limit 기본 20·최대 50 |
| `get_mail` | `mailbox`, `uid`, `includeLinks` 기본 false | 읽음 상태를 바꾸지 않는 본문 조회. 첨부 part와 안전 신호 포함 |
| `get_mail_batch` | `mailbox`, `uids`, `includeLinks` 기본 false | 동일 메일함의 중복 없는 UID 1~10개. IMAP 연결·잠금 1회 |
| `save_attachment` | `mailbox`, `uid`, `part` | 요청한 첨부를 다운로드 폴더에 저장. 위험 파일 차단·OS 보호 표시 |
| `set_read_status` | `mailbox`, `uid`, `read` | 지정 메일의 읽음/안 읽음 상태를 명시적으로 변경 |
| `prepare_send` | `to`, `cc`, `bcc`, `subject`, `text`, `attachmentPaths` | 발송하지 않고 계정에 묶인 10분 계획과 전체 미리보기 반환 |
| `send_plan_status` | `planId` | 준비 상태 `prepared` 또는 `expired` 확인 |
| `send_mail` | `planId` | 사용자 확인 후 단 한 번 발송. 자동 재전송 금지 |

`open_setup` 및 `connection_status.setup`에 추가된 `expiresAt`은 최초 생성 기준 만료 시각, `browserOpened`는 브라우저 실행 요청의 성공 여부, `pageOpened`는 실제 로컬 화면 접속 여부입니다. 브라우저 실행 성공만으로 사용자가 화면을 보았거나 연결을 완료했다고 판단하지 않습니다. `state:connected`와 조회·발송·저장 검사 결과를 확인하세요. 유효한 설정을 다시 열면 같은 만료 시각의 세션을 재사용합니다. 계정 연결만 완료한 경우 앱 재시작은 필요하지 않습니다.

## 검색에서 본문까지

먼저 `list_mailboxes`의 `path`를 사용합니다. 네이버 표시 이름을 임의로 서버 경로라고 추정하지 않습니다. 검색 날짜는 `YYYY-MM-DD`, `since`는 그 날짜부터, `before`는 그 날짜 이전입니다. `readStatus`는 `any`, `read`, `unread`입니다.

```json
{
  "mailbox": "INBOX",
  "subject": "계약",
  "since": "2026-08-01",
  "before": "2026-09-01",
  "readStatus": "any",
  "limit": 20
}
```

다음 페이지가 있으면 반환된 `nextCursor`를 그대로 `cursor`에 전달합니다. UID는 검색 결과에서 얻은 값을 그대로 쓰며, 다른 메일함의 UID를 섞지 않습니다. 본문을 읽을 메일만 골라 `get_mail` 또는 `get_mail_batch`를 사용합니다.

## 첨부파일과 읽음 상태

`save_attachment.part`에는 본문 결과의 `attachments[].part`를 그대로 사용합니다. 다운로드 상한은 파일당 25 MiB이며 파일명·유형·실행 시그니처를 검사합니다. Windows Mark-of-the-Web 또는 macOS quarantine 표시가 실패하면 저장 성공으로 처리하지 않습니다.

본문 조회는 서버 읽음 플래그를 바꾸지 않습니다. 읽음 상태를 바꾸는 기능은 `set_read_status`로 분리되어 있습니다. 도구별 승인 기본값은 [.mcp.json](../.mcp.json)에 있으며 최종 승인 동작에는 호스트 정책도 적용됩니다.

## 발송 계획과 결과

`prepare_send`의 `to`는 필수이며 `cc`, `bcc`, `attachmentPaths`는 기본 빈 배열입니다. 필드별 수신자는 최대 20개, 전체 고유 수신자는 최대 40명입니다. 제목은 최대 300자, 본문은 최대 100,000자, 발송 첨부는 최대 10개·합계 20 MiB입니다.

예시는 메일 발송이 아닌 미리보기 준비 입력입니다.

```json
{
  "to": ["recipient@example.com"],
  "subject": "회의 일정 확인",
  "text": "안녕하세요. 다음 주 회의 가능 시간을 알려 주세요.",
  "attachmentPaths": []
}
```

반환되는 `from`, `to`, `cc`, `bcc`, `subject`, `textPreview`, `attachments`, `expiresAt`을 사용자에게 모두 보여 줍니다. 이름은 `textPreview`지만 **본문 전체**입니다. 이를 잘라서 보여 준 뒤 발송을 요청하지 않습니다.

새 사용자 메시지의 명시적 확인 후 `send_mail`에 `planId`만 전달합니다. 초안 내용·수신자·계정이 달라지면 새로운 계획과 확인이 필요합니다. 다른 MCP 클라이언트도 별도 확인 UI를 구현해야 합니다. 서버는 사용자의 대화 메시지를 직접 읽거나 확인할 수 없습니다.

| 결과 | 해석 |
| --- | --- |
| `deliveryStatus:"sent"` | SMTP 서버가 전체 수신자를 접수 |
| `deliveryStatus:"partial"` | 일부 수신자만 접수. `sent`는 true일 수 있음 |
| `deliveryStatus:"rejected"` | 접수된 수신자 없음. 명확한 주소·인증 오류는 오류 결과로도 반환 |
| `SEND_RESULT_UNKNOWN` | 통신 장애 등으로 접수 결과를 알 수 없음. 자동 재전송 금지 |

`accepted`, `rejected`, `messageId`와 함께 해석합니다. SMTP 접수는 최종 배달 증명이나 수신 확인이 아닙니다. 계획은 발송 시 먼저 소비되므로 같은 ID의 재호출은 거절됩니다. 네이버 보낸메일함·수신 여부를 확인한 뒤 필요하면 새 계획을 만들고 다시 사용자 확인을 받습니다.

## 연결 오류와 계정 변경

미연결은 `NOT_CONNECTED`, 만료된 발송 계획은 `SEND_PLAN_EXPIRED`, 보내는 계정이 달라지면 `SEND_ACCOUNT_CHANGED`로 안내합니다. 과도한 요청·대기 초안·파일 상한에도 별도 오류가 있습니다. 상세 사용자 메시지는 [src/errors.ts](../src/errors.ts)와 각 핸들러를 참고하세요.

오류 원문 전체를 공개 로그에 덤프하지 않습니다. 로컬 연결 주소의 토큰도 세션 비밀값이며 공개하지 않습니다.
