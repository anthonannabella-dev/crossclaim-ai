# C-PLATFORM-WRITE-LEDGER — IMPLEMENTATION PLAN

> 依据：**MSG-20261001-18 = PASS WITH REVISE**（NEXT：将 CHANGE 收入设计后，**无需再送纯文档复审**，直接提交本 Implementation Plan）
> 分支 `gate/7-commercial-validation` · Codex · 2026-10-01 · ROUND: **R35**
> 边界：**HTTP = HOLD · REAL ADAPTER = HOLD · TRANSPORT ENABLE = FALSE · PRODUCTION CREDENTIALS = HOLD · CUSTOMER SUBMISSION = HOLD**

---

## 1. 目标与范围

把 `platform.write` 的执行权、幂等、审批消费与不确定结果恢复，落到**持久化**模型与明确的事务边界上，使 I1/I2/I3 由数据库 + 服务层共同保证；本计划**不**开启任何真实写入。

**交付物（本轮）**：本计划 + 设计文档 §12（裁定收入）。**不**包含 migration、不包含 HTTP、不包含真实 adapter。

## 2. 最终模型

### 2.1 枚举

```
enum PlatformWriteAttemptStatus {
  PENDING
  IN_FLIGHT
  SUCCEEDED
  RETRYABLE
  FAILED
  DEAD_LETTER
  BLOCKED
  UNKNOWN_PROVIDER_RESPONSE
  RECONCILING
  FAILED_CONFIRMED
  MANUAL_REVIEW
}
```

> `FAILED_CONFIRMED` = 经只读对账确认上游未执行；与 `FAILED`（上游硬拒绝）语义区分。

### 2.2 表 `PlatformWriteAttempt`（唯一逻辑执行记录 · CHANGE A）

字段与 Schema Delta Request 一致，另加：`reconcileAttempts Int @default(0)`、`reconcileNextAt DateTime?`、`reconcileLastActor String?`、`convergedBy String?`（`SYSTEM` / `USER`）、`convergedReason String?`。

**说明（CHANGE A）**：`attemptNo` 只表达**同一逻辑执行链内**的投递计数；同一 `(organizationId, idempotencyKey)` 永远只有一行主记录。逐次 transport/reconciliation 明细若未来需要，另设 append-only child model，本计划不建。

### 2.3 索引与约束（最终口径）

| # | 约束/索引 | 说明 |
| --- | --- | --- |
| C1 | `@@unique([organizationId, idempotencyKey])` | I1（裁决 ① 选 A） |
| C2 | `@@unique([organizationId, approvalId])` | I2 + CHANGE C 的可并发验证消费不变量（`approvalId` 非空） |
| C3 | raw SQL：`CREATE UNIQUE INDEX ... ON "PlatformWriteAttempt" ("organizationId", "idempotencyKey") WHERE status = SUCCEEDED` | I3（裁决 ② 批准） |
| C4 | `@@index([organizationId, status, nextRetryAt])` | 重试扫描 |
| C5 | `@@index([organizationId, status, reconcileNextAt])` | 对账扫描（裁决 ④） |
| C6 | `@@index([organizationId, targetKind, targetId])` | 审计回看 |

> 索引冲突必须在服务层转换为稳定业务错误（如 `PLATFORM_WRITE_DUPLICATE_EXECUTION_RIGHT`），**不得**向调用方暴露数据库约束细节（裁决 ②）。

## 3. 迁移顺序（获批后执行，本轮不执行）

1. **M1**：新增枚举 + 新增表（无回填）；
2. **M2**：新增 C1/C2 唯一约束与 C4–C6 索引；
3. **M3**：raw SQL 增加 C3 partial unique index；
4. 每步独立提交并跑 CI；任一步失败即停并回报；
5. 回滚：`DROP TABLE` + `DROP TYPE`（M2/M3 随表自动消失）。

## 4. 服务边界（T1 / T2 / T3 + 对账）

| 事务 | 边界 | 内容 | 不变量 |
| --- | --- | --- | --- |
| **T1** 取得执行权 | 数据库短事务，**无网络调用** | 锁/重验审批 → 插入或读取唯一 attempt → CAS 到 `IN_FLIGHT`（写 `startedAt`）→ 同事务写 `recovery.approval_consumed` | 同幂等键唯一链；同 approval 唯一执行权；任一失败整笔回滚 |
| **T2** 执行调用 | 事务外 | 调用 sink（当前仅模拟端口；真实通道关闭） | 绝不置于事务内 |
| **T3** 结果收敛 | 独立短事务 | `SUCCEEDED` / `FAILED` / `FAILED_CONFIRMED` / `RETRYABLE`(nextRetryAt) / `DEAD_LETTER` / `UNKNOWN_PROVIDER_RESPONSE` | 只有当前持有执行权的状态可收敛；`SUCCEEDED` 后不可改绑 snapshot/approval/providerRef |
| **R1** 对账 | 独立短事务（只读上游） | `UNKNOWN_PROVIDER_RESPONSE → RECONCILING → SUCCEEDED / FAILED_CONFIRMED / MANUAL_REVIEW` | **绝不重发写请求**；两个 worker 不能双重收敛（CAS + `reconcileAttempts`） |

