#!/usr/bin/env bash
# EUM Desktop Engine 설치 (macOS / Linux — 개발·테스트용)
set -euo pipefail
cd "$(dirname "$0")/.."
command -v node >/dev/null || { echo "[필요] Node.js 20 이상을 설치하세요."; exit 1; }
command -v git >/dev/null || { echo "[필요] Git 을 설치하세요."; exit 1; }
npm install --workspace apps/engine --include-workspace-root=false --no-audit --no-fund
npm run build --workspace apps/engine
(cd apps/engine && npm link --no-audit --no-fund)
eum-engine doctor
echo "설치 완료.  eum-engine pair --server https://서버주소 --code XXXX-XXXX  →  eum-engine start"
