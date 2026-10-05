# SI Runtime — PHASE 5 Controlled Learning Adoption 收口记录（docs-only）

状态：**PHASE 5 = 功能性 CLOSED**（审计裁决 MSG-20261005-83，reviewed ref `b3629ffc`）
分支：`gate/7-commercial-validation`　范围：仅文档收口，**不新增功能单元**

## 1. 单元封板

| 单元 | 内容 | 裁决 |
|---|---|---|
| P5-U1 | Candidate Review + Approval Verdict Contract（含 U1 FINAL / FINAL2） | PASS / CLOSED（MSG-20261005-66 / -70） |
| P5-U2 | Rollback Plan Contract（含 U2 FINAL） | PASS / CLOSED（MSG-20261005-72） |
| P5-U3 | Controlled Config Proposal（含 U3 FINAL / FINAL2） | PASS / CLOSED（MSG-20261005-75） |
| P5-U4 | Canary / Shadow Evaluation（含 U4 FINAL…FINAL4） | PASS / CLOSED（MSG-20261005-81） |
| P5-U5 | Controlled Adoption Review（含 U5 FINAL） | PASS / CLOSED（MSG-20261005-83） |

整体：**PHASE_5_CONTROLLED_LEARNING_ADOPTION = PASS / CLOSED**；`PHASE5_FUNCTIONAL_REVISION_REQUIRED = NO`。

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
