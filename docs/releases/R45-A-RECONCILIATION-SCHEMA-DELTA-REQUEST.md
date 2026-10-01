# R45-A — Outcome / Reimbursement Reconciliation · Schema Delta Request

> 依据：**MSG-20261001-44 = PASS WITH REVISE**（R45 Design 裁决：7 项裁决 + CHANGE A/B/C；Q7 = 按 R43 模式先提交 **Schema Delta Request**）。
> 状态：**docs-only 请求**——本文件**不实施** Schema 变更、不写 migration、不改代码；等架构方批准后再提交 R45-B Implementation Plan。
> 边界：不创建 Settlement / Billing / Fee；不改写 RecoveryLedger；不自动外写；不开启 transport。

---

## 1. 范围与复用

**新增一个领域原子模型**：provider outcome → reimbursement observation → claim reconciliation（**不含** recovered money → Settlement → Billing，后者属 R46）。

复用（不新建第二套）：

- 租户边界：所有新表挂 `organizationId` + 既有 `cc_tenant_*` / `cc_tenant_immutable__*` 触发器清单机制；
- 只追加事实：沿用 R43 的 `cc_append_only__<Table>` 清单与校验器（`tools/tenant-triggers/append-only-triggers.json`）；
- 证据：只引用既有 `EvidenceArtifact`，不复制证据仓库；
- 审批：沿用 `recovery.review_approved` 事件族 + `verifyApprovalBoundary` + `boundExtra`（R44-A 已验证的「服务端额外绑定键」模式）；
- 审计：`AuditLog`，动作命名沿用「动作/命令」风格。

## 2. 新增表（Immutable Facts，全部 append-only）

### 2.1 `ProviderOutcomeFact`

| 列 | 说明 |
| --- | --- |
| `id`, `organizationId`, `caseId`, `claimItemId?` | 租户与案件绑定（弱引用，同 R43 口径） |
| `kind` | `ACCEPTED` \| `ACCEPTANCE_REVOKED`（**不改写历史 ACCEPTED**：撤销以新事实表达，Q4） |
| `providerCaseRefCanonical?` | 复用 R43 S4 canonical（服务端构造） |
| `occurredAt` | provider 侧事件时间 |
| `sourceKind` | `OFFICIAL_API` \| `PLATFORM_REPORT` \| `MANUAL_ENTRY`（客户端自证不存在该取值） |
| `sourceRef`, `capturedAt`, `parserVersion?`, `ingestedByUserId` | provenance（Q④/⑨；缺失即拒） |
| `evidenceArtifactIds` | 引用既有 `EvidenceArtifact`（0..n） |
| `note?`, `createdAt` | —— |

### 2.2 `ReimbursementFact`

| 列 | 说明 |
| --- | --- |
| `id`, `organizationId`, `claimItemId?` | 观察到的赔付事实（**不预设**已对账） |
| `kind` | `OBSERVED` \| `REIMBURSEMENT_REVERSED`（冲正以新事实表达，Q4） |
| `reversesFactId?` | 指向被冲正的 `OBSERVED` 事实（同租户） |
| `providerEventId?` | provider 提供的稳定事件 ID（若存在） |
| `providerEventFingerprint` + `fingerprintVersion` | **版本化服务端指纹**（CHANGE C）：无稳定 ID 时由服务端按 (provider, case ref, occurredAt, amount, currency, currency-scale) 计算 |
| `amount` (Decimal 4) / `currency` | 金额与币种（**不自动换汇**） |
| `occurredAt` | provider 侧时间 |
| `providerCaseRefCanonical?`, `orderRef?`, `rawRefs?` | 匹配候选输入（canonical 恒服务端构造） |
| provenance 列 | 同 2.1 |
| `createdAt` | —— |

### 2.3 `ExpectedRecoveryBasis`（CHANGE A）

| 列 | 说明 |
| --- | --- |
| `id`, `organizationId`, `claimItemId`, `caseId` | 对账比较基准（**不是** `ClaimItem` 金额字段） |
| `expectedRecoveryAmount` (Decimal 4) / `currency` | 期望可追回金额 |
| `basisKind` | 例如 `CARRIER_CLAIM` \| `PROVIDER_POLICY` \| `CONTRACTUAL`（枚举待批） |
| `basisVersion` | 基准版本（版本化，Q② 要求） |
| `basisSource` | 依据来源（文档 / 报告 / 人工，含证据引用） |
| `effectiveAt`, `createdByUserId`, `createdAt`, `supersededByBasisId?` | append-only：新基准以新行表达 |

**不变量**：同一 `(organizationId, claimItemId)` 任意时刻至多一条 **effective** 基准（partial unique + `supersededByBasisId IS NULL`）；**禁止**在 reimbursement 到账后反向修改已生效基准。

### 2.4 `ReconciliationOverrideDecision`

| 列 | 说明 |
| --- | --- |
| `id`, `organizationId`, `claimItemId`, `reimbursementFactId` | 覆盖目标（v1：**每笔单独审批**，Q⑤） |
| `decisionKind` | `MATCHED` \| `UNMATCHED` |
| `reasonCode`, `reasonText` | 结构化理由 + 自由文本（必填） |
| `approvalId` | **必填**：`recovery.review_approved` 事件 id（humanApproval） |
| `decidedByUserId`, `decidedAt`, `createdAt` | actor 与时间 |

**唯一性**：`UNIQUE(organizationId, reimbursementFactId)`（v1 一笔 reimbursement 至多一条 override 决策）；`approvalId` 同租户唯一（沿用 R43 `UNIQUE(organizationId, approvalId)` 模式）。

## 3. Derived Projection（不是事实，可重算）

