#!/bin/bash
# ============================================================
# HS Code 种子数据导入脚本
# 用法: ./scripts/seed-hs.sh
# 前置条件: docker compose 已在运行
# ============================================================
set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE_FILE="docker-compose.prod.yml"

echo "导入 HS Code 种子数据 (16,259条)..."
docker compose -f "$COMPOSE_FILE" exec -T backend sh -c "
  cd /app && \
  npx tsx prisma/seed_hs_bulk.ts
"
echo "✅ HS Code 导入完成"
