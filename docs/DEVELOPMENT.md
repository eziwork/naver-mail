# 빌드·테스트·배포

[README](../README.md) · [설계](ARCHITECTURE.md) · [도구 명세](TOOLS.md) · [검증 상태](../RELEASE.md)

이 문서는 개발자와 배포 담당자용입니다. 일반 사용자는 [설치 안내](USER_GUIDE.md)와 Releases의 완성 패키지를 사용합니다.

## 저장소 구성

```text
.codex-plugin/plugin.json   플러그인 식별·목록 표시 정보
.mcp.json                  로컬 Rust 중계 실행·도구 승인 설정
skills/naver-mail/         호스트 AI가 따라야 하는 메일 작업 지침
src/                      TypeScript 메일·설정 화면·공유 작업 프로세스
native/                   Rust MCP 중계와 Cargo.lock
assets/                   연결 화면 리소스·아이콘·제3자 고지
test/                     실제 메일 발송 없는 자동 테스트
scripts/                  빌드·패키지·수명 주기·성능 검사
docs/                     사용자·개발자 안내, 화면 예시, 측정값
.github/workflows/        Windows와 macOS CI
```

`dist/`, `bin/`, `runtime/`, `node_modules/`, `native/target/`, `releases/`는 생성 결과로 Git에서 제외합니다. GitHub 소스만 복제한 상태는 설치용 플러그인 패키지가 아닙니다. `.codex-plugin` 같은 숨김 폴더도 배포물에 필요합니다.

## 개발 환경

- Node.js 24.19.0과 npm. `package.json`의 최소 Node 조건은 22.12.0 이상이며 검증·배포 버전은 고정합니다.
- Rust 1.98.1과 Cargo. `native/Cargo.lock`을 사용해 `--locked`로 빌드합니다.
- Windows x64: MSVC C++ 빌드 도구와 Windows SDK.
- macOS: 해당 CPU용 Rust와 Xcode Command Line Tools. 실제 배포 빌드는 Mac의 기본 SDK·링커를 사용합니다.
- 의존성과 고정 Node 런타임을 받기 위한 인터넷 연결.

정확한 패키지 버전은 [package-lock.json](../package-lock.json)과 [Cargo.lock](../native/Cargo.lock)에 있습니다. Node 설치 파일은 공식 배포본의 SHA-256 목록과 비교합니다. 일반 사용자에게 개발 환경 설치를 요구하지 않습니다.

## 처음 빌드하기

PowerShell과 macOS 터미널에서 저장소 루트를 작업 디렉터리로 사용합니다. 아래 명령은 각각 순서대로 실행합니다.

```text
git clone https://github.com/eziwork/naver-mail.git
cd naver-mail
npm ci --ignore-scripts
npm run check
npm test
npm run build
npm run build:native
npm run prepare:runtime
npm run smoke
```

`npm ci --ignore-scripts`는 패키지의 설치 스크립트를 실행하지 않습니다. OS별 키링 모듈은 해당 플랫폼의 미리 빌드된 패키지로 포함됩니다. Rust 바이너리는 생성된 `dist/tool-catalog.json`을 포함하므로 `build`보다 먼저 `build:native`를 실행하면 안 됩니다.

성공하면 `dist/worker.js`, `dist/tool-catalog.json`, `bin/naver-mail-bridge[.exe]`, `runtime/<platform>-<arch>/`가 준비됩니다. Windows는 `win32-x64`, Mac은 `darwin-x64` 또는 `darwin-arm64`를 사용합니다.

## 검사별 의미

| 명령 | 무엇을 검증하나 | 실제 네이버 접속 |
| --- | --- | --- |
| `npm run check` | 소스와 테스트의 TypeScript 타입 | 없음 |
| `npm test` | 입력 검증, 만료·계정 바인딩, 첨부파일, 설정 서버, IMAP 묶음, SMTP 결과 등 | 없음. 대체 클라이언트 사용 |
| `npm run smoke` | Rust MCP 초기화와 12개 도구 목록 | 없음 |
| `npm run test:singleton` | 두 중계의 공유 Node, 유휴 종료·재실행·강제 종료 복구 | 없음. 격리된 테스트 디렉터리 사용 |
| `node scripts/lifecycle-test.mjs --real-idle` | 단축 타이머 대신 실제 30초 유휴 | 없음 |
| `node scripts/benchmark.mjs --bundled --real-idle` | 동봉 런타임으로 5회 시작·종료·메모리 측정 | 없음 |
| `npm run test:keyring` | 임의 테스트 레코드의 OS 키링 저장·조회·삭제 | 없음. 실제 계정 레코드 변경 없음 |

