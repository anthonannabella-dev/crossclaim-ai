#!/bin/bash
# ============================================================
# 回滚到上一个版本
# 从 backups/pre-deploy-*.sql.gz 恢复数据库
# ============================================================
set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE_FILE="docker-compose.prod.yml"

# 找最新的部署前备份
LATEST_BACKUP=$(ls -t backups/pre-deploy-*.sql.gz 2>/dev/null | head -1)
if [ -z "$LATEST_BACKUP" ]; then
    echo "❌ 未找到备份文件，无法回滚"
    exit 1
fi

echo "从备份恢复: $LATEST_BACKUP"
gunzip -c "$LATEST_BACKUP" | docker compose -f "$COMPOSE_FILE" exec -T postgres psql -U customs -d customs_saas

echo "回滚到上一个 Git 提交..."
git checkout HEAD~1

echo "重新构建并启动..."
docker compose -f "$COMPOSE_FILE" up -d --build

echo "✅ 回滚完成"