### 3.1 `ClaimReconciliationProjection`

| 列 | 说明 |
| --- | --- |
| `organizationId`, `claimItemId` | 主键（每 claim 一行，可重算覆盖） |
| `status` | `UNMATCHED` \| `AMBIGUOUS` \| `MATCHED` \| `PARTIALLY_RECONCILED` \| `FULLY_RECONCILED` |
| `basisId`, `expectedAmount`, `currency` | 本次计算使用的基准（可追溯） |
| `netMatchedObservedAmount` (Decimal 4) | 有效且未被冲正抵销的已匹配金额 |
| `matchedFactIds` | 计入的 reimbursement 事实 id 列表（可追溯） |
| `inputDigest`, `projectionVersion`, `computedAt` | 输入指纹 + 投影版本 + 计算时间 |

**规则**（Q②）：`FULLY_RECONCILED` 需同时满足「全部计入事实有效且未被 reversal/correction 抵销 / provenance 完整 / currency 一致 / 全部 MATCHED / 无 unresolved AMBIGUOUS 或 conflicting evidence / 使用明确 expected basis 且 `netMatchedObservedAmount` ≥ `expectedAmount`」。
**禁止**：把 projection 当作不可逆历史事实（reversal 到来后必须可重算，Q4/CHANGE B）。

## 4. 容差策略（Q①）

- **v1 默认 exact**：`absoluteTolerance = 0` 且 `relativeTolerance = 0`（不冻结全局业务默认，也不预设 $0.01 / 1%）。
- 放宽必须通过**版本化策略**：`ReconciliationTolerancePolicy { id, organizationId?, provider?, operation?, policyVersion, absoluteTolerance, relativeTolerance, effectiveAt, createdByUserId, createdAt }`（append-only），判定使用
  `abs(observed − expected) <= max(absoluteTolerance, expected × relativeTolerance)`，
  并在 projection / 审计中记录 `policyId + policyVersion`（未配置 policy 即 exact）。

## 5. 外部事件身份与幂等（CHANGE C）

- `rr1:<claimItemId>:<reimbursementFactId>` 仅解决 **reconciliation** 幂等；**ingest** 幂等必须由 `UNIQUE(organizationId, providerEventFingerprint)` 承担。
- `providerEventFingerprint` 计算规则版本化（`fingerprintVersion`）；重复 ingest → 复用既有 `ReimbursementFact`（不新建、不双计）。
- 目标：**同一笔 reimbursement 重复导入不会累计成双倍**（架构方点名的头号风险）。

## 6. 索引 / 约束 / 触发器清单（一次完整列出，Q7）

| 类别 | 内容 |
| --- | --- |
| 唯一 | `UNIQUE(org, providerEventFingerprint)`；`UNIQUE(org, reimbursementFactId)`（override）；`UNIQUE(org, approvalId)`（override）；每 claim 至多一条 effective `ExpectedRecoveryBasis`（partial unique） |
| 索引 | `(org, claimItemId, occurredAt)`；`(org, providerCaseRefCanonical)`；`(org, status)`（projection） |
| CHECK | `amount >= 0`；`currency ~ '^[A-Z]{3}$'`；`fingerprintVersion = 'v1'`；`providerEventFingerprint ~ '^[0-9a-f]{64}$'`；枚举取值；override 的 `reasonCode` 非空 |
| 租户触发器 | 4 张事实/基准/决策表 + projection 表全部挂 `cc_tenant_*` + `cc_tenant_immutable__*`（除 projection 允许受控更新） |
| append-only | `ProviderOutcomeFact` / `ReimbursementFact` / `ExpectedRecoveryBasis`（允许置 `supersededByBasisId` 的**受控变更**，白名单单列）/ `ReconciliationOverrideDecision` 挂 `cc_append_only__*` |
| 清单同步 | `tools/tenant-triggers/required-triggers.json` 与 `append-only-triggers.json` 同批更新（CI 反向校验） |

## 7. 迁移影响

- 新增迁移（命名沿用 `20261001XX00_reconciliation_*`）：M1 表与枚举 / M2 租户触发器 / M3 projection 受控更新 / M4 append-only / M5 完整性与唯一约束；
- 同步：Prisma 模型计数（architecture-contract）、DOMAIN_MODEL、README 计数、两套触发器清单、`two-stage-upgrade.mjs` 与 CI fresh 路径；
- fresh deploy 与 upgrade path 双路径均需通过（沿用 R43 的验收方式）。

## 8. 明示禁止（本域与后续批次）

不创建 Settlement / Billing / Fee；不改写 RecoveryLedger；不自动向 Amazon 写入；不开启 transport；不使用生产凭据；**不得**把 observed reimbursement 等同可收费 recovered amount；不得把 projection 当成历史事实。

## 9. 请架构方裁决（4 问）

1. **表集合**：上述 5 张表（4 facts/basis/decision + 1 projection）是否一次批准？是否同意 projection **持久化**（便于查询与漂移检测）而非纯内存计算？
2. **容差策略**：是否按 §4 建 `ReconciliationTolerancePolicy`（append-only，缺省 exact）？或 v1 仅用常量 `exact` 并推迟建表？
3. **Expected Basis 写入权限**：`ExpectedRecoveryBasis` 的创建/取代是否需要 `humanApproval` 受保护动作（建议：是，沿用 `recovery.reconciliation_*` 命名风格）？
4. **ProviderOutcomeFact 写入**：`ACCEPTED` / `ACCEPTANCE_REVOKED` 事实在 v1 是否允许人工录入（带证据 + 审批），还是仅允许文件/官方 API 来源？

批准后我提交 **R45-B Implementation Plan**（仍不写代码），再按 S1…Sn 分批实现。
