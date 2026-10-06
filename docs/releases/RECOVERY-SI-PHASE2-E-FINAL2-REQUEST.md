> **[HISTORICAL_SNAPSHOT]** 本文是历史审计 / 证据快照，原文保留不改写（历史裁决不删除）。
> 其中关于 `RUNTIME_WIRING` / `STEP_3_RUNTIME_POLICY_WIRING` / `RSI_OUTCOME_SINK_RUNTIME_WIRING`
> 的**当时状态**已被后续实现取代：SUPERSEDED_BY=c0b61792（STEP_3_RUNTIME_POLICY_WIRING：
> Recovery SI 作为 domain capability pack 接入 ONE CrossClaim SI Runtime；后续 FINAL-2..6 与 PHASE 2
> 见 ca23b1df / adcab905 / ca298187 / 5f9ce46f / 6e98e66e）。
> 唯一**现行**状态请以 `docs/releases/CURRENT-SI-RSI-STATUS.md` 为准
> （SUPERSEDED_BY=cdd95258 为该状态件的基线 HEAD）。

# Recovery SI P2-E v1（持久化）Implementation Audit FINAL-2 —— 送审请求

- 分支：`gate/7-commercial-validation`；仓库 `anthonannabella-dev/crossclaim-ai`
- **REVIEWED_HEAD = `1fcb5244`**（P2-E REVISE 实现提交：写入口 canonical READY 重算 + 独立 lineage audit action）；
  请求包提交紧随其后（本文件所在提交）
- 前置：**MSG-20261005-23 = REVISE**（`P2_E_V1_OPTION_A = NOT_YET_CLOSED`、`FINAL2_REQUIRED = YES`），两项：CHANGE 1（exact HEAD 必须可独立复核）+ CHANGE 2（lineage action 必须独立）；另 RISKS 项要求确认 canonical READY 重算是否在写入口。
- **CHANGE 1 处置：本批已 push**，`1fcb5244` / `b5baf381` / `9b3a6417` 均在 `origin/gate/7-commercial-validation` 可见（exact SHA 可独立复核）。
- 耐久证据：`docs/releases/RECOVERY-SI-PHASE2-E-EVIDENCE.md` §9.1

## 1. CHANGE 2 —— 独立 lineage audit action（已落地）

```text
RECOVERY_SI_PACKAGE_PERSISTED_ACTION = recovery.si_package_persisted   （仅用于 P2-E transaction 的 lineage 审计）
RECOVERY_SI_PACKAGE_LINEAGE_CHANGE_KEYS = packageId / packageVersion / packageDigest / planDigestVersion /
                                          planDigest / basisVersion / opportunityRef / domain / guardAction
assertRecoverySiPackageLineageChanges() → 多键即 RECOVERY_SI_LINEAGE_CHANGES_NOT_WHITELISTED（fail-closed）
buildRecoverySiPackageLineageAuditLog() → 统一构造 lineage 审计单元（不再复用 recovery.package_generated）
```

证据：

- `P2E-G22`：action 常量 = `recovery.si_package_persisted`；白名单 9 键；多键抛错；构造出的审计单元 `entityType = RecoveryPackage`、
  `actorType = SYSTEM`（无 actor 时）且 `changes` 键集合恰好等于白名单。
- `P2E-DB12`（真实 PostgreSQL）：`readRecoveryPackagePlanDigestFromAudit(action = recovery.si_package_persisted)` 取回 `planDigest`；
  同一 package 用 `recovery.package_generated` 反查 → **null**（两种语义不再混用）。
- 无需新表 / 新列 / 新 migration。

## 2. RISKS 项 —— 写入口 canonical READY 重算（已落地）

```text
fresh state（tenantVerified + 租户一致）
  → prioritizeOpportunities()
  → planRecovery()（canonical，generatedAt = state.observedAt）
  → supplied READY_FOR_EXECUTION 必须等于 canonical planner READY 的 execution-relevant 身份
      （domain / opportunityRef / proposedAction / toolRef / executionMode /
        authorizationRequired / ownerApprovalRequired / expectedRecovery.amount(4 位小数) / currency(大写)）
  → 通过后才 ProductionControlPlane.snapshotFor → evaluateWithoutAudit(claim.prepare)
```

- 执行位置：`evaluateRecoveryPersistGate()` 内部，位于**任何 Action Guard 调用与任何 DB 写入之前**；
  `P2_E_CANONICAL_RECHECK_BOUNDARY.trustsUpstreamAllowSnapshot = false`（不信任上游 ALLOW 快照）。
- fail-closed 失败码（全部零 Guard 调用、零 DB 写入）：
  `P2E_CANONICAL_RECHECK_INPUT_REQUIRED` / `P2E_CANONICAL_TENANT_MISMATCH` / `P2E_CANONICAL_STATE_STALE` /
  `P2E_CANONICAL_READY_MISSING` / `P2E_CANONICAL_READY_MISMATCH`。
