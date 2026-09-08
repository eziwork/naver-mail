# GitHub 주소로 설치하기

사용자는 다음 두 줄만 Codex의 로컬 작업에 전달합니다.

```text
https://github.com/eziwork/naver-mail
이 플러그인을 설치해 줘.
```

## 설치를 맡은 AI가 따를 절차

이 문서를 읽는 것 자체로 설치되지는 않습니다. 아래 절차로 **일회성 설치 도우미**를 실행해야 합니다. 비밀번호는 설치 중 요청하지 않습니다.

1. GitHub API `https://api.github.com/repos/eziwork/naver-mail/releases?per_page=100`에서 공개 Release 목록을 확인합니다. 다음 페이지가 있으면 이어서 확인합니다. `/releases/latest`의 404는 배포판이 없다는 뜻이 아닙니다. 정식판이 있으면 최신 정식판을, 없으면 최신 사전 배포판을 선택합니다. 사전 배포 여부를 사용자에게 표시합니다.
2. Windows x64, Intel Mac, Apple Silicon 중 실제 컴퓨터에 맞는 대상을 고릅니다. Mac에서는 `sysctl -n hw.optional.arm64`가 1이면 Rosetta 터미널에서도 Apple Silicon입니다.
3. 해당 Release의 아래 도우미와 같은 이름의 `.sha256` 파일을 받습니다. 버전 부분은 선택한 Release의 버전입니다.

| 대상 | v0.2.1 설치 도우미 |
| --- | --- |
| Windows x64 | `naver-mail-install-0.2.1-win32-x64.exe` |
| Intel Mac | `naver-mail-install-0.2.1-darwin-x64` |
| Apple Silicon Mac | `naver-mail-install-0.2.1-darwin-arm64` |

4. OS의 SHA-256 도구(Windows `Get-FileHash`, Mac `shasum -a 256`)로 도우미의 해시와 정확한 파일명을 대조합니다. 체크섬은 다운로드 무결성 검사이며 코드서명을 대신하지 않습니다. 검사 전에 실행하지 않습니다. Mac 파일에는 검사 후 실행 권한을 설정합니다.
5. 다운로드한 도우미를 `--dry-run --json`으로 실행하여 버전·대상·기존 등록 충돌을 확인하고, 이상이 없으면 `--json`으로 실행합니다. 사용자가 터미널을 다룰 필요 없이 AI가 수행합니다. 다운로드 코드를 셸에 바로 연결해 실행하지 않습니다.
6. 결과의 상태와 안내를 그대로 구분해 설명합니다. `package_prepared`는 파일만 준비된 상태, `app_reload_required`와 `registered:true`는 CLI 등록이 끝난 상태입니다. 등록 후 새 작업에서 네이버 메일 도구가 나타나는지 확인합니다. 새 작업에서도 없을 때만 앱 재시작을 안내합니다.

도우미가 없는 이전 배포판에서는 [수동 설치 안내](USER_GUIDE.md)의 완성 패키지를 사용합니다. 운영 패키지가 없거나 접근이 막혔다면 오류 원인을 알리고 중단합니다. Source code ZIP을 설치하거나 사용자 컴퓨터에서 Rust·npm 빌드를 대신 진행하지 않습니다.

## 도우미가 하는 일

- 공개 Release 목록에서 정식판과 사전 배포판을 구분하고 운영체제·CPU에 맞는 **운영 패키지**만 선택합니다.
- 파일 크기·SHA-256·압축 경로·버전·CPU·실행 권한·Node·키링·MCP 초기화와 12개 도구 목록을 검사합니다.
- 검사가 끝난 폴더를 로컬 플러그인 출처에 반영하고 `codex plugin add … --json`으로 등록합니다. 다른 플러그인 항목은 유지합니다.
- 중단된 작업은 다음 실행 때 복구합니다. 이전 폴더는 `naver-mail.previous-시간값`으로 보관합니다. 계정 키체인과 발송 계획에 접근하지 않습니다.
- 작업이 끝나면 도우미도 종료됩니다. 상시 RAM 점유를 추가하지 않습니다.

기존 로컬 설치는 등록된 마켓플레이스 이름과 경로를 유지합니다. 신규 설치의 기본 경로는 `~/.codex/plugins/naver-mail`, 개인 목록은 `~/.agents/plugins/marketplace.json`입니다. Git 저장소나 다른 출처의 동명 플러그인이 있으면 `SOURCE_CONFLICT`로 중단합니다. 개발자는 원본에서 빌드한 뒤 기존 CLI 재설치 절차를 사용하세요.

CLI는 PATH 또는 절대 경로인 `CODEX_CLI_PATH`에서 찾습니다. CLI가 없으면 `~/.codex/naver-mail-installer/staging/naver-mail`에 검증한 패키지를 준비하고 `package_prepared`를 반환합니다. 이 경우 앱의 로컬 플러그인 설치 흐름으로 이어가며 등록 완료라고 말하지 않습니다. OS가 미서명 실행 파일을 차단하면 해당 보안 안내를 확인해야 하며, 보호 기능을 끄거나 격리 속성을 일괄 제거하지 않습니다.

## 연결은 설치 후 등록된 MCP로 진행

새 작업에서 “네이버 메일 연결해 줘”라고 요청하면 `open_setup`이 로컬 연결 화면을 엽니다. 임시 셸 명령으로 별도 설정 서버를 띄우지 않습니다. 비밀번호는 로컬 연결 화면에만 입력하며 네이버 보안설정은 새 탭에서 사용자가 직접 진행합니다.

설정 화면은 최초 생성부터 30분 동안 유지됩니다. 계정 연결이 완료되면 앱으로 돌아가면 됩니다. 이미 사용할 수 있는 플러그인에 계정을 연결한 것만으로 앱을 재시작할 필요는 없습니다.

[OpenAI 공식 플러그인 패키징](https://developers.openai.com/plugins/build/plugins) · [GitHub latest Release의 범위](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)
