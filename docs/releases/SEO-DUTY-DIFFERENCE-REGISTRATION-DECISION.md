# SEO DUTY_DIFFERENCE engine 注册判定（MSG-20261005-06 第③项收口）

## 1. 待判定问题

裁决要求：只有在 `customs-drawback` 规则**能够真实解释为** `dutyPaidAmount − dutyActuallyDueAmount` 时，
才允许把 `DUTY_DIFFERENCE` engine 注册进 `seo-public-ports` registry；否则不得为了让 Calculator「有数字」而注册。

## 2. 本次事实核查（可复核）

- 仓库内**没有** `us-customs-drawback` 的种子规则定义：该 slug 只出现在**测试夹具**与**文档**中
  （`apps/api/src/__tests__/*`、`docs/releases/*`），没有任何生产规则定义文件或 seed 脚本。
- 生产规则来自数据库的 `RuleVersion` 行（`prisma.ruleVersion.findMany`，见 `seo-recover-static-cli.ts` /
  `canonical/shadow.ts`），属于**宿主环境数据**，不在仓库内。
- 因此仓库内**无法证实**该规则的 `calculationMethod` 语义就是「已缴 − 应缴」；唯一确定的是它声明了
  `kind: 'DUTY_DIFFERENCE'` 与 `basisKey: 'engine:customs-duty-difference'`（这只是一个标识，不是数学语义证明）。

## 3. 结论（按裁决执行）

```
CUSTOMS_DUTY_DIFFERENCE_SEMANTICS = NOT_CONFIRMED_IN_REPO
DUTY_DIFFERENCE_ENGINE_REGISTRATION = NOT_REGISTERED
PUBLIC_CALCULATOR = UNAVAILABLE（estimate = null）
```

- `seo-public-ports` 的 registry **保持为空** → `listRegisteredBasisKeys()` 为空 →
  indexability gate 继续保守判 noindex；公开 Checker 继续 fail-closed。
- 代码侧已就绪但**不接线**：`seo-public-duty-difference.ts`（差值推导 + point estimate + 无人工区间）、
  `seo-public-engine-schema.ts`（rule-aware 必填）、`seo-public-answer-orchestration.ts`（双 schema 编排）。

## 4. 注册前置条件（明确、可勾选）

1. 存在一份**生效中的** `RuleVersion`，其 `calculationMethod` 能由 `sourceReferences` 支撑为
   「已缴关税 − 应缴关税」的差额语义（不是「用户自报可退额」）；
2. 该语义经架构确认（本裁决已说明只允许真实可溯源的 rate / cap / excluded amount / formula / sourceReference）；
3. 注册只影响 DEV/STAGING 的显式开启路径；`PRODUCTION_PUBLIC_CHECKER` 仍为 HOLD。

满足后只需把 engine 与其 rule-aware schema 注册进 registry（代码已就绪），无需重新设计。

## 5. 边界（本轮零公开行为变更）

`PUBLIC_SEO_CHECKER_ENABLED=false` 默认关闭；未注册即 fail-closed；不产出任何金额；
`EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS / PRODUCTION_PUBLIC_CHECKER = HOLD`；
页面仍 default NOINDEX；`FINAL_ACCEPTANCE_HEAD` 未动。
