# Recovery SI P2-E v1（持久化）FINAL-4 —— 送审请求

- 分支：`gate/7-commercial-validation`；仓库 `anthonannabella-dev/crossclaim-ai`
- **REVIEWED_HEAD = `607bf2b2`**（CHANGE E4 修订实现提交）；本送审包提交紧随其后（仅 docs/状态）
- 前置：**MSG-20261005-25 = REVISE**（`CHANGE_E3 = PASS`、`MODULE_PRIVATE_WEAKSET_PERMIT = PASS`；
  `CHANGE_E1/E2 = PASS_WITH_ONE_BINDING_GAP`；`FINAL4_REQUIRED = YES`）
- 耐久证据：`docs/releases/RECOVERY-SI-PHASE2-E-EVIDENCE.md` §9.1 / §9.2 / §9.3

## 1. CHANGE E4 —— trusted permit ↔ 精确写入批次不可变绑定（已落地）

新增 `assertRecoveryPersistBatchMatchesPermit(gate, units)`，在**任何 DB 写入之前**执行裁决列出的 12 项硬校验 + 批内 identity 校验：

```text
① 全部 units.organizationId === gate.persistedBasis.organizationId      → P2E_PERMIT_BATCH_TENANT_MISMATCH
② package.opportunityRef === gate.persistedBasis.opportunityRef          → P2E_PACKAGE_OPPORTUNITY_BINDING_MISMATCH
③ 批内 identity：
     jsonArtifact.packageId === pdfArtifact.packageId === package.id
     jsonArtifact.fileAssetId === jsonFileAsset.id
     pdfArtifact.fileAssetId  === pdfFileAsset.id
     artifact.kind / sha256 与对应 FileAsset 一致                        → P2E_BATCH_IDENTITY_MISMATCH
④ lineage AuditLog 12 项：
     action = recovery.si_package_persisted
     organizationId = permit.organizationId
     entityType = RecoveryPackage
     entityId = package.id
     changes.planDigest = permit.canonicalPlanDigest
     changes.planDigestVersion = permit.planDigestVersion
     changes.basisVersion = permit.basisVersion
     changes.opportunityRef = permit.opportunityRef
     changes.domain = permit.domain
     changes.guardAction = claim.prepare
     changes.packageId / packageVersion / packageDigest = 本批 package
     changes 仅允许 9 键白名单                                            → P2E_LINEAGE_AUDIT_NOT_GATE_BOUND
```

- 写入口 `persistRecoveryPackageWithinTransaction()` 现在必须先通过该函数（手工伪造 AuditLog / 复用合法 permit 到别的 target 全部 fail-closed）。
- 新增生产推荐入口 `persistRecoverySiPackageWithinTransaction({ prisma, gate, units })`：permit↔批次绑定 → **业务 lineage 绑定** → 单一事务。

## 2. RISKS 项 —— package.claimItemId ↔ permit.opportunityRef（已落地）

- 契约确认（未猜测）：`opportunityRef === RecoveryOpportunity.id`
  （`apps/api/src/services/intelligence/recovery-read-tool-adapters.ts`：`opportunityRef: insight.opportunityId`），
  `ClaimItem.opportunityId` 即该 relation；
- `assertPackageClaimItemOpportunityBinding()`：
  读 `ClaimItem WHERE id = package.claimItemId AND organizationId = permit.organizationId`，
  查不到或 `opportunityId !== permit.opportunityRef` → `P2E_PACKAGE_OPPORTUNITY_BINDING_MISMATCH`（零写入，事务前）。

## 3. F4E-01..04 对应

| 编号 | 要求 | 证据 |
| --- | --- | --- |
| F4E-01 | trusted org-A permit + 全部 units 都是 org-B → `P2E_PERMIT_BATCH_TENANT_MISMATCH`，port calls = 0，DB writes = 0 | `P2E-G24`（unit，零端口调用）+ `P2E-DB17`（DB 四表全 0） |
| F4E-02 | trusted permit 的 opportunity A + package/claimItem 属于 opportunity B → fail-closed，零写入 | `P2E-DB18`（`P2E_PACKAGE_OPPORTUNITY_BINDING_MISMATCH`，四表全 0） |
| F4E-03 | 合法 permit + 手工伪造 lineage AuditLog（action / entityId / packageDigest / planDigest / opportunityRef 任一不一致）→ fail-closed，零写入 | `P2E-G25`（5 种伪造逐一断言）+ `P2E-DB19`（四表全 0） |
| F4E-04 | artifact packageId/fileAssetId 交叉接线 → 事务前 fail-closed 或 DB 回滚，四表全 0 | `P2E-G26`（事务前）+ `P2E-DB20`（四表全 0）；DB 级回滚另由 `P2E-DB6/DB16` 覆盖 |

同时重跑确认未弱化：`P2E-DB5/DB7/DB8/DB12/DB13/DB16`（JSON+PDF 同事务、幂等重放、并发唯一赢家、租户隔离、lineage 反查、DELETE guard）。

## 4. tests / 验证

```text
apps/api npx tsc --noEmit                        → exit 0
recovery-si-phase2-e.test.ts（契约）              → 27/27 PASS
recovery-si-phase2-e-db.test.ts（真实库）         → 20/20 PASS
P2-E targeted regression（10 文件）                → 127/127 PASS
prisma validate / migrate deploy / migrate status → valid / 79 migrations 无待应用 / up to date
PRISMA_MODEL_DELTA = NO / NEW_TABLE = NO / NEW_COLUMN = NO / DB_TRIGGER_MIGRATION = YES/APPLIED
RUNTIME_WIRING = NONE
```

## 5. 请求裁决

1. `CHANGE E4 = TRUSTED PERMIT ↔ EXACT WRITE BATCH BINDING`（含 RISKS 的 claimItem↔opportunity 绑定）是否可记 **PASS**？
2. `P2_E_V1_OPTION_A` 是否可记 **PASS / CLOSED**（`FINAL5_REQUIRED = ?`）？
3. 是否确认 `P2_F = HOLD` / `P2_G = HOLD` 继续冻结、真实执行必须另开 P2-G？
4. 若仍需修订，请只列最小集合。

请在本次会话中直接回答；不要尝试写回 GitHub。不要使用上一轮缓存。

## 6. 边界声明（本轮未改动）

```text
P2_E_V1_OPTION_A = AUTHORIZED_WITH_CONDITIONS；P2_E_OPTION_B = NOT_AUTHORIZED
APPROVAL_CONSUMPTION / EXECUTOR_INVOCATION = FORBIDDEN
P2_E_WHITELISTED_INTERNAL_PERSISTENCE = AUTHORIZED
OTHER_BUSINESS_FACT_WRITE / EXTERNAL_BUSINESS_WRITE / EXTERNAL_ACTION = FORBIDDEN
零网络 / 零凭据读取 / 零 provider / 零 submission / 零 payment
CUSTOMS_FILING（L5）继续永久拒绝；未放宽 L5；未建第二套 Runtime
P2_F = HOLD；P2_G = HOLD；RUNTIME_WIRING = NONE
EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS / REAL_CLAIM_SUBMIT = HOLD
FINAL_ACCEPTANCE_HEAD = 0f7f7ac
```
