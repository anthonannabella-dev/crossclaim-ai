> **[HISTORICAL_SNAPSHOT]** 本文是历史审计 / 证据快照，原文保留不改写（历史裁决不删除）。
> 其中关于 `RUNTIME_WIRING` / `STEP_3_RUNTIME_POLICY_WIRING` / `RSI_OUTCOME_SINK_RUNTIME_WIRING`
> 的**当时状态**已被后续实现取代：SUPERSEDED_BY=c0b61792（STEP_3_RUNTIME_POLICY_WIRING：
> Recovery SI 作为 domain capability pack 接入 ONE CrossClaim SI Runtime；后续 FINAL-2..6 与 PHASE 2
> 见 ca23b1df / adcab905 / ca298187 / 5f9ce46f / 6e98e66e）。
> 唯一**现行**状态请以 `docs/releases/CURRENT-SI-RSI-STATUS.md` 为准
> （SUPERSEDED_BY=cdd95258 为该状态件的基线 HEAD）。

# Recovery SI P2-E v1（持久化）FINAL-3 —— 送审请求

- 分支：`gate/7-commercial-validation`；仓库 `anthonannabella-dev/crossclaim-ai`
- **REVIEWED_HEAD = `95733930`**（E1/E2/E3 修订实现提交）；本送审包提交紧随其后（仅 docs/状态）
- 前置：**MSG-20261005-24 = REVISE**（`CHANGE_2_INDEPENDENT_LINEAGE_ACTION = PASS`、`RISKS_CANONICAL_READY_RECHECK = PASS`；
  剩 E1 / E2 / E3 三项窄 blocker；`FINAL3_REQUIRED = YES`）
- exact HEAD 已 push（本批推送后 GitHub 可见）；耐久证据：`docs/releases/RECOVERY-SI-PHASE2-E-EVIDENCE.md` §9.1 / §9.2

## 1. CHANGE E1 —— 门禁与写入口不可绕过绑定（已落地）

```text
evaluateRecoveryPersistGate() = 唯一 permit 签发者
  → 返回值登记进模块私有 WeakSet
persistRecoveryPackageWithinTransaction()
  → isTrustedRecoveryPersistPermit(gate) 不成立 ⇒ P2E_CALLER_SUPPLIED_GATE_FORBIDDEN（端口零调用）
P2_E_TRUSTED_GATE_BINDING = { callerSuppliedAllowGate: FORBIDDEN, trustedGateToWriteBinding: REQUIRED,
                              permitIssuer: evaluateRecoveryPersistGate, mechanism: MODULE_PRIVATE_WEAKSET_BRAND }
```

证据：`P2E-G23`（手工伪造 ALLOW gate → 拒绝 + 零端口调用）、`P2E-DB14`（F3E-01：伪造 gate → 拒绝 + DB 四表全 0）。

## 2. CHANGE E2 —— lineage 必须绑定同一可信 gate 的 planDigest（已落地）

- `buildRecoverySiPackageLineageAuditLog({ gate, packageId, packageVersion, packageDigest, claimedPlanDigest?, actorUserId? })`；
  `planDigest / planDigestVersion / basisVersion / opportunityRef / domain / guardAction / organizationId`
  **全部**来自 `gate.persistedBasis`（不接收调用参数覆盖）；
- 调用方声明 `claimedPlanDigest` 与 `gate.persistedBasis.canonicalPlanDigest` 不一致 →
  `P2E_LINEAGE_DIGEST_MISMATCH`（fail-closed，零写入）；
- canonical 重算新增基数校验：必须**恰好 1 个** READY action（`P2E_CANONICAL_READY_CARDINALITY_INVALID`）。

证据：`P2E-G22`（digest 不一致负例 + 伪造 gate 负例 + changes 键集合恰等于 9 键白名单）；
`P2E-DB12`（反查 digest == `gate.persistedBasis.canonicalPlanDigest`）；`P2E-DB15`（F3E-02 → 拒绝 + 零写入）。

## 3. CHANGE E3 —— JSON manifest + PDF 双 artifact 原子持久化（已落地）

```text
同一 prisma.$transaction：
  1 RecoveryPackage
  2 FileAsset        （kind = OTHER + mimeType application/json  ← canonical manifest；kind = PDF）
  2 RecoveryPackageArtifact（JSON_MANIFEST + PDF）
  1 AuditLog         （action = recovery.si_package_persisted）
写入前重新校验：
  sha256(canonicalJson) === packageDigest === JSON FileAsset.sha256
  PDF artifact.sha256 === PDF FileAsset.sha256
失败 ⇒ 整笔 rollback（NO_ORPHAN_FILE_ASSET / NO_PARTIAL_ARTIFACT_SET）
```

