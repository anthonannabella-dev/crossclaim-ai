# R46 S3 FINAL — SettlementAdjustment / Full Reversal · Implementation Checkpoint（MSG-20261002-58 CHANGE A/B/C 收口）

> 依据：**MSG-20261002-58 = REVISE**（S3 架构方向正确；approval/provenance 绑定与真 exactly-once 证据须在进入 Fee linkage 前收口）。
> 边界不变：**NO Fee creation · NO Invoice mutation · NO Payment activation · NO RecoveryLedger mutation · NO autopay · R13 Payment Activation Gate = HOLD**。

## 1. CHANGE A —— approval 绑定完整 reversal 事实

- 服务端构造 canonical reversal snapshot：`organizationId / originalSettlementId / amount / currency / occurredAtUtc / externalIdentityKind / externalIdentityValueHash / financialEventFingerprint / reasonCode / evidenceArtifactIds(sorted)` → `sha256(canonicalJson(...))`；
- `approval.targetRef = reversalSnapshotDigest`，锁后重验；**审批后改 identity / 时间 / 证据 / 理由 → 旧 approval 失效**。
- 证据：提交 `3fbb47b`（绑定）+ `bdf97b7`（漂移用例）。

## 2. CHANGE B —— provenance 不允许客户端自证

- 请求只接受 `evidenceArtifactId`；客户端若传 `digest`/`kind` → `CLIENT_EVIDENCE_NOT_TRUSTED` 且零写入；
- 服务端从 `EvidenceArtifact`（id / organizationId / kind / fileAssetId / externalUrl / title / capturedAt）派生 provenance digest 与 kind，并作为唯一写入值。
- 证据：提交 `21384b8`。

## 3. CHANGE C —— same approval exactly-once 真实证据

- 新增真实 PostgreSQL 竞争用例：**same `approvalId` + 两个不同有效 execution** → 恰好一次提交、`approval_consumed = 1`、loser = `APPROVAL_ALREADY_CONSUMED`、loser adjustment = 0、无 raw P2002、失败事务零残留。
- 证据：提交 `21384b8`。

## 4. 测试映射（MSG-58 §TEST 七项）

| # | 要求 | 用例 |
| --- | --- | --- |
| 1 | identity changed after approval → reject | `settlement-reversal-db.test.ts` › MSG-58 CHANGE A › identity 变体 |
| 2 | occurredAt changed → reject | 同上 › occurredAt 变体 |
| 3 | evidence changed → reject | 同上 › evidence 变体 |
| 4 | evidence digest/kind client spoof → reject | MSG-57 CHANGE 2/3 › `CLIENT_EVIDENCE_NOT_TRUSTED` |
| 5 | reasonCode changed → reject | MSG-58 CHANGE A › reasonCode 变体 |
| 6 | same approval / two different executions concurrency → exactly one | MSG-57 CHANGE 2/3 › same approvalId 竞争 |
| 7 | 所有拒绝路径：原 Settlement / Adjustment / approval consumption / 下游资金表零副作用 | 上述用例均带 counts 断言 |

## 5. 证据汇总

- `settlement-reversal-db` **10/10 PASS**（真实 PostgreSQL）
- `settlement-record-db` 15/15 · `settlement-receipt-snapshot` 12/12 · `action-guard` 15/15（S2 永久基线未退化）
- `tsc --noEmit` 0 error；下游 `FeeCalculation / BillingInvoice / Payment / RecoveryLedgerEntry` 全 0
- CI：`3fbb47b` success；`21384b8` / `bdf97b7` / `b7daaef` 见 CI 记录

## 6. 请裁决（编号）

1. CHANGE A/B/C 是否已按 MSG-20261002-58 收口（含 test-name 映射）？
2. 是否批准 **R46 S3 CLOSED** 并进入 **R46 S4（Fee membership + fee calculation/adjustment）**？
