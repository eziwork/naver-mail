# 클로드 코드에서 사용하기

[README](../README.md) · [계정 연결](USER_GUIDE.md#네이버-계정-연결하기)

v0.3.0부터 Codex와 Claude Code가 같은 메일 엔진·계정 연결 화면·12개 도구를 사용하도록 구성합니다. **현재 이 변경은 다음 배포용이며, 기존 v0.2.1 다운로드에는 클로드 코드 설정이 없습니다.** v0.3.0 이상 운영 패키지가 공개된 뒤 아래 방법으로 설치하세요.

## 지원 환경

| 운영체제 | 패키지 |
| --- | --- |
| Windows x64, 기본 Windows 터미널 | `naver-mail-<버전>-win32-x64.zip` |
| Mac Intel | `naver-mail-<버전>-darwin-x64.tar.gz` |
| Mac Apple Silicon | `naver-mail-<버전>-darwin-arm64.tar.gz` |

Claude Code 2.1.289 이상을 권장합니다. Windows ARM64 네이티브·WSL·Linux, claude.ai 웹·모바일·Cowork는 이 배포 범위에 포함하지 않습니다. ChatGPT도 로컬 MCP를 실행하는 Codex 앱·CLI 또는 지원되는 데스크톱 Work가 대상이며 일반 웹 채팅에 설치하는 방식은 아닙니다. 실제 검증 범위는 [배포 기록](../RELEASE.md)에 구분합니다.

## 설치

클로드 코드에 다음처럼 요청해도 됩니다. 설치를 맡은 에이전트는 아래 패키지 확인과 등록 순서를 따릅니다.

```text
https://github.com/eziwork/naver-mail
docs/CLAUDE_CODE.md를 읽고 내 운영체제에 맞는 네이버 메일 플러그인을 설치해 줘.
```

1. [Releases](https://github.com/eziwork/naver-mail/releases)에서 v0.3.0 이상의 운영체제·CPU에 맞는 **완성 패키지**와 같은 이름의 `.sha256` 파일을 받습니다. 공개 Release 목록에서 호환되는 정식판을 우선하고, 없으면 최신 사전 배포판을 선택해 표시합니다. 아직 해당 버전이 없으면 출시 전임을 알립니다. 소스 ZIP이나 다른 OS 패키지로 대신하지 않습니다.
2. Windows는 `Get-FileHash -Algorithm SHA256`, Mac은 `shasum -a 256`으로 파일명과 해시를 대조한 뒤 압축을 풉니다. Mac의 숨김 폴더와 실행 권한도 보존합니다. 아래 `<플러그인 절대 경로>`는 압축을 푼 **naver-mail 폴더**입니다. 공백이 있어도 하나의 인수로 전달하도록 따옴표를 유지합니다.
3. 터미널에서 차례대로 실행합니다. Node·Rust를 별도로 설치할 필요는 없습니다. 이 명령은 이미 설치된 Claude Code CLI를 사용합니다.

```text
claude plugin validate "<플러그인 절대 경로>"
claude plugin marketplace add "<플러그인 절대 경로>"
claude plugin install naver-mail@eziwork-naver-mail --scope user
claude plugin list
```

이미 같은 이름의 마켓플레이스가 다른 경로에 등록되어 있으면 덮어쓰지 말고 `claude plugin marketplace list`로 출처를 확인합니다. 설치 결과가 활성 상태인지 확인하고 Claude Code를 새로 시작합니다. `/mcp`에서 네이버 메일 연결을 확인한 뒤 **“네이버 메일 연결해 줘”**라고 요청하세요. 자동 적용되지 않으면 `/naver-mail:naver-mail`로 사용 지침을 불러올 수 있습니다.

GitHub 소스 저장소를 바로 `claude plugin marketplace add eziwork/naver-mail`로 등록하면 실행 파일이 없어 동작하지 않습니다. 기존 `naver-mail-install` 실행 파일은 **Codex 등록용**입니다. 클로드 코드에는 위의 완성 패키지 등록 절차를 사용합니다.

## 연결·조회·발송

계정 연결은 `127.0.0.1`의 임시 브라우저 화면에서 진행합니다. 비밀번호는 대화창에 입력하지 않습니다. 같은 PC의 같은 OS 사용자로 Codex에서 이미 연결했다면 같은 보안 저장소의 계정을 사용할 수 있습니다. 어느 한쪽에서 계정을 바꾸거나 연결을 해제하면 다른 쪽에도 영향을 줍니다.

최근 메일 검색, 과거 메일 검색, 본문·첨부파일 조회, 첨부 저장, 읽음 표시 변경, 초안 준비와 확인 후 발송을 지원합니다. 받는 사람·참조·숨은 참조·제목·전체 본문·첨부파일을 대화에서 검토한 다음 **새 메시지로 발송을 확인**합니다. 본문 조회나 발송 등 민감한 도구에는 Claude의 명시적 사용자 승인 메타데이터도 제공합니다. 비대화형·무인 발송용 플러그인이 아닙니다.

선택한 메일 내용은 사용하는 AI 서비스로 전달됩니다. Claude Code에서는 Anthropic, Codex에서는 OpenAI의 처리 정책과 조직 설정이 적용됩니다.

## 업데이트와 제거

업데이트는 새 패키지의 체크섬을 검증하고 Claude Code를 종료한 뒤, 기존 로컬 출처를 새 패키지로 교체해 진행합니다. 기존 폴더는 별도로 백업하고 다른 파일을 덮어쓰지 않습니다. 같은 등록 경로를 유지한 다음 실행합니다.

```text
claude plugin marketplace update eziwork-naver-mail
claude plugin update naver-mail@eziwork-naver-mail
```

제거할 때는 다음 명령을 사용합니다. 플러그인 제거만으로 OS 보안 저장소의 계정이 삭제되지는 않습니다. 양쪽에서 연결을 해제하려면 제거 전에 대화에서 요청하세요.

```text
claude plugin uninstall naver-mail@eziwork-naver-mail --scope user
claude plugin marketplace remove eziwork-naver-mail
```

공식 규격 확인: [플러그인 명세](https://code.claude.com/docs/en/plugins-reference), [로컬 마켓플레이스](https://code.claude.com/docs/en/plugin-marketplaces), [설치 명령](https://code.claude.com/docs/en/plugins/cli-reference), [도구별 명시적 승인](https://code.claude.com/docs/en/mcp). 확인일: 2026-10-06.
