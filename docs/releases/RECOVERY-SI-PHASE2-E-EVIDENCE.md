# Recovery SI P2-E v1 —— 实施证据（DB 取证 / 单一事务 / lineage / DELETE guard）

- 分支：`gate/7-commercial-validation`
- 依据：**MSG-20261005-22 = PASS WITH REVISE**（`P2_E_V1_OPTION = A`；`P2_E_OPTION_B = NOT_AUTHORIZED`）
- 四项必修：① 入口门禁 `P2_E_GUARD_ACTION = claim.prepare`；② package/artifact/FileAsset/audit 单一事务；
  ③ lineage 表述（`planDigest` 仅 trace basis）；④ RecoveryPackage 的 DB DELETE guard。
- 本文件是**实施证据**（命令 + 真实输出摘要）；送审正文见 `RECOVERY-SI-PHASE2-E-IMPLEMENTATION-AUDIT-REQUEST.md`。
- 全部证据来自真实 PostgreSQL（本地开发库 `127.0.0.1:55432`）；不使用 mock 替代 DB 行为。

## 1. 产物清单

| 文件 | 角色 |
| --- | --- |
| `apps/api/src/services/intelligence/recovery-persist-gate.ts` | 必修 1 门禁（`claim.prepare`）+ 必修 2/3/4 契约常量 + 单一事务编排（P2-E2） |
| `apps/api/src/services/intelligence/recovery-persist-prisma-port.ts` | **新增**：`prisma.$transaction` 单一事务端口 + 幂等收敛入口 + lineage 落库反查（只读） |
| `apps/api/src/services/intelligence/recovery-package-preview.ts` | P2-C 可信预览（复用既有纯函数产出 manifest/digest，本批不改） |
| `apps/api/prisma/migrations/20261005040000_recovery_package_delete_guard/migration.sql` | 必修 4 迁移（P2-E1） |
| `tools/tenant-triggers/append-only-triggers.json` | 触发器清单登记 `cc_no_delete__*`（tgtype 11） |
| `apps/api/src/__tests__/recovery-si-phase2-e.test.ts` | 必修 1/2/3/4 契约验收（P2E-G1..G15） |
| `apps/api/src/__tests__/recovery-si-phase2-e-db.test.ts` | **DB 取证**（P2E-DB1..DB13，真实库） |

### 新增生产模块的边界（`recovery-persist-prisma-port.ts`）

```text
RUNTIME_WIRING = NONE（无路由 / 无 HTTP / 无 server.ts 接线 / 无守护进程）
APPROVAL_CONSUMPTION = FORBIDDEN（不消费审批）
EXECUTOR_INVOCATION = FORBIDDEN（不调用 executor）
BUSINESS_FACT_WRITE = 仅 RecoveryPackage / RecoveryPackageArtifact / FileAsset / AuditLog 四个批准单元
EXTERNAL_ACTION = FORBIDDEN（零网络、零凭据、零 provider）
manifest / digest = 既有纯函数产出后原样透传，本层不重算
```

## 2. 迁移与触发器清单（P2E-09 / 必修 4）

```text
npx prisma validate      → The schema at prisma\schema.prisma is valid 🚀（exit 0）
npx prisma migrate deploy → 79 migrations found / No pending migrations to apply（exit 0）
npx prisma migrate status → Database schema is up to date!（exit 0）
```

- 迁移 `20261005040000_recovery_package_delete_guard` 已应用（`_prisma_migrations` 有行）。
- DB 实测：`cc_no_delete__RecoveryPackage` / `cc_no_delete__RecoveryPackageArtifact` 均存在且为 `BEFORE DELETE`
  （`pg_get_triggerdef`）；函数体分别抛 `RECOVERY_PACKAGE_DELETE_FORBIDDEN` / `RECOVERY_PACKAGE_ARTIFACT_DELETE_FORBIDDEN`。
- **清单 ↔ 运行库一致性**：`tools/tenant-triggers/emit-check-sql.mjs` 与 `emit-check-append-only-sql.mjs`
  生成的 `DO $$ ... $$` 校验块在本库上直接执行通过（含「清单外启用触发器」反向核对）。
  清单真源已登记两条 `cc_no_delete__*`（tgtype 11），`unexpectedPrefixes` 含 `cc_no_delete__%`。

## 3. 单一事务原子性（必修 2 / P2E-03 / P2E-10）

端口实现：`createPrismaRecoveryPersistPort(prisma)` 把四个单元收进同一个 `prisma.$transaction`
（写入顺序 `RecoveryPackage → FileAsset → RecoveryPackageArtifact → AuditLog`，artifact 的外键最后满足）；
批内 `organizationId` 不一致时**不触库**直接 fail-closed（`P2E_TENANT_MIXED_BATCH`）。

