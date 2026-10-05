# SI Runtime — PHASE 5 Controlled Learning Adoption 收口记录（docs-only）

状态：**PHASE 5 = 功能性 CLOSED**（审计裁决 MSG-20261005-83，reviewed ref `b3629ffc`）
分支：`gate/7-commercial-validation`　范围：仅文档收口，**不新增功能单元**

## 1. 单元封板

| 单元 | 单元名称 | final reviewed HEAD | final verdict | 状态 |
|---|---|---|---|---|
| P5-U1 | Candidate Review + Approval Verdict Contract | `c96ec7e1` | PASS / CLOSED（MSG-20261005-70；PHASE5_U1_FINAL3_REQUIRED = NO） | CLOSED |
| P5-U2 | Rollback Plan Contract | `b50ca7ab` | PASS / CLOSED（MSG-20261005-72；PHASE5_U2_FINAL2_REQUIRED = NO） | CLOSED |
| P5-U3 | Controlled Config Proposal | `9a245254` | PASS / CLOSED（MSG-20261005-75；PHASE5_U3_FINAL3_REQUIRED = NO） | CLOSED |
| P5-U4 | Canary / Shadow Evaluation | `edcbb826` | PASS / CLOSED（MSG-20261005-81；PHASE5_U4_FINAL5_REQUIRED = NO） | CLOSED |
| P5-U5 | Controlled Adoption Review | `b3629ffc` | PASS / CLOSED（MSG-20261005-83；PHASE5_U5_FINAL2_REQUIRED = NO） | CLOSED |

整体：**PHASE_5_CONTROLLED_LEARNING_ADOPTION = PASS / CLOSED**；`PHASE5_FUNCTIONAL_REVISION_REQUIRED = NO`。

## 1b. 完整可信链（逐段已封板）

```
Verified Outcome / Learning Evidence            （PHASE 4：U3 learning evidence + RSI immutable ledger）
  → Verified Offline Evaluation                 （PHASE 4：U4 offline evaluation，resolved denominator）
  → Verified Meta-improvement Candidate         （PHASE 5 U1 之前的 PROPOSAL_ONLY candidate，provenance + fingerprint）
  → Verified Candidate Approval                 （PHASE 5 U1 candidate review + approval verdict）
  → Verified Rollback Plan                      （PHASE 5 U2，锚定 U2/U4 baseline snapshot）
  → Verified Controlled Config Proposal         （PHASE 5 U3，target allowlist + 字段 value schema + from 绑定 trusted baseline）
  → Verified Same-input Canary / Shadow Eval    （PHASE 5 U4，CohortRunSourcePort + VerifiedCohortRun 成员级绑定）
  → Verified Controlled Adoption Review         （PHASE 5 U5，ELIGIBLE-only 门 + ticket/verdict provenance）
```

链上每一段都以 provenance + canonical fingerprint + deep-freeze 与 digest 绑定；任一段缺失或不一致一律 fail-closed。

## 2. 代码资产（apps/api/src/services/outcome-learning/）

- `meta-improvement-candidate.ts` — PROPOSAL_ONLY 候选（provenance + fingerprint + deep-freeze）。
- `candidate-approval.ts` — 评审票据与 approval/rejection verdict（approver 角色门、single-use 防 replay、过期、单向撤销、verdict provenance）。
- `rollback-plan.ts` — Rollback Plan（只接受 verified APPROVED verdict；baseline 必须为 server-owned snapshot 派生；ROLLBACK_PLAN_ONLY）。
- `controlled-config-proposal.ts` — 受控配置提案（双门 + one verdict → one proposal；delta 受 target allowlist 与字段 value schema 约束，`from` 必须等于 trusted baseline 当前值）。
- `canary-shadow-evaluation.ts` — 双轨 Shadow/Canary（复用 Phase 4 指标口径；server-owned CohortRef + CohortRunSourcePort + VerifiedCohortRun 成员级绑定；三态 recommendation；强制回滚条件且回滚锚定 U2 baseline）。
- `controlled-adoption-review.ts` — 受控采用评审（ELIGIBLE canary 门；ticket/verdict provenance；replay/过期/撤销；scope 精确；APPROVED/REJECTED 语义分离）。

## 3. 语义边界（必须保持）

- **REVIEW_ONLY / PROPOSAL_ONLY / ROLLBACK_PLAN_ONLY / SHADOW_ONLY**；不存在任何自动执行入口。
- `APPROVED` = `APPROVED_FOR_CONTROLLED_ADOPTION_PLANNING`；`REJECTED` = `REJECTED_NO_CONTROLLED_ADOPTION_PLAN`。
- `apply` / `autoPromotion` / `productionRollout` / Policy·Guard·Router·Action Runtime mutation = **FORBIDDEN**。
- 真正的执行需另立 **Controlled Adoption Plan / Execution Gate** 单元（本轮不做）。

### 永久边界登记

```
AUTO_APPLY    = FORBIDDEN
AUTO_PROMOTION = FORBIDDEN
AUTO_ROLLOUT  = FORBIDDEN
POLICY_MUTATION = FORBIDDEN
GUARD_MUTATION = FORBIDDEN
ROUTER_MUTATION = FORBIDDEN
ACTION_RUNTIME_MUTATION = FORBIDDEN
APPROVED review = APPROVED_FOR_CONTROLLED_ADOPTION_PLANNING（无配置执行权限）
REJECTED review = REJECTED_NO_CONTROLLED_ADOPTION_PLAN（无配置执行权限）
```

## 4. 未解锁边界（HOLD / FORBIDDEN）

REAL_MODEL_NETWORK / PAID_MODEL_CALLS / EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS /
PRODUCTION_ENABLEMENT / P2_F / P2_G / CUSTOMS real filing = **HOLD**；
SECOND_RUNTIME / SECOND_POLICY_ENGINE / SECOND_CONTROL_PLANE / SECOND_MODEL_GATEWAY / SECOND_COST_LEDGER /
SECOND_META_EVIDENCE_STORE = **FORBIDDEN**；L5_RELAXATION = **FORBIDDEN**。

未宣称：`MODEL_GATEWAY_RUNTIME_WIRED` / `ACTION_RUNTIME_PRODUCTION_ENABLED` / `META_IMPROVEMENT_INTEGRATED` /
`PRODUCTION_READY` 全部为 **false**（无真实 E2E 证据）。

## 5. 非阻断债务（继续记录）

1. 三类 digest（evidenceDigest / evaluationDigest / 各 fingerprint）仍截 16 hex，长期持久化建议完整 SHA-256。
2. 各 canonical fingerprint 需随上游结构升级同步维护（`recordContentKey`、各 fingerprint 列表）。
3. `scanRawPayloadKeys()` 固定递归深度（canonical 白名单已阻止深层未知字段进入记录）。
4. `recovery-si-phase2-e-db` P2E-DB5 test-isolation debt（单独运行 20/20 PASS；全套回归唯一失败项）。

## 6. 归档索引

MSG-20261005-65 … MSG-20261005-83（PHASE 5 各轮裁决与澄清，均在 `AI-ARCHITECT-INBOX.md` 逐字归档，`tools/verdict-diff/compare.mjs` = FULL_COPY_OK）。
