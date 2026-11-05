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

if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
  Write-Host ""
  Write-Host "Codex CLI 가 없습니다. 아래 명령으로 설치한 뒤 본인의 ChatGPT 계정으로 로그인하세요:" -ForegroundColor Yellow
  Write-Host "  npm install -g @openai/codex"
  Write-Host "  codex login"
}
Write-Host ""
Write-Host "설치 완료. 웹의 [PC 연결] 화면에서 연결 코드를 발급한 뒤 아래 순서로 실행하세요:" -ForegroundColor Green
Write-Host "  eum-engine pair --server https://서버주소 --code XXXX-XXXX"
Write-Host "  eum-engine start"
