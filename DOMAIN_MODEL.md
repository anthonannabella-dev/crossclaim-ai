# DOMAIN_MODEL —— CrossClaim 领域模型

权威定义在 [`apps/api/prisma/schema.prisma`](./apps/api/prisma/schema.prisma)。
本文件解释**为什么这样建**，以及哪些不变量必须守住。

---

## 一、模型总览（34 个 = 32 个核心模型 + 2 个联结模型）

> **口径统一**：**29 个核心模型**（架构章程 §六 的清单 + C-0006-A 的 `CanonicalFact` + C-0006-B1 的 `RuleEvaluationShadow` + C-0008-A 的 `Session`、`UserInvitation`）**+ 2 个联结模型 `CaseEvidence`、`CanonicalFactSource`**。
> README、本文、PR 描述、架构契约测试全部按此口径，不允许 29/31 混用。
>
> 身份域（`Session` / `UserInvitation`）**不挂 cc_tenant_* 数据库触发器**：租户边界由应用层 Membership 复核 + 审计承担（C-0008-A 裁定）。

### 组织与用户

| 模型 | 说明 |
|---|---|
| `Organization` | 企业（多租户根）。所有 tenant-owned 表挂 `organizationId` |
| `User` | 用户（登录主体） |
| `Membership` | 用户 ↔ 企业的成员关系与角色 |
| `Session` | C-0008-A 服务端会话（只存 tokenHash；绝对 12h + 空闲 30m；租户边界靠 Membership 复核） |
| `UserInvitation` | C-0008-A 邀请制入口（无公开注册；tokenHash + expiresAt + attemptCount） |

### 数据进入系统

| 模型 | 说明 |
|---|---|
| `SourceConnection` | 数据源连接（文件上传 / API / SFTP…）。只存**凭据引用** |
| `FileAsset` | 原始文件资产（字节 + 元数据 + sha256）。**不是 Evidence** |
| `ImportBatch` | 每次导入的批次留痕，含字段映射快照 |
| `SourceTransaction` | 原始业务交易（账单行 / 订单行 / 运单行）。**只读事实** |

### 业务事实层（C-0006-A）

| 模型 | 说明 |
|---|---|
| `CanonicalFact` | 统一后的业务事实（金额 / 币种 / 日期 / 外部引用 + 来源计数）。`status=ACTIVE` 才能进入检测；`CONFLICT` 只进审计与对账复核 |
| `CanonicalFactSource` | 事实 ↔ 原始行（`SourceTransaction`）的联结，保存来源类型快照与 `observedAt`；原始数据永不丢失 |

> 相同业务事实可以同时来自 FILE_UPLOAD 与 API：两条原始行都保留，只计 1 个 ACTIVE 事实；
> 数值冲突 → `CONFLICT` fail closed，禁止进入 Detection / RuleEvaluation / RecoveryOpportunity。

### 核心业务实体

| 模型 | 说明 |
|---|---|
| `RecoveryOpportunity` | **系统核心实体**：这里可能有一笔钱可以追 |

### 图

| 模型 | 说明 |
|---|---|
| `RecoveryGraphNode` | 追回图节点（多态引用任意实体） |
| `RecoveryGraphEdge` | 追回图关系（CAUSES / DUPLICATES / RESPONSIBLE_FOR 等） |

### 证据

| 模型 | 说明 |
|---|---|
| `EvidenceArtifact` | 证据材料（文件型或外部链接型） |
| `EvidenceEdge` | 证据之间的关系（SUPPORTS / REFUTES / CONTEXT_FOR） |

### 案件与路由

| 模型 | 说明 |
|---|---|
| `Case` | 追回案件，承载状态机与 Temporal 工作流引用 |
| `CaseOpportunity` | 案件 ↔ 机会（多对多） |
| `RecoveryRoute` | 追回路由：这笔钱该向谁要 |

> `RouteTarget` 含 `INSURER`（保险公司）与 `CUSTOMS_AUTHORITY`（海关当局），
> `Channel` 含 `INSURANCE`，`SettlementSource` 含 `INSURER_PAYOUT`。
> **三个追回域从第一版起就可表达**，不必等到 Wave 6 再改枚举与迁移。

### 申诉与复议

| 模型 | 说明 |
|---|---|
| `Claim` | 首次申诉 / 索赔 |
| `Appeal` | 复议 |

### 规则引擎

