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
claim.created
claim.evidence_linked
claim.item_created
claim.item_created_without_platform_ref
claim.recoverable_amount_reviewed
claim.status_changed
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
rule_evaluation.shadow_completed
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

## 6. 批量与性能基线（待补测）

当前无正式基准。离线可用 `tools/validation-run` 生成大批量 CSV 后跑导入链路，观察：
导入耗时、批次行数分布、失败行比例、内存峰值。该项记入 `CODE_COMPLETE_REPORT` 工作清单 O6。

---

## 7. 事件响应清单（上线后）

1. 确认范围：`/health` → 审计日志 → 影响租户。
2. 止血：必要时把 `PAYMENTS_ENABLED=false`（支付类）、暂停对应 `SourceConnection`（采集类）。
3. 取证：导出该租户的 `AuditLog` 与相关 `ImportBatch` / `PaymentEvent`。
4. 修复与回归：补测试 → CI 绿 → 发布。
5. 复盘：把新发现的失败模式加入 fixture 场景包（防回归）。
