# DOMAIN_MODEL —— CrossClaim 领域模型

权威定义在 [`apps/api/prisma/schema.prisma`](./apps/api/prisma/schema.prisma)。
本文件解释**为什么这样建**，以及哪些不变量必须守住。

---

## 一、模型总览（25 个）

### 组织与用户

| 模型 | 说明 |
|---|---|
| `Organization` | 企业（多租户根）。所有业务表挂 `organizationId` |
| `User` | 用户（登录主体） |
| `Membership` | 用户 ↔ 企业的成员关系与角色 |

### 数据进入系统

| 模型 | 说明 |
|---|---|
| `SourceConnection` | 数据源连接（文件上传 / API / SFTP…）。只存**凭据引用** |
| `FileAsset` | 原始文件资产（字节 + 元数据 + sha256）。**不是 Evidence** |
| `ImportBatch` | 每次导入的批次留痕，含字段映射快照 |
| `SourceTransaction` | 原始业务交易（账单行 / 订单行 / 运单行）。**只读事实** |

### 核心业务实体

| 模型 | 说明 |
|---|---|
| `RecoveryOpportunity` | **系统核心实体**：这里可能有一笔钱可以追 |

### 图

| 模型 | 说明 |
|---|---|
| `RecoveryGraphNode` | 追回图节点（多态引用任意实体） |
| `RecoveryGraphEdge` | 追回图关系（CAUSES / DUPLICATES / RESPONSIBLE_FOR…） |

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
| `RecoveryRoute` | 追回路由：这笔钱该向谁要（平台 / 承运商 / 货代 / 保险 / Broker） |

### 申诉与复议

| 模型 | 说明 |
|---|---|
| `Claim` | 首次申诉 / 索赔 |
| `Appeal` | 复议 |

### 规则引擎

| 模型 | 说明 |
|---|---|
| `RuleSet` | 规则集（按域 + 渠道 + 作用域） |
| `RuleVersion` | 规则版本（tier / source / version / effective / last_verified / definition） |
| `RuleEvaluation` | 规则计算结果（含 `dedupeKey` 幂等键） |

### 到账与账本

| 模型 | 说明 |
|---|---|
| `Settlement` | **客户实际收到的钱**（平台 credit / 银行到账 / 抵扣） |
| `RecoveryLedgerEntry` | 追回账本分录。**只增不改**，纠错用 REVERSAL |

### 收费

| 模型 | 说明 |
|---|---|
| `BillingInvoice` | CrossClaim 向客户开的收费单，**与 Settlement 分离** |
| `FeeCalculation` | 成功费计算（费率快照 + 可复算的中间量） |

### 审计

| 模型 | 说明 |
|---|---|
| `AuditLog` | 全链路留痕（含 actorType：USER / SYSTEM / AI / EXTERNAL） |

---

## 二、四条最容易搞错的不变量

### 1. `FileAsset` ≠ `EvidenceArtifact`

同一个 PDF：作为"上传的文件"是 `FileAsset`；作为"这个案件的费率依据"是 `EvidenceArtifact`。
前者是字节，后者是**语义**。混为一谈会导致：一份证据无法服务多个案件、
以及"上传即证据"这种错误默认。

### 2. `SourceTransaction` ≠ `RecoveryLedgerEntry`

前者是"账单上写了什么"，后者是"我们认定该收多少钱、以及实际到账多少"。
`SourceTransaction` 表里**没有任何指向账本的外键**——这是刻意的物理隔离（章程 §七.3）。

### 3. `Settlement` ≠ `BillingInvoice`

两笔钱方向相反：平台把钱退给客户（Settlement），CrossClaim 向客户收成功费（Billing）。
把它们放一张表会立刻产生"负营收"之类的统计灾难。

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

**状态跃迁必须留 `AuditLog`**，且不得由 AI 触发。

---

## 四、与旧项目模型的对应关系

旧项目 `E:\zhuihuiweikuan-saas` 中曾出现过一批早期追回模型
（`LossSignal` / `RecoveryCase` / `CaseSignal` / `ChannelAccount` / `ImportBatch` 等）。
**它们不作为本仓库的基准**，只作字段设计参考。对应关系：

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

## 五、迁移约定

- 所有迁移**必须可重复执行**，且不得包含破坏性 DDL 而不说明
- 每次 schema 变更必须同时更新本文件
- 迁移前必须能在 fresh clone 上跑通：`apps/api` → `npm ci` → `npx prisma migrate deploy`
