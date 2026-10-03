# C17 FINAL-2 CHECKPOINT — CONCURRENCY + IDEMPOTENCY IMMUTABILITY（CHANGE A/B/C）

状态：**READY_FOR_REVIEW**
前序：C17 FINAL 裁决 = REVISE（① root+fact PASS；② SUBMITTED→providerSubmissionId REVISE；③ PASS；④ PASS；⑤ 不 CLOSED），要求 CHANGE A（并发原子）/ CHANGE B（idempotencyKey payload 冲突）/ CHANGE C（fact 完整等价）。
IMPLEMENTATION_HEAD = 0c35106
边界：**NO platform write · TRANSPORT=false · Payment = 0 · R13 HOLD · 无生产凭据 · 真实 filing = HOLD_EXTERNAL**。

## CHANGE A — providerSubmissionId 冲突改为并发原子

- store 新增 appendFactGuarded(fact, { forbidProviderSubmissionIdConflict })：**同一事务内**先 `SELECT "id" FROM "CustomsSubmissionAttempt" WHERE "id"=$1 AND "organizationId"=$2 FOR UPDATE`（root 行锁，等价于 advisory lock 的串行化点），锁内重读该 attempt 的全部事实，再做冲突判定与 append。
- 新测试：两个独立连接并发提交 **PROV-A / PROV-B** 的 PROVIDER_VERIFIED 事实 → **exactly one accepted**，另一个稳定返回 PROVIDER_SUBMISSION_ID_CONFLICT；库内 verified providerSubmissionId 恰好 1 个。

## CHANGE B — 同 idempotencyKey 的 immutable payload 冲突

- openCustomsSubmissionAttempt 在 createRoot 得到既有 root（P2002 → 回读）后，比对完整 immutable identity snapshot：opportunityId / caseId / claimItemId / packageId / packageDigest / provider / operation / jurisdiction / remedyType。
- 任一不同 → **IDEMPOTENCY_KEY_CONFLICT**（零新 fact、零外写），不再静默返回 ROOT_EXISTING；完全一致 → ROOT_EXISTING（正常 retry）。

## CHANGE C — fact 回读必须完整 immutable equality

- appendFactGuarded 在锁内若发现同 id 事实，逐字段比较 status / providerSubmissionId / source / verificationLevel / observedAt / providerReference / errorCode / reconciliationAttempt（以及 org/attempt）。
- 完全一致 → ALREADY_RECORDED（等效重放）；任一不一致 → **FACT_IMMUTABLE_MISMATCH** fail-closed，不写新事实、不吞掉差异。

## 验收

- `customs-submission-ledger-db` **13/13**：原 10/10 全部保持（一 key 一根 / 双连接并发一根 / 状态事实逐条追加 / SUBMITTED 缺 id 双拒 / append-only / 跨租户 lineage / digest 形状 / timeout 不建第二根 / ambiguous 仅对账 / 24h → MANUAL_REVIEW / 无凭据字段）+ 新增 3 条（CHANGE A 并发 exactly-one、CHANGE B IDEMPOTENCY_KEY_CONFLICT、CHANGE C FACT_IMMUTABLE_MISMATCH）。
- 闸门：prisma validate valid；migrate deploy 成功；generate OK；tsc api 0 error；tsc web 0 error；API contract API_CONTRACT_OK（86/73）；audit coverage OK；autopilot rules OK。
- 不重做 C17 架构（root UNIQUE / tenant guard / append-only / digest CHECK 保持原样）。

## 请裁决（编号裁决 PASS / REVISE / BLOCK）

① CHANGE A 并发原子是否满足（root FOR UPDATE + 锁内判定 + 并发 exactly-one 测试）；② CHANGE B IDEMPOTENCY_KEY_CONFLICT 是否满足；③ CHANGE C FACT_IMMUTABLE_MISMATCH 是否满足；④ 是否批准 **C17 = PASS/CLOSED**（此后按 ㉑ 实施 C21 HTTP，继续 filingSubmitted=false / TRANSPORT=false / HOLD_EXTERNAL）。
