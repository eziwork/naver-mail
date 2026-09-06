# 0.2.0 배포 상태와 검증

이 패키지는 로컬 데스크톱용입니다. 웹·클라우드 Work 연결은 포함하지 않습니다.

## 현재 확인한 내용

- Windows x64에서 타입 검사, 자동 테스트, Rust MCP 초기화와 12개 도구 목록, 동시 연결 2개, 작업 프로세스 공유, 실제 30초 유휴 종료, 다음 호출 재시작, 강제 종료 후 복구를 확인했습니다.
- 고정 Node 24.19.0을 포함한 실행을 확인했습니다. 런타임 다운로드는 공식 SHASUMS256와 대조합니다.
- 연결 화면은 가상 계정으로 브라우저 검증했습니다. 일반·좁은 화면, 연결 완료, 비밀번호 입력란 삭제, 브라우저 저장소 미사용을 확인했습니다.
- macOS ARM64와 Intel 교차 빌드에 성공했습니다. Mach-O의 CPU 종류와 시스템 라이브러리 의존성을 확인했습니다. 실제 macOS 기기에서 앱 연결·키체인·첨부파일 격리·메모리를 확인하기 전에는 지원 검증 완료로 표시하지 않습니다.
- 실제 메일은 발송하지 않았습니다. SMTP 일부 거절·통신 단절은 대체 전송기로 검증했습니다.
- 이 로컬 검증판은 개발자 코드서명과 macOS 공증을 받지 않았습니다. 공개 배포 완성판으로 표시하지 않습니다.

Windows 최종 자동 테스트는 37개가 통과했습니다. 연결 1개를 유지하며 실제 30초 유휴 종료를 5회 반복한 결과, 최대 대기 작업 집합은 7.56 MiB, Node 준비 시간은 0.921~1.305초, 유휴 Node 수는 0개였습니다. 네이버 통신 시간을 포함하지 않은 수치입니다. 이전 버전은 같은 Windows 작업 집합 기준 약 95 MiB였습니다. 장기간 사용이나 다른 OS에서도 같은 수치가 보장되는 것은 아닙니다.

깨끗한 운영용 의존성으로 구성한 Windows 패키지에서 기존 자격 증명을 그대로 읽고 네이버 IMAP·SMTP 검증을 통과했습니다. 실제 메일 본문 조회나 발송은 수행하지 않았습니다. 12개 도구의 입력 스키마를 기존 배포본과 비교해 일치함을 확인했습니다.

## 재현 가능한 확인

개발 환경에서 `npm ci --ignore-scripts`, `npm run check`, `npm test`, `npm run build`, `npm run build:native`, `npm run prepare:runtime`, `npm run smoke`, `node scripts/lifecycle-test.mjs --real-idle`, `node scripts/benchmark.mjs --bundled --real-idle`, `npm run package` 순서로 확인합니다. 일반 사용자가 실행할 명령이 아닙니다.

`.github/workflows/validate.yml`은 Windows, Intel Mac, Apple Silicon Mac을 각각 빌드하고 유휴 종료와 재실행을 검증합니다. [GitHub Actions 실행 기록](https://github.com/eziwork/naver-mail/actions/workflows/validate.yml)에서 해당 커밋의 실제 결과를 확인하세요. 워크플로 파일의 존재만으로 통과를 의미하지 않습니다. Mac UI와 실제 네이버 로그인은 별도 확인이 필요합니다. 임시 OS 키링 읽기·쓰기 검사는 `npm run test:keyring`으로 실행하며 실제 계정을 변경하지 않습니다.

Windows에서 Mac 교차 빌드 시 Rust 표준 라이브러리의 사용하지 않는 `-liconv` 링크 지정만 제외하고 Zig의 macOS 시스템 라이브러리 정의를 사용했습니다. 실제 배포용 Mac 재빌드는 Xcode SDK와 기본 Rust 링커를 사용하는 위 macOS 작업에서 수행해야 합니다.

## 정식 배포 전 남은 확인

1. 깨끗한 Windows 및 Intel·Apple Silicon Mac에서 플러그인 설치, 실제 데스크톱 앱 MCP 연결, 계정 연결과 재설정을 확인합니다. 네이버 인증은 사용자가 로컬 화면에서 직접 입력합니다.
2. Mac 키체인 허용/거절/잠금, 200% 확대·키보드만 사용, 브라우저 실행 실패·만료 복구, 첨부파일 격리를 확인합니다.
3. Windows Authenticode와 Apple Developer ID로 중계를 서명하고, Mac 키링 모듈 및 동봉 런타임의 서명·hardened runtime 호환성을 확인합니다. Apple `notarytool`로 최종 배포물을 공증하고 Gatekeeper로 검사합니다. 호스트 Node의 코드서명에 따른 키체인 권한도 확인합니다.
4. 서명 후 체크섬과 압축파일을 다시 생성합니다. 앱 번들 또는 설치 패키지를 사용한다면 해당 최종 배포물을 공증합니다. 인증서와 Apple 계정은 저장소에 포함하지 않습니다.
5. 사용자 승인 후에만 본인에게 테스트 메일을 발송하여 전체 경로를 확인합니다. 발송 장애는 재시도하지 말고 결과를 먼저 확인합니다.

## 복구

업데이트는 OS 키링의 기존 계정 레코드를 변경하지 않습니다. 문제가 있으면 Codex를 종료하고 백업한 플러그인 원본을 복원한 후 앱 플러그인 화면에서 다시 설치하고 새 작업을 시작합니다. 발송 계획은 메모리에만 있어 재시작 시 사라집니다. 발송 중 장애가 있었다면 보낸메일함·수신 여부를 먼저 확인합니다.

## 기준 문서

- [OpenAI 로컬 MCP](https://learn.chatgpt.com/docs/extend/mcp)
- [공식 Rust MCP SDK](https://rust.sdk.modelcontextprotocol.io/)
- [네이버 IMAP/SMTP 설정](https://help.naver.com/service/30029/contents/21344?osType=COMMONOS)
- [GitHub 실행 환경](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [Node 24.19.0 지원 플랫폼](https://github.com/nodejs/node/blob/v24.19.0/BUILDING.md)
