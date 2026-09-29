# FINAL GATE REVIEW — CrossClaim AI（Production Candidate 总审）

> 依据架构方 **MSG-20260929-41**（ADMIN-CONSOLE-PHASE4-HARDENING = PASS_CLOSE；要求提交本文件后进入最终裁决）。
> 分支 `gate/7-commercial-validation`；本文件提交前 HEAD = `759fabf`（其上 CI 绿：`4b34489` completed success）。
> 状态三轨：`CODE PASS` / `INTEGRATION PENDING` / `PRODUCTION VALIDATION PENDING`（MSG-20260929-20 口径）。
> 红线（架构方未改判前恒定）：自动提交 Claim/Appeal **FORBIDDEN**；自动扣佣 / 支付自动化 **HOLD**；真实追回效果**只能**由 Production Validation 判定。

## 0. 本文件的方法与判据

**审什么**：当前代码是否已达到「除真实平台、真实数据、真实资金、真实提交验证之外，可作为生产候选版本」。不新增功能。

**证据分级**（本文每条结论都标注来源类型）：

| 标记 | 含义 |
|---|---|
| `[CI]` | GitHub Actions 每个 commit 都跑的闸门（全新 PostgreSQL 16 上 migrate deploy + 全量测试） |
| `[DB]` | 真实 PostgreSQL 的集成用例（本机容器 `crossclaim-postgres`，与 CI 同构） |
| `[CODE]` | 代码常量 / 类型层不可绕过的约束（编译期锁死） |
| `[DOC]` | 仓库文档（设计稿、清单、runbook） |

**当前规模**：37 模型 / 39 枚举 / **18 迁移** / **27 租户完整性触发器**（CI 逐步校验触发器数量）`[CI]`；API 契约 `implemented=52 / documented=53`（唯一 documented-only 为 `/files/<token>`，由存储层按 token 解析）`[CI]`；审计覆盖 `code_actions=78 / documented_actions=71`，闸门 OK`[CI]`；测试 **106 files / 979 cases 全绿**（新增 A2 硬化 19 项后重跑）`[DB]`。

---

## 1. 当前模块完成矩阵

| 模块 | CODE | INTEGRATION | PRODUCTION VALIDATION | 证据 |
|---|---|---|---|---|
| 认证 / 会话 / RBAC / 租户隔离 | PASS | — | PENDING | `auth-db` `auth-http-db` `tenant-isolation` `[DB]` |
| 上传与导入（CSV/JSON/XLSX） | PASS | PENDING（真实导出） | PENDING | `ingest-db` `ingest-bulk-db` `upload-runtime-db` `[DB]` |
| 归一化 / 事实层 / 检测 / 机会 | PASS | PENDING | PENDING | `canonical-*-db` `detection-db` `[DB]` |
| 证据与交付物（含 POD 上传登记） | PASS | PENDING（承运商 API HOLD） | PENDING | `pod-evidence` `evidence-promotion` `[DB]` |
| 人工复核 / 高额卡口 | PASS | — | PENDING | `workflow-hitl-db` `workflow-recovery-review` `[DB]` |
| 提交准备（离线载荷 + 干跑校验） | PASS | PENDING（平台条款） | PENDING | `submission-payload` `[CODE]` |
| 提交执行（Submission Adapter） | 未开始 | **HOLD → DESIGN-FIRST** | PENDING | `adapters/types.ts` `[CODE]` |
| 账单 / 佣金对账（dry-run） | PASS | PENDING（Stripe test） | PENDING | `workflow-billing-db` `workflow-commission-db` `[DB]` |
| Success Fee 自动扣佣 | 未开始 | **HOLD** | PENDING | 红线 `[DOC]` |
| 参照数据（承运商费率 / 关税税率） | PASS | PENDING（真实公告文件） | PENDING | `reference-data` `freight-rate` `[DB]` |
| 统一验证 Harness | PASS | — | PENDING（真实文件） | `validation-run-*` `[DB]` |
| Operations Dashboard | PASS | PENDING（真实数据量） | PENDING | `operations-dashboard-db` `[DB]` |
| Notification projection | PASS（无投递） | — | PENDING | `notification-projection-db` `[DB]` |
| Admin Console A1/A2/A3/A4/A5/A6 | PASS | PENDING（真实数据） | PENDING | `admin-*-db` + `admin-http-smoke-db` `[DB]` |

---

## 2. Schema 状态

