# ADMIN BACKOFFICE AUDIT — CrossClaim AI

> 生成：2026-09-29（Codex）· 分支 `gate/7-commercial-validation`
> 目的：按宿主 OFFLINE COMPLETION AUDIT 第 13/20 项，回答「真实上线后，后台是否足以处理异常」。
> 口径：只核查**已有能力**与**离线可补项**。任何新增接口 / 新增 UI 页面 / 新增数据暴露面都属于产品范围变更，
> 必须回到架构方裁决（见 §4），本文件不自行实施。

---

## 1. 今天的后台能力清单（按异常类别）

| 异常类别 | 运营现在能做什么 | 入口 | 证据 |
|---|---|---|---|
| 上传/导入失败 | 看到批次状态、行数、时间（**看不到 errorReport 明细**，见 G1） | `GET /imports` | `auth/data-routes.ts` · `workflow-http-db.test.ts` |
| 导入批次异常终止 | 批次会被推进到 FAILED/PARTIAL 终态，不会永久停在 PARSING；重跑同一文件幂等 | 导入层 | `ingest.test.ts`（stage=parse/mapping/normalize/persist 全路径）· `ingest-bulk-db.test.ts` |
| 连接（采集源）异常 | 暂停 / 恢复 / 吊销 / 轮换凭据引用，全程留审计 | `POST /connections/:id/status`、`/credential-ref` | `connection-lifecycle-db.test.ts` |
| 机会识别异常 | 人工复核 QUALIFY / REJECT（带原因白名单） | `POST /opportunities/:id/qualify\|reject` | `workflow-http-db.test.ts` |
| 案件/证据/Claim 越权访问 | 角色矩阵 fail-closed（FINANCE 读不到 Claim 正文与证据） | 读取端点 | `workflow-case-read-db.test.ts` |
| 高额回收（> $1000） | 人工卡口：REQUEST / APPROVE / REJECT，仅 OWNER/ADMIN 批准 | `POST /cases/:caseId/recovery-review` | `workflow-recovery-review.test.ts` · `workflow-hitl-db.test.ts` |
| 账单状态推进 | 手工推进开票/收款状态（含 paymentReference） | `POST /billing/:invoiceId/status` | `workflow-billing-db.test.ts` |
| 支付事件卡住 / 失败 | **人工重放**（白名单原因；无 paymentId 上下文返回 409，不猜金额） | `POST /payments/events/:id/replay` | **本轮新增** `payment-admin-http-db.test.ts` |
| 自动重试到期 / 死信 | **手工跑到期重试**（limit 夹取 1–100；无上下文的自动落 DEAD_LETTER） | `POST /payments/processing/retry-due` | 同上 · `workflow-payment-attempt-db.test.ts` |
| 财务对账差异 | 差异清单 + CSV（只读，不自动修账） | `GET /payments/reconciliation(.csv)` | `workflow-payment-reconciliation-db.test.ts` |
| 佣金对账 | dry-run 差异匹配（仅 OWNER/ADMIN；永不自动置 PAID） | `POST /commissions/reconcile` | `workflow-commission-db.test.ts` |
| 服务整体不可用 | 健康检查（含数据库探测）+ Prometheus 指标（默认关闭，需 `METRICS_ENABLED=true`） | `GET /health`、`GET /metrics` | `health.test.ts` · `metrics.test.ts` |
| 取证 | 审计日志**只写不读**：需直接查库，无接口（见 G2） | — | `OPERATIONS.md` §3 动作清单 + `tools/audit-coverage` 闸门 |

---

## 2. 覆盖缺口（按优先级）

