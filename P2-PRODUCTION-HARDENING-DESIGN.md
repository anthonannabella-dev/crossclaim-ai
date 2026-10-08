# P2 PRODUCTION HARDENING DESIGN（设计稿，v1）

> ⚠️ **SUPERSEDED（历史归档）** —— 自 2026-10-08 起，CrossClaim 唯一正式部署入口为仓库根目录 `DEPLOYMENT.md`
> （配合 `deploy/release-manifest.json` 与 `node deploy/verify-release.mjs` 门禁）。
> 本文仅作历史记录保留，**不得作为部署流程依据**；内容冲突时以 `DEPLOYMENT.md` + manifest 为准。
> 归档索引：`docs/archive/DEPLOYMENT-HISTORY.md`


> 依据架构方 **MSG-20260929-69**：`NEXT: P2 PRODUCTION HARDENING DESIGN FIRST`，并给出 P2-1…P2-4 四块范围。
> **性质：DESIGN ONLY。** 本稿**不部署任何环境、不执行 Secret 轮换、不接触真实数据、不改代码**。

---

## 0. 边界与前提（先声明）

| 事项 | 状态 |
|---|---|
| 生产环境部署 / DNS / 域名 / TLS | **HOST APPROVAL REQUIRED**（本稿只写设计与判定标准） |
| Secret 轮换的**实际执行** | **HOST APPROVAL REQUIRED**（本稿只写流程、回滚与审计要求） |
| 真实客户数据 | **WAITING_HOST_DATA**（不阻塞开发；本稿定义输入契约与验证步骤） |
| Action Guard | **DESIGN ONLY / HOLD**（不在 P2 范围；不接业务端点） |
| Production Enablement | **HOLD** |

参考（不重复其内容）：`DEPLOYMENT.md`、`PRODUCTION-READINESS-CHECKLIST.md`、`DATA-QUALITY-REPORT-TEMPLATE.md`、`PHASE1-REAL-DATA-VALIDATION.md`、`REAL-DATA-VALIDATION-BACKLOG.md`。

---

## 1. P2-1 Deployment Smoke Design

**目标**：用可重复的清单证明两条路径 —— ① 从零到可用（fresh install）；② 变更可控（迁移 / 回滚检查点 / 环境校验 / 探针语义 / 密钥缺失行为）。

| # | 场景 | 步骤 | 通过标准 |
|---|---|---|---|
| S-1 | Fresh install | 空 PostgreSQL + 空环境 → 配置环境变量 → `npx prisma migrate deploy` → 启动 API/Web → 访问 `/health` → 登录 → Admin Console 可读 | 迁移全部 applied；`/health` 200 且 `killSwitchResolver.status='ok'`；控制台只读页面可访问 |
| S-2 | Migration deploy（升级） | 既有库 → 仅应用新迁移 → 校验迁移计数与租户触发器数量 | 迁移计数 = 当前迁移数；`cc_tenant%` 触发器 = **28**（CI 同口径断言） |
| S-3 | Rollback checkpoint | 迁移前：记录备份点（见 P2-2）；迁移后验证失败时：**先回滚应用代码**，再判定是否需数据层恢复 | 应用层回滚后服务可用且数据未损坏；数据层恢复仅在必要时执行（需 HOST 批准） |
| S-4 | Environment validation | 必填/选填环境变量清单与格式校验（URL 形态、盐值长度 ≥16、布尔白名单） | 缺失必填项 → 启动失败并输出**变量名**（绝不输出值）；选填缺失 → 按 §1.2 矩阵降级 |
| S-5 | Health check 语义 | `/health`（+`/healthz`）作为 **liveness**；readiness 语义单列（DB 可达 + 迁移完整 + resolver 可解析） | resolver 降级 **不等于** 服务 down（HTTP 200 + 字段标记）；readiness 失败由部署层判定（见 D1） |
| S-6 | Secret missing behavior | 逐项移除密钥后观察启动与运行行为 | 符合 §1.2 矩阵；绝不静默放行 |

### 1.2 密钥缺失行为矩阵（设计）