| 证据 | 断言 | 结果 |
| --- | --- | --- |
| P2E-DB5 | `gate=ALLOW` → `P2E_PERSISTED` / `unitsWritten=4`；四表各 1 行；版本与 digest 原样落库 | PASS |
| P2E-DB5 | 八类业务事实写入计数全 0（Claim / PlatformWriteAttempt / CustomsSubmissionAttempt / RecoveryManualSubmission / Payment / Settlement / RecoveryLedgerEntry / BillingInvoice） | PASS |
| P2E-DB6 | 第 4 单元（AuditLog）FK 失败 → 整笔回滚：四表在该租户下均为 0 行（无孤儿 artifact / 孤立文件资产 / 半条审计） | PASS |
| P2E-DB9 | `gate` 非 ALLOW → 端口**零调用**、DB 零写入（`P2E_GATE_NOT_ALLOWED`） | PASS |

## 4. 幂等与并发唯一赢家（P2E-03）

| 证据 | 断言 | 结果 |
| --- | --- | --- |
| P2E-DB7 | 同 `(organizationId, claimItemId, packageVersion, packageDigest)` 重放：第 1 次 `P2E_PERSISTED`；第 2 次 `P2E_PACKAGE_ALREADY_EXISTS`（`converged=true`）；package/FileAsset/artifact/audit 各 1 行 | PASS |
| P2E-DB8 | 两个并发同键写入：恰好 1 个 `persisted=true`；package/FileAsset/artifact/audit 各 1 行（失败方整笔回滚） | PASS |

唯一性由 DB 唯一约束 `RecoveryPackage @@unique(organizationId, claimItemId, packageVersion, packageDigest)` 承担；
失败方不产生第二条业务包，也不遗留孤儿单元。

## 5. 租户隔离（P2E-02）

| 证据 | 断言 | 结果 |
| --- | --- | --- |
| P2E-DB10① | 同一批混入两个 `organizationId` → 应用层 fail-closed（`P2E_TENANT_MIXED_BATCH`），DB 零写入 | PASS |
| P2E-DB10② | orgB 的 package 引用 orgA 的 ClaimItem → 租户触发器 `cross-tenant reference blocked` | PASS |
| P2E-DB10③ | orgB 的 artifact 引用 orgA 的 package → DB 层拒绝 | PASS |
| P2E-DB11 | 反查受租户约束：跨租户 `packageId` 反查返回 `null`（不泄露存在性） | PASS |

## 6. lineage 落库反查（必修 3 / P2E-05）

- 链固定为 `CanonicalSourceFacts → RecoveryPackage → RecoveryPackageArtifact → FileAsset → packageDigest → AuditLog`。
- `planDigest` 只作**追溯 basis**，不取代 `packageDigest` 作为业务身份。
- 反查路径：`readRecoveryPackageLineage` 从真实 DB 读回 package / artifact / FileAsset / AuditLog 后投影；
  `readRecoveryPackagePlanDigestFromAudit` 从落库审计事实（`changes.planDigest`）反查追溯 basis。

| 证据 | 断言 | 结果 |
| --- | --- | --- |
| P2E-DB12 | 审计事实反查 `planDigest` = 写入值；投影 `identityValue = packageDigest` 且 `≠ planDigest`；`traceBasis = planDigest`；artifact/fileAsset/audit 引用齐全；`orphanFileAssetIds = []` | PASS |

## 7. DELETE guard 行为取证（必修 4 / P2E-04）

| 证据 | 断言 | 结果 |
| --- | --- | --- |
| P2E-DB13 | 对**已落库**的 RecoveryPackage 直接 `delete` → 拒绝（`RECOVERY_PACKAGE_DELETE_FORBIDDEN`），行保留 | PASS |
| P2E-DB13 | 对已落库 artifact 直接 `delete` → 拒绝（既有 append-only 守卫 `APPEND_ONLY_TABLE` 与新增 `cc_no_delete__*` 同级，按名称序 append-only 先触发；结论同为 DB 层不可删除），行保留 | PASS |

> 诚实说明：artifact 的 DELETE 由**既有** `cc_append_only__RecoveryPackageArtifact`（tgtype 27）先拦下；
> 本批新增的 `cc_no_delete__RecoveryPackageArtifact`（tgtype 11）已部署（P2E-DB1 取证），
> 但因事件同级且触发顺序按名称序，其异常文本在 artifact 删除路径上不出现。
> 该事实不影响裁决目标（DB 层不可删除），此处如实登记，不作「新增 guard 生效」的过度声明。

## 8. 回归与静态检查

```text
apps/api npx tsc --noEmit                                        → exit 0
recovery-si-phase2-e.test.ts（契约）                              → 23/23 PASS
recovery-si-phase2-e-db.test.ts（DB 取证）                        → 16/16 PASS
P2-E targeted regression（10 文件 / 119 例；含 Phase1 / P2-AB / P2-C / P2-D /
  recovery-manual-package(+db) 交叉回归）                          → 10 files / 119 tests PASS
prisma validate / migrate deploy / migrate status                → valid / no pending / up to date
```

