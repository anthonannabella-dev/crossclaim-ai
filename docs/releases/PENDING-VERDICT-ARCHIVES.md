# 待归档裁决清单（AI-ARCHITECT-INBOX.md）

> 目的：把「已读取但尚未逐字归档」的裁决登记在仓库内，避免只存在于会话上下文。
> 归档要求：逐字转写 → FNV-1a 哈希与抽取值一致 → `node tools/verdict-diff/compare.mjs <staged> <MSG-ID>` 输出 `FULL_COPY_OK`，然后追加到 `AI-ARCHITECT-INBOX.md`。

| # | 主题 | 抽取长度 | FNV-1a | reviewed HEAD | 状态 |
| --- | --- | --- | --- | --- | --- |
| 1 | **ZERO evidence**（WHOLE_SCHEMA_DIFF_ZERO 证据送审） | 3207 | `fa4fee5d` | `90b1f71` | **PASS WITH REVISE** — 已归档为 `MSG-20261004-27`（FULL_COPY_OK） |
| 2 | **SEO-3 PUBLIC API SECURITY**（公开只读 Checker/Calculator） | 4501 | `1aef0ed7` | `3066ac2` | **REVISE** — 已归档为 `MSG-20261004-28`（FULL_COPY_OK） |

**当前无待归档裁决（2026-10-04 收口：`MSG-20261004-27` / `-28` / `-29` 均已入库）。**

### 抽取坐标与坑（复核于 2026-10-04）

按「从最旧开始数第 n 条 `ChatGPT 说：`」定位：`n=2` = FINAL-2（`e18e358`, 4536, `a59fc0d9`，已归档 `MSG-20261004-26`）；`n=3` = ZERO evidence（`90b1f71`, 3207, `fa4fee5d`）；`n=4` = SEO-3（`3066ac2`, 4501, `1aef0ed7`）；`n=5` = EXACT-ORDER（`1950ef8`, 3190, `064442e4`，已归档 `MSG-20261004-29`）。

抽取方法：取 `document.body.innerText` 中所有 `ChatGPT 说：` 的出现位置，按相邻两处切段；对每段裁掉 `ChatGPT 可能会出错` 及其后的 UI 尾巴与该段之后的下一条用户消息，再 trim。

**本次踩到的坑**：当该条回复不是会话最后一条时，其段尾会带上日期分隔标签（如 `今天 20:01`），必须先截掉再 trim —— 否则会比归档值多出 10 个字符、哈希不匹配（SEO-3 实测：未截断 4511 / `9dc7d595`，截断后 4501 / `1aef0ed7`）。

**导出方式**：`cua_repl` 运行时没有 `require`，但 `await import("node:fs")` 可用，因此可把页面 DOM 抽出的原文直接写入 `work/stage/*.txt`；随后在 node 侧独立复算长度与 FNV-1a 二次确认（本次两侧一致：4501 / `1aef0ed7`，无 BOM）。

## 归档后需立即执行的事项

**来自 #1（ZERO evidence，PASS WITH REVISE）**：`WHOLE_SCHEMA_DIFF_ZERO = PASS`、`NON_C18_SCHEMA_HISTORY_DRIFT = CLOSED`；`C18-SCHEMA-DRIFT-FINDING.md` 已改为 RESOLVED / CLOSED 并改用 `tools/verification/c18-clean-replay-proof.mjs` 路径；`shared / production migrate deploy` 以 `MSG-20261004-29` 为准（staging / non-prod shared = AUTHORIZED，production = HOLD）。

**来自 #2（SEO-3，REVISE）**：按 `docs/releases/SEO-3-PUBLIC-API-AUDIT-REQUIREMENTS.md` 与 `docs/releases/SEO-3-CHANGE-AB-SCHEMA-SKETCH.md` 实现：
- CHANGE A：`basisKey` 级语义白名单（未注册 key → `UNKNOWN_ANSWER_KEY` → `INVALID_REQUEST`，必须在传入引擎前拒绝）
- CHANGE B：字段级 `Number.isFinite` / 类型 / 整数小数 / min-max（替换现在 number/boolean 直接 continue 的漏洞；**不得**把 PII 正则推广到数值，避免误杀合法金额）
- engine 输出校验（`ENGINE_OUTPUT_INVALID` fail-closed）
- HTTP 接线相关项（body ≤ 8 KiB、限流先于引擎、timeout、并发上限、no-store、same-origin、可信代理 IP、共享/边缘限流）留到 PUBLIC HTTP FINAL 前

## 硬边界（不变）

`MIGRATE_DEPLOY`(shared/prod) · `PUBLIC_CHECKER_HTTP` · `PUBLIC_CHECKER_PRODUCTION` · `REAL_TRANSPORT` · `EXTERNAL_WRITE` · `PAYMENT` · `PRODUCTION_ENABLEMENT` = HOLD；`TRANSPORT=false`；`FINAL_ACCEPTANCE_HEAD=0f7f7ac` 未动。

## CI 状态（2026-10-04 更新）

红色连击已结束：**`4f02282` run `37190859502` = success**（此前 `3125271…b5149ca` 连续 failure）。此后 a293935 / 2e9e678 / 42b9ccb / 8ad4380 的前序 heads 全部 success。

根因不是数据完整性问题，而是仓库三处**严格契约/清单未同步**，均已修复：

1. `1b15ab7` — tenant-trigger 白名单（`required-triggers.json` 102→103）+ 补两个 `cc_tenant_immutable__*`（复用既有 `cc_forbid_tenant_reassignment()`）；
2. `cc13bde` — append-only 白名单（`append-only-triggers.json` 47→48）；
3. `4f02282` — 模型清单：C18 新增 3 个 model → **82（76 core + 6 join）→ 85（79 core + 6 join）**，同步 `architecture-contract.test.ts` 的标题与 `toHaveLength`（本地 142/142，CI 通过）。

定位工具（已入库）：`work/scripts/ci-failure-digest.mjs`（失败 job/step + 关键行）、`work/scripts/ci-step-context.mjs`（打印失败 step 之后的原文片段与失败用例行，不做正则改写）。

**结论**：`C18_INTERNAL_SKELETON = CLOSED` + `WHOLE_SCHEMA_DIFF_ZERO` + **CI 绿** 三者互相印证；因此本文档中「ZERO evidence」「EXACT-ORDER REPLAY」两轮送审内容均已获远端 CI 独立确认（不再是“仅本地证据”）。