| 变量（仅名称） | 缺失时的行为 | 理由 |
|---|---|---|
| `DATABASE_URL` | **启动失败（fail fast）** | 无数据库无法保证任何事实一致性 |
| 审计 IP 盐（`AUDIT_IP_SALT`） | 启动成功；审计 IP 哈希置空（现有行为） | 不阻塞核心流程，且绝不落原始 IP |
| 文件下载签名密钥（`STORAGE_URL_SECRET`） | 启动成功；签名下载 **fail closed**（拒绝生成链接） | 宁可不可下载，不可泄露文件 |
| Webhook 签名密钥（Stripe） | 启动成功；webhook **拒绝**（已实现） | 无签名即不可信 |
| `CROSSCLAIM_API_URL`（Web） | Web 启动成功；API 调用失败折叠为受控状态（现有行为） | 展示层降级不阻断 |

### 1.3 执行者与证据

- **CI 已覆盖**：fresh DB 上真实执行迁移 + 触发器计数断言 + 全量测试（作为 S-1/S-2 的机器证据）。
- **部署环境执行**（属宿主）：S-3/S-4/S-6 需在目标环境实际执行一次，产物为 smoke 报告（模板见 §4.4）。
- 本稿**不新增** CI 步骤；如需把 S-4/S-6 自动化，另案批准。

---

## 2. P2-2 Backup / Restore Verification

**目标**：证明恢复后 **事实一致 + 审计连续 + 租户隔离保持**。

### 2.1 范围（架构方指定 + 现有模型）

| 对象 | 校验内容 |
|---|---|
| `Organization` / `User` / `Membership` | 行数一致；`(organizationId,userId)` 唯一性保持 |
| `Claim` | 行数一致；跨租户引用违规数 = 0 |
| `EvidenceArtifact` / `CaseEvidence` | 行数一致；联结表引用完整 |
| 回收链（`RecoveryOpportunity` / `Settlement` / `RecoveryLedgerEntry` / `RecoveryPayout`） | 行数与**金额聚合（Decimal 精确比较）**一致 |
| `BillingInvoice` / `FeeCalculation` / `Payment` | 行数与金额聚合一致 |
| `AuditLog` | 行数一致；按 `action` 分布一致；`max(createdAt)` 一致（审计连续性） |
| `KillSwitchRequest` | 行数一致；`state` 分布一致（控制面状态不丢） |
| 结构 | 迁移表记录一致；`cc_tenant%` 触发器 = 28；部分唯一索引存在 |

### 2.2 方法（设计）

```text
1) 备份：pg_dump（含 schema + data）→ 生成带时间戳的备份文件（off-repo 存放）
2) 恢复：pg_restore 到**隔离的 scratch 数据库**（绝不覆盖生产库）
3) 比对：运行只读比对脚本（未来实现 tools/backup-verify/compare.mjs）
        —— 逐表行数 / 分组计数 / 金额聚合 / 审计分布 / 触发器与索引
4) 判定：任一不变量不一致 → 该备份判定为「不可用」，不使用；记录报告
5) 清理：scratch 数据库销毁（不入版本库、不进日志）
```

### 2.3 不变量清单（必须全部成立）

| # | 不变量 | 说明 |
|---|---|---|
| B1 | 逐表行数一致 | 上表全部对象 |
| B2 | 按租户分组计数一致 | 证明租户维度未错位 |
| B3 | 金额聚合一致（精确） | Decimal 不做浮点近似 |
| B4 | 审计连续 | 行数 + action 分布 + `max(createdAt)` |
| B5 | 控制面状态一致 | KillSwitchRequest 的 state 分布 |
| B6 | 租户隔离保持 | 跨租户引用违规 = 0（触发器口径） |
| B7 | 结构一致 | 迁移记录 + 触发器 28 + 关键唯一索引存在 |

### 2.4 数据安全边界

- 备份文件**可能含客户数据**：不得提交到版本库、不得进入 CI 产物、不得打印内容；仅按宿主指定位置存放。
- 恢复演练在隔离环境进行；**任何对生产库的写操作都需要 HOST APPROVAL**。

---

## 3. P2-3 Secret Rotation Design

**目标**：定义可执行、可回滚、可审计的轮换流程；**本稿不执行轮换**。

### 3.1 清单（仅名称，绝不记录取值）

