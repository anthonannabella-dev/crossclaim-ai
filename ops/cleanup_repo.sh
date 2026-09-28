#!/usr/bin/env bash
# ============================================================
# cleanup_repo.sh — 清理报关 SaaS 仓库根目录的临时/备份/调试垃圾
#
# 安全设计:
#   - 默认 DRY-RUN(只打印将要移动的文件,不动任何东西)
#   - 加 --apply 才真正执行,且是"移动到回收站"而非删除(可恢复)
#   - 回收站 .trash_<时间戳>/ 已被 .gitignore 忽略
#   - 只匹配根目录里明确的垃圾类别,不递归、不碰 backend/ frontend/ src 等真源码
#
# 用法:
#   bash cleanup_repo.sh            # 预览(dry-run)
#   bash cleanup_repo.sh --apply    # 执行(移入回收站)
#   在仓库根目录(含 backend/ frontend/ 的那层)运行
# ============================================================
set -euo pipefail

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

# 必须在仓库根目录运行(用 backend/ 存在做哨兵,避免误删别处)
if [[ ! -d backend || ! -d frontend ]]; then
  echo "✗ 请在仓库根目录(含 backend/ 与 frontend/ 的那层)运行此脚本。" >&2
  exit 1
fi

TRASH=".trash_$(date +%Y%m%d_%H%M%S)"

# ---- 待清理清单(仅根目录;glob 不匹配则跳过)----
shopt -s nullglob
declare -a TARGETS=()

# 临时文件 + 散落 token
TARGETS+=( _tmp_* _ap_token.txt .test_token.txt )
# 一次性调试 / 脚手架脚本
TARGETS+=( check_*.js trigger_*.js gen_token*.js verify_api.js verify_deepseek*.js verify_fields.js verify_token.js )
TARGETS+=( fix_*.js fixed_*.js reset*.js archive_new*.js do_upload.js rearchive.js final_verify.js )
TARGETS+=( test_api*.js test_regex*.js )
# 重复 / 备份文件
TARGETS+=( schema2.prisma docker-compose.yml.bak )
# 自动备份目录
TARGETS+=( .hermes_backup* )

# 去重 + 仅保留真实存在的路径
declare -a EXIST=()
for t in "${TARGETS[@]}"; do
  [[ -e "$t" ]] && EXIST+=( "$t" )
done

if [[ ${#EXIST[@]} -eq 0 ]]; then
  echo "✓ 没有可清理的目标,仓库已是干净的。"
  exit 0
fi

# ---- 显式保护名单(就算意外匹配也绝不动)----
PROTECT_RE='^(verify\.sh|deploy-live\.sh|build_customs_codes\.js|ocr_main_fix\.py|schema\.prisma|docker-compose\.yml|docker-compose\.prod\.yml|docker-compose\.monitoring\.yml)$'

echo "模式: $([[ $APPLY -eq 1 ]] && echo '★ APPLY(移入回收站)' || echo 'DRY-RUN(仅预览,加 --apply 执行)')"
echo "回收站: $TRASH"
echo "------------------------------------------------------------"

count=0
for f in "${EXIST[@]}"; do
  if [[ "$f" =~ $PROTECT_RE ]]; then
    echo "  [跳过·受保护] $f"
    continue
  fi
  size=$(du -sh "$f" 2>/dev/null | cut -f1)
  echo "  [清理] $f  ($size)"
  count=$((count+1))
  if [[ $APPLY -eq 1 ]]; then
    mkdir -p "$TRASH"
    mv "$f" "$TRASH/"
  fi
done

echo "------------------------------------------------------------"
if [[ $APPLY -eq 1 ]]; then
  echo "✓ 已移动 $count 项到 $TRASH/(可直接 mv 回来恢复;确认无误后 rm -rf 它)"
else
  echo "预览完成:共 $count 项将被清理。执行: bash cleanup_repo.sh --apply"
fi
