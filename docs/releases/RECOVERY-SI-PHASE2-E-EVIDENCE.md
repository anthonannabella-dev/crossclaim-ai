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
recovery-si-phase2-e.test.ts（契约）                              → 15/15 PASS
recovery-si-phase2-e-db.test.ts（DB 取证）                        → 13/13 PASS
P2-E targeted regression（10 文件 / 108 例；含 Phase1 / P2-AB / P2-C / P2-D /
  recovery-manual-package(+db) 交叉回归）                          → 10 files / 108 tests PASS
prisma validate / migrate deploy / migrate status                → valid / no pending / up to date
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
