# R46 S4-A —— Membership 并发边界 Schema Delta / 决策请求

状态：**DECISION REQUEST（未实施）** · 提出时间 2026-10-02 · 提出方 CODEX · 待架构方裁决
依据：MSG-20261002-60 CHANGE B（"真实 PostgreSQL membership 并发证明"；"application-level `activeChain.findFirst`
本身不能作为并发防双计费边界"）。

## 1. 缺证事实（可复现，非推测）

当前 `FeeCalculationSettlement` 上只有触发器 `cc_feecalculationsettlement_chain_unique`
（`apps/api/prisma/migrations/20261001161500_settlement_billing_linkage_invariants/migration.sql` §c），
其语义为 **先查后插**：

```sql
SELECT count(*) INTO dup_count
  FROM "FeeCalculationSettlement" m
  JOIN "FeeCalculation" f ON f."id" = m."feeCalculationId"
 WHERE m."organizationId" = NEW."organizationId"
   AND m."settlementId" = NEW."settlementId"
   AND f."feeChainId" = chain;
IF dup_count > 0 THEN RAISE EXCEPTION 'FEE_CHAIN_SETTLEMENT_ALREADY_CONSUMED' ...
```

两个并发事务在 READ COMMITTED 下各读到 `dup_count = 0` 并一起提交 → **同一 Settlement 在同一个 logical feeChain
内被计费两次**；membership 行上没有 chain 身份列，因此**没有任何唯一约束可兜底**。

实测证据（真实 PostgreSQL，本地容器 `crossclaim-postgres`）：

- `apps/api/src/__tests__/fee-record-db.test.ts` → 用例
  「CHANGE B（缺证：R46 S4-A）：同一 Settlement + 同一 feeChain 两个并发 membership → 数据库层最多一个成功」
  当前 `ok.length = 2`（期望 1），以 `it.fails` 标注；
- 受保护写路径继承同一缺口：`activeChain.findFirst` 与写入之间没有任何数据库边界（check-then-act）。
  该时序**不写成断言用例**（复现依赖两个事务真实交叠，不稳定），因此不作为 CI 证据，只作为设计结论；
  稳定证据是上面两条。

`it.fails` 是**显式缺证标记**：样例通过 = 当前仍然失败；约束落地后该用例会转为"意外通过"，强制实施者把
`it.fails` 改回 `it`（forced flip），并把本文件的缺证段落标记为 CLOSED。

## 2. 影响面（为什么必须回到架构方）

- 这是 **幂等 / 事务 / 并发一致性边界** 的变化（`.autopilot/RULES.md` arch_review_triggers），
  且涉及 **Schema 实质变化** → 需要 Schema Delta 裁决；
- 直接后果是**重复计费**（double billing）→ 触碰成功费链路（`Settlement → RecoveryLedger → FeeCalculation →
BillingInvoice`），属于资金链路边界，不得由 CODEX 自行落地；
- 裁决前 **不修改 Schema、不写 migration**；S4 保持 OPEN，不进入 S5。

## 3. 候选方案

### 方案 A（推荐）：反规范化 chain 身份 + 部分唯一索引

1. `FeeCalculationSettlement` 新增列：
   - `feeChainId TEXT`（写入时由 `FeeCalculation.feeChainId` 反规范化；BEFORE INSERT 触发器校验与父行一致，
     不一致 → `FEE_CHAIN_MISMATCH`）；
2. 部分唯一索引：
   ```sql
   CREATE UNIQUE INDEX "FeeCalculationSettlement_org_chain_settlement_key"
     ON "FeeCalculationSettlement" ("organizationId", "feeChainId", "settlementId")
     WHERE "settlementId" IS NOT NULL AND "feeChainId" IS NOT NULL;
   CREATE UNIQUE INDEX "FeeCalculationSettlement_org_chain_adjustment_key"
     ON "FeeCalculationSettlement" ("organizationId", "feeChainId", "adjustmentId")
     WHERE "adjustmentId" IS NOT NULL AND "feeChainId" IS NOT NULL;
   ```
3. 保留现有触发器作为**补充校验**（错误码语义不变），唯一索引作为**真正的并发边界**；
   `P2002/23505` 必须在服务层收敛为既有错误码（`MEMBERSHIP_CHAIN_CONFLICT` /
   `FEE_CHAIN_SETTLEMENT_ALREADY_CONSUMED`），不得泄漏 raw P2002。
4. 回填：`UPDATE ... FROM "FeeCalculation"` 一次性补齐历史行 `feeChainId`；
   回填前需先跑重复检测（`GROUP BY organizationId, feeChainId, settlementId HAVING count(*) > 1`），
   若历史已有重复，迁移必须显式失败并输出冲突清单，禁止静默去重。
5. 正向对照：**不同 feeChain** 的同一 Settlement 保持允许（`FeeCalculationSettlement` 上不得出现全局
   `UNIQUE(org, settlementId)`）——已由现有 positive control 用例锁定。

### 方案 B（补充，非替代）：受保护写路径序列化

在 `recordFeeCalculation` 的同一事务内，先取 `pg_advisory_xact_lock`（键：organizationId + claimItemId，
或 organizationId + settlementId），再加锁后重读 active chain / membership 再写入。

- 优点：不改 Schema，能收敛"同一 claimItem 的并发双计费"；
- 缺点：只保护**受保护写路径**，对任意直写数据库的代码路径无效；
  与连接池共用时需确认锁在同一连接内取放；
- 结论：可以作为 A 的**纵深防御**，但不能代替唯一约束成为"并发边界"。

## 4. 需要裁决的问题

1. 是否批准 **方案 A**（Schema Delta：新增 `feeChainId` 列 + 两个部分唯一索引 + 回填 + 触发器降级为补充）？
2. 是否同时批准 **方案 B**（受保护写路径 advisory lock 序列化）作为纵深防御？
3. 已冻结不变量复核：`UNIQUE(org, settlementId)` 全局唯一仍然**禁止**（会错误阻断合法 supersession / 新 fee chain）。

## 5. 边界（全程未变）

`BillingInvoice = 0` · `Payment = 0` · 不触发 autopay · `RecoveryLedger` 无变化 ·
R13 Payment Activation Gate 持续 HOLD · `TRANSPORT = false` · 无生产凭据 · 无真实资金动作。
