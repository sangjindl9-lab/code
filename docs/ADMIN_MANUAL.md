# 관리자 매뉴얼

## 1. 서버 설치

### Docker Compose (자체 서버)
```bash
cp .env.example .env
# POSTGRES_PASSWORD 와 JWT_SECRET 을 반드시 채웁니다
#   JWT_SECRET 생성: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
docker compose up -d --build
docker compose logs -f server      # "EUM Control Server 실행 중" 확인
```
외부에서 접속하려면 HTTPS가 필요합니다. PC 엔진은 `https://` 주소가 아니면 연결을 거부합니다(로컬 테스트 주소 제외). Nginx·Caddy 같은 리버스 프록시에서 인증서를 붙이고 `/ws` 경로의 WebSocket 업그레이드를 허용하세요.

### Railway
저장소의 `Dockerfile` 과 `railway.json` 을 그대로 사용합니다. PostgreSQL 서비스를 추가하고 서버 서비스에 다음 변수를 설정합니다.

| 변수 | 값 |
| --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `JWT_SECRET` | 32바이트 이상 무작위 문자열 |
| `STORAGE_DIR` | `/data/storage` (볼륨을 `/data` 에 연결) |
| `RAILWAY_RUN_UID` | `0` (볼륨 쓰기 권한) |
| `PORT` | `4000` |

### 환경변수 전체
`.env.example` 에 설명과 함께 있습니다. `ALLOW_SIGNUP=1` 로 두면 누구나 가입할 수 있으니, 필요한 사람이 가입한 뒤에는 `0` 으로 되돌리세요. 가입한 사람은 각자 분리된 작업공간(조직)을 갖습니다.

## 2. 데이터베이스

- 스키마는 `apps/server/migrations/*.sql` 이며 서버가 시작할 때 아직 적용되지 않은 파일만 순서대로 적용합니다. 스키마를 바꿀 때는 기존 파일을 고치지 말고 새 번호의 파일을 추가합니다.
- 백업: `pg_dump "$DATABASE_URL" -Fc -f eum-$(date +%F).dump`
- 복원: `pg_restore -d "$DATABASE_URL" --clean eum-날짜.dump`
- 결과물 파일은 DB가 아니라 `STORAGE_DIR` 에 있습니다. DB와 함께 백업하세요.

## 3. PC 엔진 관리

| 명령 | 설명 |
| --- | --- |
| `eum-engine doctor` | Node·Git·npm·Docker·AI 도구 상태 점검 |
| `eum-engine pair --server URL --code 코드` | 서버에 PC 등록 |
| `eum-engine start` | 엔진 실행 (Ctrl+C 로 종료, 실행 중 작업도 중단) |
| `eum-engine config` | 현재 설정 보기 |
| `eum-engine config workspaceRoot D:\EUM-Projects` | 프로젝트 저장 경로 |
| `eum-engine config maxConcurrency 2` | 동시에 진행할 프로젝트 수 (프로젝트 하나 안에서는 항상 한 작업씩) |
| `eum-engine config cpuLimitPercent 80` | CPU 사용률이 이 값을 넘으면 새 작업을 받지 않음 |
| `eum-engine config minFreeMemMb 1024` | 여유 메모리가 이 값보다 적으면 새 작업을 받지 않음 |
| `eum-engine config allowMeteredApi true` | **요금 발생 가능.** API 키로 로그인된 AI 도구 사용 허용 |

설정 파일은 `%USERPROFILE%\.eum-engine\config.json` 입니다. 웹의 PC 연결 화면에서 **일시정지**(새 작업을 받지 않음)와 **연결 해제**(토큰 즉시 무효)를 할 수 있습니다.

### Windows 트레이 앱·설치 패키지 (미검증)
```powershell
cd apps\engine\desktop
npm install
npm start          # 개발 실행
npm run dist       # release\ 에 설치 파일(NSIS) 생성
```
코드 서명 인증서가 있으면 electron-builder의 `CSC_LINK`, `CSC_KEY_PASSWORD` 환경변수로 지정합니다.

## 4. 역할별 AI 배정
웹 **설정 → 역할별 AI 배정** 에서 기획·백엔드·오류 수정 등 역할마다 사용할 AI 도구를 고릅니다. 목록에는 연결된 PC에 설치된 도구만 나옵니다. 새 프로젝트부터 적용됩니다.

## 5. 장애 대응

| 상황 | 시스템 동작 | 관리자 조치 |
| --- | --- | --- |
| PC가 갑자기 꺼짐 | 임대 시간(`LEASE_SEC`, 기본 60초) 후 작업을 대기열로 되돌림. 같은 작업이 3번 끊기면 실패 처리 | PC를 켜고 엔진 실행. 실패했다면 **다시 시도** |
| 엔진만 재시작 | 시작하면서 자신이 맡았던 작업을 즉시 반납하고 다시 받음. 커밋되지 않은 변경은 마지막 체크포인트로 되돌림 | 없음 |
| 서버 재시작 | 작업 상태는 DB에 있어 유지됨. 시작할 때 만료된 임대를 정리 | 없음 |
| 서버와 PC 사이 통신 끊김 | 엔진이 로그를 쌓아 두었다가 순번대로 다시 전송, 서버가 중복 제거 | 없음 |

## 6. 감사 로그
`audit_logs` 테이블에 가입·로그인(실패 포함)·프로젝트 생성/취소/재시도·승인/반려·PC 등록/해제/일시정지·결과물 업로드/다운로드가 사용자, IP, 시각과 함께 기록됩니다. 조회 화면은 아직 없어 SQL로 확인합니다.

```sql
SELECT created_at, action, user_id, ip, detail FROM audit_logs ORDER BY id DESC LIMIT 100;
```
