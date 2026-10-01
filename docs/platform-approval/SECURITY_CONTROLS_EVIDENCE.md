# SECURITY_CONTROLS_EVIDENCE

> 平台申请要求 **IMPLEMENTED + TESTED + EVIDENCE AVAILABLE**（「代码支持」不算证据）。
> 状态口径：`REUSED`（已有 PASS 底座）/ `PARTIAL` / `TO_BUILD`（Codex 可实施）/ `HOST`（需宿主）。

## 1. 已复用安全底座（不重做）

| 控制 | 状态 | 证据来源 |
| --- | --- | --- |
| Tenant Isolation | `REUSED` | 既有租户触发器清单 + tenant-isolation 测试 |
| RBAC / Membership | `REUSED` | 权限矩阵测试 + 锁后角色重验（R43/R44） |
| Audit | `REUSED` | AuditLog + audit-coverage 闸门 |
| HITL / Approval consumption | `REUSED` | Action Guard + approval-tx-verify（R43 S3、R44-A/B） |
| Action Guard / Kill Switch | `REUSED` | runtime guard + kill switch 测试 |
| CAS / Row Lock / Idempotency | `REUSED` | R43 S3 事务模式 + PG1–PG10 |
| CredentialRef | `REUSED` | 既有凭据引用设计（SourceConnection 只存引用） |
| Secret rejection | `REUSED` | secret 扫描/拒绝测试 |
| File scanning / Signed download | `REUSED` | 既有上传与下载测试 |
| deterministic money logic | `REUSED` | Decimal 契约 + 资金域零副作用断言 |
| append-only / controlled ledger | `REUSED` | 触发器清单（append-only/controlled-mutation） |

## 2. Production Security（申请前必须补齐）

| 控制 | 状态 | 说明 / 证据要求 |
| --- | --- | --- |
| Production HTTPS / TLS | `HOST` | 需生产域名与证书；证据 = TLS 配置报告 + 扫描 |
| Production domain | `HOST` | DNS/域名与备案类事项由宿主执行 |
| Production Secret Manager / Vault | `HOST` + `TO_BUILD` | 宿主提供实例；Codex 实施 CredentialRef 集成与测试 |
| Encryption at rest | `HOST` + `TO_BUILD` | 依赖宿主数据库/卷配置；需配置截图与声明 |
| Encryption in transit | `TO_BUILD` | 强制 TLS、HSTS、禁止明文回退；测试证据 |
| Secret / OAuth token rotation | `TO_BUILD` | 见 `OAUTH_TOKEN_LIFECYCLE.md`；需轮换测试 |
| OAuth revoke handling | `TO_BUILD` | 撤销后立即失效 + 审计；测试证据 |
| App uninstall / disconnect handling | `TO_BUILD` | 断连即停止同步 + 状态机 + 审计 |
| Data retention policy | `TO_BUILD` | 见 `PRIVACY_DATA_LIFECYCLE.md`；需可执行的清理任务 |
| Data deletion policy | `TO_BUILD` | 客户删除请求流程 + 证据 |
| Customer authorization withdrawal | `TO_BUILD` | 撤回授权后的同步/删除行为 |
| Backup / restore policy | `PARTIAL` | 已有合成备份验证；需生产策略与演练记录 |
| Dependency vulnerability scanning | `PARTIAL` | 已有 license gate；需 CVE/SCA 工具（宿主决定付费与否） |
| CVE response policy | `TO_BUILD` | 分级响应 SLA + 记录模板 |
| OWASP Top 10 baseline | `TO_BUILD` | 逐项自评 + 测试/扫描证据 |
| Security logging / monitoring | `PARTIAL` | 已有结构化日志；需生产监控接入 |
| Alerting | `HOST` + `TO_BUILD` | 告警通道（邮件/IM）需宿主提供 |
| Incident Response Plan | `TO_BUILD` | 见 `INCIDENT_RESPONSE_PLAN.md` |
| Production / test 环境分离 | `HOST` | 需独立环境与凭据 |
| least-privilege 生产凭据 | `HOST` | 平台侧角色最小化（与 `*_SCOPE_MATRIX` 一致） |

## 3. 证据归档方式

每条控制最终必须有：**声明（是什么）· 实现位置 · 测试/演练证据 · 时间戳 · 责任人**。
建议在实施批次中把证据路径写入本表对应行（避免「口头声明」）。