说明：`FileKind` 枚举无 JSON 值，故 JSON manifest 的 FileAsset 使用 `kind = OTHER` + `mimeType = application/json`；
artifact 侧严格是 `JSON_MANIFEST` + `PDF`。

证据：`P2E-DB5` / `DB7` / `DB8` / `DB12`（FileAsset = 2、artifact = 2 且 kinds 恰为 JSON_MANIFEST + PDF）；
`P2E-DB16`（F3E-04：第二条 artifact 唯一约束失败 → package/fileAsset/artifact/audit 全 0）。并发重放：`P2E-DB8` 仍为单包 + 2/2/1。

## 4. RISKS 措辞修正（已落地）

`P2_E_PERSIST_GATE_BOUNDARY` 不再写 `BUSINESS_FACT_WRITE = DRY_RUN_ONLY`：

```text
P2_E_WHITELISTED_INTERNAL_PERSISTENCE = AUTHORIZED（RecoveryPackage / RecoveryPackageArtifact / FileAsset / AuditLog）
OTHER_BUSINESS_FACT_WRITE = FORBIDDEN
EXTERNAL_BUSINESS_WRITE = FORBIDDEN
```

## 5. F3E-01..04 对应

| 编号 | 要求 | 证据 |
| --- | --- | --- |
| F3E-01 | 手工伪造 ALLOW gate / permit → 持久化入口无法调用 → DB writes = 0 | `P2E-G23`（unit，端口零调用）+ `P2E-DB14`（DB 四表全 0） |
| F3E-02 | trusted canonicalPlanDigest=A，lineage planDigest=B → fail-closed → DB writes = 0 | `P2E-G22` + `P2E-DB15`（`P2E_LINEAGE_DIGEST_MISMATCH`，零写入） |
| F3E-03 | 成功持久化 → package 1 / FileAsset 2 / Artifact 2（kinds = JSON_MANIFEST + PDF）/ lineage Audit 1 | `P2E-DB5`（含 artifact kinds 与 sha256 断言）、`DB12` |
| F3E-04 | 第二个 artifact 或 lineage 写失败 → package/fileAsset/artifact/audit 全 0 | `P2E-DB16`（第二条 artifact 唯一约束失败 → 全 0）+ `P2E-DB6`（lineage audit FK 失败 → 全 0） |

并发 replay 终态：`P2E-DB8` → package = 1、FileAsset = 2、artifact = 2、audit = 1、无孤儿。

## 6. tests / 验证

```text
apps/api npx tsc --noEmit                        → exit 0
recovery-si-phase2-e.test.ts（契约）              → 23/23 PASS
recovery-si-phase2-e-db.test.ts（真实库）         → 16/16 PASS
P2-E targeted regression（10 文件）                → 119/119 PASS
prisma validate / migrate deploy / migrate status → valid / 79 migrations 无待应用 / up to date
PRISMA_MODEL_DELTA = NO / NEW_TABLE = NO / NEW_COLUMN = NO / DB_TRIGGER_MIGRATION = YES/APPLIED
RUNTIME_WIRING = NONE
```

## 7. 请求裁决

1. CHANGE E1 / E2 / E3 是否可记 **PASS**？
2. `P2_E_V1_OPTION_A` 是否可记 **PASS / CLOSED**（`FINAL4_REQUIRED = ?`）？
3. 是否确认 `P2_F = HOLD` / `P2_G = HOLD` 继续冻结、真实执行必须另开 P2-G？
4. 若仍需修订，请只列最小集合。

请在本次会话中直接回答；不要尝试写回 GitHub。不要使用上一轮缓存。

## 8. 边界声明（本轮未改动）

```text
P2_E_V1_OPTION_A = AUTHORIZED_WITH_CONDITIONS；P2_E_OPTION_B = NOT_AUTHORIZED
APPROVAL_CONSUMPTION / EXECUTOR_INVOCATION = FORBIDDEN
OTHER_BUSINESS_FACT_WRITE / EXTERNAL_BUSINESS_WRITE / EXTERNAL_ACTION = FORBIDDEN
零网络 / 零凭据读取 / 零 provider / 零 submission / 零 payment
CUSTOMS_FILING（L5）继续永久拒绝；未放宽 L5；未建第二套 Runtime
P2_F = HOLD；P2_G = HOLD；RUNTIME_WIRING = NONE
EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS / REAL_CLAIM_SUBMIT = HOLD
FINAL_ACCEPTANCE_HEAD = 0f7f7ac
```
