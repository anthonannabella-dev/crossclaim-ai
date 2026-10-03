# CARRIER QUEUE #8 FINAL — CLAIM-READY PACKAGE COMPLETENESS SEMANTICS CHECKPOINT

状态：**READY_FOR_REVIEW**（estimate only；不提交索赔、不算成功费、不做 FX）
前序：MSG-20261003-116 = REVISE-MINOR（唯一剩余 = PACKAGE COMPLETENESS MUST RESPECT PARTIAL ESTIMATE BASIS / BLOCKERS）。
IMPLEMENTATION_HEAD = 760c41a（full 760c41abaed7efc546a9a955a7196562ce955632）；CI = SUCCESS · RUN_ID = 37096150327
边界：**NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据**。

## 1. CHANGE A（⑱）— COMPLETE 要求 estimate basis 完整

- 旧行为：`allEstimated` 只检查 `status === ESTIMATED`，因此 `status = ESTIMATED` + `estimateBasis = PARTIAL_PROVIDER_RULE_BASIS` + `blockers = [UNKNOWN_CHARGE_ELIGIBILITY_EXCLUDED]` 的保守估算仍会把 package 标成 COMPLETE —— 把「有可用的保守下界估算」误表达成「claim-ready package 金额基础已完整」。
- 现行：`allEstimateBasisComplete = estimatesByCurrency.length > 0 && every(status === ESTIMATED && estimateBasis === COMPLETE_RULE_BASIS && blockers.length === 0)`；`packageCompleteness = (!bundleMismatch && bundle.completeness === COMPLETE && eligibility.decision === ELIGIBLE && allEstimateBasisComplete) ? COMPLETE : PARTIAL`。

## 2. ⑲⑳㉑ 语义规则与 invariant

- **⑲**：ANY `estimateBasis = PARTIAL_PROVIDER_RULE_BASIS` → `packageCompleteness = PARTIAL`（仍存在 provider-rule uncertainty）。
- **⑳** invariant：`packageCompleteness = COMPLETE` → `blockers.length === 0`（反之不必然；COMPLETE 不携带 unresolved blocker）。
- **㉑**：estimate 本身**仍可**是 `ESTIMATED` + `PARTIAL_PROVIDER_RULE_BASIS`（含义：有保守估算但公式不完整），未改判成 `MISSING_AMOUNT_BASIS`。
- **㉒**：`COMPLETE_RULE_BASIS`（如 BASE INCLUDED + DUTY_TAX definitively EXCLUDED、无 UNKNOWN、blockers 为空）+ bundle COMPLETE + eligibility ELIGIBLE → package COMPLETE 可接受。
- **㉓** 多币种聚合：任一 currency 为 PARTIAL_PROVIDER_RULE_BASIS → 整个 package PARTIAL（不因每个 currency 都是 ESTIMATED 就 COMPLETE）；全部 complete → COMPLETE。

## 3. 未改动（㉕ 不重做）

ELIGIBLE-only amount rule / null semantics（NOT_ELIGIBLE、BLOCKED_INDETERMINATE、MISSING_AMOUNT_BASIS）/ charge classification（BASE INCLUDED、DUTY_TAX EXCLUDED、其余 UNKNOWN 保守排除）/ multi-currency 设计 / versioning / package 字段 / no-write 边界 均保持上一轮 PASS 状态；bundle 与 eligibility 的 bundleId 不一致仍 fail-closed。

## 4. 回归（㉔）

`carrier-recovery-estimate` **23/23**（原 15 + FINAL 8；并按 ⑲ 修改 1 条既有断言）：

- ELIGIBLE + BASE/DUTY only → `COMPLETE_RULE_BASIS`，blockers 为空，**package COMPLETE**。
- BASE + FUEL(UNKNOWN) → estimate 仍 `ESTIMATED` / `PARTIAL_PROVIDER_RULE_BASIS`，**package PARTIAL**，且 package blockers 含 `USD:UNKNOWN_CHARGE_ELIGIBILITY_EXCLUDED`。
- invariant：package COMPLETE → blockers 为空；PARTIAL 情形 blockers 非空。
- ㉑ PARTIAL_PROVIDER_RULE_BASIS 未被改判成 MISSING_AMOUNT_BASIS（amount 仍 35.00）。
- 多币种：一 complete（USD）+ 一 partial（EUR）→ package PARTIAL；全部 complete → package COMPLETE 且 blockers 为空。
- NOT_ELIGIBLE / INDETERMINATE / MISSING_AMOUNT_BASIS 均保持 PARTIAL 且无金额；deterministic（含 completeness 语义）。
- 既有断言按 ⑲ 更新：base fixture（含 FUEL UNKNOWN）的 package 由 COMPLETE 改为 PARTIAL。

合计：recovery-estimate 23 + sla-eligibility 35 + evidence-bundle 21 + invoice-pod 18 + tracking 24 + carrier-auth-account-discovery 41 + connector 8 + provider-readiness DB 1 = **171/171**；tsc api 0 error；tsc web 0 error；API contract = `API_CONTRACT_OK`（implemented=84 / documented=71，未新增路由）；CI RUN = 37096150327（head 760c41a）5 jobs 全绿。

## 5. 请裁决（编号裁决 PASS / REVISE / BLOCK）

① `allEstimateBasisComplete` 定义（status + basis + blockers）与 packageCompleteness 公式是否符合 ⑱；② PARTIAL_PROVIDER_RULE_BASIS → package PARTIAL 的永久规则是否符合 ⑲；③ `COMPLETE → blockers = []` invariant 是否符合 ⑳；④ estimate 仍保持 ESTIMATED + PARTIAL_PROVIDER_RULE_BASIS 是否符合 ㉑；⑤ 多币种聚合语义是否符合 ㉓；⑥ 是否批准 CARRIER QUEUE #8 = PASS/CLOSED，以及是否授权下一内部单元（Queue #9 CLAIM PACKAGE GENERATION / MANUAL-SUBMISSION WORKFLOW）。
