# EUM Desktop Engine 설치 (Windows PowerShell)
# 사용법: 저장소 폴더에서  powershell -ExecutionPolicy Bypass -File scripts\install-engine.ps1
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

function Require($name, $hint) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { Write-Host "[필요] $name 이(가) 없습니다. $hint" -ForegroundColor Red; exit 1 }
}
Require node "https://nodejs.org 에서 Node.js 20 이상을 설치하세요."
Require git  "https://git-scm.com 에서 Git 을 설치하세요."
$major = [int]((node -v).TrimStart('v').Split('.')[0])
if ($major -lt 20) { Write-Host "[필요] Node.js 20 이상이 필요합니다. (현재 $(node -v))" -ForegroundColor Red; exit 1 }

Write-Host "1/3 엔진 빌드 중..."
npm install --workspace apps/engine --include-workspace-root=false --no-audit --no-fund
npm run build --workspace apps/engine

Write-Host "2/3 eum-engine 명령 등록 중..."
Push-Location apps\engine; npm link --no-audit --no-fund; Pop-Location

Write-Host "3/3 설치된 도구 점검"
eum-engine doctor

Write-Host ""
Write-Host "AI 도구는 쓰려는 것만 설치하고 본인의 구독 계정으로 로그인하세요 (종량제 API 키는 쓰지 않습니다):" -ForegroundColor Yellow
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Write-Host "  Claude : npm install -g @anthropic-ai/claude-code ; claude   (구독 계정 선택)" }
if (-not (Get-Command codex  -ErrorAction SilentlyContinue)) { Write-Host "  GPT    : npm install -g @openai/codex ; codex login" }
if (-not (Get-Command agy    -ErrorAction SilentlyContinue)) { Write-Host "  Gemini : https://antigravity.google/download 설치 후 agy 실행" }
Write-Host ""
Write-Host "설치 완료. 웹의 [PC 연결] 화면에서 연결 코드를 발급한 뒤 아래 순서로 실행하세요:" -ForegroundColor Green
Write-Host "  eum-engine pair --server https://서버주소 --code XXXX-XXXX"
Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\engine-background.ps1 install   # 창 없이 실행 + 자동 시작"
Write-Host "  (창에서 직접 보려면: eum-engine start)"