## 9.2 MSG-20261005-24（P2-E FINAL-2）修订落地

裁决：**REVISE**（CHANGE 2 与 canonical READY recheck 记 PASS；剩三项窄 blocker；`FINAL3_REQUIRED = YES` 窄 FINAL-3）。

### CHANGE E1 —— 门禁与写入口不可绕过绑定

- `evaluateRecoveryPersistGate` 成为**唯一 permit 签发者**：返回值登记进模块私有 `WeakSet`；
  `isTrustedRecoveryPersistPermit()` 供写入侧校验；`persistRecoveryPackageWithinTransaction()` 对非 permit 对象直接
  `P2E_CALLER_SUPPLIED_GATE_FORBIDDEN`（手工构造 / JSON 往返的 ALLOW 对象一律无效，端口零调用）。
- `P2_E_TRUSTED_GATE_BINDING = { callerSuppliedAllowGate: 'FORBIDDEN', trustedGateToWriteBinding: 'REQUIRED',
  permitIssuer: 'evaluateRecoveryPersistGate', mechanism: 'MODULE_PRIVATE_WEAKSET_BRAND' }`。
- 证据：P2E-G23（手工伪造 ALLOW gate → 拒绝 + 零端口调用）；P2E-DB14（F3E-01：伪造 gate → 拒绝 + 四表全 0）。

### CHANGE E2 —— lineage 绑定可信 gate 的 planDigest

- `buildRecoverySiPackageLineageAuditLog({ gate, ... })` 的 `planDigest / planDigestVersion / basisVersion /
  opportunityRef / domain / guardAction / organizationId` **全部取自 gate.persistedBasis**（不来自调用参数）；
  调用方若声明 `claimedPlanDigest` 且与 `gate.persistedBasis.canonicalPlanDigest` 不一致 →
  `P2E_LINEAGE_DIGEST_MISMATCH`（fail-closed，零写入）。
- 新增门禁字段 `persistedBasis`（仅 ALLOW 且 canonical 重算通过时非空）；canonical 重算新增基数校验
  `P2E_CANONICAL_READY_CARDINALITY_INVALID`（P2-E 每次只持久化一个包 ⇒ 必须恰好 1 个 READY action）。
- 证据：P2E-G22（含 digest 不一致负例 + 伪造 gate 负例）；P2E-DB12（反查 digest == gate.canonicalPlanDigest）；
  P2E-DB15（F3E-02：digest 不一致 → 拒绝 + 零写入）。

### CHANGE E3 —— JSON manifest + PDF 双 artifact 原子持久化

- 事务单元数量固定为 `1 RecoveryPackage + 2 FileAsset（JSON/OTHER + PDF）+ 2 RecoveryPackageArtifact
  （JSON_MANIFEST + PDF）+ 1 lineage AuditLog`（`RECOVERY_PERSIST_TRANSACTION_UNIT_COUNTS`）；
  `assertApprovedTransactionUnits()` 由「集合相等」升级为「集合 + 数量相等」。
- 写入前重新校验确定性绑定：`sha256(canonicalJson) === packageDigest === JSON FileAsset.sha256`；
  `PDF artifact.sha256 === PDF FileAsset.sha256`；缺一即 fail-closed
  （`P2E_PACKAGE_DIGEST_MISMATCH` / `P2E_JSON_FILE_ASSET_DIGEST_MISMATCH` / `P2E_ARTIFACT_KIND_SET_MISMATCH` /
  `P2E_ARTIFACT_FILEASSET_DIGEST_MISMATCH`）。
- 说明：`FileKind` 枚举无 JSON 值，JSON manifest 以 `kind = OTHER` + `mimeType = application/json` 落库；
  artifact 侧仍是 `JSON_MANIFEST` + `PDF`（canonical 事实载体 + derivative）。
- 证据：P2E-DB5 / DB7 / DB8 / DB12（各 2 FileAsset / 2 artifact，kind 恰好 JSON_MANIFEST + PDF）；P2E-DB16
  （F3E-04：第二条 artifact 唯一约束失败 → 四表全 0 回滚）。

### 措辞修正（RISKS 项）

`P2_E_PERSIST_GATE_BOUNDARY` 不再写 `BUSINESS_FACT_WRITE = DRY_RUN_ONLY`（与事实不符），改为：

```text
P2_E_WHITELISTED_INTERNAL_PERSISTENCE = AUTHORIZED（RecoveryPackage / RecoveryPackageArtifact / FileAsset / AuditLog）
OTHER_BUSINESS_FACT_WRITE = FORBIDDEN
EXTERNAL_BUSINESS_WRITE = FORBIDDEN
```

