# OPERATIONS — CrossClaim AI

> 面向值守与排障：健康检查、日志、审计、常见故障处置、数据运维。

---

## 1. 健康检查

`GET /health`（只读、无副作用）：

```json
{ "status": "ok", "checkedAt": "...", "version": "...",
  "checks": { "<dep>": { "ok": true, "latencyMs": 3, "detail": "..." } } }
```

- `ok` = 全部依赖可用；`degraded` = 部分依赖不可用（仍返回 200，便于探针区分）。
- `detail` 只保留错误消息前 200 字符，**不含堆栈 / 连接串**。

---

## 2. 日志与可观测性

| 信号 | 位置 | 说明 |
|---|---|---|
| 请求日志 | 应用 stdout（结构化 JSON） | 每请求一条 `http_request`：`method / path / status / ms`；`/files/<token>` 已脱敏 |
| 审计 | 数据库 `AuditLog` | 50+ 关键动作（见 §3），含 actor、租户、时间 |
| 迁移审计 | `AuditLog.migration.applied` | 迁移执行留痕 |
| CI | GitHub Actions | 三作业：api（迁移 + 类型 + 测试）/ web（typecheck + build）/ license-gate |

**指标端点（O9，已实现）**：`GET /metrics` 返回 Prometheus 文本，**默认关闭**（`METRICS_ENABLED=true` 才暴露，否则 404）。
指标口径：`crossclaim_http_requests_total{method,status_class}`、`crossclaim_http_request_duration_ms_sum/_count`、`crossclaim_process_uptime_seconds`。
计数器只存在于进程内（重启清零），**不含任何租户/PII 数据**；需要长周期趋势仍以 `http_request` 日志与 `AuditLog` 为准。

---

## 3. 关键审计动作（运维关注）

```text
adapter.pull_completed
adapter.pull_failed
auth.login_failed
auth.login_succeeded
auth.session_expired
auth.session_revoked
billing.status_changed
canonical_fact.conflict
canonical_fact.conflict_detected
case.created
case.status_changed
claim.approved_by_human
claim.created
claim.deadline_recorded
claim.evidence_linked
claim.item_created
claim.item_created_without_platform_ref
claim.platform_case_ref_recorded
claim.recoverable_amount_reviewed
claim.response_recorded
claim.status_changed
claim.submitted
claim.submitted_by_human
claim.terminal_recorded
commercial_terms.created
commission.reconciliation_failed
connector.normalizer_version_changed
connector.pull_finished
connector.pull_started
evidence.case_linked
evidence.created
evidence.promotion_failed
evidence.promotion_reused
file.downloaded
file.scan_passed
file.upload_duplicate
file.upload_failed
file.uploaded
identity.duplicate_resolved
import.completed
import.failed
import.retry_completed
opportunity.status_changed
payment.processing_failed
payment.processing_payment_linked
payment.processing_recovered
payment.processing_replayed
payment.processing_started
payment.reconciliation_failed
payment.review_approved
payment.review_rejected
payment.review_required
payment.succeeded
recovery.review_approved
recovery.review_rejected
recovery.review_required
recovery_outcome.confirmed
recovery_payout.duplicate_ignored
recovery_payout.recorded
rule_evaluation.shadow_completed
settlement.confirmation_recorded
settlement.reconciliation_changed
settlement.reversal_linked
source_connection.created
source_connection.credential_rotated
source_connection.status_changed
sync_run.completed
sync_run.failed
user.invitation_accepted
user.invitation_failed
user.invited
```

---

## 4. 常见故障与处置

| 症状 | 可能原因 | 处置 |
|---|---|---|
| 启动即失败，报缺少环境变量 | 缺 `DATABASE_URL` 等必需项 | 按报错清单补齐（一次列全） |
| `/health` = degraded | 数据库不可达 | 检查 PG 与连接串；`checks.<dep>.detail` 给出原因 |
| 上传被拒 | 命中字节级安全扫描 | 让用户改传 CSV；`file.upload_failed` 有记录 |
| 导入 0 行 / 全部失败 | 列名不匹配或必需列缺失 | 用 `tools/validation-run` 适配报告定位；未识别列不会猜 |
| 同一文件重复上传 | 幂等生效 | 返回 duplicate，不重复入库（`file.upload_duplicate`） |
| 支付事件重复 | provider 重投 | 幂等：`DUPLICATE`，不新增 attempt / Payment |
| 支付投递失败后未恢复 | 需执行恢复 | `PaymentProcessingAttempt` 有 `RETRYABLE_FAILED` 与重试到期扫描；审计 `payment.processing_recovered` |
| 财务对账有差异 | provider 与本地不一致 | 生成差异清单（只读、零写入），人工处理 |

---

## 5. 数据运维

| 操作 | 命令 |
|---|---|
| 应用迁移（生产） | `cd apps/api && npx prisma migrate deploy` |
| 迁移状态 | `npx prisma migrate status` |
| 合成数据（仅非生产） | `npm run db:seed` |
| 看库 | `psql "$DATABASE_URL"` |
| 回滚 | 见 `DEPLOYMENT.md` §7（应用回滚优先；数据回滚需备份恢复） |

**禁止**：生产环境执行 `prisma migrate dev`、`prisma migrate reset` 或任何 `db push`。

---

## 6. 批量与性能基线（实测）

环境：本地 PostgreSQL 16 容器（Windows 主机，2026-09-29）；CI 为 GitHub Actions ubuntu-latest。

| 场景 | 规模 | 结果 | 证据 |
|---|---|---|---|
| 适配层解析（纯内存：CSV → canonical input） | 10,000 行 | PASS，行数一致；该文件 14 个场景合计 130ms | `validation-run-scenarios.test.ts` #11 |
| 数据库导入链路（parse → ImportBatch → SourceTransaction + CanonicalFact 双写） | 10,000 行 | IMPORTED，10,000 行全部落库，耗时 ≈ 59s | `ingest-bulk-db.test.ts` |
| 同一文件重复导入（幂等） | 2,000 行 ×2 | 第二次 0 新增、2,000 条记为重复，批次记录仍留痕 | 同上 |
| 行级失败不中断整批 | 2,000 行含 1 坏行 | PARTIAL，1,999 行入库，失败行号精确 | 同上 |

运维结论：

1. **单次导入会超过 Prisma 交互事务默认 5s 上限**。修复前 1 万行必然报
   `Transaction already closed: A query cannot be executed on an expired transaction.`
   现按 `chunkSize=1000` 分块写入，每块一个显式 `timeout=60s` 事务
   （`apps/api/src/services/ingest/prisma-repository.ts`）。
2. 当前吞吐 ≈ 170 行/秒，瓶颈在事实层：每个事实 2 次 upsert 往返（技术债 **TD-8**）。
   1 万行 ≈ 59s 可接受；若真实文件到 10 万行量级，必须先做事实层批量写入优化。
3. 分块的原子性粒度是「块」：第 N 块失败时前 N-1 块的行会保留，但批次会被导入层推进到
   FAILED/PARTIAL，行仍带 importBatchId 且受 dedupeKey 幂等保护 —— 重跑同一文件不会重复计数。

## 7. 事件响应清单（上线后）

1. 确认范围：`/health` → 审计日志 → 影响租户。
2. 止血：必要时把 `PAYMENTS_ENABLED=false`（支付类）、暂停对应 `SourceConnection`（采集类）。
3. 取证：导出该租户的 `AuditLog` 与相关 `ImportBatch` / `PaymentEvent`。
4. 修复与回归：补测试 → CI 绿 → 发布。
5. 复盘：把新发现的失败模式加入 fixture 场景包（防回归）。
