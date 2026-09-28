#!/bin/sh
# ============================================================
# 数据库备份脚本 — pg_dump + 上传 MinIO
# 用法: ./backup.sh [backup|restore <filename>]
# 由 Docker 内部 cron 或手动触发
# ============================================================

set -e

# 从 docker-compose 环境变量读取（也可直接设置）
PGHOST="${PGHOST:-postgres}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-customs}"
PGDATABASE="${PGDATABASE:-customs_saas}"
MINIO_ENDPOINT="${MINIO_ENDPOINT:-minio}"
MINIO_PORT="${MINIO_PORT:-9000}"
MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:?MINIO_ACCESS_KEY is required}"
MINIO_SECRET_KEY="${MINIO_SECRET_KEY:?MINIO_SECRET_KEY is required}"
BACKUP_BUCKET="database-backups"
BACKUP_DIR="/tmp/backups"

mkdir -p "$BACKUP_DIR"

setup_mc() {
  mc alias set backup-minio "http://${MINIO_ENDPOINT}:${MINIO_PORT}" "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" 2>/dev/null || true
  mc mb "backup-minio/${BACKUP_BUCKET}" 2>/dev/null || true
}

do_backup() {
  TIMESTAMP=$(date +%Y-%m-%dT%H-%M-%S)
  FILENAME="customs-saas-${TIMESTAMP}.sql.gz"
  FILEPATH="${BACKUP_DIR}/${FILENAME}"

  echo "[Backup] Starting pg_dump of ${PGDATABASE}..."
  PGPASSWORD="${PGPASSWORD}" pg_dump -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
    --no-owner --no-acl | gzip > "$FILEPATH"

  SIZE=$(du -h "$FILEPATH" | cut -f1)
  echo "[Backup] Done: ${FILEPATH} (${SIZE})"

  setup_mc
  echo "[Backup] Uploading to MinIO..."
  mc cp "$FILEPATH" "backup-minio/${BACKUP_BUCKET}/${FILENAME}"
  echo "[Backup] Uploaded: ${BACKUP_BUCKET}/${FILENAME}"

  rm -f "$FILEPATH"

  # 清理30天前的旧备份
  echo "[Backup] Cleaning up old backups..."
  CUTOFF=$(date -d "30 days ago" +%Y-%m-%d 2>/dev/null || date -v-30d +%Y-%m-%d 2>/dev/null || echo "")
  if [ -n "$CUTOFF" ]; then
    mc ls "backup-minio/${BACKUP_BUCKET}/" 2>/dev/null | while read -r line; do
      OBJ_DATE=$(echo "$line" | awk '{print $1}')
      OBJ_NAME=$(echo "$line" | awk '{print $NF}')
      if [ "$OBJ_DATE" '<' "$CUTOFF" ] && [ -n "$OBJ_NAME" ]; then
        echo "  Deleting: $OBJ_NAME"
        mc rm "backup-minio/${BACKUP_BUCKET}/${OBJ_NAME}" 2>/dev/null || true
      fi
    done
  fi
  echo "[Backup] Complete"
}

do_restore() {
  BACKUP_FILE="$1"
  if [ -z "$BACKUP_FILE" ]; then
    echo "Usage: $0 restore <filename>"
    echo "Available backups:"
    setup_mc
    mc ls "backup-minio/${BACKUP_BUCKET}/" 2>/dev/null
    exit 1
  fi

  FILEPATH="${BACKUP_DIR}/${BACKUP_FILE}"
  setup_mc
  echo "[Restore] Downloading ${BACKUP_FILE} from MinIO..."
  mc cp "backup-minio/${BACKUP_BUCKET}/${BACKUP_FILE}" "$FILEPATH"

  echo "[Restore] Restoring to ${PGDATABASE}..."
  gunzip -c "$FILEPATH" | PGPASSWORD="${PGPASSWORD}" psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE"

  rm -f "$FILEPATH"
  echo "[Restore] Complete"
}

case "${1:-backup}" in
  backup)  do_backup ;;
  restore) do_restore "$2" ;;
  list)
    setup_mc
    mc ls "backup-minio/${BACKUP_BUCKET}/" 2>/dev/null
    ;;
  *)
    echo "Usage: $0 {backup|restore <file>|list}"
    exit 1
    ;;
esac
