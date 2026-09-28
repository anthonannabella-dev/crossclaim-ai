#!/bin/bash
# ==============================================================
# deploy-live.sh — 一键热部署后端源码到运行中的容器
# 绕过 Docker build 网络问题（VPN 关闭时 npm registry 不可达）
# ==============================================================
# 用法:
#   ./deploy-live.sh              # 部署当前 backend/ 源码
#   ./deploy-live.sh /path/to/backend  # 部署指定路径
# ==============================================================
set -euo pipefail

CONTAINER_NAME="customs-backend"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  customs-saas 热部署脚本 (Hot Reload)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 1. 定位源码目录
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="${1:-$SCRIPT_DIR/backend}"
SRC_DIR="$(cd "$SRC_DIR" 2>/dev/null && pwd || echo "$SRC_DIR")"

if [ ! -f "$SRC_DIR/package.json" ]; then
  echo "❌ 错误: 目录 $SRC_DIR 中没有 package.json"
  echo "   用法: $0 [backend源码路径]"
  exit 1
fi
echo "📁 源码目录: $SRC_DIR"

# 2. 检查容器运行状态
if ! docker ps --format '{{.Names}}' | grep -qxF "$CONTAINER_NAME"; then
  echo "❌ 错误: 容器 $CONTAINER_NAME 未运行"
  echo "   请先: cd 项目目录 && docker-compose up -d"
  exit 1
fi
echo "✅ 容器 $CONTAINER_NAME 运行中"

# 3. 复制源码到容器
echo ""
echo "📦 [1/4] 复制源码到容器..."
TMP_DIR="/tmp/deploy-$(date +%s)"
docker exec "$CONTAINER_NAME" mkdir -p "$TMP_DIR"

(cd "$SRC_DIR" && tar cz \
  --exclude='node_modules' \
  --exclude='node_modules_tmp' \
  --exclude='dist' \
  --exclude='.git' \
  --exclude='__tests__' \
  .) | docker exec -i "$CONTAINER_NAME" tar xz -C "$TMP_DIR"

echo "   ✅ 源码已复制到 $TMP_DIR"

# 4. 安装依赖
echo ""
echo "📦 [2/4] 安装 npm 依赖..."
START_TS=$(date +%s)
docker exec "$CONTAINER_NAME" sh -c "cd $TMP_DIR && npm install --include=dev --no-fund --no-audit"
END_TS=$(date +%s)
echo "   ✅ npm install 完成 ($((END_TS - START_TS))s)"

# 5. 编译
echo ""
echo "🔨 [3/4] 编译 TypeScript..."
START_TS=$(date +%s)
docker exec "$CONTAINER_NAME" sh -c "cd $TMP_DIR && npm run build"
END_TS=$(date +%s)
echo "   ✅ 编译完成 ($((END_TS - START_TS))s)"

# 6. 检查编译产物
if ! docker exec "$CONTAINER_NAME" test -f "$TMP_DIR/dist/index.js"; then
  echo "   ⚠️  dist/index.js 未生成，编译可能失败"
  echo "   手动检查: docker exec $CONTAINER_NAME ls -la $TMP_DIR/dist/"
fi

# 7. 替换运行中的代码
echo ""
echo "🚀 [4/4] 替换运行中代码..."
docker exec "$CONTAINER_NAME" sh -c "
  rm -rf /app/dist.bak /app/node_modules.bak 2>/dev/null || true
  [ -d /app/dist ] && mv /app/dist /app/dist.bak
  [ -d /app/node_modules ] && mv /app/node_modules /app/node_modules.bak 2>/dev/null || true

  cp -r $TMP_DIR/dist /app/dist
  cp -r $TMP_DIR/node_modules /app/node_modules
  cp $TMP_DIR/package.json /app/package.json
  cp -r $TMP_DIR/prisma /app/prisma 2>/dev/null || true
"

# 8. Prisma
echo ""
echo "🗄️  生成 Prisma 客户端..."
docker exec "$CONTAINER_NAME" sh -c "cd /app && npx prisma generate" 2>&1 | grep -v "^>" || true

# 9. 重启
echo ""
echo "🔄 重启后端..."
docker exec "$CONTAINER_NAME" sh -c "
  PID=\$(cat /tmp/app.pid 2>/dev/null || echo '')
  if [ -n \"\$PID\" ] && kill -0 \"\$PID\" 2>/dev/null; then
    kill \"\$PID\" 2>/dev/null || true
    sleep 1
  fi
  cd /app && nohup node dist/index.js > /app/app.log 2>&1 &
  echo \$! > /tmp/app.pid
"

# 10. 健康检查
echo ""
echo "⏳ 等待服务启动 (最多 15 秒)..."
OK=false
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  sleep 1
  CODE=$(docker exec "$CONTAINER_NAME" sh -c "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/health 2>/dev/null || echo '000'")
  if [ "$CODE" != "000" ]; then
    echo "   ✅ 后端响应 HTTP $CODE ($i 秒)"
    if [ "$CODE" = "200" ] || [ "$CODE" = "401" ]; then
      OK=true
    fi
    break
  fi
done

# 11. 清理
docker exec "$CONTAINER_NAME" rm -rf "$TMP_DIR" 2>/dev/null || true

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$OK" = "true" ]; then
  echo "  ✅ 热部署完成！API 已可用"
else
  echo "  ⚠️  部署完成但状态未知，检查日志:"
  echo "     docker exec $CONTAINER_NAME tail -30 /app/app.log"
fi
echo "  时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "  容器: $CONTAINER_NAME"
echo "  API:  http://localhost:3000"
echo "  日志: docker exec $CONTAINER_NAME tail -f /app/app.log"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
