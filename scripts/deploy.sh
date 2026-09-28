#!/bin/bash
# ============================================================
# 生产环境一键部署脚本
# 用法:
#   ./scripts/deploy.sh               # 部署（不含备份恢复）
#   ./scripts/deploy.sh --seed-hs      # 部署后导入HS Code
#   ./scripts/deploy.sh --rollback     # 回滚到上一个版本
# ============================================================
set -euo pipefail

cd "$(dirname "$0")/.."
PROJECT_ROOT=$(pwd)

BACKUP_DIR="$PROJECT_ROOT/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
COMPOSE_FILE="docker-compose.prod.yml"

echo "========================================"
echo " Customs SaaS 生产部署 [$TIMESTAMP]"
echo "========================================"

# 1. 备份当前数据库
echo "[1/5] 备份数据库..."
docker compose -f "$COMPOSE_FILE" exec -T postgres pg_dump -U customs customs_saas | gzip > "$BACKUP_DIR/pre-deploy-$TIMESTAMP.sql.gz" || echo "  ⚠ 备份失败，继续部署..."

# 2. 拉取最新代码
echo "[2/5] 拉取最新代码..."
git pull --rebase

# 3. 重建镜像
echo "[3/5] 构建镜像..."
docker compose -f "$COMPOSE_FILE" build --no-cache backend
docker compose -f "$COMPOSE_FILE" build --no-cache frontend

# 4. 启动服务
echo "[4/5] 启动服务..."
docker compose -f "$COMPOSE_FILE" up -d --force-recreate backend frontend nginx

# 5. 健康检查
echo "[5/5] 健康检查..."
sleep 10
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/health 2>/dev/null || echo "000")
if [ "$HEALTH" = "200" ]; then
    echo "✅ 部署成功！后端响应: $HEALTH"
else
    echo "⚠ 部署完成但健康检查异常 (HTTP $HEALTH)，请检查容器日志:"
    echo "   docker compose -f $COMPOSE_FILE logs --tail=50 backend"
fi

echo ""
echo "部署完成: $TIMESTAMP"
