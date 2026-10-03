# BG-021 — INDEPENDENT-SITE 事实层 **IMPLEMENTATION CHECKPOINT**

- 依据：**MSG-20261003-139 = APPROVED TO IMPLEMENT WITH REVISE**（无需再送 Schema Design）
- 分支 `gate/7-commercial-validation` · Codex · 2026-10-04
- 边界不变：`filingSubmitted=false` / `externalWritePerformed=false` / `transportEnabled=false` / `Payment=0` / `collection=OFF` / `productionCredentials=ABSENT`；不接真实 PSP，不实现 `dispute.submit`

## 1. 交付物

| 项 | 内容 |
|---|---|
| Prisma | 3 模型 + 3 枚举：`IndependentSiteHandoffFact` / `IndependentSiteResponseFact` / `IndependentSiteSettlementFact`；`Ps04HandoffChannel` / `Ps04ResponseDisposition` / `Ps04SettlementVerification` |
| Migration | `20261003230000_independent_site_recovery_facts`（migrate deploy OK；共 65 条迁移） |
| 模型总数 | 73 → **76**（70 core + 6 join），architecture-contract 142/142 |
| 触发器 | 11 枚（tenant 3 / immutable 3 / append-only 3 / lineage 2），清单已同步（baseline 98 / append-only 43） |

## 2. 逐条对应 REVISE 要求

| 裁决要求 | 落点 |
|---|---|
| `IndependentSiteSettlementFact` 必须带 `evidenceArtifactRef`；VERIFIED ⇒ 非空（machine-safe） | 字段 + `IndependentSiteSettlementFact_verified_needs_evidence` CHECK + `_evidence_ref_shape` CHECK |
| H1 语义写死为 **initial recovery handoff root** | `@@unique([organizationId, disputeReference])`（注释写明：未来补证 / 二次提交 / appeal 必须新建 Attempt/Appeal Fact 或 generation，不得删除该约束） |
| 补充 `UNIQUE(organizationId, executionKey)` | 已加（服务端幂等身份） |
| Response.source DB CHECK IN ('MANUAL_ENTRY','FIXTURE') | `IndependentSiteResponseFact_source_check` |
| Response.amount NULL 或 >= 0；**Settlement.amount > 0** | `_amount_non_negative` / `_amount_positive`（0 元 VERIFIED 不得成为 recovered truth） |
| currency 复用既有 CurrencyShape（`^[A-Z]{3}$`），不做第二套规则 | `_currency_shape` CHECK（response / settlement 各一条） |
| 禁止 PAN / CVV / raw card·bank / OAuth token / PSP secret | `_account_ref_not_numeric`（`!~ '^[0-9]{6,19}$'`）+ machine-safe 形状 CHECK；事实层无 PAN/CVV/secret 字段 |
| latest 由 `observedAt/receivedAt DESC, id DESC` 推导；禁止 mutable isLatest | 无 `isLatest` 列；测试断言 correct 事实追加后 latest 推导 |
| 同租户 lineage（response / settlement → handoff root） | `cc_ps04_lineage__*` 触发器 |
| append-only / tenant / immutable | `cc_append_only__*` / `cc_tenant_*` / `cc_tenant_immutable__*` |

## 3. PostgreSQL 验收（`apps/api/src/__tests__/independent-site-facts-db.test.ts` → 8/8）

1. 并发不同 executionKey 启动同一 dispute → **exactly one root**（其余显式唯一约束拒绝）；同 executionKey 重放 → 拒绝；
2. 同 dispute 不同 executionKey（二次提交）→ 拒绝（root 语义）；
3. 同租户 lineage：无 handoff 的 response / settlement 拒绝；跨租户拒绝；同租户 + 同 dispute 通过；
4. UPDATE / DELETE → append-only 拒绝；
5. PAN-like（16 位数字）/ numeric account / 自由文本 secret → DB CHECK 拒绝；
6. response：source 非白名单拒绝 / currency 非 `^[A-Z]{3}$` 拒绝 / 负金额拒绝 / NULL 金额（LOST）接受；
7. settlement：VERIFIED 缺 evidence 拒绝 / amount = 0 拒绝 / currency 形状拒绝 / UNVERIFIED 可落库（但不构成 recovered+billable）；
8. corrected 事实追加历史 + latest 由 `observedAt DESC, id DESC` 推导。

## 4. 回归

- architecture-contract 142/142；db-constraint-coverage 26/26；`tsc --noEmit` EXIT=0
- 迁移 64 → **65**；README 与 doc-sync（动态计数）同步
- 未触碰任何既有表/列（纯新增）

## 5. 永久语义

`submitted ≠ won ≠ settled ≠ recovered ≠ billable`；
`PSP says WON ≠ settlement verified`；`settlement reference exists ≠ settlement verified`；
只有带 evidence 的 VERIFIED settlement 才能进入 recovered / fee basis / BillingInvoice。
