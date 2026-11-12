# EUM Desktop Engine 을 창 없이 백그라운드로 실행 / 로그인 시 자동 시작 (Windows, 관리자 권한 불필요)
#
# 사용법 (저장소 폴더에서):
#   powershell -ExecutionPolicy Bypass -File scripts\engine-background.ps1 install   # 자동 시작 등록 + 지금 바로 실행
#   powershell -ExecutionPolicy Bypass -File scripts\engine-background.ps1 start     # 지금 실행 (창 없이)
#   powershell -ExecutionPolicy Bypass -File scripts\engine-background.ps1 stop      # 중지
#   powershell -ExecutionPolicy Bypass -File scripts\engine-background.ps1 status    # 실행 여부 + 최근 로그
#   powershell -ExecutionPolicy Bypass -File scripts\engine-background.ps1 log       # 로그 실시간 보기 (Ctrl+C 로 종료)
#   powershell -ExecutionPolicy Bypass -File scripts\engine-background.ps1 uninstall # 자동 시작 해제 + 중지
param([ValidateSet('install', 'start', 'stop', 'status', 'log', 'uninstall')][string]$Action = 'status')
$ErrorActionPreference = 'Stop'

$repo = Split-Path $PSScriptRoot -Parent
$cli = Join-Path $repo 'apps\engine\dist\src\cli.js'
$home_ = if ($env:EUM_ENGINE_HOME) { $env:EUM_ENGINE_HOME } else { Join-Path $env:USERPROFILE '.eum-engine' }
$logDir = Join-Path $home_ 'logs'
$log = Join-Path $logDir 'engine.log'
$vbs = Join-Path $home_ 'eum-engine-hidden.vbs'
$startup = [Environment]::GetFolderPath('Startup')
$startupVbs = Join-Path $startup 'EUM Desktop Engine.vbs'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source

function Running() {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like "*cli.js*start*" -and $_.CommandLine -like "*apps*engine*" }
}

function WriteLauncher() {
  if (-not $node) { throw 'node.exe 를 찾을 수 없습니다. Node.js 를 설치하세요.' }
  if (-not (Test-Path $cli)) { throw "엔진이 빌드되지 않았습니다. 먼저 실행:  npm run build --workspace apps/engine" }
  New-Item -ItemType Directory -Force $logDir | Out-Null
  # 로그가 5MB 를 넘으면 이전 로그로 돌립니다.
  $rotate = "If fso.FileExists(logf) Then If fso.GetFile(logf).Size > 5000000 Then fso.CopyFile logf, logf & "".old"", True : fso.DeleteFile logf"
  $content = @"
' EUM Desktop Engine 숨김 실행기 (자동 생성)
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
logf = "$log"
$rotate
sh.Run "cmd /c """"$node"" ""$cli"" start >> ""$log"" 2>&1""", 0, False
"@
  Set-Content -Path $vbs -Value $content -Encoding Unicode
}

function Start-Engine() {
  if (Running) { Write-Host '이미 실행 중입니다.' -ForegroundColor Yellow; return }
  WriteLauncher
  Start-Process wscript.exe -ArgumentList "`"$vbs`"" -WindowStyle Hidden
  Start-Sleep -Seconds 3
  if (Running) { Write-Host "엔진이 백그라운드에서 실행 중입니다. 로그: $log" -ForegroundColor Green }
  else { Write-Host "실행에 실패했습니다. 로그를 확인하세요: $log" -ForegroundColor Red; if (Test-Path $log) { Get-Content $log -Tail 20 } }
}

function Stop-Engine() {
  $procs = @(Running)
  if ($procs.Count -eq 0) { Write-Host '실행 중인 엔진이 없습니다.'; return }
  foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Host "엔진을 중지했습니다. (진행 중이던 작업은 서버가 다음 실행 때 되돌립니다)" -ForegroundColor Green
}

switch ($Action) {
  'install' {
    WriteLauncher
    Copy-Item $vbs $startupVbs -Force
    Write-Host "로그인 시 자동 시작으로 등록했습니다: $startupVbs" -ForegroundColor Green
    Start-Engine
  }
  'start' { Start-Engine }
  'stop' { Stop-Engine }
  'uninstall' {
    Stop-Engine
    if (Test-Path $startupVbs) { Remove-Item $startupVbs -Force; Write-Host '자동 시작을 해제했습니다.' -ForegroundColor Green }
  }
  'status' {
    $procs = @(Running)
    if ($procs.Count -gt 0) { Write-Host "실행 중 (PID $($procs.ProcessId -join ', '))" -ForegroundColor Green } else { Write-Host '중지됨' -ForegroundColor Yellow }
    Write-Host ("자동 시작: " + $(if (Test-Path $startupVbs) { '등록됨' } else { '등록 안 됨' }))
    if (Test-Path $log) { Write-Host "--- 최근 로그 ($log) ---"; Get-Content $log -Tail 15 }
  }
  'log' {
    if (-not (Test-Path $log)) { Write-Host "아직 로그가 없습니다: $log"; return }
    Get-Content $log -Tail 30 -Wait
  }
}
