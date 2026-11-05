# EUM AI SOFTWARE FACTORY PRO

휴대폰이나 브라우저에서 "이런 프로그램을 만들어줘"라고 요청하면, 내 PC에 설치한 개발 엔진이 구독 중인 AI 코딩 도구(Codex CLI)로 실제 소스코드를 만들고, 실제 테스트를 통과한 결과물만 웹에서 내려받게 해 주는 시스템입니다.

현재 상태: **PHASE 1 (실행 가능한 핵심 MVP)**. 구현된 범위와 남은 작업은 [docs/STATUS.md](docs/STATUS.md), 실제 테스트 결과는 [docs/TEST_REPORT.md](docs/TEST_REPORT.md)를 보세요.

## 구성

| 폴더 | 내용 |
| --- | --- |
| `apps/server` | 중앙 서버 (NestJS + PostgreSQL). 인증, 프로젝트, 작업 대기열, 승인, 결과물, 감사 로그 |
| `apps/web` | 웹 관리 화면 (Next.js, PWA). 서버가 정적 파일로 함께 제공 |
| `apps/engine` | PC 개발 엔진 (Node.js). AI 도구 실행, Git 작업 폴더, 테스트, 패키징 |
| `apps/engine/desktop` | Windows 트레이 앱 (Electron) 과 설치 패키지 빌드 설정 |
| `android` | PWA 를 Android APK 로 패키징하는 설정 |
| `tests/e2e.mjs` | 서버·엔진을 실제 프로세스로 띄우는 전체 흐름 검증 |
| `docs` | 사용자·관리자 매뉴얼, 보안·운영 가이드, 테스트 보고서 |

## 빠른 시작

**1. 서버** (자체 서버에 설치하는 경우)

```bash
cp .env.example .env      # POSTGRES_PASSWORD, JWT_SECRET 입력
docker compose up -d --build
# http://서버주소:4000 접속 → 첫 계정이 관리자가 됩니다
```

**2. PC 엔진** (Windows PowerShell, Node.js 20 이상과 Git 필요)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-engine.ps1
npm install -g @openai/codex ; codex login        # 본인 ChatGPT 계정으로 로그인
eum-engine pair --server https://서버주소 --code XXXX-XXXX   # 코드는 웹 [PC 연결]에서 발급
eum-engine start
```

**3. 웹에서 [새로 만들기]** 로 프로그램 제작을 요청합니다.

## 개발·테스트

```bash
npm install
npm run build
TEST_DATABASE_URL=postgres://... npm test          # 서버 16건 + 엔진 10건
E2E_DATABASE_URL=postgres://...  npm run test:e2e  # 전체 흐름 7개 시나리오
```
