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

## 五、多租户隔离

- 所有业务表必须带 `organizationId`
- 查询层必须强制注入租户过滤，禁止"先查再判"
- 任何跨租户的读取都是 P0 缺陷
- 文件访问必须经签名 URL + 租户校验，禁止裸 `storageKey` 外泄

---

## 六、Adapter 契约

每个外部平台一个 Adapter，必须实现：

```
authenticate()                      获取/刷新凭据（凭据来自密钥引用）
fetchCapabilities()                 该平台支持哪些追回场景
pullXxx()                           拉取数据（分页、增量、限流）
normalize(raw) → SourceTransaction[]  归一化，保留 raw
submitClaim(claim) → ExternalRef     若支持 API 提交；不支持则返回 NEEDS_MANUAL
```

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
