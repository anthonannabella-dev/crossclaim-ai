# SI-RSI V2-03 — 免费阶段六态投影与金额语义

> 授权：HOST DIRECTIVE 2026-10-09「CUSTOMS OPPORTUNITY UNLOCK & AUTO-COMMISSION V2」PHASE A。
> 基线：`1c18ceff`（V2-02）。分支：`feat/customs-opportunity-unlock-v2`。

## 1. 交付物

| 文件 | 说明 |
| --- | --- |
| `apps/api/src/services/customs/customs-opportunity-unlock-state.ts` | 六态投影（纯函数，复用 C1/C3/C4/C5 输出） |
| `apps/api/src/__tests__/customs-opportunity-unlock-state.test.ts` | 19 项单测 |

## 2. 状态机（严格顺序判定）

```text
跨租户 / 机会不存在          → NO_DATA（不泄露任何数据）
已取得付费权益               → UNLOCKED
无 C1 事实                   → NO_DATA
缺必需证据 / 未见差异        → NEEDS_EVIDENCE（引导补件，禁止转收费检索）
C4 = NOT_ELIGIBLE            → NOT_ELIGIBLE
C4 = ELIGIBLE + C5 = ESTIMATED + 正金额 → READY_TO_UNLOCK（唯一可见付费入口）
C5 = ESTIMATED（资格未定）    → FREE_ESTIMATED
其余                         → NEEDS_EVIDENCE
```

判定顺序即安全边界：任一前置不成立都不会越过到"可购买"状态。

## 3. 金额语义（PHASE A 硬约束）

| 规则 | 实现方式 |
| --- | --- |
| 不得虚构金额 | 仅当 `C5 = ESTIMATED` 才输出金额；否则 `disclosableByCurrency = []` |
| 只从可追溯事实生成 | 每个金额候选带 `source`（`ESTIMATE`/`DISCREPANCY`/`DRAWBACK_MODEL`）与 `lineRef` |
| 多币种分别显示、禁止汇率换算 | 输出按币种分组；`totalAcrossCurrencies` 恒为 `null`；`appliesFxConversion=false` |
| 不得混淆金额口径 | 投影只输出 `kind` 分列的预估；`billable=false`、`finalAmountDerived=false`、`chargedFee=null` |
| 关税纠错 ≠ Duty Drawback | 两类分列（`dutyCorrection` / `drawback`），不合并、不相互抵减 |
| 同一经济利益不得重复计算 | 同一 `(currency, lineRef)` 只保留一次（`DUTY_CORRECTION` 优先），其余进入 `duplicateBenefitsExcluded` 并附原因码 |
| 金额非法一律剔除 | 0 / 负数 / 非定点数被丢弃；全部丢弃时给出 `NO_DISCLOSABLE_AMOUNT` |

## 4. 免费调用隔离联动

- `NEEDS_EVIDENCE` / `NO_DATA` 分支显式带 `PAID_ESCALATION_FORBIDDEN` 原因码，
  即"事实不足时只引导补件、不得偷偷升级到收费检索"在数据契约层面表达。
- `paidEscalationAllowed` 在**所有**状态下恒为 `false`（类型与运行时双重固定）。
- 本模块不导入 provider，也不发起任何外部调用；金额来源全部是既有 C1/C3/C4/C5 输出。

## 5. 回归结果（本机真实执行）

```text
VITEST  customs-opportunity-unlock-state   19/19 PASS
VITEST  V2 三套件合计                      62/62 PASS
TSC     apps/api --noEmit                  0 error
```

## 6. 仍未证明

```text
HTTP_ROUTE_WIRING=NOT_DONE   投影尚未接入 /customs 与 /customs/unlock/[opportunityId]（属 V2-06）
REAL_PROVIDER=NOT_VERIFIED   Provider 仍未接线（HOLD_EXTERNAL）
POSTGRESQL_IT=NOT_RUN        本机无 PostgreSQL（127.0.0.1:5432 不可达）
```

## 7. 边界自证

`CUSTOMS_OPPORTUNITY_PROJECTION_BOUNDARY`：`externalCallPerformed=false`、`providerInvoked=false`、
`chargedAmount=null`、`paymentCaptured=false`、`autoCollectionEnabled=false`、`billable=false`、
`appliesFxConversion=false`、`productionCredentials='ABSENT'`。未新增调度器 / Runtime，
未触碰 `main` / release 分支 / U1 封板代码。
