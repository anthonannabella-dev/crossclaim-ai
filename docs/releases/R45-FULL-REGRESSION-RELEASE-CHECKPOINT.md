# R45 — Full Regression / Release Implementation Checkpoint

> 依据：**MSG-20261002-50 = PASS WITH REVISE**（S4 主体 CLOSED；③ 批准进入 **R45 S5 —— read-only consistency checker + permanent regression closure**，完成后提交本 Checkpoint，届时再裁决 R45 是否整体 CLOSED）。
> 边界（继续冻结）：**NO Settlement · NO Billing · NO Fee · NO RecoveryLedger mutation · NO platform write · TRANSPORT=false · NO production credentials**。

---

## 1. S5 交付

| 类别 | 内容 |
| --- | --- |
| 只读 checker | `tools/consistency/check-reconciliation.mjs`（DETECT ≠ REPAIR；只输出 SELECT 判定，**不含任何 INSERT/UPDATE/DELETE/ALTER**） |
| 验收测试 | `apps/api/src/__tests__/reconciliation-consistency-checker-db.test.ts`（12 项：clean → 通过且只读；9 类漂移 → 非零） |
| CI 接入 | `.github/workflows/ci.yml`：fresh deploy 之后执行 checker（clean DB 必须 0） |
| 升级路径 | `tools/upgrade-verify/two-stage-upgrade.mjs`：stage 2 升级后执行同一 checker |

---

## 2. checker 检查面（MSG-20261002-50 ③ 最低检查面 → 编号）

| # | 检查 | 对应要求 |
| --- | --- | --- |
| [1] | projection ↔ ProjectionFact generation 一致 | Projection ↔ ProjectionFact generation 一致 |
| [2] | projection.basisId 弱引用（存在 / 同租户 / 同 claimItem） | dangling / cross-tenant basis（**不得解释为 MATCHED**） |
| [3] | projection.tolerancePolicyId 弱引用（存在 / 同租户或系统级 / scope·version 一致） | dangling / cross-tenant policy |
| [4] | **deterministic rebuild == stored projection**（net 重算 + 状态与容差比较；含 `FULLY_WITHOUT_BASIS` / `MATCHED_WITH_BASIS` / `SHOULD_BE_FULLY` / `SHOULD_BE_PARTIAL` / `SHOULD_BE_AMBIGUOUS_OVER_RECOVERY`） | deterministic rebuild；FULLY 必须具备有效 basis |
| [5] | over-recovery 必须带 `AMOUNT_EXCEEDS_EXPECTED` reason（来自 projection rebuild audit） | over-recovery exceptional state |
| [6] | 每个 (org, claimItem) 至多一条 effective basis | one effective basis |
| [7] | 每个 policy scope 至多一条 effective policy | one effective policy per scope |
| [8] | reversal linkage（目标存在 / 同租户 / 为 OBSERVED / 不自指） | reversal linkage；duplicate / full reversal invariants |
| [9] | evidence 引用（存在 / 同租户；人工路径 ≥1 且带 reasonCode） | dangling / cross-tenant evidence；manual outcome provenance |
| [10] | **S4 approval 语义（basis）**：受保护动作审计存在 + approvalId + **恰好消费一次** | CHANGE B（approval semantics） |
| [11] | **S4 approval 语义（override）**：approvalId 同租户 `review_approved` + `boundAction = recovery.reconciliation_override` + 恰好消费一次 | CHANGE B |
| [12] | **S4 approval 语义（人工 provider outcome）**：记录审计带 approvalId + 恰好消费一次 | CHANGE B |
| [13] | provider identity 冲突（同 org + provider + providerEventId 出现多个指纹） | conflicting evidence / identity collision |
| [14] | `matchedFactIds` 摘要缓存 == membership 关系表（当前 generation） | 事实成员关系不得只有摘要 |

> 说明：[4] 的 net 重算是**容差无关**的（net 为有效 OBSERVED 之和，扣除被 override `UNMATCHED` 排除的事实与已冲正事实）；状态比较才使用 policy 容差。冲突证据的**语义判定**（`CONFLICTING_EVIDENCE`）仍由 S3 计算层承担（有单测），checker 侧以 [13] 的 identity 冲突兜底。

---

## 3. 验收证据

| 项 | 结果 |
| --- | --- |
| `npx prisma validate` | **valid**（R45 全阶段零 Schema 变更之外的 S1 结构已冻结） |
| `npx tsc --noEmit` | **PASS（0 error）** |
| S5 checker DB 验收 | **12/12 PASS**（clean → 通过且执行前后快照一致；9 类漂移 → 非零） |
| two-stage upgrade（本地） | **TWO_STAGE_UPGRADE_OK**（保数据；两套触发器清单 + **R45 checker** + R43 checker 在升级路径全部通过） |
| 全量 API 套件 | **176 files / 1730 tests PASS**（本地全量；CI 侧 fresh migrate + 两套触发器清单 + R45 checker + R43 checker + 全量测试 + two-stage upgrade） |
| 触发器清单（fresh） | required-triggers 56 / append-only-受控变更 12 |

---

## 4. R45 全阶段回归基线（永久保留）

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| S1 | 七表 + 七枚举 + 租户/归属/append-only/受控 supersede/partial unique/CHECK/generation 立即校验 | CLOSED（MSG-20261001-47） |
| S2 | ingest（服务端 v1 身份指纹 + 幂等复用 + 冲正语义） | CLOSED（MSG-20261002-48） |
| S3 | deterministic projector（纯计算 + 锁内整体替换 + 三段故障完整回滚 + CHANGE A/C） | CLOSED（MSG-20261002-49） |
| S4 | 四个受保护动作（basis set/supersede、override、人工 provider outcome；evidence 逐条校验、失败零推进、重放/冲突语义） | CLOSED（MSG-20261002-50） |
| S5 | 只读 checker + 全量回归收口 | 本 Checkpoint |

R45 家族测试合计：**s1 27 + s2 19 + s3 31 + s4 19 + s5 12**（含纯函数与真实 PostgreSQL），与既有 PG/H/D/M/R43/R44 永久基线一并保留，**不得 skip 或弱化断言**。

---

## 5. 边界与风险分类

- `FOUNDATION_REUSED` = 既有 consistency checker 模式、租户/append-only 触发器清单机制、two-stage upgrade 通道、R43 S6 approval semantic checker 模式。
- `OSS_CANDIDATE` = 无新增依赖（`OSS_DECISION = EXISTING`；LICENSE / COMMERCIAL_USE / LICENSE_RISK = n/a）。
- `NEW_RISK_BOUNDARY` = **YES**（新增只读 checker 与 CI/升级路径强制；无新 Schema、无新写路径）。
- `ARCH_REVIEW_REQUIRED` = **YES**。
- 仍然 HOLD：Settlement · Billing · Fee · RecoveryLedger 写入 · 平台外写 · transport · 生产凭据 · Payment/Mandate/autopay（R13 独立 Gate）。

---

## 6. 请裁决

1. S5 只读 checker 的检查面与「DETECT ≠ REPAIR」纪律是否满足 MSG-20261002-50 ③ 的最低检查面与 CHANGE B/C？
2. R45（S1–S5）是否可整体判定 **CLOSED**？
3. 若 CLOSED，下一步是否按既定队列进入 **R46（Settlement / Billing linkage，独立 Gate）**（仍受 R12/R13 红线与 Payment Activation Gate HOLD 约束）？
