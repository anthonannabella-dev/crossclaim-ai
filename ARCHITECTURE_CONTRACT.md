# ARCHITECTURE_CONTRACT —— CrossClaim 架构契约

本文件是**不可违反**的架构约定。任何 PR 若违反，应被 `BLOCK`。

---

## 一、分层与边界

| 层 | 职责 | 不得做的事 |
|---|---|---|
| **Adapter 层** | 对接外部平台/承运商（Amazon SP-API、UPS/FedEx/DHL、聚合物流 API、海关数据） | 不得把平台规则写进业务逻辑 |
| **Ingest 层** | 文件/接口数据进入系统：`FileAsset` → `ImportBatch` → `SourceTransaction` | 不得直接产出金额结论 |
| **Normalize 层** | 把各家字段归一化为内部模型 | 不得丢失原始行（`raw` 必须保留） |
| **Rule Engine** | 确定性规则评估 → `RuleEvaluation` → `RecoveryOpportunity` | 不得调用 LLM 决定金额 |
| **Domain 层** | Opportunity → Graph → Evidence → Case → Route → Claim/Appeal | 不得绕过状态机 |
| **Money 层** | `Settlement` / `RecoveryLedger` / `BillingInvoice` / `FeeCalculation` | 账本只增不改 |
| **AI 层** | 文档理解、抽取、解释、推荐、文本起草 | 不得写账本、不得定金额、不得改状态 |

---

## 二、不可违反的领域规则（17 条）

1. `RecoveryOpportunity` 是系统核心业务实体。
2. `SourceTransaction` 与 `RecoveryLedger` **必须严格分离**。
3. 原始账单、订单、Invoice **不允许**直接变成 `RecoveryLedger`。
4. `Settlement` 只表示客户**实际收到**的退款、Credit、补偿或到账。
5. CrossClaim 自己向客户收费属于 `Billing`。
6. `Billing` 与 `Settlement` **必须分开**（两笔钱方向相反，禁止混表）。
7. `FileAsset` **不等于** `Evidence`。
8. `Evidence` 必须支持**一份证据服务多个 Case**。
9. `RecoveryGraph` 第一版用 **PostgreSQL Node + Edge 表**实现。
10. **不引入 Neo4j**，除非后期有明确必要并经架构审计。
11. 金额、佣金、Deadline、账本结果**不能由 LLM 决定**。
12. 金额类逻辑必须使用确定性代码、SQL 或 Rule Engine。
13. AI 负责：文档理解、字段抽取、异常解释、证据推荐、案件总结、Claim 文本、Appeal 文本、非结构化判断。
14. 外部平台必须通过 **Adapter** 接入。
15. 平台规则**不得硬编码**在业务逻辑中。
16. `RuleVersion` 至少包含：`source`、`version`、`effective_from`、`effective_to`、`last_verified`。
17. 规则优先级：客户合同 > 客户 Rate Card / Amendment > 官方 Carrier Tariff > 日期对应政策 > 默认规则。

---

## 三、金额与账本的不可逆约

### 3.1 三种钱，三个地方

| 钱的方向 | 载体 | 含义 |
|---|---|---|
| 平台/承运商 → 客户 | `Settlement` + `RecoveryLedgerEntry` | 客户被少给的钱，追回来了 |
| 客户 → CrossClaim | `BillingInvoice` + `FeeCalculation` | CrossClaim 的成功费 |
| 原始发生过什么 | `SourceTransaction` | **只读的事实记录**，不是结论 |

**禁止**：从 `SourceTransaction` 直接生成 `RecoveryLedgerEntry`。
必须经过：`SourceTransaction` → `RuleEvaluation` → `RecoveryOpportunity`
→ `Case` → `Claim` → `Settlement` → `RecoveryLedgerEntry`。

### 3.2 账本只增不改

`RecoveryLedgerEntry` 写入后**不可更新**。纠错通过 `REVERSAL` 反向分录 +
`voidsEntryId` 表达。任何 `UPDATE` 账本金额的代码都是审计事故。

### 3.3 成功费可复算

`FeeCalculation.computation` 必须存下计算依据与中间量，
使任何一笔费用都能在事后被独立复算。

---

## 四、确定性边界（AI 不许越界）

```
允许 AI 做                     禁止 AI 做
─────────────────────────     ─────────────────────────
文档理解 / 字段抽取             决定金额、佣金、费率
异常解释 / 责任方建议           决定 Deadline
证据推荐                       写 RecoveryLedger
案件总结                       改 Case / Claim 状态
Claim / Appeal 文本草稿        直接对外提交
```

