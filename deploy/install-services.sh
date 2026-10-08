#!/usr/bin/env bash
# CrossClaim API + Web —— 幂等安装 / 升级入口（systemd）
#
# 行为：build → 建最小权限用户 → 装 unit → daemon-reload → enable → restart → health 校验。
# 幂等：可重复执行；不覆盖已存在的 /etc/crossclaim/api.env 与 /etc/crossclaim/web.env；
#       **绝不写入真实生产凭据**（DATABASE_URL / STORAGE_URL_SECRET / AUDIT_IP_SALT 由密钥管理注入）。
# 端口：API 3000（/health、/readyz）、Web 3001（/）、RSI health 4319（由 install-rsi-service.sh 管理）。
# 用法： sudo deploy/install-services.sh [--dry-run]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="/etc/systemd/system"
ENV_DIR="/etc/crossclaim"
DRY_RUN="no"
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN="yes"

run() {
  if [[ "${DRY_RUN}" == "yes" ]]; then echo "[dry-run] $*"; else "$@"; fi
}

echo "== 1/6 构建（API 必须先 build，Web 用 next start 读取既有 .next）=="
run npm --prefix "${REPO_ROOT}/apps/api" run build

ensure_user() {
  local user="$1"
  if ! id -u "${user}" >/dev/null 2>&1; then
    run useradd --system --no-create-home --shell /usr/sbin/nologin "${user}"
  else
    echo "user ${user} already exists"
  fi
}

echo "== 2/6 最小权限用户 + 状态目录 =="
ensure_user crossclaim-api
ensure_user crossclaim-web
run install -d -m 0750 -o crossclaim-api -g crossclaim-api /var/lib/crossclaim-api
run install -d -m 0750 -o crossclaim-api -g crossclaim-api /var/lib/crossclaim-api/storage
run install -d -m 0750 -o crossclaim-web -g crossclaim-web /var/lib/crossclaim-web

echo "== 3/6 环境变量文件（不覆盖已有；不含明文凭据）=="
run install -d -m 0750 "${ENV_DIR}"

write_env_if_absent() {
  local file="$1"
  local owner="$2"
  local content="$3"
  if [[ -f "${file}" ]]; then
    echo "keep existing ${file}"
    return
  fi
  if [[ "${DRY_RUN}" == "yes" ]]; then
    echo "[dry-run] 生成 ${file}"
    return
  fi
  printf '%s\n' "${content}" > "${file}"
  chmod 0640 "${file}"
  chown "root:${owner}" "${file}"
}

API_ENV="$(cat <<'EOF'
# CrossClaim API 运行环境（不要在此写明文生产凭据）
# 由密钥管理注入：DATABASE_URL / STORAGE_URL_SECRET / AUDIT_IP_SALT
NODE_ENV=production
PORT=3000
LOG_LEVEL=info
STORAGE_DRIVER=local
STORAGE_LOCAL_ROOT=/var/lib/crossclaim-api/storage
METRICS_ENABLED=false
EOF
)"

WEB_ENV="$(cat <<'EOF'
# CrossClaim Web 运行环境（Web 不直连数据库，也不需要任何数据库凭据）
NODE_ENV=production
PORT=3001
NEXT_TELEMETRY_DISABLED=1
CROSSCLAIM_API_URL=http://127.0.0.1:3000
EOF
)"

write_env_if_absent "${ENV_DIR}/api.env" crossclaim-api "${API_ENV}"
write_env_if_absent "${ENV_DIR}/web.env" crossclaim-web "${WEB_ENV}"

echo "== 4/6 安装 unit 并 reload =="
run install -m 0644 "${REPO_ROOT}/deploy/systemd/crossclaim-api.service" "${UNIT_DIR}/crossclaim-api.service"
run install -m 0644 "${REPO_ROOT}/deploy/systemd/crossclaim-web.service" "${UNIT_DIR}/crossclaim-web.service"
run systemctl daemon-reload

echo "== 5/6 enable + restart（幂等；API 先于 Web）=="
run systemctl enable crossclaim-api crossclaim-web
run systemctl restart crossclaim-api
run systemctl restart crossclaim-web

echo "== 6/6 health 校验 =="
if [[ "${DRY_RUN}" == "yes" ]]; then
  echo "[dry-run] 等待后 curl -fsS http://127.0.0.1:3000/health 与 http://127.0.0.1:3001/"
  exit 0
fi

wait_http() {
  local url="$1"
  local label="$2"
  for _ in $(seq 1 15); do
    if curl -fsS --max-time 3 "${url}" >/dev/null 2>&1; then
      echo "${label}_OK ${url}"
      return 0
    fi
    sleep 4
  done
  echo "${label}_FAILED（60s 内未就绪）" >&2
  return 1
}

wait_http "http://127.0.0.1:3000/health" "API_HEALTH"
wait_http "http://127.0.0.1:3001/" "WEB_ROOT"