- 证据（`recovery-si-phase2-e.test.ts`）：`P2E-G16` 缺重算输入；`P2E-G17` `authorizationReady=false` 伪造 READY；
  `P2E-G18` `riskClass=HIGH`（OWNER gate）伪造 READY；`P2E-G19` 金额篡改；`P2E-G20` 陈旧 state；
  `P2E-G21` 对齐成立 → `canonicalReadyVerified = true` 且给出 64-hex `canonicalPlanDigest`，Guard 调用数 = 1。
- 实现边界：本模块**独立**实现同语义投影，**未修改**已 CLOSED 的 P2-D 模块
  （`recovery-guard-dry-run.ts` 仅只读复用 `planRecovery` / `prioritizeOpportunities` / `buildRecoveryPlanDigest`）。

## 3. 裁决 TEST 清单逐条对应（1–12）

| # | 要求 | 证据 |
| --- | --- | --- |
| 1 | canonical READY 重算发生在 DB transaction/write 之前 | `recovery-persist-gate.ts` 门禁顺序（canonical → Control Plane → Guard）；P2E-G16..G21 全部零 Guard 调用；写入口仅在 ALLOW 后进入端口 |
| 2 | `claim.prepare` 使用 trusted Control Plane | P2E-G2 / G4（degraded → DENY 且零调用）；门禁不接收 capabilities |
| 3 | mixed tenant 在任何 DB write 前 fail closed | P2E-DB10①（应用层 `P2E_TENANT_MIXED_BATCH`，DB 零写入）+ P2E-DB10②③（DB 触发器拒绝） |
| 4 | package + artifacts + lineage Audit 同事务 | P2E-DB5（四单元各 1 行、同一 `prisma.$transaction`）；`recovery-persist-prisma-port.ts` |
| 5 | transaction failure 全回滚 | P2E-DB6（第 4 单元 FK 失败 → 四表该租户下全 0） |
| 6 | sequential / concurrent replay 只形成完整一套 | P2E-DB7 / P2E-DB8（各 1 行 package/FileAsset/artifact/audit） |
| 7 | no orphan FileAsset | P2E-DB7 / DB8（FileAsset 计数 = 1）+ DB12（`orphanFileAssetIds = []`） |
| 8 | RecoveryPackage core immutable | 既有 `cc_recoverypackage_controlled_mutation`（BEFORE UPDATE，仅允许状态类列；本批未改动） |
| 9 | RecoveryPackage DELETE DB reject | P2E-DB1 / DB2 / DB13（`RECOVERY_PACKAGE_DELETE_FORBIDDEN`，行保留） |
| 10 | Artifact UPDATE/DELETE DB reject | 既有 `cc_append_only__RecoveryPackageArtifact`（tgtype 27）+ 本批新增 `cc_no_delete__RecoveryPackageArtifact`（P2E-DB13） |
| 11 | lineage action = `recovery.si_package_persisted` | P2E-G22 + P2E-DB12（含 `recovery.package_generated` 反查 null 的负例） |
| 12 | 八类外写事实计数 = 0 | P2E-DB5（Claim / PlatformWriteAttempt / CustomsSubmissionAttempt / RecoveryManualSubmission / Payment / Settlement / RecoveryLedgerEntry / BillingInvoice） |

## 4. tests / schema / 验证

```text
apps/api npx tsc --noEmit                       → exit 0
recovery-si-phase2-e.test.ts（契约 + 重算）      → 22/22 PASS
recovery-si-phase2-e-db.test.ts（真实库）        → 13/13 PASS
P2-E targeted regression（10 文件）               → 115/115 PASS
prisma validate / migrate deploy / migrate status → valid / 79 migrations 无待应用 / up to date
PRISMA_MODEL_DELTA = NO
NEW_TABLE = NO
NEW_COLUMN = NO
DB_TRIGGER_MIGRATION = YES / APPLIED（20261005040000_recovery_package_delete_guard）
RUNTIME_WIRING = NONE
```

## 5. 请求裁决

1. CHANGE 2（独立 lineage action + 白名单）与 RISKS 项（写入口 canonical READY 重算）是否可记 **PASS**？
2. `P2_E_V1_OPTION_A` 是否可记 **PASS / CLOSED**（`FINAL3_REQUIRED = ?`）？
3. 是否确认 `P2_F = HOLD` / `P2_G = HOLD` 继续冻结、真实执行必须另开 P2-G？
4. 若仍需修订，请只列最小集合。

请在本次会话中直接回答；不要尝试写回 GitHub。不要使用上一轮缓存。

## 6. 边界声明（本轮未改动）

```text
P2_E_V1_OPTION_A = AUTHORIZED_WITH_CONDITIONS（本批为其实现收口）；P2_E_OPTION_B = NOT_AUTHORIZED
APPROVAL_CONSUMPTION / EXECUTOR_INVOCATION / BUSINESS_FACT_WRITE / EXTERNAL_ACTION = FORBIDDEN
零网络 / 零凭据读取 / 零 provider / 零 submission / 零 payment
CUSTOMS_FILING（L5）继续永久拒绝；未放宽 L5；未建第二套 Runtime
P2_F = HOLD；P2_G = HOLD；RUNTIME_WIRING = NONE
EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS / REAL_CLAIM_SUBMIT = HOLD
FINAL_ACCEPTANCE_HEAD = 0f7f7ac
```