| 模型 | 说明 |
|---|---|
| `RuleSet` | 规则集（按域 + 渠道 + 作用域；支持全局与租户两种所有权） |
| `RuleVersion` | 规则版本（tier / source / version / effective / last_verified / definition） |
| `RuleEvaluation` | 规则计算结果（含 `dedupeKey` 幂等键） |
| `RuleEvaluationShadow` | C-0006-B 影子评估结果（`runId` + `engineVersion`，绑 `CanonicalFact`）。**只写结论**，不创建 Opportunity / Case / Settlement，绝不进入资金链 |

### 到账与账本

| 模型 | 说明 |
|---|---|
| `Settlement` | **客户实际收到的钱**（平台 credit / 承运商 credit / 银行到账 / 抵扣） |
| `RecoveryLedgerEntry` | 追回账本分录。**只增不改**，纠错用 REVERSAL |

### 收费

| 模型 | 说明 |
|---|---|
| `BillingInvoice` | CrossClaim 向客户开的收费单，**与 Settlement 分离** |
| `FeeCalculation` | 成功费计算（费率快照 + 可复算的中间量） |

### 审计

| 模型 | 说明 |
|---|---|
| `AuditLog` | 全链路留痕（actorType：USER / SYSTEM / AI / EXTERNAL） |

### 联结模型

| 模型 | 说明 |
|---|---|
| `CaseEvidence` | 案件 ↔ 证据的多对多联结（复合主键） |

---

## 二、四条最容易搞错的不变量

### 1. `FileAsset` ≠ `EvidenceArtifact`

同一个 PDF：作为"上传的文件"是 `FileAsset`；作为"这个案件的费率依据"是 `EvidenceArtifact`。
前者是字节，后者是**语义**。混为一谈会导致"上传即证据"的错误默认，
以及一份证据无法服务多个案件。

### 2. `SourceTransaction` ≠ `RecoveryLedgerEntry`

前者是"账单上写了什么"，后者是"我们认定该收多少、实际到账多少"。
`SourceTransaction` 表里**没有任何指向账本的外键**——这是刻意的物理隔离（§七.3）。
唯一的溯源路径是：

```
SourceTransaction → RuleEvaluation → RecoveryOpportunity
  → CaseOpportunity → Case → Claim → Settlement → RecoveryLedgerEntry
```

### 3. `Settlement` ≠ `BillingInvoice`

两笔钱方向相反：平台/承运商把钱退给客户（Settlement），CrossClaim 向客户收成功费（Billing）。
放一张表会立刻产生"负营收"这类统计灾难。

### 4. 证据与案件是多对多

`CaseEvidence` 是联结表，不是 `Case` 的从属字段。
一份承运商费率表会被几十个案件同时引用。

---

## 三、状态机

### Opportunity

```
DETECTED → QUALIFIED → CONVERTED
         ↘ REJECTED（必须写 rejectedReason）
         ↘ EXPIRED（超过 claimDeadline）
```

### Case

```
OPEN → COLLECTING_EVIDENCE → READY_TO_CLAIM → CLAIMED
  ↑                                              ↓
  └────────────── APPEALING ←────────────────────┘
                     ↓
        WON / PARTIALLY_WON / LOST → SETTLED → CLOSED
```

### Claim / Appeal

```
DRAFT → SUBMITTED → ACKNOWLEDGED →
   APPROVED / PARTIALLY_APPROVED / REJECTED / NO_RESPONSE
```

状态跃迁必须留 `AuditLog`，且**不得由 AI 触发**。

---

## 四、租户隔离（两层强制）

### 4.1 应用层

- 每个 tenant-owned 模型显式带 `organizationId`
- 每个 tenant-owned 模型带 `@@unique([organizationId, id])`（复合键基础）
- 查询必须注入租户过滤

### 4.2 数据库层（不可绕过）

"引用对象必须同租户"由**数据库触发器**强制，不只靠应用层约定。

为什么不是 Prisma 复合外键：Prisma 要求复合外键的 FK 字段全部可空，
而 `organizationId` 不可空，二者冲突；因此采用架构契约允许的
**等价数据库级约束**。

| 对象 | 位置 |
|---|---|
| 校验函数 | `crossclaim_assert_tenant_integrity()` |
| 迁移 | `20260928060000_tenant_integrity/migration.sql` |
| 覆盖 | **17 张**有跨表引用的 tenant-owned 表 |