| Secret | 类型 | 轮换影响 | 建议方式 |
|---|---|---|---|
| 数据库口令（`DATABASE_URL` 内） | 可停机型 | 连接中断（滚动重启） | 新建口令 → 双口令并存窗口 → 切换 → 撤销旧口令 |
| 会话/令牌相关密钥 | 可重叠型 | 轮换会使既有会话失效 | 双密钥重叠（接受旧值至会话 TTL）→ 撤销旧值 |
| 审计 IP 盐（`AUDIT_IP_SALT`） | 可重叠型 | 旧哈希不可与新哈希比对（历史不重算） | 直接切换 + 记录切换时间点（历史哈希保留） |
| 文件下载签名密钥（`STORAGE_URL_SECRET`） | 可重叠型 | 旧签名链接失效 | 双密钥验证窗口 → 撤销旧值 |
| Webhook 签名密钥（Stripe） | 可重叠型 | 旧签名被拒 | 双密钥验证窗口（若上游支持）→ 撤销旧值 |
| 平台凭据引用（`credentialRef`） | 引用名（值在外部） | 连接需重认证 | 更新外部值 → 重新验证连接状态 |
| 未来 OAuth 凭据 | 占位 | — | 同"引用名"策略：仓库只存引用 |

### 3.2 流程（每项 Secret 通用）

```text
准备（记录变更单：谁/何时/哪一项 Secret 名称）
  → 生成新值（不入仓库、不入日志）
  → 重叠窗口（双值可接受；窗口 = 相关 TTL + 余量）
  → 切换（应用读取新值；滚动重启以最小化停机）
  → 验证（登录 / 导入 / 下载 / webhook 冒烟各一次）
  → 撤销旧值
  → 审计留痕（见 §3.3）
```

### 3.3 审计与可观测

- 审计记录**只含**：Secret 名称、操作者、时间、结果、影响范围、关联变更单号；**绝不记录取值**（含前后缀）。
- 建议新增审计动作 `secret.rotated`（需批准；与 `killswitch.changed` 同属安全事件族）。
- 失败回滚：保留旧值直至验证通过；若验证失败 → 回退到旧值并记录失败事件。
- 停机窗口估计：数据库口令轮换 < 1 分钟（滚动重启）；会话密钥轮换不影响可用性但强制重新登录（需提前公告）。

### 3.4 权限

- 轮换**只能由宿主执行**（HOST APPROVAL REQUIRED）；Codex 不得读取或输出任何 Secret 取值。

---

## 4. P2-4 Production Validation Runbook

**目标**：真实数据到位后，用固定步骤与模板产出可审计、可复算的验证报告。真实数据状态：**WAITING_HOST_DATA（不阻塞开发）**。

### 4.1 输入契约（宿主提供）

| 项 | 要求 |
|---|---|
| 数据形态 | 已脱敏的结算/账单导出（示例：Shopify 订单/退款导出） |
| 最小规模 | ≥500 单（`VALIDATION-RUN-001` 口径） |
| 字段 | 订单号、日期、金额、币种、平台费用/退款标识（**不含**买家姓名/地址/邮箱等 PII） |
| 交付方式 | 宿主指定路径（不经聊天/不提交仓库） |

### 4.2 步骤

```text
1) 接收检查：文件格式、行数、时间范围、字段完整性（不合格 → 记录并退回宿主）
2) 导入：走既有 import pipeline（File/API input → parse → normalize → validate → ImportBatch → SourceTransaction）
3) 数据质量报告：按 DATA-QUALITY-REPORT-TEMPLATE.md 产出（桶分布 / 异常角标 / 抽样明细）
4) 机会判定：仅在既有已批准范围内执行（规则引擎当前 HOLD/DESIGN-FIRST，不在本 Runbook 内启用）
5) 人工复核：抽样确认可追回金额口径与证据引用
6) 输出：Validation 报告（结论 + 证据 + 复算指引）
```

### 4.3 失败处理

| 失败 | 处理 |
|---|---|
| 数据不足 / 缺字段 | 记录缺口清单，退回宿主补齐（不臆造数据） |
| 导入失败 / 行级错误 | 使用既有 error report（`/admin/imports/:id/errors`）；修复映射后重跑 |
| 重复导入 | 依赖 `dedupeKey` 幂等（不得产生重复事实） |
| 租户错配 | 立即停止，报告并隔离样本（不得跨租户入库） |

### 4.4 输出模板（报告必须有）

1. 输入摘要（文件名/行数/时间范围/脱敏声明）
2. 导入结果（批次、成功/失败行数、错误分类）
3. 数据质量（桶分布、异常清单、抽样）
4. 结论与置信度（**可追回效果只能由本 Runbook 判定**；不得由开发环境推断）
5. 证据索引（批次 id、报告文件、CI/commit 引用）
6. 未决问题与下一步

> Deployment smoke 报告（§1）与 Validation 报告（§4）使用同一模板族：结论 + 证据 + 复算指引。

