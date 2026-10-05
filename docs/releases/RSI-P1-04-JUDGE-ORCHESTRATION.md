# RSI-P1-04 —— Builder / Judge 隔离编排

- 分支：`gate/7-commercial-validation`
- 模块：`apps/api/src/services/autonomy/rsi-judge-orchestration.ts`（纯函数，零 IO / 零外写）
- 本轮范围：候选能否 PROMOTED **只由独立 Judge + 确定性证据**决定；本模块不落库、不改 baseline、不发网络。

## 1. 判定规则（`judgeCandidate`）

| 规则 | 行为 |
| --- | --- |
| 隔离 | `builderRef === judgeRef`（或任一为空）→ `SELF_JUDGE_FORBIDDEN`，即使证据齐全也 REJECTED |
| 必需证据按风险分级 | `LOW: [TEST]`、`MEDIUM: [TEST, REPLAY]`、`HIGH: [TEST, REPLAY, BENCHMARK, SECURITY, POLICY]` |
| 缺证据 | 该 kind 没有任何记录 → `EVIDENCE_MISSING:<KIND>` |
| 自证不算证据 | 该 kind 只有 `producedBy === builderRef` 的 PASSED → `SELF_PRODUCED_EVIDENCE:<KIND>` |
| 失败证据 | `FAILED` → `EVIDENCE_FAILED:<KIND>`；`PENDING/RUNNING/INCONCLUSIVE` → `EVIDENCE_NOT_CONCLUDED:<KIND>` |
| 结果 | `reasonCodes` 为空才 `PROMOTED`，否则 `REJECTED`；reasonCodes 排序稳定、与输入顺序无关 |
| 不自行应用 | `autoPromoted` **恒为 false**；`autoPromoteEligible` 只在显式开启且 `riskClass = LOW` 时为 true（复用 `canAutoPromote`，默认 OFF） |

## 2. 追加式 decision（`recordPromotionDecision`）

同一 `dedupeKey` 只能记录一次；重复记录返回 `DECISION_IMMUTABLE` ——
与 `AutonomyPromotionDecision.dedupeKey` 的数据库唯一约束同语义（DB 侧另有 `judgeRef != candidate.builderRef` 触发器）。

## 3. 验收

`apps/api/src/__tests__/rsi-judge-orchestration.test.ts` 10 例：

- 独立证据齐全 → PROMOTED（并返回必需证据集合与满足的 evaluationId）
- 自任 judge → REJECTED `SELF_JUDGE_FORBIDDEN`
- 缺必需证据 → `EVIDENCE_MISSING:REPLAY`
- builder 自证证据 → `SELF_PRODUCED_EVIDENCE:TEST`
- 失败 / 未结论证据 → `EVIDENCE_FAILED:TEST` / `EVIDENCE_NOT_CONCLUDED:TEST`
- 风险分级必需证据（LOW 只要 TEST；HIGH 逐条给出缺失码）
- 判定确定性（evidence 顺序无关）
- 永不自行应用（`autoPromoted = false`；HIGH 即使显式开启也不自动升级）
- decision append-only（重复 dedupeKey → `DECISION_IMMUTABLE`）
- 边界常量（不落库 / 不发网络 / 不读凭据 / 不改 baseline / 无外部写）

`tsc --noEmit` exit 0；门禁 `api-contract` / `audit-coverage` / `autopilot-rules` 全 OK。

## 4. 边界不变

```
EXTERNAL_WRITE = HOLD
PAYMENT = HOLD
TRANSPORT = HOLD
PRODUCTION_CREDENTIALS = HOLD
RSI_MODEL_NETWORK = HOLD
RSI_PAID_MODEL_CALLS = HOLD
```

本模块只产出 decision 记录；真正把变更应用到 baseline 仍属 L4/L5，需要 OWNER 门禁与独立审计。
