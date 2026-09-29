# PRODUCTION READINESS CHECKLIST — CrossClaim AI

> 依据宿主指令（2026-09-29）与架构方 **MSG-20260929-20**：状态三轨化 `CODE PASS` / `INTEGRATION PENDING` / `PRODUCTION VALIDATION PENDING`。
> 本清单是「能否进入 Production Candidate」的判据；**勾选 ≠ 已上线**，真实数据与真实平台验证统一在最后执行。
>
> 红线（架构方未改判前恒定）：自动提交 Claim/Appeal **未批准**；自动扣佣 **未批准**；真实追回效果**只能**由 Production Validation 判定。
>
> 最终总审（Gate 1–10 + Production Candidate 判定）见 [`FINAL-GATE-REVIEW.md`](FINAL-GATE-REVIEW.md)。

---

## A. 运行与配置

- [x] `prisma validate` / `migrate deploy` / `generate` 在全新库上可执行（CI 覆盖）
- [x] 环境变量清单与 `.env.example` 对齐（数据库、存储、审计盐、Temporal、AI、可观测性、运行时）
- [x] 默认安全开关为关闭态：`PAYMENTS_ENABLED=false`、`METRICS_ENABLED=false`
- [x] 健康检查 `/health`、`/healthz`（含数据库探测）
- [x] Admin Console / Operations 只读端点 HTTP smoke（真实服务器 + PostgreSQL）：401 未登录 / 403 角色 / 404 跨租户 / 405 非 GET / 200 白名单，且调用前后事实快照一致（MSG-20260929-40；同时修正 `/admin/*`、`/operations/*` 未进 `WORKFLOW_PATH` 导致真实服务器 404 的接线缺陷）
- [ ] 生产域名 / TLS / 反向代理配置（**HOST APPROVAL REQUIRED**）
- [ ] 生产数据库与对象存储（S3 兼容）（**HOST APPROVAL REQUIRED**）

## B. 数据与 Schema

- [x] 38 模型 / 19 迁移 / 28 租户完整性触发器，CI 校验触发器数量
- [x] 幂等以来源指纹 v1 统一（`sourceFingerprint` + `fingerprintVersion`）
- [ ] 追加 Schema（Claim Tracking / Billing 扩展 / carrier_rules / customs_duty_rates）→ **DESIGN-FIRST（MSG-20）**

## C. 功能三轨状态（当前）

| 模块 | CODE | INTEGRATION | PRODUCTION VALIDATION |
|---|---|---|---|
| 认证 / 会话 / RBAC / 租户隔离 | PASS | — | PENDING |
| 上传与导入（CSV/JSON/XLSX） | PASS | PENDING（真实导出） | PENDING |
| 归一化 / 事实层 / 检测 / 机会 | PASS | PENDING | PENDING |
| 证据与交付物（含 POD 上传登记） | PASS | PENDING（承运商 API HOLD） | PENDING |
| 人工复核 / 高额卡口 | PASS | — | PENDING |
| 提交准备（离线载荷 + 干跑校验） | PASS | PENDING（平台条款） | PENDING |
| 提交执行（Submission Adapter） | 未开始 | HOLD → DESIGN-FIRST | PENDING |
| 账单 / 佣金对账（dry-run） | PASS | PENDING（Stripe test） | PENDING |
| Success Fee 自动扣佣 | 未开始 | HOLD | PENDING |
| 参照数据（承运商费率 / 关税税率） | PASS | PENDING（真实公告文件） | PENDING |
| 统一验证 Harness | PASS | — | PENDING（真实文件） |
| Dashboard / Admin / Notifications | PASS | PENDING（真实数据） | PENDING |

## D. 安全

- [x] 密码哈希、会话令牌哈希、账号锁定、邀请制
- [x] 角色矩阵 fail-closed（OWNER/ADMIN/OPS/FINANCE/VIEWER）
- [x] 租户隔离由数据库触发器强制（28 个）
- [x] 上传内容扫描（可执行/压缩包/PDF/图片伪装/MIME 伪造/NUL）
- [x] 凭据只以引用名出现；审计不落原始 IP（加盐哈希）
- [x] 载荷与自由文本的凭据/PII 防线（`NO_SECRET_KEYS` / `NO_SECRET_VALUES` / 邮箱电话拦截）
- [ ] 生产密钥管理与轮换（**HOST APPROVAL REQUIRED**）

## E. 失败恢复 / 幂等 / 并发

- [x] 导入：坏行不中断整批（PARTIAL + 行号 + 去重计数）、`dedupeKey` 唯一约束
- [x] 批量导入分块 + 显式事务超时（1 万行回归闸门）
- [x] 支付事件执行尝试：重试白名单、退避、DEAD_LETTER、replay、retry-due
- [x] 并发 CAS（机会复核、支付执行）、部分唯一索引
- [x] 证据与事实同事务写入（C-0006-A）

## F. 可观测性

- [x] 结构化日志 + 请求日志 + 安全日志出口（webhook 验签失败等）
- [x] `/metrics`（Prometheus 文本，默认关闭）
- [x] `tools/audit-coverage` 闸门（代码审计动作 ↔ 运维清单双向核对）
- [ ] 错误追踪 / 告警通道（第三方服务 → **HOST APPROVAL REQUIRED**）

## G. Kill Switch 与人工闸门

- [x] 提交闸门恒 `NEEDS_MANUAL`（`supportsClaimSubmission=false`，类型层锁死）
- [x] 高额卡口：> $1000 需 OWNER/ADMIN 复核
- [x] `SUBMISSION_TRANSPORT_ENABLED=false`（离线载荷模块永不传输）
- [ ] 租户/平台级 kill switch 的实现（Phase B/C，待设计裁决）

## H. 部署与回滚

- [x] `DEPLOYMENT.md`（步骤、环境变量、初始化、回滚）
- [x] 幂等 `db:seed`（合成数据，禁生产）
- [x] CI：全新 PostgreSQL 上跑迁移 + 全量测试；web typecheck/build；许可证闸门
- [ ] 生产发布流程与灰度策略（**HOST APPROVAL REQUIRED**）

## I. 上线前必须完成的 Production Validation（统一执行）

逐项对应 [`REAL-DATA-VALIDATION-BACKLOG.md`](REAL-DATA-VALIDATION-BACKLOG.md)：

- [ ] RD-01…RD-03 真实/脱敏导出文件跑通 VALIDATION-RUN 并产出商业评审
- [ ] RD-04…RD-07 真实运费账单、官方费率/DAS/SLA、关税税率与 301、报关单结构识别
- [ ] RD-08 承运商 POD（授权后）与文件上传登记一致
- [ ] RD-09 Stripe test 全事件链（`reports/C-0010-C2-runbook.md`）
- [ ] RD-10 平台条款核对（是否允许代提交）＋沙箱内人工批准单次提交
- [ ] RD-11 真实账号 `AI Prepare → Human Approve → Submit` 全链路留痕
- [ ] RD-12 真实到账 → 账单 → 佣金三方对账一致

## J. 判据

**Production Candidate = A–H 全部为 `[x]` 或明确标注 HOST APPROVAL REQUIRED 项，且 C 表所有「本轮可完成」模块为 CODE PASS。**
I 区（Production Validation）不属于 Candidate 判据，属上线前动作。