---

## 5. 本设计**不做**什么

- ❌ 不部署任何环境、不配置 DNS/TLS、不创建云资源
- ❌ 不执行任何 Secret 轮换（仅定义流程）
- ❌ 不接触真实客户数据；不使用真实数据做测试
- ❌ 不实现 Action Guard、不接业务端点、不阻断 Claim/Billing/Payment/Submission
- ❌ 不改 Schema、不改运行时取值语义

## 6. 待裁决（D1–D6）

| # | 问题 | 建议 |
|---|---|---|
| **D1** | readiness 是否新增独立端点（如 `/readyz`：DB + 迁移 + resolver），把 `/health` 固定为 liveness | 建议新增（部署层据 readiness 摘流），`/health` 语义保持不变 |
| **D2** | 备份/恢复比对是否纳入 CI（用合成数据 + 临时库） | 建议纳入"合成数据版"（真实备份仍只在宿主环境演练） |
| **D3** | 是否批准新增审计动作 `secret.rotated`（只记名称与结果） | 建议批准；否则改为结构化安全日志 |
| **D4** | smoke 脚本（S-1/S-2）是否允许用 docker compose 在本机/CI 复现 | 建议允许（不含任何生产凭据） |
| **D5** | Validation 报告的通过门槛（例如：≥500 单、行级成功率 ≥99%、异常桶可解释） | 建议按此门槛，最终以架构方裁定为准 |
| **D6** | P2 四项是否合并为一个实现 checkpoint，还是逐项交付 | 建议逐项（P2-1 → P2-2 → P2-3 → P2-4），每项单独 checkpoint |


---

## 7. R2 修订（按架构方 MSG-20260929-70 = GO_WITH_MINOR_REVISE）

### 7.1 D1（APPROVE）→ 独立 readiness 端点已实现

- `/health`（+ `/healthz`）= **liveness**：仅表示进程活着；resolver 降级时仍 200。
- `/readyz` = **readiness**：DB 可用 + migration 完整 + resolver 可解析；不满足 → **503**。
- 失败只返回原因码：`DATABASE_UNAVAILABLE` / `MIGRATION_MISMATCH` / `KILL_SWITCH_RESOLVER_FAIL_CLOSED`；
  **禁止**返回 SQL 错误 / 连接串 / 堆栈 / secret（实现中连错误消息都不带出）。

### 7.2 D2（APPROVE WITH SCOPE LIMIT）→ 备份比对入 CI 的边界

- CI 只允许 **synthetic dataset → 临时库 → 比对（schema / migration / trigger 28 / indexes / tenant isolation）**；
- 禁止在 CI 使用真实客户数据、禁止输出备份文件、禁止保存数据库 dump artifact；
- 真实备份验证仍**只在宿主环境**进行（P2-2 阶段执行）。

### 7.3 D3（APPROVE）→ `secret.rotated` 审计动作

- 允许字段：`secretName` / `actorUserId` / `timestamp` / `result` / `changeRequestId`；
- 禁止：secret 取值、hash、前后缀、长度，尤其禁止 `oldSecret` / `newSecret`；
- 语义：属 **security operation audit**（不是业务 AuditLog）；**读取 secret 不产生审计**。

### 7.4 D4（APPROVE）→ docker smoke

- 允许本地 / CI / 临时环境执行；容器使用**测试 secret**、**随机数据库名**、生命周期结束**销毁**；
- 已实现：`tools/smoke/deploy-smoke.mjs` + CI 作业 `Deploy smoke · fresh install + migration upgrade`。

### 7.5 D5（REVISE）→ Production Validation 门槛（替换原 §4 门槛）

| 阶段 | 门槛 |
|---|---|
| **Stage A** 数据完整性 | `input rows = normalized rows + quarantine rows + rejected rows`；**禁止 silent drop** |
| **Stage B** Candidate | `Candidate >= 10`；**Candidate ≠ Claim**（不得记为已主张） |
| **Stage C** 人工确认 | `human verification >= 5`，分类 TRUE POSITIVE / FALSE POSITIVE / NEEDS DATA |
| 第一阶段**禁止** | 直接判断回收金额 / 成功率 / ARR / 收费能力（属商业验证阶段） |

### 7.6 D6（APPROVE）→ 逐项交付

`P2-1 → checkpoint → P2-2 → checkpoint → P2-3 → checkpoint → P2-4 → checkpoint`（不合并；四项风险性质不同）。