服务层函数草案（纯编排，不读 env / 不直接发网络）：`acquireExecutionRight()`、`submitThroughPort()`、`settleResult()`、`reconcile()`、`progressManualReview()`。

## 5. 审批消费不变量（CHANGE C 报告与方案）

- 现状：消费 = 写 `recovery.approval_consumed` 审计事件；`AuditLog` 无 `approvalId` 列，**审计侧无法直接加唯一约束**；既有「恰一次」由业务 CAS/锁保障（claim / appeal 已通过真实并发验收）。
- 本方案：以 `PlatformWriteAttempt.(organizationId, approvalId)` 唯一约束作为**数据库级消费不变量**（取得执行权即消费），并与消费审计同事务。
- **需架构方确认**：是否认可该方案满足 CHANGE C；若不认可（要求审计侧唯一约束），需先对 `AuditLog` 做额外 Schema 裁定，本实现暂停在 T1 之前，不自行弱化。

## 6. 恢复所有权矩阵（CHANGE B）

| 状态迁移 | SYSTEM | OWNER / ADMIN | 审计要求 |
| --- | --- | --- | --- |
| `UNKNOWN_PROVIDER_RESPONSE → RECONCILING` | 允许 | 允许 | 记录 actor |
| `RECONCILING → SUCCEEDED / FAILED_CONFIRMED` | 允许（**只读**判定） | 允许 | 记录 provider 证据引用 |
| `RECONCILING → MANUAL_REVIEW`（24h 未定） | 允许 | 允许 | 记录超时原因 |
| `MANUAL_REVIEW → 终态` | **不允许** | 允许 | 必须 `actor + reason` |

## 7. 保留与归档（裁决 ⑤，本阶段不实现清理）

- 默认在线保留 24 个月；legal hold / dispute hold 可阻止清理；
- 归档口径：不可变、加密、访问受控的 append-only 导出，保留核心事实（状态历史、snapshot digest/version、approval reference、provider reference、审计关联）；
- 不归档 secret/token/credential 或无必要的原始敏感 payload；
- 清理/归档任务另行审计后再实现。

## 8. PostgreSQL 验收矩阵（实施阶段必须全绿）

| # | 场景 | 期望 |
| --- | --- | --- |
| PG1 | 同 key 并发取得执行权 | 恰一个成功，另一个结构化拒绝（稳定错误码） |
| PG2 | 同 approval + 不同 snapshot 并发 | 不能同时取得执行权 |
| PG3 | T1 任一步失败（含消费审计写入被拒） | 整笔回滚（attempt 与审计均无残留） |
| PG4 | approval 已消费后再发起第二执行链 | 拒绝（`APPROVAL_ALREADY_CONSUMED` / 唯一约束路径） |
| PG5 | `UNKNOWN_PROVIDER_RESPONSE` 后 | 不得再调用 write sink（调用计数 0 增量） |
| PG6 | 进程重启后 | 从持久化状态继续 reconciliation |
| PG7 | 两个 reconciliation worker 并发 | 不双重收敛（恰一次终态） |
| PG8 | `SUCCEEDED` 后改绑 snapshot/approval/providerRef | 拒绝（成功不可变） |
| PG9 | 跨租户绑定（审批 / 目标对象） | 拒绝 |
| PG10 | 绕过服务层直接插入两条 `SUCCEEDED` 同键 | 被 partial unique index 拒绝 |

## 9. 实施步骤与提交拆分（获批后）

1. S1 迁移（M1+M2+M3）+ `prisma validate` + 迁移校验脚本；
2. S2 服务层：`acquireExecutionRight / submitThroughPort / settleResult / reconcile`（以 Prisma 账本端口实现替换内存账本）；
3. S3 真实 PostgreSQL 验收 PG1–PG10（`apps/api/src/__tests__/platform-write-ledger-db.test.ts`）；
4. S4 存量单测回归（platform-write 17/17 + action-guard 22/22 + 全量）+ `tsc` + `prisma validate`；
5. S5 送审（REVIEWED_HEAD = S4 后 HEAD）——送审内容为**实现**，不是文档。

## 10. 风险与回滚

- 风险：把「本方唯一执行权 + 幂等 + provider 对账」误述为数学意义的 exactly-once；若某 provider 既无幂等写又无可靠只读查询，该 adapter 未来必须 **BLOCK 自动真实写入**（裁决 RISKS）。
- 回滚：删除新表/枚举即可，无历史数据依赖；服务层可回退到内存账本端口（仅测试用途）。

## 11. 待架构方确认

1. §5 的 CHANGE C 方案（以 attempt 唯一约束承担消费不变量）是否认可？
2. §2.1 新增 `FAILED_CONFIRMED` / `RECONCILING` / `MANUAL_REVIEW` 三态是否批准？
3. 迁移拆成 M1/M2/M3 三步提交是否接受？
