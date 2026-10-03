# CARRIER QUEUE #5 FINAL — CURRENCY TRUTH + MIXED-CURRENCY GUARD CHECKPOINT

状态：**READY_FOR_REVIEW**；前序 MSG-20261003-110 = REVISE-MINOR（唯一剩余 = invoice currency truth / mixed-currency safety）。
IMPLEMENTATION_HEAD = c98a513（full c98a51391dbab56cb86cdb95877075a3ab359921）；CI = SUCCESS · RUN_ID = 37075713837
边界：**NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据**。

## 1. CHANGE A（⑭）— invoice currency 严格 canonical

`raw.currency.trim()` 后必须匹配 `^[A-Z]{3}$`，**不再自动 uppercase**（`usd` / `US` → `CURRENCY_REQUIRED`）；provider adapter 负责 provider-specific canonicalization，核心 truth plane 只接受 canonical facts。

## 2. CHANGE B（⑰⑱⑲）— charge currency 校验 + same-currency invariant

- charge 无 currency → 继承 invoice currency；
- 显式有 currency → 必须 canonical（`^[A-Z]{3}$`），否则 `CURRENCY_REQUIRED`；
- 显式 currency ≠ invoice currency → **`CHARGE_CURRENCY_MISMATCH`**（新增稳定 code，不复用 CURRENCY_REQUIRED）；
- 混币 charge 不产生成功 fact，**绝不被加总**；不做汇率换算 / 自动转币 / 忽略 charge currency（Queue #5 不承担 FX conversion）。

## 3. 回归（㉒）

`carrier-invoice-pod-read` **18/18**：新增 invoice currency canonical（USD PASS / usd·US → CURRENCY_REQUIRED）、charge currency 继承与显式一致 PASS、charge 非 canonical → CURRENCY_REQUIRED、charge EUR + invoice USD → CHARGE_CURRENCY_MISMATCH（无 facts）且 `0.1+0.2=0.3` 精确性保持；既有 invoice provenance / POD / raw allowlist / decimal exactness 全部 green。

全套件：invoice-pod 18 + tracking 24 + carrier 41 + connector 8 + provider-readiness DB 1 = **92/92**；tsc api 0 error；API contract = `API_CONTRACT_OK`（implemented=84 / documented=71，未新增路由）；CI RUN = 37075713837（head c98a513）5 jobs 全绿。

## 4. 未重做（㉓）/ 未做（㉖）

未重做 account lineage / invoice·POD ports / BigInt helpers / charge taxonomy / POD masking / provenance binding / raw allowlists / read-only flags。未计算赔付或退款资格、未提交 claim、未 enable TRANSPORT、未使用真实凭据。㉑ POD reference 语法校验与 ⑳ total-vs-components reconciliation delta 留给后续 Evidence Assembly 阶段（本轮不扩大范围）。Queue #6（SLA Evidence Assembly）待架构方授权。

## 5. 请裁决（编号裁决 PASS / REVISE / BLOCK）

① invoice canonical currency 是否收口；② charge currency 校验 + same-currency invariant 是否收口；③ `CHARGE_CURRENCY_MISMATCH` 命名是否接受；④ 是否批准 CARRIER QUEUE #5 = PASS/CLOSED；⑤ 下一内部单元。
