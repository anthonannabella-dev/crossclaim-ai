# 待归档裁决清单（AI-ARCHITECT-INBOX.md）

> 目的：把「已读取但尚未逐字归档」的裁决登记在仓库内，避免只存在于会话上下文。
> 归档要求：逐字转写 → FNV-1a 哈希与抽取值一致 → `node tools/verdict-diff/compare.mjs <staged> <MSG-ID>` 输出 `FULL_COPY_OK`，然后追加到 `AI-ARCHITECT-INBOX.md`。

| # | 主题 | 抽取长度 | FNV-1a | reviewed HEAD | 状态 |
| --- | --- | --- | --- | --- | --- |
| 1 | **ZERO evidence**（WHOLE_SCHEMA_DIFF_ZERO 证据送审） | 3207 | （待复抽核对） | `90b1f71` | **PASS WITH REVISE** — 已读取，待归档 |
| 2 | **SEO-3 PUBLIC API SECURITY**（公开只读 Checker/Calculator） | 4501 | `1aef0ed7` | `3066ac2` | **REVISE** — 已读取，待归档 |

## 归档后需立即执行的事项

**来自 #1（ZERO evidence，PASS WITH REVISE）**：按裁决原文处理其 REVISE 项；`shared / production migrate deploy` 的解禁与否以裁决为准（当前 HOLD）。

**来自 #2（SEO-3，REVISE）**：按 `docs/releases/SEO-3-PUBLIC-API-AUDIT-REQUIREMENTS.md` 与 `docs/releases/SEO-3-CHANGE-AB-SCHEMA-SKETCH.md` 实现：
- CHANGE A：`basisKey` 级语义白名单（未注册 key → `UNKNOWN_ANSWER_KEY` → `INVALID_REQUEST`，必须在传入引擎前拒绝）
- CHANGE B：字段级 `Number.isFinite` / 类型 / 整数小数 / min-max（替换现在 number/boolean 直接 continue 的漏洞；**不得**把 PII 正则推广到数值，避免误杀合法金额）
- engine 输出校验（`ENGINE_OUTPUT_INVALID` fail-closed）
- HTTP 接线相关项（body ≤ 8 KiB、限流先于引擎、timeout、并发上限、no-store、same-origin、可信代理 IP、共享/边缘限流）留到 PUBLIC HTTP FINAL 前

## 硬边界（不变）

`MIGRATE_DEPLOY`(shared/prod) · `PUBLIC_CHECKER_HTTP` · `PUBLIC_CHECKER_PRODUCTION` · `REAL_TRANSPORT` · `EXTERNAL_WRITE` · `PAYMENT` · `PRODUCTION_ENABLEMENT` = HOLD；`TRANSPORT=false`；`FINAL_ACCEPTANCE_HEAD=0f7f7ac` 未动。
