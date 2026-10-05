# BG-011 PS04 D1–D3 枚举迁移 —— 架构审计请求（Audit Pack）

- 请求时间：2026-10-05T03:27:57.495Z；**REVIEWED_HEAD = `5d809039`**（branch `gate/7-commercial-validation`）
- 背景：MSG-20261003-133 Q1 仅批准 D1–D3 枚举。宿主要求本项立即送审；本文件即耐久记录（本机 gh token 失效，audit 通道用仓库文件 + 右侧 ChatGPT 会话）。

## 1. scope（严格限定）

仅枚举扩展，**且不含 D4、不改动其它 Schema**：

```sql
-- apps/api/prisma/migrations/20261003200000_ps04_enum_d1_d3/migration.sql
ALTER TYPE "RecoveryDomain" ADD VALUE IF NOT EXISTS 'INDEPENDENT_SITE';
ALTER TYPE "Channel" ADD VALUE IF NOT EXISTS 'SHOPIFY';
ALTER TYPE "Channel" ADD VALUE IF NOT EXISTS 'STRIPE';
ALTER TYPE "Channel" ADD VALUE IF NOT EXISTS 'PAYPAL';
ALTER TYPE "RouteTarget" ADD VALUE IF NOT EXISTS 'PAYMENT_PROCESSOR';
```

## 2. invariant（本次需要确认的不变量）

1. 只做**加法**：`ADD VALUE IF NOT EXISTS`，不删值、不改名、不做数据搬运；
2. 覆盖恰好为 D1–D3 五项：`RecoveryDomain += INDEPENDENT_SITE`；`Channel += SHOPIFY / STRIPE / PAYPAL`；`RouteTarget += PAYMENT_PROCESSOR`；
3. **不包含 D4**，也不引入任何新表/新列；
4. 业务代码在使用新枚举值前必须先完成本迁移（PS04 Phase 1 只读链另见 BG-010/BG-018 证据）；
5. 迁移可从空库执行（CI 路径：`prisma migrate deploy` on fresh database）。

## 3. tests（已有证据）

- `apps/api/src/__tests__/architecture-contract.test.ts` → **142/142 PASS**（本地实测，退出码 0）；
- 迁移已在仓库存在并被 CI 的空库 `migrate deploy` 路径覆盖（本批之前的多次 hosted CI 均 success）；
- 相关只读链证据：BG-018（independent-site 34 例）与 BG-021 的事实层 DB 不变量均已复核通过。

## 4. schema delta

| 枚举 | 变更 | 说明 |
| --- | --- | --- |
| `RecoveryDomain` | `+ INDEPENDENT_SITE` | 域扩展，纯加法 |
| `Channel` | `+ SHOPIFY` `+ STRIPE` `+ PAYPAL` | 渠道扩展，纯加法 |
| `RouteTarget` | `+ PAYMENT_PROCESSOR` | 路由目标扩展，纯加法 |

无表结构变更、无列变更、无索引变更、无数据回填。

## 5. requested verdict

1. 是否可记 **BG-011 = COMPLETED / CLOSED**（D1–D3 已落地且 CI 空库路径通过）？
2. 是否同意「D4 仍未批准、不得顺带实施」的边界？
3. 若仍需补充证据，请只列**最小集合**（例如需要 `migrate status` 输出或空库回放日志）。

## 6. 边界声明（不变）

```
EXTERNAL_WRITE = HOLD
PAYMENT = HOLD
TRANSPORT = HOLD
PRODUCTION_CREDENTIALS = HOLD
FINAL_ACCEPTANCE_HEAD = 0f7f7ac（未动）
```