## 9.1 MSG-20261005-23（P2-E Implementation Audit）修订落地

裁决：**REVISE**（`P2_E_V1_OPTION_A = NOT_YET_CLOSED`；`FINAL2_REQUIRED = YES`），范围两项：

### CHANGE 1 —— exact HEAD 必须可独立复核

- 本批核实：`b5baf381` 当时**未 push**，GitHub 返回 `No commit found for SHA: b5baf381`，架构方无法独立读取 exact implementation HEAD。
- 处置：本修订完成后 push 最终实现 HEAD，并只送窄 FINAL-2（见
  `docs/releases/RECOVERY-SI-PHASE2-E-FINAL2-REQUEST.md`）。`EXACT_HEAD_INDEPENDENT_REVIEW = BLOCKED_UNTIL_PUSH`。

### CHANGE 2 —— lineage audit action 必须独立

- 新增 `RECOVERY_SI_PACKAGE_PERSISTED_ACTION = 'recovery.si_package_persisted'`（`recovery-persist-gate.ts`），
  **仅**用于 P2-E transaction 的 lineage 审计；不再复用既有 `recovery.package_generated`。
- 新增固定白名单 `RECOVERY_SI_PACKAGE_LINEAGE_CHANGE_KEYS`（9 键：packageId / packageVersion / packageDigest /
  planDigestVersion / planDigest / basisVersion / opportunityRef / domain / guardAction）+
  `assertRecoverySiPackageLineageChanges()`（多键 → `RECOVERY_SI_LINEAGE_CHANGES_NOT_WHITELISTED` fail-closed）。
- 新增 `buildRecoverySiPackageLineageAuditLog()`（`recovery-persist-prisma-port.ts`）统一构造 lineage 审计单元。
- 证据：P2E-G22（action 独立 + 白名单 fail-closed）；P2E-DB12 改为只认独立 action 反查 planDigest，
  并断言用 `recovery.package_generated` 反查返回 `null`（语义不再混用）。

### RISKS 项（写入口 canonical READY 重算）—— 已落地

- 新增 `verifyRecoveryPersistCanonicalReady()`：`fresh state → prioritizeOpportunities → planRecovery（canonical）
  → supplied READY 必须等于 canonical planner READY 的 execution-relevant 身份`；
  在**任何 Action Guard 调用与任何 DB 写入之前**执行；缺失输入即 fail-closed。
- `evaluateRecoveryPersistGate()` 新增 `canonical` 输入与 outcome 字段
  （`canonicalReadyVerified` / `canonicalPlanDigest` / `lineageAction`）；`P2_E_CANONICAL_RECHECK_BOUNDARY.trustsUpstreamAllowSnapshot = false`。
- 失败码：`P2E_CANONICAL_RECHECK_INPUT_REQUIRED` / `P2E_CANONICAL_TENANT_MISMATCH` / `P2E_CANONICAL_STATE_STALE` /
  `P2E_CANONICAL_READY_MISSING` / `P2E_CANONICAL_READY_MISMATCH`（全部零 Guard 调用、零 DB 写入）。
- 证据：P2E-G16（缺输入）/G17（authorizationReady=false 伪造 READY）/G18（HIGH-risk OWNER gate 伪造 READY）/
  G19（金额篡改）/G20（陈旧 state）/G21（对齐成立 → 给出 canonicalPlanDigest）。
- 实现方式：P2-E 模块内独立实现同语义投影，**不改动**已 CLOSED 的 P2-D 模块（`recovery-guard-dry-run.ts` 仅只读复用其
  `planRecovery` / `prioritizeOpportunities` / `buildRecoveryPlanDigest`）。

### 措辞修正（非 blocker）

本批实际包含 trigger-only 迁移，因此表述精确化为：

```text
PRISMA_MODEL_DELTA = NO
NEW_TABLE = NO
NEW_COLUMN = NO
DB_TRIGGER_MIGRATION = YES / APPLIED（20261005040000_recovery_package_delete_guard）
```

## 9. 边界（本批未动）

```text
P2_E_V1_OPTION = A（AUTHORIZED_WITH_CONDITIONS）；P2_E_OPTION_B = NOT_AUTHORIZED
APPROVAL_CONSUMPTION / EXECUTOR_INVOCATION / EXTERNAL_ACTION = FORBIDDEN
零网络 / 零凭据读取 / 零 provider 调用 / 零 submission / 零 payment
CUSTOMS_FILING（L5）继续永久拒绝；未放宽 L5、未建第二套 Runtime
P2_F = HOLD；P2_G = HOLD（真实执行必须另开 P2-G）
RUNTIME_WIRING = NONE；SCHEMA_DELTA_REQUIRED = NO（复用既有模型与唯一约束）
FINAL_ACCEPTANCE_HEAD = 0f7f7ac（未动）
```