- **18 个迁移**全部可在空库上 `migrate deploy`（CI 每次全新库执行）`[CI]`；迁移清单见 `apps/api/prisma/migrations/`（init → tenant_integrity → canonical_fact_layer → payment_domain → payment_processing_attempt → claim_item → claim_source_fingerprint → claim_tracking_delta → recovery_confirmation_delta）。
- **租户隔离由数据库触发器强制**（27 个 `cc_tenant%` 触发器；CI 逐次断言数量，任何缺失即失败）`[CI]`；跨租户读取在真实库用例中被证明为 404/空集（`tenant-isolation-db`、`admin-membership-db` 用例 01–03）`[DB]`。
- **幂等统一为来源指纹 v1**：`sourceFingerprint` + `fingerprintVersion`（`source-fingerprint-db`）`[DB]`。
- **Claim 生命周期枚举**（实测值，非推断）：`DRAFT / SUBMITTED / ACKNOWLEDGED / APPROVED / PARTIALLY_APPROVED / REJECTED / NO_RESPONSE / WITHDRAWN`。
  - ⚠️ **对 Gate 2 图的一个更正**：`RECOVERY` **不是** `ClaimStatus` 的取值。Recovery 是独立域（`RecoveryOpportunity → Case → RecoveryRoute → Settlement → RecoveryPayout`），由 `recovery-outcome` / `recovery-confirmation` 驱动，而不是 Claim 状态机的下一格。若架构方要求把 RECOVERY 写成 Claim 状态，属 **Schema 语义变更 → 需 Delta 审批**，本轮不动作。
- **金额事实来源**：Recovery 侧 `confirmedAmount` 为唯一事实来源，`receivedAmount` 为投影（`recovery-confirmation-db`、看板 `amounts` 全部由投影聚合派生）`[DB]`。
- **Import 状态枚举**：`PENDING / PARSING / IMPORTED / PARTIAL / FAILED`；Admin A4 的 5 个展示桶为**固定映射**，未知状态 fail-closed 归 `failed`，**未新增**任何运营状态 `[DB]`。
- 未决 Schema 提案（均 DESIGN-FIRST、未实施）：Claim Tracking / Billing 扩展 / `carrier_rules` / `customs_duty_rates` `[DOC]`。

## 3. API 状态

- **契约闸门**：`API.md` ↔ 实现路由双向比对，`implemented=52 / documented=53`，结果 `API_CONTRACT_OK` `[CI]`。
- **真实 HTTP 可达性**（本轮新增，属 Final Gate 关键修复）：Admin 六模块 + Operations 三端点在**真实 server 装配**下均已验证 `200`，未登录 `401`、角色不足 `403`、跨租户与未知资源 `404`、非 GET `405`（`admin-http-smoke-db.test.ts` 7 项）`[DB]`。
- **本轮修复的三个真实缺陷**（均由 HTTP smoke 暴露，非设计变更）：
  1. `/admin/*` 与 `/operations/*` 未登记进 `server.ts` 的 `WORKFLOW_PATH` —— 服务层全绿但真实服务器一律 404（端点不可达）。
  2. 这两个只读面未进方法白名单 —— GET 在方法闸门处被 405 拦下。
  3. `/admin/permission-matrix` 在路由层**没有任何角色校验**（服务层同样不校验）—— 任何已登录角色（含 VIEWER）都能读完整角色×权限矩阵；已统一 `assertAdminAccess(userMembership)`。
- **写端点**：全部写路径均要求会话 + 权限前置；Admin Console / Operations 六个 Admin 模块**只有 GET**（非 GET 405，端点内二次 GET-only 校验）。
- Webhook（Stripe）不走会话：先验签原始 body 再处理；`PAYMENTS_ENABLED` 默认关闭时「验签通过 → IGNORE + 200，保留审计」`[CODE]` `[DB]`。

## 4. 权限状态

**角色**：`OWNER / ADMIN / OPS / FINANCE / VIEWER`（`MembershipRole` + `permissionsFor` 单一来源）`[CODE]`。

| 面 | OWNER | ADMIN | OPS | FINANCE | VIEWER | 证据 |
|---|---|---|---|---|---|---|
| Admin：Tenant Overview / Audit Explorer | ✅ | ✅ | ❌ | ❌ | ❌ | `ADMIN_MODULE_ROLES` `[CODE]` `[DB]` |
| Admin：Import Validation | ✅ | ✅ | ✅ | ❌ | ❌ | 同上 |
| Admin：System Health | ✅ | ✅ | ✅ | ❌ | ❌ | 同上 |
| Admin：Recovery Review / User-Membership | ✅ | ✅ | ❌ | ❌ | ❌ | 同上 |
| Operations 看板（claims / recovery / 金额） | ✅ | ✅ | 按权限键 | 按权限键 | ❌ | `dashboardVisibilityFor` `[CODE]` `[DB]` |
| 权限矩阵端点 `/admin/permission-matrix` | ✅ | ✅ | ❌ | ❌ | ❌ | 本轮修复（原为「已登录即可读」）`[DB]` |

