# PC-04 FINAL Checkpoint（ERROR / RECOVERY STATES — REVISE 收口后）

状态：**READY_FOR_REVIEW / FINAL CHECKPOINT**（待架构方最终复审）
FINAL_IMPLEMENTATION_HEAD = b3db319
FINAL_IMPLEMENTATION_HEAD_FULL = b3db319c224148a5417b5957dec7c4e4b8699f19
CI = SUCCESS · RUN_ID = 37028855841 · CI_HEAD = b3db319
前序：首次 checkpoint IMPLEMENTATION_HEAD = 6758e9b / CI 37027265617 → MSG-20261003-85 = **REVISE-MINOR**（唯一 CHANGE：Claim recovery 状态语义必须收成一份共享语义）。
授权：MSG-20261003-84 ④⑤⑥；本次修订依据 MSG-20261003-85 ④。
边界：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。

## 1. 唯一 CHANGE 的收口方式

新增共享语义层 `apps/api/src/services/workflow/claim-recovery-semantics.ts`，成为 claim 状态语义的**唯一来源**：

| 单一来源定义 | 内容 |
|---|---|
| `ClaimPackageReadiness` + `READINESS_LABEL` | 客户可见 readiness 类型与文案（从 `claim-package-view.ts` 上移，后者改为 re-export） |
| `CLAIM_READINESS_TO_RECOVERY_CODE` | readiness → recovery code 的**唯一映射表**（READY_TO_SUBMIT / SUBMITTED / ACKNOWLEDGED / APPROVED → `null`；NEEDS_EVIDENCE → EVIDENCE_REQUIRED；NEEDS_REVIEW → MANUAL_ACTION_REQUIRED；REJECTED / APPEAL_REQUIRED → APPEAL_REQUIRED） |
| `CLAIM_RECOVERY_SUMMARY` | recovery code → 客户可读安全摘要（唯一来源，无内部错误文本） |
| `deriveClaimReadiness(items, context)` | PC-03 使用的 readiness 推导（唯一实现） |
| `deriveClaimRecoveryCode(items)` | PC-04 使用的 recovery code 推导（复用同一映射与同一判断顺序） |

语义对齐（避免两份并行判定漂移）：

- `REVIEW_REQUIRED` 现在在两个消费者中都表示「需要人工复核」（readiness = NEEDS_REVIEW ↔ code = MANUAL_ACTION_REQUIRED）；此前 PC-03 会把它当作可提交，属真实漂移点，已修正。
- `DISCOVERED` + 缺材料 → NEEDS_EVIDENCE ↔ EVIDENCE_REQUIRED；`READY_TO_APPEAL` / `closedReason=REJECTED` → APPEAL_REQUIRED ↔ APPEAL_REQUIRED。
- `claim-package-view.ts` 不再保留本地 readiness/映射/文案定义（仅 re-export）；`recovery-states.ts` 的 case 循环改为调用 `deriveClaimRecoveryCode()` + `CLAIM_RECOVERY_SUMMARY[]`，删除原先复制的三分支判定。

## 2. 验证证据

- 新增永久测试「PC-04 REVISE — claim 状态语义只有一份来源」：对同一输入断言 `CLAIM_READINESS_TO_RECOVERY_CODE[deriveClaimReadiness(items, ctx)] === deriveClaimRecoveryCode(items)`，并断言不需要客户提示的 readiness 映射为 `null`（避免重复打扰）。
- `recovery-states-http-db` **7/7 PASS**（原 6 项 + 新增共享语义 1 项）。
- `claim-package-view-http-db` **8/8 PASS**（PC-03 语义未回归）。
- `tsc --noEmit`（apps/api）0 error；CI 全量回归（API job：migration / typecheck / unit + DB / two-stage upgrade）在 RUN_ID = 37028855841 全绿。
- 本地 API contract `API_CONTRACT_OK`（本次未新增路由）。

## 3. 未做 / 边界

未扩大范围：未新增路由、未改 Schema、未加 migration、未新增写端点、未触碰 payment / external write / provider OAuth / X4 / monitoring backend。本轮只做状态语义收口 + 永久测试。

## 4. 下一执行单元（待裁决）

若 PASS：PC-04 = PASS / CLOSED → 进入 **PC-05 Recovered money visibility**。
边界保持：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
