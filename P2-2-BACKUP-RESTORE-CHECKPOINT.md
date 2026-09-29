# P2-2 BACKUP / RESTORE VERIFICATION CHECKPOINT

> 类型：**IMPLEMENTATION CHECKPOINT**（P2-2）
> 依据：**MSG-20260929-71**（`P2-2 = GO`：CI 合成验证 + B1–B7 + Restore Failure Simulation + dump 产物边界 + 真实备份 HOST ONLY）
> 分支：`gate/7-commercial-validation` @ **dc61e40**；main = `0e9a273`
> 边界：未使用真实数据库/真实备份；dump 只存在容器内 `/tmp`，**未产生任何 artifact**

---

## 1. 交付物

| 文件 | 内容 |
|---|---|
| `tools/backup-verify/run-synthetic-backup-verify.mjs` | 全流程脚本：临时 Postgres 容器 → `migrate deploy` → **Prisma 合成种子** → `pg_dump`（容器内）→ `createdb scratch` → `pg_restore` → **B1–B7 比对** → **Restore Failure Simulation** → 容器销毁 |
| `.github/workflows/ci.yml` | 新增作业 `Backup restore verify · synthetic dataset`（D2：CI 可重复执行） |

链路与架构方要求一致：`Synthetic Dataset → PostgreSQL → pg_dump → pg_restore scratch → Compare`。

## 2. B1–B7 验收结果（本地与 CI 均 `BACKUP_VERIFY_OK`）

| 项 | 结果（CI 日志原文摘要） |
|---|---|
| **B1** 行数一致 | `38 tables compared; 20 non-empty (AuditLog, BillingInvoice, CanonicalFact, Case, EvidenceArtifact, FeeCalculation, FileAsset, ImportBatch, …)` |
| **B2** 租户隔离 | `36 tables × 2 tenants; 22 tenant-scoped rows present`（每张 tenant-owned 表在 A/B 两个租户上「恢复后 = 原始」） |
| **B3** 金额一致 | `Settlement.amount=1234.5678 · RecoveryLedgerEntry.amount=1234.5678 · RecoveryPayout.amount=1234.5678 · BillingInvoice.total=100.0000 · FeeCalculation.feeAmount=185.1852 · Payment.amount=100.0000`（numeric `::text` 精确比较，**无 float**） |
| **B4** 审计连续性 | `original=2\|2026-09-29 18:16:29.559\|bv.synthetic.a:1,bv.synthetic.b:1 restored=（完全一致）` |
| **B5** Kill Switch | `state original=PENDING_ENABLE:1,APPLIED:1 restored=一致; idempotencyIndex=1; pendingIndex=1; tenantTriggers=28` |
| **B6** Schema | `original=19\|174\|41\|242 restored=一致`（迁移 19 / 索引 174 / 枚举 41 / 约束 242） |
| **B7** 不变量 | `fkCount=90 unvalidated=0`（恢复后外键全部有效） |
| **SIM** Restore Failure Simulation | `auditRows before=2 after=0 → detected=true`：故意破坏 scratch 后**必须被判失败**（证明不会误判成功） |

## 3. 覆盖范围与如实披露

- 合成种子通过 **Prisma 客户端**写入（自动满足 `updatedAt`/默认值/枚举约束），共 **20/22** 个模型写入成功。
- **2 项未写入（如实记录，不伪造）**：`CaseEvidence`、`Claim` —— 二者均以 `PrismaClientValidationError` 失败（种子脚本对这两个模型的字段假设与 schema 不符）；脚本以 `SEED_SKIP:` 行显式输出，并在 B1 的非空表清单中体现真实覆盖。
- 因此：B1 覆盖 38 张表的行数一致性（其中 20 张非空），B2/B3/B4/B5/B6/B7 的断言全部基于**真实存在的合成行**；`Claim`/`CaseEvidence` 属于**未覆盖**项，将在 P2-4（真实数据验证）或后续小修中补种（不需 Schema 变更）。

## 4. 边界确认（MSG-20260929-71 补充要求）

| 要求 | 状态 |
|---|---|
| CI 允许 temporary dump | ✅ dump 位于容器 `/tmp/bv.dump`，随容器销毁 |
| 禁止 upload artifact / persist dump / commit dump | ✅ 脚本不写任何宿主文件；CI 作业**没有任何 artifact 上传步骤** |
| 真实备份测试 = HOST APPROVAL REQUIRED | ✅ 未接触真实数据库/真实备份 |
| Restore Failure Simulation | ✅ 破坏 scratch → 检出失败（见 SIM） |
| 不改 Schema / 不改业务能力 | ✅ 无 Schema 变更；脚本只读配置 + 临时容器 |

## 5. 测试与 CI

| 项 | 结果 |
|---|---|
| 本地 | `BACKUP_VERIFY_OK`（B1–B7 + SIM 全 PASS） |
| **CI（HEAD `dc61e40`，run `36610840795`）** | **五作业全部 SUCCESS**：API（迁移 + typecheck + 113 files / 1075 tests）/ Web（build）/ 许可证闸门 / **Deploy smoke（DEPLOY_SMOKE_OK）** / **Backup restore verify（BACKUP_VERIFY_OK，B1–B7 + SIM）** |

## 6. 待裁决

- **Q1**：`604faac` / `6e88b13` / `dc61e40`（含本报告提交）是否批准 fast-forward 合并到 `main`？（注：前两个为 WIP 提交，最终状态以 `dc61e40` 为准）
- **Q2**：是否批准进入 **P2-3 Secret Rotation**（按设计 §3：流程 + 回滚 + 停机窗口 + `secret.rotated` 审计动作；**实际轮换仍为 HOST APPROVAL REQUIRED**，实现只做脚本/清单/审计接线）？或先把 `Claim` / `CaseEvidence` 补种完成后再进入 P2-3（建议后者：消除覆盖缺口，不阻塞 P2-3 设计）。