另外两类**规则所有权**约束（同属数据库级强制）：

| 约束 | 内容 |
|---|---|
| `cc_ruleset_ownership_check` | `RuleSet`：`SYSTEM` ⇒ `organizationId IS NULL` 且 `ownerKey='GLOBAL'`；`TENANT` ⇒ `organizationId IS NOT NULL` 且 `ownerKey=organizationId` |
| `cc_ruleversion_ownership` | `RuleVersion` 必须与所属 `RuleSet` 的租户归属一致；禁止全局 `RuleVersion` 指向租户 `RuleSet` |

**新增 tenant 相关外键时**，必须同步在对应 trigger 的 `TG_ARGV` 补一对参数，
否则该外键不受保护（架构契约测试会校验覆盖清单）。

### 4.3 幂等

| 模型 | 幂等键 | 作用 |
|---|---|---|
| `SourceTransaction` | `@@unique([organizationId, dedupeKey])` | 同一账单/运单行重复导入不产生第二条交易 |
| `RuleEvaluation` | `dedupeKey` | 同一交易 + 同一规则版本不重复评估 |

`dedupeKey` 生成建议：
`sha256(organizationId | connectionId | referenceType | externalId | rowFingerprint)`，
其中 `rowFingerprint` 取原始行归一化后的稳定指纹。

---

## 五、规则的所有权（全局 vs 租户）

| 字段 | 说明 |
|---|---|
| `ownerType` | `SYSTEM`（官方 Tariff / 政策 / 默认规则）或 `TENANT`（客户合同 / Rate Card） |
| `organizationId` | 租户规则填租户；**全局规则为空** |
| `ownerKey` | 归一化键：租户 id 或字面量 `GLOBAL` |

**为什么需要 `ownerKey`**：PostgreSQL 唯一索引不约束 `NULL`，若直接用
`@@unique([organizationId, channel, scope, name])`，全局规则之间无法保证唯一。
用 `ownerKey` 归一化后，`@@unique([ownerKey, channel, scope, name])` 同时约束两类规则。

**权限**：`ownerType=SYSTEM` 的规则普通租户**不可修改**，只能继承或被租户级规则覆盖。

优先级不变：客户合同 > 客户 Rate Card > 官方 Tariff > 日期政策 > 默认规则。

---

## 六、图节点的引用规则

| 项 | 规定 |
|---|---|
| 唯一性 | `@@unique([organizationId, nodeType, refId])` —— 同租户同类型同引用只能有一个节点 |
| 允许成为节点的实体 | `ORGANIZATION` → `Organization`；`CHANNEL` → `SourceConnection`；`ACCOUNT` → 外部账号标识；`SHIPMENT` / `INVOICE` → `SourceTransaction`；`OPPORTUNITY` → `RecoveryOpportunity`；`CASE` → `Case`；`CLAIM` → `Claim`；`SETTLEMENT` → `Settlement` |
| 删除策略 | 节点随 Organization 级联删除；**被引用的业务实体删除时节点不自动删除**，需应用层显式清理并写 `AuditLog`（保留图谱历史） |
| 跨租户 | 边的两端必须同租户 —— 由数据库触发器强制 |

---

## 七、到账与收费的可追溯链

```
Settlement（客户实际到账，可关联 EvidenceArtifact 佐证）
    ↓
FeeCalculation（费率快照 + computation 中间量，可独立复算）
    ↓
BillingInvoice（CrossClaim 向客户开票）
```

- `Settlement.evidenceId` 是指向 `EvidenceArtifact` 的**真实关系**，不允许悬空
- `FeeCalculation` 同时真实关联 `Settlement` / `Case` / `BillingInvoice`

---

## 八、与旧项目模型的对应关系

旧项目 `E:\zhuihuiweikuan-saas` 中曾有一批早期追回模型
（`LossSignal` / `RecoveryCase` / `CaseSignal` / `ChannelAccount` 等）。
**它们不作为本仓库基准**，只作字段设计参考。

| 旧项目 | 本仓库 |
|---|---|
| `LossSignal` | `RecoveryOpportunity` |
| `RecoveryCase` | `Case` |
| `Evidence` | `EvidenceArtifact`（且必须支持多案件） |
| `RecoveryLedgerEntry` | `RecoveryLedgerEntry`（概念一致） |
| `ImportBatch` | `ImportBatch`（保留） |
| `ChannelAccount` | `SourceConnection` |
| `Claim` / `CaseSignal` | `Claim` / `CaseOpportunity` |
| （无） | `RecoveryGraph*` / `EvidenceEdge` / `RecoveryRoute` / `RuleSet` / `RuleVersion` / `RuleEvaluation` / `Settlement` / `BillingInvoice` / `FeeCalculation` |

