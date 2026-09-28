#!/bin/sh
# ============================================================
# 生产环境 SSL 证书生成脚本
# 用法: ./nginx/ssl/generate.sh [domain]
# 示例: ./nginx/ssl/generate.sh zgxl.top
# 前置条件: 已安装 openssl
# ============================================================
set -e

DOMAIN="${1:-${PUBLIC_HOST:-localhost}}"
CERT_DIR="$(dirname "$0")"

echo "生成自签名证书: CN=${DOMAIN}"
echo "⚠ 自签名证书仅用于测试！生产环境请使用 Let's Encrypt:"
echo "   docker run -it --rm -v certs:/etc/letsencrypt certbot/certbot certonly --webroot -w /var/www/html -d ${DOMAIN}"

openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout "${CERT_DIR}/server.key" \
    -out "${CERT_DIR}/server.crt" \
    -subj "/CN=${DOMAIN}/O=Customs SaaS/C=CN" 2>/dev/null

chmod 600 "${CERT_DIR}/server.key"
chmod 644 "${CERT_DIR}/server.crt"

echo "✅ 证书已生成:"
echo "  ${CERT_DIR}/server.crt"
echo "  ${CERT_DIR}/server.key"

# 输出证书指纹用于验证
openssl x509 -fingerprint -sha256 -noout -in "${CERT_DIR}/server.crt"
