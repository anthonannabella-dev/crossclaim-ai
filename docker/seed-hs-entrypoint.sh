#!/bin/sh
# HS Code 自动导入入口点
# 在 docker 启动时调用，仅在表为空时执行
# 调用: docker compose exec -T backend sh -c "npx tsx prisma/seed_hs_bulk.ts"

set -e

echo "等待数据库就绪..."
until pg_isready -h postgres -U customs -d customs_saas 2>/dev/null; do
  sleep 2
done
echo "数据库就绪。"

echo "检查 HS Code 数据..."
HS_COUNT=$(PGPASSWORD="${POSTGRES_PASSWORD}" psql -h postgres -U customs -d customs_saas -t -A -c "SELECT COUNT(*) FROM "HSCode"" 2>/dev/null || echo "0")

if [ "$HS_COUNT" = "0" ] || [ "$HS_COUNT" = "" ]; then
  echo "HS 编码表为空，开始导入 (16,259条)..."
  npx tsx prisma/seed_hs_bulk.ts
  echo "HS 编码导入完成。"
else
  echo "HS 编码已存在 ($HS_COUNT 条)，跳过导入。"
fi
