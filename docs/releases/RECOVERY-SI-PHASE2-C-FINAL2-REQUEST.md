# Recovery SI P2-C（Option A）FINAL-2 —— 送审请求

- 分支：`gate/7-commercial-validation`
- **REVIEWED_HEAD = `180ccb67`**（C1 / C2 / C3 修订后的实现提交；本轮全部代码与测试在该 SHA 上）
- 前置：**MSG-20261005-17 = REVISE**（`REVIEWED_HEAD = 436599a6`；原文 5330 字符 / 375 行 / FNV `5a40eb34` / `FULL_COPY_OK`）。该裁决确认 `P2C_01/02/03/04/08/09 = PASS`，要求只修 `P2C_05 / P2C_06 / P2C_07`，并只补 4 条负例后送 **P2-C FINAL-2**。
- 耐久记录：`docs/releases/RECOVERY-SI-PHASE2-C-EVIDENCE.md` §8
- 本轮范围：**只修 C1 / C2 / C3**，未进入 P2-D / P2-E / P2-F / P2-G

## 1. 三项必修的落地方式

| 裁决要求 | 落地 |
| --- | --- |
| `CHANGE C1`（可信 PREPARE registry） | 执行入口签名改为只接受 `RecoveryPrepareRegistry`；该对象由 `createRecoveryPrepareRegistry()` 创建并登记进模块内 `WeakSet` 闭包品牌；`isTrustedPrepareRegistry()` 做运行时校验；非工厂对象（即使 `kind` / `proofs` 外形一致）→ `UNTRUSTED_PREPARE_REGISTRY` 且**零调用**、零 fact 读取。边界面量 `trustedPrepareRegistryOnly = true` |
| `CHANGE C2`（fact → opportunity / money identity binding） | fact source 契约改为返回 `{ opportunityRef, fact }`；调用前校验 `loaded.opportunityRef === requested`（`FACT_IDENTITY_MISMATCH`）、`loaded.fact.organizationId === input.organizationId`（`TENANT_MISMATCH:FACTS`）；并校验 `fact.currency` 与 `fact.recoverableAmount` 与 **verified** `OpportunitySlice.recoverable` 一致（`FACT_PLAN_MISMATCH`）。边界面量 `factIdentityBound / factPlanMoneyBound = true` |
| `CHANGE C3`（完整 output + string-value 敏感扫描） | 新增统一 `validatePreparedRecoveryPackagePreview()`（由工厂工具与执行入口共用）：`kind / opportunityRef / persisted / submitted / executionAuthorized / executorInvoked / packageVersion / digestVersion / packageDigest 格式与由 manifest 重算 / pdfDigest 格式 / pdfBytes / canonicalJson === serializeCanonicalManifest(manifest) / 敏感内容`；`scanPreparedPackage()` 现在同时扫 **key 与字符串值**（`Bearer ...`、`X-Amz-Signature=`、`token=`、`access_token=`、`refresh_token=`、`api_key=`、`sk-...`、JWT 样式、IBAN 样式、13–19 位数字卡号样式、signed http(s) URL）。边界面量 `sharedPreviewValidator / sensitiveValueScan = true` |

## 2. 最小 FINAL-2 证据（4 条负例，P2C-01..09 全部保留）

| # | 裁决要求 | 证据 |
| --- | --- | --- |
| F2C-01 | 同名同形 PREPARE registry + 假 DB/network side effect → 不予调用 → counters = 0 | 伪造品牌对象 + 同名工具（每次调用自增 `dbWrites` / `networkCalls`）→ `ok=false / UNTRUSTED_PREPARE_REGISTRY`、`invocations=[]`、`effects = {0,0}` |
| F2C-02 | requested `opp-A` 但 fact source 返回 `opp-B` facts → `FACT_IDENTITY_MISMATCH`、preview = null | 同上，detail 含 `FACT_IDENTITY_MISMATCH`，`preview = null` |
| F2C-03 | verified recoverable = 300 USD 但 facts = 900 USD/EUR → `FACT_PLAN_MISMATCH` | state `300 USD` vs facts `900.0000 EUR` → detail 含 `FACT_PLAN_MISMATCH`，`preview = null` |
| F2C-04 | 合法字段携带 signed URL / Bearer token → `SENSITIVE_PACKAGE_CONTENT_REJECTED` | `instructionNote` 含 `X-Amz-Signature=`、`normalizedRefs` 含 `Bearer ...` → detail 含 `SENSITIVE_CONTENT`，`preview = null`（`scanPreparedPackage({ instructionNote: 'Bearer ...' })` 亦单独断言命中） |
| 保留 | `P2C-01..09` 保持通过 | 10 例全绿（含 C3 validator 对伪造 preview 的 `DIGEST_FORMAT / PDF_DIGEST_FORMAT / PDF_BYTES_INVALID / CANONICAL_JSON_MISMATCH / EXECUTION_AUTHORIZED_FLAG` 断言） |

