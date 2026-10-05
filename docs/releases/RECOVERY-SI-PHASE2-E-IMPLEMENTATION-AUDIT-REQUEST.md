# Recovery SI P2-E v1（持久化：单一事务 / lineage / DB DELETE guard）Implementation Audit —— 送审请求

- 分支：`gate/7-commercial-validation`；**REVIEWED_HEAD = `b5baf381`**（P2-E DB closure 实现提交：`recovery-persist-prisma-port.ts` +
  `recovery-persist-gate.ts`（migrationStatus → APPLIED）+ `recovery-si-phase2-e.test.ts` + `recovery-si-phase2-e-db.test.ts` +
  `docs/releases/RECOVERY-SI-PHASE2-E-EVIDENCE.md`）
- 前置：**MSG-20261005-22 = PASS WITH REVISE**（`P2_E_V1_OPTION = A`；`P2_E_OPTION_B = NOT_AUTHORIZED`），四项必修如下。
- 耐久证据：`docs/releases/RECOVERY-SI-PHASE2-E-EVIDENCE.md`（命令 + 真实输出摘要）

## 1. 必修 ① 入口门禁 `P2_E_GUARD_ACTION = claim.prepare`

- `P2_E_GUARD_ACTION = 'claim.prepare'`；`P2_E_FORBIDDEN_GUARD_ACTIONS = ['claim.submit', 'platform.write', 'appeal.submit']`；
- 判定链路：actor 租户校验 → 可信 `ProductionControlPlane.snapshotFor` → `evaluateWithoutAudit(claim.prepare)`；
- `P2_E_PERSIST_GATE_BOUNDARY.requiresP2dAllow = false`（**不得**以 P2-D `claim.submit = ALLOW` 作为写入前提）；
- outcome 恒为 `persisted=false / transactionRequired=true / dbDeleteGuardRequired=true / approvalConsumed=false / executorInvoked=false`；
- `degraded` 或 actor 租户不一致 → DENY 且**零 Guard 调用**（P2E-G3/G4 断言调用计数 = 0）。

## 2. 必修 ② package / artifact / FileAsset / audit 收进单一事务

- 事务单元常量：`RECOVERY_PERSIST_TRANSACTION_UNITS = ['RecoveryPackage','RecoveryPackageArtifact','FileAsset','AuditLog']`，
  失败策略 `ROLLBACK_ALL`；批内单元集合不符即 fail-closed（`P2E_TRANSACTION_UNIT_SET_MISMATCH`，端口零调用）；
- 真实端口（**新增**）`createPrismaRecoveryPersistPort(prisma)`：四个单元写入同一个 `prisma.$transaction`
  （顺序 `RecoveryPackage → FileAsset → RecoveryPackageArtifact → AuditLog`）；批内 `organizationId` 不一致 → 不触库 fail-closed；
- DB 实测：ALLOW → 四表各 1 行（P2E-DB5）；AuditLog 单元 FK 失败 → 四表全 0 行（P2E-DB6，整笔回滚）；
- 幂等/并发：同键重放 → 单包 + `P2E_PACKAGE_ALREADY_EXISTS`（P2E-DB7）；并发同键 → 唯一赢家、无孤儿单元（P2E-DB8）。

## 3. 必修 ③ lineage 表述

- `RECOVERY_PERSIST_LINEAGE = { businessIdentity: 'packageDigest', traceBasis: 'planDigest', planDigestReplacesPackageDigest: false }`；
- 链：`CanonicalSourceFacts → RecoveryPackage → RecoveryPackageArtifact → FileAsset → packageDigest → AuditLog`；
- 落库反查（**新增**）`readRecoveryPackageLineage`（真实 DB 读回后投影）+ `readRecoveryPackagePlanDigestFromAudit`（从审计事实取回追溯 basis）；
- DB 实测（P2E-DB12）：`identityValue = packageDigest ≠ planDigest`，`traceBasis = planDigest`，artifact/fileAsset/audit 引用齐全、`orphanFileAssetIds = []`。

## 4. 必修 ④ RecoveryPackage DB DELETE guard