메모리 검사 목표는 설정·초안이 없는 MCP 연결 1개에서 최대 20 MiB, 유휴 Node 0개, 준비 3초 이내입니다. `--real-idle` 검사는 수 분이 걸릴 수 있습니다. `NAVER_MAIL_BENCHMARK_OUTPUT`에 JSON 출력 경로를 지정할 수 있습니다. 실제 사용자 앱과 별개로 측정되는 테스트 프로세스의 지표입니다.

키링 검사는 OS의 키체인 접근 UI가 필요할 수 있으므로 자동 CI의 무인 환경과 일반 로그인 세션을 구분합니다. 실제 네이버 인증은 로컬 연결 화면이나 `connection_status`의 `verify:true`로 따로 확인합니다. 테스트 스위트에 실제 계정 비밀번호를 넣지 않습니다. 실제 메일 발송은 사용자의 별도 명시적 요청이 있을 때만 진행합니다.

## 패키지 만들기

위 빌드·검사를 마친 대상 OS에서 다음을 실행합니다.

```text
npm run package
```

결과는 `releases/naver-mail-0.2.0-<platform>-<arch>.zip` 또는 `.tar.gz`와 `.sha256`입니다. 패키지에는 다음이 들어 있습니다.

- 플러그인 manifest, MCP 설정, 스킬, 화면 자산, 사용자·개발 문서
- 컴파일된 Node 작업 코드와 생성한 도구 목록
- 대상 OS의 Rust 중계, Node 런타임과 라이선스
- 개발용 의존성을 제외한 운영용 npm 패키지와 OS별 키링 모듈
- 버전·대상·서명 여부를 기록한 `BUILD.json`과 파일별 `SHA256SUMS`

Node와 Rust의 바이너리를 Git에 넣지 않고 Releases의 다운로드 자산으로 배포합니다. `package.json`의 `private:true`는 npm 레지스트리 오발행을 방지하며 GitHub 저장소의 공개 여부와 무관합니다.

`scripts/package.mjs`의 `--repack`은 기존 스테이징의 의존성을 재사용합니다. 문서만 갱신할 때 사용할 수 있지만 의존성이나 대상 OS가 바뀌었다면 새로 패키징합니다. 교차 패키지 변수는 `NAVER_MAIL_PACKAGE_PLATFORM`, `NAVER_MAIL_PACKAGE_ARCH`, `NAVER_MAIL_BRIDGE_BINARY`이며 실제 대상 바이너리·런타임·키링 모듈이 먼저 준비되어야 합니다. 변수만 바꾼다고 다른 OS용 코드가 빌드되는 것은 아닙니다.

## 로컬 앱에서 설치 검증하기

패키지를 새로운 폴더에 압축 해제하고 그 **완성 폴더**를 로컬 마켓플레이스에 등록합니다. 소스 디렉터리나 빌드 도구의 의존성에 우연히 기대지 않는지 확인하는 단계입니다.

관리자가 사용할 수 있는 독립된 테스트 목록 예시는 다음과 같습니다.

```text
naver-mail-test/
  .agents/plugins/marketplace.json
  plugins/naver-mail/               압축을 푼 완성 플러그인
```

```json
{
  "name": "eziwork-mail-test",
  "interface": { "displayName": "Eziwork 메일 테스트" },
  "plugins": [{
    "name": "naver-mail",
    "source": { "source": "local", "path": "./plugins/naver-mail" },
    "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
    "category": "Productivity"
  }]
}
```

`source.path`는 `.agents/plugins/`가 아니라 마켓플레이스 루트 기준입니다. 이 루트를 지원되는 Codex CLI에서 `codex plugin marketplace add <절대 경로>`로 등록하고, 데스크톱 앱을 재시작한 뒤 플러그인 목록에서 설치해 새 작업으로 검사합니다. 기존 개인 마켓플레이스를 수정할 때는 다른 항목을 덮어쓰지 말고 플러그인 생성 도구로 병합합니다.