- **fail-closed**：未知角色 / 空角色一律拒绝（`canAccessAdminModule('')` → false；用例 11）`[DB]`。
- **不泄露存在性**：跨租户一律 404（不是 403），已用真实库与真实 HTTP 双重断言 `[DB]`。
- **PII**：A2 响应禁止完整邮箱（默认掩码 `a***@example.com`）、禁止 `failedLogins` / `lockedUntil` / `tokenHash` / `ipHash` / `userAgent` / `passwordHash`（用例以 marker 断言不出现）`[DB]`。
- 未实施（将来需独立设计，不属本 Gate）：`ADMIN-GOVERNANCE-DESIGN`（角色/邀请/停用/删除）、`ADMIN-PII-ACCESS-DESIGN`（完整邮箱解掩码）。

## 5. 外部依赖状态

全部外部依赖均为 **REAL_DATA_VALIDATION_PENDING**，且**不影响代码完成度判定**（架构方 MSG-41 明确口径）：

| ID | 依赖 | 状态 | 需宿主动作 |
|---|---|---|---|
| RD-01 | Shopify 真实导出 | PENDING | 真实/脱敏文件 |
| RD-02/03 | Amazon / Walmart / TikTok 结算导出 | PENDING | 真实导出 |
| RD-04/05 | 承运商运费账单、官方费率 / DAS / SLA | PENDING | 官方文件 |
| RD-06 | 关税税率 / 301 清单 | PENDING | 官方文件 |
| RD-07 | C88 / 7501 海关单（结构识别，非 OCR） | PENDING | 真实样本；**OCR 为 BACKLOG** |
| RD-08 | 承运商 POD（17TRACK / EasyPost） | **HOLD** | 账号与授权 |
| RD-09 | Stripe test 账号 + webhook 签名密钥 | PENDING | 账号/密钥（HOST） |
| RD-10 | 平台条款核对（是否允许代提交）+ 沙箱单次人工批准 | PENDING | 法务/平台确认 |
| RD-11 | 真实账号 `AI Prepare → Human Approve → Submit` | PENDING | 真实账号（HOST） |
| RD-12 | 真实到账 → 账单 → 佣金三方对账 | PENDING | 真实资金（HOST） |

平台连接器（SP-API / TikTok / Walmart）**HOLD**；Shopify 文件适配器已实现（文件路径，不走 API）。`[DOC]`

## 6. 已知 Pending 清单（代码侧，均不阻塞 Production Candidate）

1. `ADMIN-IMPORT-SAMPLE-VIEW-DESIGN`（样本脱敏查看，v1 明确不做）
2. `EXPORT-DESIGN`（导出/下载，v1 明确不做）
3. `EVIDENCE-VIEWER-DESIGN`（证据内容预览；Admin 只给引用与元数据）
4. `CASE-VIEW-DESIGN`（订单/案件详情视图）
5. `finance-console-design`（财务控制台）
6. `ADMIN-GOVERNANCE-DESIGN`、`ADMIN-PII-ACCESS-DESIGN`（见 §4）
7. 租户/平台级 **kill switch** 实现（Phase B/C，待设计裁决）
8. OCR（C88/7501）—— BACKLOG，当前以结构识别 + 人工录入口径为准
9. 规则引擎（RuleSet / RuleVersion / Deadline / 可追回金额算法）—— **HOLD / DESIGN-FIRST**
10. 错误追踪与告警通道（第三方服务）—— 需宿主决策

## 7. Blocker 清单

**代码侧 Blocker：0（零）**。以下全部为宿主权限范围内动作，不影响「代码是否达到 Production Candidate」：

| # | 事项 | 类型 |
|---|---|---|
| B-1 | 生产部署 / 域名 / TLS / 反向代理 / 生产数据库与对象存储 | HOST APPROVAL REQUIRED |
| B-2 | 生产密钥管理与 Secret 轮换 | HOST APPROVAL REQUIRED |
| B-3 | Stripe test（乃至 live）账号与 webhook 密钥 | HOST APPROVAL REQUIRED |
| B-4 | 各平台开发者账号 / 第三方真实账号授权 | HOST APPROVAL REQUIRED |
| B-5 | 真实/脱敏业务文件、真实客户数据 | HOST APPROVAL REQUIRED |
| B-6 | 托管账户 / 预授权 / 分账（KYC 与资金合规） | HOST APPROVAL REQUIRED |
| B-7 | 任何自动提交、自动扣佣的放行 | 架构方未改判前恒为 FORBIDDEN / HOLD |

