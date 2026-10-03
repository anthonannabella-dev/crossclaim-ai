# CARRIER QUEUE #7 FINAL — OBSERVATIONAL RULE NON-GATING SEMANTICS CHECKPOINT

状态：**READY_FOR_REVIEW**（只回答「证据支持什么结论」；不计算追回金额、不提交索赔）
前序：MSG-20261003-114 = REVISE-MINOR（唯一剩余 = OBSERVATION RULE MUST NOT BECOME A HARD ELIGIBILITY GATE）。
IMPLEMENTATION_HEAD = a0b319b（full a0b319b25f831a401a8575e5d10ae32f252c4f7f）；CI = SUCCESS · RUN_ID = 37094680071
边界：**NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据**。

## 1. CHANGE A（⑰）— observation rule 不再 gating

- 旧行为：`exceptionOrDelayObserved = false` → `EXCEPTION_OR_DELAY_OBSERVED = FAIL`；因聚合规则「任一 FAIL → NOT_ELIGIBLE」，它事实上成为资格硬门槛 —— 即使 `actual > promised` 已独立证明 late delivery，只要 carrier 没有产生 EXCEPTION/DELAYED scan，就会得到 NOT_ELIGIBLE。
- 现行：该规则两种观察结果的 **status 均为 PASS**，语义差异只体现在 reasonCode —— 观察到 → `PASS` / `EXCEPTION_OR_DELAY_OBSERVED`；未观察到 → `PASS` / `EXCEPTION_DELAY_NOT_OBSERVED`。
- 理由：「没有 exception scan」不能推出「没有发生 late delivery」；该规则表达「观察结果是什么」，不是「资格条件是否通过」。未采用 UNKNOWN（那会让总体聚合变成 INDETERMINATE，仍然阻塞 otherwise-valid late delivery）。
- 目前未引入 ⑱ 的 `effect: GATING | INFORMATIONAL` 模型（架构方明确「本轮不要求扩大设计，最小修复即可」）；EXCEPTION_OR_DELAY_OBSERVED 通过 status + reasonCode 表达 informational 语义。

## 2. ㉗ Rule version

- `ruleSetVersion` 由 `1.0.0` → **`1.0.1`**（修复 observation 被错误当作 gating 的语义 bug，非新增规则维度）。`ruleSetId` 不变。

## 3. 保持不变（㉑㉒㉕）

- 真实 gating conditions 不变：`TERMS_EFFECTIVE_RANGE = FAIL`（条款明确不适用）与 `DELIVERY_TIMING = FAIL`（时间事实明确未迟到）仍可决定 NOT_ELIGIBLE。
- 三值 decision 聚合不变（任一 FAIL → NOT_ELIGIBLE；否则任一 UNKNOWN → INDETERMINATE；全部 PASS → ELIGIBLE）。
- PARTIAL → `EVIDENCE_COMPLETENESS = UNKNOWN` → INDETERMINATE 的保守性维持（㉒ ACCEPTED）。
- conflict → 依赖规则 UNKNOWN、无静默消解、无金额 / 无提交 / deterministic / terms range 语义均未改动。

## 4. 回归（⑲⑳㉖）

`carrier-sla-eligibility` **35/35**（原 24 + FINAL 11；并按要求修改 1 条既有断言）：

- ⑲ Case A：late delivery（promised 12:00 / actual 14:00）+ **无异常扫描** → `DELIVERY_TIMING = PASS`、`EXCEPTION_OR_DELAY_OBSERVED = PASS`（reasonCode `EXCEPTION_DELAY_NOT_OBSERVED`）、**decision = ELIGIBLE**（不再 NOT_ELIGIBLE）。
- ㉖ late + 有异常扫描 → ELIGIBLE；未观察到不得本身成为 gating blocker（blockers 为空）；exception observed 保持 informational PASS。
- ㉑ on-time + 无扫描 / 有扫描 → 均 NOT_ELIGIBLE，且 `blockers = [DELIVERY_TIMING:ON_TIME_OR_EARLY]`（仅由真实 gating condition 决定）。
- ㉑ terms-out-of-range 仍 NOT_ELIGIBLE；㉒ PARTIAL 仍 INDETERMINATE；conflict 仍 INDETERMINATE；deterministic（含无扫描情形）；无金额字段 / 无提交 / 无 write / 无 network；`ruleSetVersion = 1.0.1`。

合计：sla-eligibility 35 + evidence-bundle 21 + invoice-pod 18 + tracking 24 + carrier-auth-account-discovery 41 + connector 8 + provider-readiness DB 1 = **148/148**；tsc api 0 error；tsc web 0 error；API contract = `API_CONTRACT_OK`（implemented=84 / documented=71，未新增路由）；CI RUN = 37094680071（head a0b319b）5 jobs 全绿。

## 5. 请裁决（编号裁决 PASS / REVISE / BLOCK）

① observation rule 非 gating 语义（两种观察结果均 PASS，reasonCode 区分）是否收口（⑰）；② Case A：late + 无异常扫描 → ELIGIBLE 是否满足 ⑲；③ 原有 `events = []` 断言改为 informational PASS 是否符合 ⑳；④ 真实 gating conditions（TERMS_EFFECTIVE_RANGE / DELIVERY_TIMING FAIL）保持不变是否符合 ㉑；⑤ `ruleSetVersion = 1.0.1` 是否符合 ㉗；⑥ 是否批准 CARRIER QUEUE #7 = PASS/CLOSED，以及是否授权 CARRIER QUEUE #8（RECOVERY AMOUNT ESTIMATION + CLAIM-READY PACKAGE INPUT）。