**AI 输出一律落到"建议字段"**（如 `Case.aiSummary`、`Claim.aiDraftText`），
并且：

- 对外提交（Claim/Appeal）**必须有人工确认卡口**
- AI 产出不得作为账本或结算的依据

---

## 五、多租户隔离（两层强制）

### 5.1 应用层

- 所有 tenant-owned 表必须显式带 `organizationId`
- 查询层必须强制注入租户过滤，禁止"先查再判"
- 任何跨租户的读取都是 P0 缺陷
- 文件访问必须经签名 URL + 租户校验，禁止裸 `storageKey` 外泄
- `RuleSet` 的全局规则（`SYSTEM`）普通租户**不可修改**，只能被继承或被租户级规则覆盖

### 5.2 数据库层（不可绕过）

**"引用对象必须属于同一租户"由数据库强制，不只靠应用层约定。**

实现方式（为什么不是 Prisma 复合外键）：

- Prisma 的复合外键要求 FK 字段全部可空，而 `organizationId` 不可空 —— 二者冲突
- 因此采用**等价数据库级约束**：一个通用触发器函数 + 按表挂触发器

| 对象 | 位置 |
|---|---|
| 校验函数 | `crossclaim_assert_tenant_integrity()` |
| 迁移 | `apps/api/prisma/migrations/20260928060000_tenant_integrity/migration.sql` |
| 覆盖范围 | 17 张有跨表引用的 tenant-owned 表 |

另有两类**规则所有权**约束同属本层（`20260928070000_tenant_integrity_fixes`）：

- `RuleSet` 的 `ownerType / ownerKey / organizationId` 组合由 CHECK 约束强制自洽
- `RuleVersion` 必须与所属 `RuleSet` 的租户归属一致（禁止全局版本指向租户规则集）

规则：行的 `organizationId` 必须与被引用行的 `organizationId` 相同，否则抛 `check_violation`。

**维护要求**：新增 tenant 相关外键时，必须同步在对应 trigger 的 `TG_ARGV` 中补一对参数，
否则该外键不受保护。架构契约测试会校验触发器覆盖的清单。

### 5.3 幂等

- `SourceTransaction.dedupeKey` + `@@unique([organizationId, dedupeKey])`：
  同一行重复导入不得产生第二条交易，进而不得重复产出机会
- `RuleEvaluation.dedupeKey`：同一交易 + 同一规则版本不得重复评估

### 5.4 验证方式

租户隔离与幂等属于**数据库行为**，必须由真实数据库测试证明，
不能用 schema 文本检查代替。见 `apps/api/src/__tests__/tenant-isolation.test.ts`。

---

## 六、Adapter 契约

每个外部平台一个 Adapter。**Phase 1 的活跃接口是只读的**：

```
ExternalAdapter（Phase 1 唯一活跃接口，只读）
  capabilities()                    该平台支持哪些追回场景 / domain / channel / 分页上限
  authenticate(credentialRef)       获取/刷新凭据（凭据只以引用名出现）
  pull(request, session)            拉取数据（分页、增量、限流）
  → 输出规范导入格式（canonical ingest format），保留 raw 作为证据
```

**第三方写入不属于 Phase 1 的 ExternalAdapter**：

- `ExternalWriteAdapter`（`submitClaim`）当前**禁止启用**，注册表拒绝注册带写入面的适配器，
  提交闸门 `submitClaimThroughAdapter()` 永不调用第三方方法，统一返回 `NEEDS_MANUAL`
- 自动 Claim / Appeal 提交必须重新走架构审计后才能开启

> 2026-09-28 架构方裁定（C-0003 Checkpoint 2 / CHANGE #28、#37）：本节由「每个 Adapter 必须实现
> `submitClaim`」改为上面的只读接口 + 独立写入面，代码与测试同步。

**Phase 1 策略**：优先 **只读 API + 文件上传**，
「向平台要钱」这一步保留**半自动卡口**（生成规范文本，人工提交），
以规避账号风控风险。详见 `PRODUCT_SPEC.md`。

---

## 七、规则治理

- 规则是**数据**（`RuleSet` / `RuleVersion`），不是代码常量
- 每个 `RuleVersion` 必须可追溯到来源（合同编号 / 官方公告 / 费率表版本）
- 规则必须有 `last_verified`：**会过期的规则必须能看出来**
- 规则变更必须留 `AuditLog`

---

## 八、变更本文件

修改本文件属于**架构变更**，必须：

1. 在 `AI-BRIDGE` Issue 发起 `TYPE: ARCHITECTURE`
2. 获得 `PASS`
3. 在 PR 中同步更新 `DOMAIN_MODEL.md` 与相关代码