## 8. Production Candidate 判定依据

判定口径（架构方 MSG-41）：不会因「无客户数据 / 无真实 API / 无真实追回案例」否定代码完成度。

**A. CODE COMPLETE（已达成）**
1. 空库可迁移：18 迁移 + `migrate deploy` + `generate` 在全新 PostgreSQL 16 上通过 `[CI]`。
2. 租户隔离由数据库触发器强制（27 个，CI 逐步校验），跨租户一律 404/空集 `[CI]` `[DB]`。
3. 全量测试 106 files / 979 cases 全绿（真实 PostgreSQL）`[DB]`，CI 每 commit 复跑 `[CI]`。
4. API 契约、审计覆盖、许可证三道闸门全绿 `[CI]`。
5. 只读面可观测、写入口有权限前置、读操作不污染审计（前后快照一致）`[DB]`。
6. 提交边界锁死在类型层：`supportsClaimSubmission: false` 为字面量类型，`createAdapterRegistry` 拒绝任何声明 `true` 的适配器；`SUBMISSION_TRANSPORT_ENABLED = false` 且有断言 `[CODE]` `[DB]`。
7. 证据链可追溯：上传登记 → `EvidenceArtifact` → `CaseEvidence`，内容扫描（可执行/压缩包/PDF 伪装/MIME 伪造/NUL）与租户校验 `[DB]`。
8. 失败恢复：导入坏行不中断（PARTIAL + 行号 + 去重）、支付事件执行尝试（重试白名单 / 退避 / DEAD_LETTER / replay / retry-due）、并发 CAS `[DB]`。
9. 可观测性：结构化日志 + 请求日志 + webhook 安全日志出口；`/metrics` 默认关闭；`/health`、`/healthz` 含数据库探测 `[DB]`。
10. 部署准备：`DEPLOYMENT.md`（前置/构建/API/Web/初始化/健康与就绪/回滚）+ `.env.example` 21 个变量 + 幂等 `db:seed`（合成数据）+ 数据库备份恢复说明 `[DOC]`。

**B. INTEGRATION PENDING**：RD-01…RD-12 全部真实文件/真实账号/真实平台对接（详见 §5），以及 Stripe test 全事件链 runbook（`reports/C-0010-C2-runbook.md`）。

**C. REAL VALIDATION PENDING**：真实追回效果、成功费真实到账对账、真实提交后的平台回执——**只能**由 Production Validation 判定。

**D. BLOCKERS**：代码侧 0；宿主侧 7 项（§7 B-1…B-7）。

**结论（提交架构方裁决）**：建议 `PRODUCTION CANDIDATE = YES (CODE COMPLETE)`，条件为架构方接受 §7 的宿主侧事项继续挂在 HOST APPROVAL 轨道。

---

## 9. 附：Gate 1–10 速查

| Gate | 主题 | 结论（证据见对应章节） |
|---|---|---|
| 1 | 核心业务闭环完整性 | PASS（未知字段不猜测 → UNKNOWN/QUARANTINE；未见双事实来源） |
| 2 | Claim 生命周期 | PASS，附 §2 对 RECOVERY 状态的更正 |
| 3 | Evidence Chain | PASS（hash 一致、租户隔离、不泄露 storageKey） |
| 4 | Recovery / Settlement | PASS（confirmedAmount 唯一来源；无自动资金动作） |
| 5 | Submission Boundary | PASS（Prepare → Human Approve → Manual Submit；传输恒关闭） |
| 6 | 真实依赖隔离 | PASS（RD-01…RD-12 全标 REAL_DATA_VALIDATION_PENDING） |
| 7 | 权限安全 | PASS（本轮修掉「service pass ≠ production safe」的三个真实缺陷） |
| 8 | Observability | PASS（关键动作有审计、读操作不污染审计、开关默认关闭） |
| 9 | 生产部署准备 | PASS（清单齐备；域名/密钥/生产库仍为 HOST APPROVAL） |
| 10 | 最终分类 | A CODE COMPLETE / B INTEGRATION PENDING / C REAL VALIDATION PENDING / D 宿主侧 7 项 |