이 저장소의 Git 소스에는 OS별 런타임과 실행 파일이 없으므로, 저장소 URL을 마켓플레이스에 바로 연결하면 설치는 되어도 실행할 수 없는 폴더가 될 수 있습니다. 사용자에게는 [GitHub 주소 설치 지침](INSTALL_FROM_GITHUB.md)에 따라 최신 Release 운영 패키지를 내려받아 등록하는 흐름을 제공합니다. 개발자·관리자가 GitHub 마켓플레이스를 구성할 때도 `source.path`가 가리키는 위치에 완성된 Release 폴더를 넣어야 합니다. 조직의 마켓플레이스 자동 동기화와 OpenAI 공개 디렉터리 등록은 준비된 패키지 배포와 별도의 작업입니다. [공식 패키징 문서](https://developers.openai.com/plugins/build/plugins)를 기준으로 호스트 버전별 지원을 확인하세요.

## 설정과 환경변수

기본값은 [src/constants.ts](../src/constants.ts)에 있습니다. 사용자용 설정 파일에 메일 비밀번호를 넣지 않습니다.

| 변수 | 용도 |
| --- | --- |
| `CODEX_MCP_NODE_PATH` | 호스트 앱이 제공하는 Node 절대 경로. 없으면 동봉 런타임 사용 |
| `NAVER_MAIL_RUNTIME_DIR`, `NAVER_MAIL_PIPE` | Rust가 Node에 전달하는 내부 IPC 설정. 일반 사용자는 설정하지 않음 |
| `NAVER_MAIL_BUILD_TARGET`, `CARGO_TARGET_DIR` | 개발자의 Rust 대상·출력 경로 |
| `NAVER_MAIL_PACKAGE_PLATFORM`, `NAVER_MAIL_PACKAGE_ARCH` | 패키지 대상 플랫폼·CPU |
| `NAVER_MAIL_BRIDGE_BINARY`, `NAVER_MAIL_RELEASE_DIR` | 준비된 중계 파일·배포 결과 경로 지정 |
| `NAVER_MAIL_TEST_ROOT`, `NAVER_MAIL_TEST_IDLE_MS` | 격리된 수명 주기 검사 전용. 운영 앱 설정에 넣지 않음 |

## CI와 릴리스 절차

[Desktop validation](../.github/workflows/validate.yml)은 Windows x64, macOS Intel, macOS Apple Silicon에서 타입·단위 테스트·각 OS의 네이티브 빌드·실제 30초 유휴·패키지를 검사합니다. 결과는 [GitHub Actions](https://github.com/eziwork/naver-mail/actions/workflows/validate.yml)에 남고, 패키지와 benchmark JSON을 아티팩트로 보관합니다. CI 통과는 실제 데스크톱 앱의 설정 UI·네이버 계정·서명·공증 검증까지 의미하지 않습니다.

1. 버전 변경 시 `package.json`과 lockfile, `src/constants.ts`, Cargo manifest/lock, 플러그인 manifest를 함께 갱신합니다.
2. 변경한 스키마를 기준으로 도구 목록을 재생성하고 Rust를 다시 빌드합니다.
3. 테스트·깨끗한 패키지 실행·플랫폼별 확인을 수행하고 [RELEASE.md](../RELEASE.md)에 실제 실행 범위를 기록합니다.
4. 인증서가 준비되면 Windows Authenticode와 macOS Developer ID 서명·공증을 수행합니다. 서명 후 패키지와 체크섬을 다시 만듭니다.
5. Git 태그와 소스 커밋을 연결하고 Releases에 OS별 패키지·체크섬·검증 상태를 올립니다. 미검증 또는 미서명 단계는 사전 배포판으로 표시합니다.

0.2.0의 Mac 파일은 Windows에서 교차 빌드했습니다. 실제 배포용 재빌드는 Mac SDK를 사용하는 CI 또는 Mac 환경에서 수행합니다. Windows 교차 빌드의 상세 제한은 [배포 상태](../RELEASE.md)에 기록했습니다.

## 복구와 로그 취급

기존 패키지를 보관하고 문제가 생기면 앱을 종료한 뒤 이전 패키지를 다시 등록·설치합니다. OS 키링 레코드는 그대로 유지합니다. 메모리의 발송 계획은 복원하지 않습니다. 발송 중 연결이 끊겼다면 네이버 보낸메일함과 수신 여부부터 확인하고 재시도를 결정합니다.

MCP 표준 출력에는 프로토콜 데이터만 출력해야 합니다. 로그를 추가할 때 비밀번호·본문·계정 주소·로컬 설정 토큰을 기록하지 않습니다. 버그 재현은 합성 메일과 테스트 파일을 사용하고, 공개 이슈에는 필요한 오류 코드만 남깁니다.

제3자 의존성의 고지는 [assets/licenses](../assets/licenses)에 있으며 Naver 안내 이미지 출처는 [SOURCES.md](../assets/guide/SOURCES.md)에 있습니다. 이 게시 작업에서 프로젝트 전체의 새로운 라이선스를 지정하지 않았습니다.
