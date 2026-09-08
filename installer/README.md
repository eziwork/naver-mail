# 일회성 설치 도우미

메일 중계와 별도인 Rust 실행 파일입니다. GitHub Release 목록에서 운영 패키지를 선택하고 무결성을 검증한 뒤 로컬 Codex CLI로 등록합니다. Node는 설치 도우미 자체의 실행에 필요하지 않습니다.

`cargo test --locked --manifest-path installer/Cargo.toml`로 테스트하고 `npm run build:installer`로 현재 OS용 파일과 체크섬을 만듭니다. 설치 절차는 [GitHub 주소 설치 지침](../docs/INSTALL_FROM_GITHUB.md)에 있습니다.

`--dry-run --json`은 배포판과 기존 설치를 조회하고 파일을 변경하지 않습니다. `--json`은 실제 설치를 수행합니다. 계정 자격 증명은 읽거나 저장하지 않습니다.

새 파일은 사용자 홈의 도우미 작업 폴더에서 검사하며 설치 전 트랜잭션 기록을 남깁니다. 중단 시 다음 실행에서 복구합니다. 기존 Git 작업 폴더와 다른 출처의 플러그인은 덮어쓰지 않습니다.