| # | 缺口 | 影响（上线后） | 结论 |
|---|---|---|---|
| G1 | `GET /imports` 不返回 `errorReport`（失败行号与错误码只落库） | 运营看到「PARTIAL 1999/2000」却不知道哪行坏、为什么坏，必须让工程师查库 | **需架构方裁定**（数据暴露面变更），本轮只记录 |
| G2 | 无审计日志查询接口（`AuditLog` 只写不读） | 事件响应第 3 步「取证」只能直连数据库，运营无法自助 | **需架构方裁定**（安全/权限面），本轮只记录 |
| G3 | Web 控制台无 `/imports`、`/payments`、对账差异页面（这些只有 API） | 运营必须用 curl/后台脚本处理支付与导入异常 | **需产品范围裁定** |
| G4 | 无内置调度器：`retry-due` 由**宿主侧调度调用**（设计如此，无队列/无后台线程） | 生产必须挂外部 cron/调度，否则死信不会被处理 | 部署前提，写入 `DEPLOYMENT.md` 待办（见 §4） |
| G5 | 无错误追踪 / 告警出口（只有结构化日志与 metrics） | 故障需人工巡检发现，不能主动告警 | 现实依赖（Sentry 等属第三方服务）→ 宿主决策 |
| G6 | quarantine 目录（连接器侧）与 `reports/cursors/` 不进仓库，也无 UI 查看 | 隔离件只能到宿主机翻文件 | 与 G3 同批裁定 |

---

## 3. 本轮（offline）已补的内容

1. **`apps/api/src/__tests__/payment-admin-http-db.test.ts`（6 用例）** —— 补齐两个运维最关键端点此前
   完全没有 HTTP 层覆盖的空白：
   未登录 401 / FINANCE 重放与 OPS 跑重试 403 / 原因缺失或非白名单 400 `INVALID_INPUT` /
   无 paymentId 上下文 409 `PAYMENT_CONTEXT_REQUIRED` / OWNER 重放成功（账单 ISSUED → PAID + 审计齐全）/
   `retry-due` 成功且 `limit` 越界被夹取而不是报错。
2. **`OPERATIONS.md` §6** —— 把「批量与性能基线（待补测）」换成实测数字（1 万行落库 ≈ 59s、
   事务超时缺陷与分块修复、TD-8）。
3. **`CODE_COMPLETE_REPORT.md`** —— 更新覆盖统计、技术债与工作清单（O6 / O10 收口）。

> 这些都属于架构方 MSG-20260929-09 明确允许的离线范围：测试矩阵、文档、运维检查、审计覆盖、可观测性。

---

## 4. 上线前必须由宿主 / 架构方决定的事项

| 事项 | 归属 | 说明 |
|---|---|---|
| G1 导入失败明细是否对租户内运营可见 | 架构方（数据暴露面） | 可做成「只回错误码 + 行号，不回原始值」的最小暴露 |
| G2 审计日志查询接口 | 架构方（安全/权限面） | 需要新的权限位与租户作用域设计 |
| G3 后台页面（导入/支付/对账） | 架构方 + 宿主（产品范围） | 与 Gate 7 收口顺序冲突时以后者为准 |
| G4 调度器/外部 cron（retry-due 定时调用） | 宿主（部署） | 需要生产环境与凭据 |
| G5 错误追踪 / 告警服务 | 宿主 | 第三方服务与费用 |
| 生产部署 / 域名 / TLS / Secret | 宿主 | HOST APPROVAL REQUIRED |

---

## 5. 上线首周运维日清单（不需要新功能，今天就能做）

每天：

1. `GET /health` 与 `GET /metrics`（若已开启）——确认依赖与错误计数。
2. 查该租户 `ImportBatch.status in (FAILED, PARTIAL)`——异常批次立刻重跑（幂等，不会重复计数）。
3. 查 `PaymentProcessingAttempt.status = DEAD_LETTER`——逐条看 `errorCode`，
   技术失败按 `replay` 白名单原因重放；无 `paymentId` 的一律人工核账，**不补金额**。
4. 查 `GET /payments/reconciliation` 的差异清单——任何差异交给财务确认，不自动修账。

每周：

5. `POST /commissions/reconcile`（dry-run）核对佣金差异。
6. 复盘本周新出现的失败模式，补进 `apps/api/fixtures/scenarios/`（防回归）。
