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

## CI 状态（2026-10-04 更新）

红色连击已结束：**`4f02282` run `37190859502` = success**（此前 `3125271…b5149ca` 连续 failure）。

根因不是数据完整性问题，而是仓库三处**严格契约/清单未同步**，均已修复：

1. `1b15ab7` — tenant-trigger 白名单（`required-triggers.json` 102→103）+ 补两个 `cc_tenant_immutable__*`（复用既有 `cc_forbid_tenant_reassignment()`）；
2. `cc13bde` — append-only 白名单（`append-only-triggers.json` 47→48）；
3. `4f02282` — 模型清单：C18 新增 3 个 model → **82（76 core + 6 join）→ 85（79 core + 6 join）**，同步 `architecture-contract.test.ts` 的标题与 `toHaveLength`（本地 142/142，CI 通过）。

定位工具（已入库）：`work/scripts/ci-failure-digest.mjs`（失败 job/step + 关键行）、`work/scripts/ci-step-context.mjs`（打印失败 step 之后的原文片段与失败用例行，不做正则改写）。

**结论**：`C18_INTERNAL_SKELETON = CLOSED` + `WHOLE_SCHEMA_DIFF_ZERO` + **CI 绿** 三者互相印证；因此本文档中「ZERO evidence」裁决的送审内容已获远端 CI 独立确认（不再是"仅本地证据"）。
