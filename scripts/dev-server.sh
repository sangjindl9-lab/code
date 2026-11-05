#!/usr/bin/env bash
# 개발용: 중앙 서버 + 웹 화면을 한 번에 빌드해서 실행합니다. (.env 필요)
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a
npm install --no-audit --no-fund
npm run build:server && npm run build:web
node apps/server/dist/src/main.js
