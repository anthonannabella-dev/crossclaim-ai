# BG-019 重新送审 — CHANGE A + CHANGE B + Matrix Guard

- 依据：**MSG-20261003-141 = REVISE（仅 CHANGE A + B + matrix guard）**；REVIEWED_HEAD `4ee901b`
- 边界：External Write=HOLD · Real Money=HOLD · Customer Submission=HOLD · Production Credentials=HOST_ONLY

## CHANGE A — Platform Qualification Read Projection

- 新只读端点：`GET /platform-accounts/:platformAccountId/qualification`（OWNER/ADMIN/OPS/FINANCE；tenant-scoped）。
- 直接读取既有持久化判定 `RecoveryQualificationAssessmentRecord`，返回 status / reasonCodes / policyId / policyVersion / algorithmVersion / currency / estimated* / expectedNetRecovery / costRatio / digests / computedAt。
- 边界：`readOnly=true`、`recomputedOnRead=false`、`filingAuthorized=false`；`INDETERMINATE` / `NOT_QUALIFIED` / `CONDITIONAL` 原样返回，不做美化。
- UI：`/platform-recovery-state?caseId=&platformAccountId=` 真实读取并展示上述字段（替换了原先「本读模型不返回 qualification」的披露文案）。
- PG 验收 `platform-qualification-read.test.ts` → **3/3**（真实读取/原样展示/403·400·404·跨租户/读取不重算）。

## CHANGE B — Independent-site Phase-1 结果持久化

- 新表 `IndependentSitePhase1Projection`（append-only，+1 模型 → 总数 77；迁移 65 → 66）：
  `qualificationStatus` / `qualificationReasonCodes` / `evidenceReadinessStatus` / `evidenceSummary` / `claimReadyStatus` / `packageId` / `packageDigest` / `policyId` / `policyVersion` / `algorithmVersion` / `resultDigest` / `computedAt`。
- DB 不变量：`UNIQUE(org, disputeReference, resultDigest)` 幂等；append-only（UPDATE/DELETE 拒绝）；tenant + immutable 触发器；qualification/evidence/claimReady 状态白名单；digest/shape 校验；**`externalWritePerformed=false` 与 `autoSubmitAllowed=false` 由 DB CHECK 强制**；latest 由 `computedAt DESC, id DESC` 推导（无 isLatest）。
- `/independent-site-disputes/:ref/state` 现在返回 `phase1`（qualification / evidence / claim-ready + policy + computedAt + 两个 false 边界），仅当确实缺失时才保留 `notPersisted`。
- UI：Independent-site 面板新增「Phase 1 投影」区块，真实展示上述字段。
- PG 验收 `ps04-phase1-projection.test.ts` → **3/3**（幂等/corrected 历史/latest 推导/UPDATE·DELETE 拒绝/externalWrite 与 autoSubmit 被 CHECK 拒绝/state 读出且 notPersisted 清空）。

## Matrix Guard（按裁决加严）

- frontend cell 现在要求：真实调用后端（`/api` 或项目 `apiGet` 助手）+ **域 token** + **关键状态 token**。
- Platform 关键状态 token = `qualification`；Independent-site = `phase1`。
- 加严后四域矩阵：**0 缺口**（platform frontend 证据 = `/platform-recovery-state/page.tsx`；independent-site = `/integration-status/page.tsx`）。

## 结果

Platform：Opportunity → **Qualification（真实持久化判定）** → Claim-ready → Submission（含 External submission: NOT ENABLED / NEEDS_MANUAL）→ Recovered/Fee/Billing。
Independent-site：Dispute → **Qualification / Evidence / Claim-ready（已持久化）** → Handoff → Response → Settlement → Recovered → Fee → Billing，五状态分开呈现。