详见 `LEGACY_MIGRATION_AUDIT.md` §5 与 §16.1。

---

## 九、迁移约定

- 所有迁移**必须可重复执行**，破坏性 DDL 必须显式说明
- 每次 schema 变更必须同步更新本文件
- fresh clone 必须能跑通：`apps/api` → `npm ci` → `npx prisma migrate deploy`
- **CI 会在全新 PostgreSQL 上真实执行迁移**，并校验 20 个租户触发器存在

当前迁移：

| 迁移 | 内容 |
|---|---|
| `20260928055802_init` | Gate 0 领域模型结构（31 = 29 核心 + 2 联结） |
| `20260928060000_tenant_integrity` | 租户完整性触发器（16 张表） |
| `20260928070000_tenant_integrity_fixes` | C-0002 CHANGE #13/#14：BillingInvoice 租户触发器 + RuleSet/RuleVersion 所有权约束 |
| `20260928080000_audit_actor_identity` | C-0003 CHANGE #16：审计 actor 身份拆分（actorType / actorUserId / actorRef） |
| `20260928090000_audit_tenant_closure` | C-0003 CHANGE #24：审计租户闭合（actor 必须是该租户的成员） |
| `20260928100000_audit_actor_identity_required` | C-0003 CHANGE #27：actor 身份必填（触发器总数为 19） |
| `20260928120000_canonical_fact_layer` | C-0006-A：CanonicalFact / CanonicalFactSource（纯增量） |
| `20260928130000_rule_evaluation_shadow` | C-0006-B1：RuleEvaluationShadow（runId + engineVersion） |
| `20260928140000_rule_evaluation_identity_prepare` | C-0006-B2 Step 1：canonicalDedupeKey + 可空唯一约束 |
| `20260928150000_customer_foundation_auth` | C-0008-A：Session / UserInvitation / User.passwordChangedAt |
| `20260929010000_payment_domain` | C-0010-A：Payment / PaymentEvent（客户支付事实；+1 租户触发器） |

---

## 支付执行不变量（C-0010-B2）

```text
I1  SUCCEEDED 的执行尝试必须带 paymentId（不允许「成功但没有资金事实」）
I2  SUCCEEDED 的执行尝试不可改写：status / paymentId / paymentEventId 均不可变更
I3  一笔 Payment 最多一个成功执行来源（SUCCEEDED + paymentId 上的部分唯一索引）
```

- 三层保护：应用层 CAS（只收口 RUNNING 的尝试）→ 数据库 CHECK（I1）→ BEFORE UPDATE 触发器（I2）
- `PaymentEvent`（入站事实）与 `PaymentProcessingAttempt`（执行历史）都是 append-only，职责不重叠：
  前者回答「provider 说了什么」，后者回答「我们这次执行结果如何」
- 同一事件同一时刻只允许一个进行中的执行尝试（PENDING / RUNNING 上的部分唯一索引）
- 上述约束与 provider 无关：未来接入 Stripe / PayPal 等其他支付方时同样适用

## 角色与权限（C-0008-B1，架构方批准）

| 角色 | 连接写 | 机会复核 | 建案 | Claim 正文 | Claim 金额 | Billing 查看 | Billing 推进 |
|---|---|---|---|---|---|---|---|
| OWNER | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| ADMIN | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| OPS | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| FINANCE | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| VIEWER | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

- 唯一实现：`apps/api/src/services/workflow/permissions.ts`；未知 / 空角色 fail closed（全部拒绝）。
- 连接**读取**当前与「连接写」同权限（OWNER / ADMIN）；是否给 OPS 只读仍待架构方裁定（已列入 C-0008-B1 Checkpoint 的 QUESTIONS）。
- 用户触发的一切状态变化必须与 AuditLog 同事务写入（`actorType=USER` + `actorUserId`）；Web 层不做本地授权。
- 机会人工复核只允许 `DETECTED → QUALIFIED` 与 `DETECTED → REJECTED`（拒绝必须带批准词表的 reason）；`DETECTED → CONVERTED` 只能由 Recovery Closure 建案流程触发。
