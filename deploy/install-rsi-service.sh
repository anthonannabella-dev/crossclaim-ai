#!/usr/bin/env bash
# CrossClaim RSI Controller —— 幂等安装 / 升级入口
#
# 行为：build → 建最小权限用户 → 装 unit → daemon-reload → enable → restart → health 校验。
# 幂等：可重复执行；不覆盖已存在的 /etc/crossclaim/rsi.env；**绝不写入真实生产凭据**。
# 用法： sudo deploy/install-rsi-service.sh [--dry-run]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SRC="${REPO_ROOT}/deploy/systemd/crossclaim-rsi.service"
UNIT_DST="/etc/systemd/system/crossclaim-rsi.service"
ENV_DIR="/etc/crossclaim"
ENV_FILE="${ENV_DIR}/rsi.env"
RUN_USER="crossclaim-rsi"
SERVICE="crossclaim-rsi"
DRY_RUN="no"
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN="yes"

run() {
  if [[ "${DRY_RUN}" == "yes" ]]; then echo "[dry-run] $*"; else "$@"; fi
}

echo "== 1/6 构建 =="
run npm --prefix "${REPO_ROOT}/apps/api" run build

echo "== 2/6 最小权限用户（已存在则跳过）=="
if ! id -u "${RUN_USER}" >/dev/null 2>&1; then
  run useradd --system --no-create-home --shell /usr/sbin/nologin "${RUN_USER}"
else
  echo "user ${RUN_USER} already exists"
fi
run install -d -m 0750 -o "${RUN_USER}" -g "${RUN_USER}" /var/lib/crossclaim-rsi

echo "== 3/6 环境变量文件（不覆盖已有；不含明文凭据）=="
if [[ ! -f "${ENV_FILE}" ]]; then
  run install -d -m 0750 "${ENV_DIR}"
  if [[ "${DRY_RUN}" == "yes" ]]; then
    echo "[dry-run] 生成 ${ENV_FILE}（RSI_* 开关；DATABASE_URL 由密钥管理注入）"
  else
    cat > "${ENV_FILE}" <<'EOF'
# CrossClaim RSI Controller 运行环境（不要在此写明文生产凭据）
RSI_ENABLED=true
RSI_PAUSED=false
RSI_OBSERVE_ENABLED=true
RSI_AUTO_INCIDENT_ENABLED=true
RSI_AUTO_PATCH_ENABLED=true
RSI_AUTO_VALIDATE_ENABLED=true
RSI_AUTO_JUDGE_ENABLED=true
RSI_AUTO_PROMOTE_LOW_RISK_ENABLED=false
RSI_HEALTH_PORT=4319
# DATABASE_URL 由宿主密钥管理注入（本脚本不写）
#
# 事件驱动运行入口（rsi-run）读取的只读 artifact 路径；
# 留空/不设 = 该事件源静默（不会虚构任务）。由宿主或流水线写入这些文件。
# RSI_TASKS_PATH=/opt/crossclaim/.rsi/tasks.json
# RSI_CI_RESULTS_PATH=/opt/crossclaim/.rsi/ci.json
# RSI_VERDICT_PATH=/opt/crossclaim/.rsi/verdict.json
# RSI_TEST_RESULTS_PATH=/opt/crossclaim/.rsi/tests.json
# RSI_WATCHDOG_INTERVAL_MS=60000
EOF
    chmod 0640 "${ENV_FILE}"
  fi
else
  echo "keep existing ${ENV_FILE}"
fi

echo "== 4/6 安装 unit 并 reload =="
run install -m 0644 "${UNIT_SRC}" "${UNIT_DST}"
run systemctl daemon-reload

echo "== 5/6 enable + restart（幂等）=="
run systemctl enable "${SERVICE}"
run systemctl restart "${SERVICE}"

echo "== 6/6 health 校验 =="
if [[ "${DRY_RUN}" == "yes" ]]; then
  echo "[dry-run] 等待 5s 后 curl -fsS http://127.0.0.1:4319/health"
  exit 0
fi
for _ in $(seq 1 12); do
  if body="$(curl -fsS --max-time 3 http://127.0.0.1:4319/health 2>/dev/null)"; then
    echo "RSI_HEALTH_OK ${body}"
    exit 0
  fi
  sleep 5
done
echo "RSI_HEALTH_FAILED（60s 内未就绪）" >&2
exit 1