## 3. tests（本地实测）

```text
api tsc --noEmit → exit 0
recovery-si-phase2-c 10/10 PASS（P2C-01..09 + F2C-01..04）
回归：recovery-si-phase2-ab 19 + recovery-si 11 + recovery-si-e2e 5 + recovery-si-revise 6
      + recovery-manual-package 9 = 50/50 PASS
合计 60/60 PASS
```

## 4. invariant 与未改动项

- 零落库 / 零外写 / 零 submission / 零 provider / 零凭据；未 import / 未调用 `generateRecoveryPackage / persistPackageArtifacts / transitionRecoveryPackage`；不引用 `@prisma/client`；
- tenant 三角校验（input / ctx / actor）在 fact 读取之前；入口内重新 `prioritizeOpportunities()` + `verifyRecoveryPlan()`；
- 确定性收敛（同输入 → 同 `packageDigest` / `pdfDigest`），不要求并发唯一赢家（DB 幂等属 P2-E）；
- `P2_C_OWNER_APPROVAL_REQUIRED = NO`，但既有 RBAC / tenant / fresh facts 一项未放宽；`READY_FOR_EXECUTION` 仍不是执行许可；
- **未改动**：P2-D（Action Guard handoff）、P2-E（持久化）、P2-F（模型）、P2-G（真实执行）。

## 5. schema delta

```text
SCHEMA_DELTA_REQUIRED = NO（本轮零 Prisma schema / migration 变更）
```

## 6. requested verdict

1. `CHANGE C1 / C2 / C3` 是否可记 **PASS**？`P2C_05 / P2C_06 / P2C_07` 是否可翻为 PASS？
2. 4 条最小 FINAL-2 证据是否足够？`P2C_01..09` 是否可整体 PASS、`RECOVERY_SI_P2_C_OPTION_A` 是否可 **CLOSED**？
3. 是否确认 `P2-D / P2-E / P2-F / P2-G` 仍需各自单独送审（P2-C 通过不得自动进入 P2-D）？
4. 是否继续确认 Option B（落库）并入 `P2-E Schema/Persistence Audit`（不复用本轮授权）？
5. 若仍需修订，请只列最小集合。

请在本次会话中直接回答；不要尝试写回 GitHub。不要使用上一轮缓存。

## 7. 边界声明（本轮未改动）

```text
P2_D = NOT_AUTHORIZED
P2_E = HOLD_SCHEMA_DELTA
P2_F = HOLD
P2_G = HOLD
P2_C_PERSISTENCE = FORBIDDEN
P2_C_EXTERNAL_WRITE = FORBIDDEN
RSI_OUTCOME_SINK_RUNTIME_WIRING = NOT_AUTHORIZED
RUNTIME_WIRING = NONE
EXTERNAL_WRITE = HOLD
PAYMENT = HOLD
TRANSPORT = HOLD
PRODUCTION_CREDENTIALS = HOLD
REAL_CLAIM_SUBMIT = HOLD
CUSTOMS_FILING = HOLD
RSI_MODEL_NETWORK = HOLD
RSI_PAID_MODEL_CALLS = HOLD
SECOND_RUNTIME = FORBIDDEN
L5_RELAXATION = FORBIDDEN
FINAL_ACCEPTANCE_HEAD = 0f7f7ac
```