- 迁移 `20261005040000_recovery_package_delete_guard`（已应用）：`cc_no_delete__RecoveryPackage` / `cc_no_delete__RecoveryPackageArtifact`（BEFORE DELETE）；
- 清单同步：`tools/tenant-triggers/append-only-triggers.json` 登记两条（tgtype 11）+ `unexpectedPrefixes` 增 `cc_no_delete__%`；
- 清单 ↔ 运行库一致性：`emit-check-sql.mjs` / `emit-check-append-only-sql.mjs` 的 `DO $$` 校验块在真实库上直接通过（P2E-DB3/DB4）；
- 行为取证（P2E-DB13）：对**已落库**的 RecoveryPackage 直接删除 → `RECOVERY_PACKAGE_DELETE_FORBIDDEN`，行保留；
- **诚实登记**：artifact 的 DELETE 由既有 append-only 守卫（tgtype 27）先触发，异常文本为 `APPEND_ONLY_TABLE`；
  新增的 `cc_no_delete__RecoveryPackageArtifact` 已部署（P2E-DB1 取证），但事件同级且按名称序不先触发。结论仍为「DB 层不可删除」，
  本送审不主张「新增 guard 在 artifact 路径上生效」。

## 5. 证据与验证

```text
recovery-si-phase2-e.test.ts（契约 P2E-G1..G15）      → 15/15 PASS
recovery-si-phase2-e-db.test.ts（P2E-DB1..DB13）      → 13/13 PASS（真实 PostgreSQL）
P2-E targeted regression（10 文件 / 108 例）          → 10 files / 108 tests PASS
  （含 recovery-si / recovery-si-revise / recovery-si-e2e / phase2-ab / 2-c / 2-d / 2-e / 2-e-db /
    recovery-manual-package / recovery-manual-package-db）
apps/api npx tsc --noEmit                             → exit 0
prisma validate / migrate deploy / migrate status     → valid / 79 migrations 无待应用 / up to date
SCHEMA_DELTA_REQUIRED = NO（复用既有模型与唯一约束；未改 schema.prisma）
RUNTIME_WIRING = NONE（无路由 / 无 server.ts 接线）
```

## 6. requested verdict

1. 四项必修（① `claim.prepare` 门禁；② 单一事务；③ lineage 表述；④ DB DELETE guard）是否可记 **PASS**？
   `P2_E_V1_OPTION = A` 的实现是否可记 **PASS / CLOSED**？
2. `P2E-01..10` 与 `P2E-DB1..DB13` 是否足够（`FINAL-2_REQUIRED = ?`）？
3. 是否确认 `APPROVAL_CONSUMPTION / EXECUTOR_INVOCATION / EXTERNAL_ACTION = FORBIDDEN`，
   且 `P2_F` / `P2_G` 仍需各自单独送审、P2-E 通过不得自动解锁？
4. 真实执行通道（executor / provider transport / external write）是否确认必须另开 **P2-G** 审计？
5. 若仍需修订，请只列最小集合。

请在本次会话中直接回答；不要尝试写回 GitHub。不要使用上一轮缓存。

## 7. 边界声明（本批未改动）

```text
P2_E_V1_OPTION = A（AUTHORIZED_WITH_CONDITIONS）；P2_E_OPTION_B = NOT_AUTHORIZED
APPROVAL_CONSUMPTION / EXECUTOR_INVOCATION / BUSINESS_FACT_WRITE / EXTERNAL_ACTION = FORBIDDEN
零网络 / 零凭据读取 / 零 provider / 零 submission / 零 payment
CUSTOMS_FILING（L5）继续永久拒绝；未放宽 L5；未建第二套 Runtime（SECOND_RUNTIME = FORBIDDEN）
P2_F = HOLD；P2_G = HOLD；RUNTIME_WIRING = NONE；SCHEMA_DELTA_REQUIRED = NO
EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS / REAL_CLAIM_SUBMIT = HOLD
FINAL_ACCEPTANCE_HEAD = 0f7f7ac
```

## 8. 风险分级（提交模板要求）

```text
FOUNDATION_REUSED：既有 RecoveryPackage / RecoveryPackageArtifact / FileAsset / AuditLog 模型与唯一约束；
  既有 pure functions（manifest / canonical JSON / digest / PDF）；既有 action-guard control plane；
  Recovery SI Phase 1 / P2-A / P2-B / P2-C / P2-D
NEW_RISK_BOUNDARY：首次把 SI 生成的 recovery package **真实落库**（INTERNAL_WRITE）；
  单一事务原子性 + DB 层不可删除 + lineage 可反查是该新边界的三个约束面
ARCH_REVIEW_REQUIRED：YES —— 内部写入边界变化（持久化白名单 / 原子性 / 不可删除 / lineage）
```
