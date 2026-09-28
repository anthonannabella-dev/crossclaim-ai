#!/usr/bin/env bash
# ============================================================
# 报关 SaaS · 一键本地拉起 + 验证脚本
# 用法:把本文件放到项目根目录 customs-saas/ 下,执行:
#   bash verify.sh
# 前置:已安装 docker / docker compose、Node.js 18+、npm
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

echo "▶ [0/6] 检查环境..."
command -v docker >/dev/null || { echo "❌ 未装 docker"; exit 1; }
command -v node   >/dev/null || { echo "❌ 未装 Node.js"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "❌ 未装 docker compose"; exit 1; }

# 1) .env:不存在则用开发默认值生成(已有则不动)
if [ ! -f .env ]; then
  echo "▶ 生成开发用 .env(占位密码,生产请改)"
  cat > .env <<'ENV'
NODE_ENV=development
POSTGRES_USER=customs
POSTGRES_PASSWORD=customs_dev
POSTGRES_DB=customs_saas
REDIS_PASSWORD=customs_dev
DATABASE_URL=postgresql://customs:customs_dev@localhost:5432/customs_saas
REDIS_URL=redis://:customs_dev@localhost:6379
MINIO_ENDPOINT=localhost
MINIO_PORT=8333
MINIO_ACCESS_KEY=customs
MINIO_PASSWORD=customs_dev
JWT_SECRET=dev_jwt_secret_change_me
BASE_URL=http://localhost:3000
FRONTEND_URL=http://localhost:5173
CORS_ORIGIN=http://localhost:5173
# 前半段 OCR/AI 才需要;只验证导出闭环可留空
DEEPSEEK_API_KEY=
OCR_SERVICE_URL=http://localhost:8000
ENV
else
  echo "▶ 已存在 .env,沿用你的配置"
fi
set -a; . ./.env; set +a

echo "▶ [1/6] 启动基础设施(postgres / redis / seaweedfs)..."
docker compose up -d postgres redis seaweedfs

echo "▶ [2/6] 等待 Postgres 就绪..."
for i in $(seq 1 30); do
  docker compose exec -T postgres pg_isready -U "${POSTGRES_USER:-customs}" >/dev/null 2>&1 && break
  sleep 2; [ "$i" = 30 ] && { echo "❌ Postgres 30s 未就绪"; exit 1; }
done
echo "  ✅ Postgres 就绪"

echo "▶ [3/6] 后端:装依赖 + 生成 Prisma + 迁移..."
( cd backend
  npm install
  npm run db:generate
  npm run db:migrate
  echo "  ✅ 数据库迁移完成"
)

echo "▶ [4/6] 拉起后端(:3000)..."
( cd backend && npm run dev > ../backend.dev.log 2>&1 & echo $! > ../.backend.pid )
for i in $(seq 1 30); do
  curl -sf http://localhost:3000/api/health >/dev/null 2>&1 && break || true
  curl -sf http://localhost:3000/ >/dev/null 2>&1 && break || true
  sleep 2; [ "$i" = 30 ] && echo "  ⚠ 后端 60s 未响应,看 backend.dev.log"
done
echo "  ✅ 后端已启动(日志 backend.dev.log)"

echo "▶ [5/6] 前端:装依赖 + 拉起(:5173)..."
( cd frontend && npm install && npm run dev > ../frontend.dev.log 2>&1 & echo $! > ../.frontend.pid )
sleep 4
echo "  ✅ 前端已启动(日志 frontend.dev.log)"

echo ""
echo "▶ [6/6] ✅ 全栈已拉起,按下面清单验证「自动化报关」闭环:"
cat <<'CHECK'
────────────────────────────────────────────────
 前端  http://localhost:5173    后端  http://localhost:3000
────────────────────────────────────────────────
 验证步骤(对应导出XML闭环):
  1. 登录 → 左侧「自动化报关」(已无「报关工作台」)
  2. 点「上传单证」→ 传几张发票/箱单/提单 → 启动流水线
  3. 观察状态流转:OCR → AI校验 → 自动填制 → 待复核
     (OCR/AI 需配 DEEPSEEK_API_KEY 与 OCR 服务;未配则前半段会停)
  4. 点「通过复核」→ 状态应为「预检通过·待导出」
  5. 点「导出XML申报」→ 应下载 declaration_*.xml,状态转「已导出·待回执」
  6. 打开下载的 XML,确认是 DecHead/DecLists 标准结构(67号公告)
  7. 点「海关回执」回填 放行 → released → 确认结关 → completed
  ★ 第4~7步是纯逻辑,不依赖 OCR/AI,可直接验证闭环
────────────────────────────────────────────────
 停止:  kill $(cat .backend.pid) $(cat .frontend.pid); docker compose stop
CHECK
