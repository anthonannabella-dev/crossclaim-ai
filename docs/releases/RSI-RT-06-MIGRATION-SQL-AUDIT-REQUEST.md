# [RSI → ARCHITECT] RSI-RT-06 MIGRATION SQL AUDIT（请裁定 migration draft 是否可应用）

## 0. 耐久记录与通道

- 本文件即耐久记录：`docs/releases/RSI-RT-06-MIGRATION-SQL-AUDIT-REQUEST.md`（随本批 commit 推到
  `gate/7-commercial-validation`，在 GitHub 上可读）。
- **代码/迁移送审 HEAD = `4472e8b`**（RSI-RT-06 落地提交）；本请求文档是紧随其后的文档提交。
- 通道说明（诚实记录）：本机 `gh` token 已失效（`gh auth status` = invalid），因此本轮**无法**按惯例把
  请求写进 GitHub issue #2 comment。耐久记录改用仓库内文件（同样是 GitHub 上的持久、可审计记录）。
  若宿主希望恢复 issue-comment 通道，需要重新 `gh auth login`（见文末 HOST_ACTION）。

## 1. 声明（硬边界，未变）

- `migrate deploy` = **NOT RUN**；`MIGRATION_APPLIED = NO`；未接触 dev / shared / production 库。
- 只在一次性库上执行：`crossclaim_rsi_migration_gen` / `crossclaim_rsi_trigger_check` /
  `crossclaim_ephemeral_test` / `crossclaim_c18_exact_order`，全部用后即 DROP。
- `TRANSPORT=false`；`EXTERNAL_WRITE / PAYMENT / PRODUCTION_CREDENTIALS / PRODUCTION_ENABLEMENT` 全 HOLD。
- 未注册任何 HTTP 路由；未写任何 reconcile / 幂等业务逻辑。

## 2. 送审内容（相对 reviewed 基线 `328592d`）

| 文件 | 变更 |
| --- | --- |
| `apps/api/prisma/schema.prisma` | +8 个平台级模型（85 → 93），见 §3 |
| `apps/api/prisma/migrations/20261005000000_rsi_autonomy_state_persistence/migration.sql` | **新增 migration draft**（结构由 `prisma migrate diff` 生成，尾部手工追加 DB 不变量） |
| `apps/api/src/services/autonomy/rsi-lifecycle.ts` | 追加值域常量（单源）：`RSI_LEASE_STATES` / `RSI_EVALUATION_KINDS` / `RSI_EVALUATION_RUN_STATES` / `RSI_PROMOTION_DECISIONS` / `RSI_RISK_CLASSES` |
| `tools/tenant-triggers/append-only-triggers.json` | +3 条 RSI 证据表 append-only 触发器 |
| `apps/api/src/__tests__/rsi-schema-contract.test.ts` | 新增（10 例，纯静态） |
| `apps/api/src/__tests__/rsi-persistence-db.test.ts` | 新增（8 例，真实 PG，仅一次性库） |
| `apps/api/src/__tests__/architecture-contract.test.ts` | 模型总数断言 85 → 93 |
| `docs/releases/RSI-RT-06-SCHEMA-DELTA.md` | 新增证据文档 |

## 3. schema 摘要

8 张表（**平台级：无 `organizationId` / `tenantId` / `customerId`**）：

```
AutonomyIncident          kind, dedupeKey UNIQUE, status*, riskClass*, sourceRefs JSON, detectedAt
AutonomyTask              incidentId FK, status*, riskClass*, ownerGateRequired, dedupeKey UNIQUE
AutonomyCandidate         taskId FK, status*, builderRef, baselineRef, codeCommitRef, promptVersion, dedupeKey UNIQUE
AutonomyEvaluationRun     candidateId FK, kind*, status*, startedAt, finishedAt
AutonomyMetricResult      evaluationRunId FK, name, value DECIMAL(18,6), unit, recordedAt, supersedesId   ← append-only
AutonomyPromotionDecision candidateId FK, dedupeKey UNIQUE, decision*, reason, judgeRef, decidedAt, supersedesId  ← append-only
AutonomyRollbackRecord    candidateId FK, targetRef, reason, triggeredBy, recordedAt, supersedesId       ← append-only
AutonomyLease             taskId UNIQUE, ownerRef, acquiredAt, renewedAt, expiresAt, status*              ← 时间单调
```

`*` = `TEXT + CHECK`，值域单源在 `rsi-lifecycle.ts` 并由 `rsi-schema-contract.test.ts` 逐项比对。

## 4. migration SQL 中「由 Prisma 生成」的部分

一次性库先应用全部既有 migration，再对当前 `schema.prisma` 做 diff，得到**只含 8 张新表**的
`CREATE TABLE` / `CREATE INDEX` / `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY`。
可复现：`node work/scripts/gen-rsi-migration.mjs`。

## 5. migration SQL 中「手工追加」的部分（本次审查重点，逐字）

```sql
-- 生命周期状态 TEXT + CHECK（值域 = rsi-lifecycle.ts 单源）
ALTER TABLE "AutonomyIncident"  ADD CONSTRAINT "AutonomyIncident_status_chk"  CHECK ("status" IN ('OPEN','DIAGNOSED','TASKED','CLOSED','REJECTED'));
ALTER TABLE "AutonomyIncident"  ADD CONSTRAINT "AutonomyIncident_risk_class_chk" CHECK ("riskClass" IN ('LOW','MEDIUM','HIGH'));
ALTER TABLE "AutonomyIncident"  ADD CONSTRAINT "AutonomyIncident_dedupe_key_shape_chk" CHECK (length("dedupeKey") > 0);
ALTER TABLE "AutonomyTask"      ADD CONSTRAINT "AutonomyTask_status_chk"      CHECK ("status" IN ('READY','IN_PROGRESS','CANDIDATE_READY','VALIDATED','JUDGED','PROMOTED','REJECTED','BLOCKED'));
ALTER TABLE "AutonomyTask"      ADD CONSTRAINT "AutonomyTask_risk_class_chk"  CHECK ("riskClass" IN ('LOW','MEDIUM','HIGH'));
ALTER TABLE "AutonomyTask"      ADD CONSTRAINT "AutonomyTask_dedupe_key_shape_chk" CHECK (length("dedupeKey") > 0);
ALTER TABLE "AutonomyCandidate" ADD CONSTRAINT "AutonomyCandidate_status_chk" CHECK ("status" IN ('CREATED','PATCHED','SANDBOXED','REPLAYED','TESTED','BENCHMARKED','POLICY_CHECKED','JUDGED','PROMOTED','REJECTED'));
ALTER TABLE "AutonomyCandidate" ADD CONSTRAINT "AutonomyCandidate_builder_ref_shape_chk" CHECK (length("builderRef") > 0);
ALTER TABLE "AutonomyCandidate" ADD CONSTRAINT "AutonomyCandidate_dedupe_key_shape_chk" CHECK (length("dedupeKey") > 0);
ALTER TABLE "AutonomyEvaluationRun" ADD CONSTRAINT "AutonomyEvaluationRun_kind_chk" CHECK ("kind" IN ('TEST','REPLAY','BENCHMARK','SECURITY','POLICY'));
ALTER TABLE "AutonomyEvaluationRun" ADD CONSTRAINT "AutonomyEvaluationRun_status_chk" CHECK ("status" IN ('PENDING','RUNNING','PASSED','FAILED','INCONCLUSIVE'));
ALTER TABLE "AutonomyMetricResult" ADD CONSTRAINT "AutonomyMetricResult_name_shape_chk" CHECK (length("name") > 0);
ALTER TABLE "AutonomyMetricResult" ADD CONSTRAINT "AutonomyMetricResult_unit_shape_chk" CHECK (length("unit") > 0);
ALTER TABLE "AutonomyPromotionDecision" ADD CONSTRAINT "AutonomyPromotionDecision_decision_chk" CHECK ("decision" IN ('PROMOTED','REJECTED','ROLLED_BACK'));
ALTER TABLE "AutonomyPromotionDecision" ADD CONSTRAINT "AutonomyPromotionDecision_judge_ref_shape_chk" CHECK (length("judgeRef") > 0);
ALTER TABLE "AutonomyRollbackRecord" ADD CONSTRAINT "AutonomyRollbackRecord_target_ref_shape_chk" CHECK (length("targetRef") > 0);
ALTER TABLE "AutonomyRollbackRecord" ADD CONSTRAINT "AutonomyRollbackRecord_triggered_by_shape_chk" CHECK (length("triggeredBy") > 0);
ALTER TABLE "AutonomyLease" ADD CONSTRAINT "AutonomyLease_status_chk" CHECK ("status" IN ('ACTIVE','EXPIRED','RELEASED'));
ALTER TABLE "AutonomyLease" ADD CONSTRAINT "AutonomyLease_owner_ref_shape_chk" CHECK (length("ownerRef") > 0);
ALTER TABLE "AutonomyLease" ADD CONSTRAINT "AutonomyLease_time_order_chk" CHECK ("expiresAt" > "acquiredAt" AND "renewedAt" >= "acquiredAt");

-- 证据表 append-only：UPDATE / DELETE 一律拒绝（新事实 = 新记录 + supersedesId）
CREATE OR REPLACE FUNCTION "cc_rsi_evidence_append_only"() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'RSI_EVIDENCE_APPEND_ONLY: RSI evidence facts are append-only; insert a new record with supersedesId';
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "cc_append_only__AutonomyMetricResult"        BEFORE UPDATE OR DELETE ON "AutonomyMetricResult"        FOR EACH ROW EXECUTE FUNCTION "cc_rsi_evidence_append_only"();
CREATE TRIGGER "cc_append_only__AutonomyPromotionDecision"   BEFORE UPDATE OR DELETE ON "AutonomyPromotionDecision"   FOR EACH ROW EXECUTE FUNCTION "cc_rsi_evidence_append_only"();
CREATE TRIGGER "cc_append_only__AutonomyRollbackRecord"      BEFORE UPDATE OR DELETE ON "AutonomyRollbackRecord"      FOR EACH ROW EXECUTE FUNCTION "cc_rsi_evidence_append_only"();

-- Builder / Judge 分离：PromotionDecision 的判定者不得是该候选的生成者（fail-closed）
CREATE OR REPLACE FUNCTION "cc_rsi_promotion_judge_separation"() RETURNS TRIGGER AS $$
DECLARE builder text;
BEGIN
  SELECT "builderRef" INTO builder FROM "AutonomyCandidate" WHERE "id" = NEW."candidateId";
  IF builder IS NULL THEN RAISE EXCEPTION 'RSI_PROMOTION_CANDIDATE_MISSING: candidate % not found', NEW."candidateId"; END IF;
  IF NEW."judgeRef" = builder THEN RAISE EXCEPTION 'RSI_BUILDER_JUDGE_SAME_ACTOR: judgeRef must differ from candidate.builderRef'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "cc_rsi_promotion_judge_separation" BEFORE INSERT ON "AutonomyPromotionDecision"
  FOR EACH ROW EXECUTE FUNCTION "cc_rsi_promotion_judge_separation"();
```

（实际文件中对每个触发器都先有 `DROP TRIGGER IF EXISTS`，保证 migration 可重复执行；
全文见 migration.sql，`migration.sql` 里没有任何其它 `DROP` / `ALTER COLUMN` / 数据语句。）

## 6. 已执行证据

| 项 | 结果 |
| --- | --- |
| `prisma validate` | valid（93 models） |
| `npx tsc --noEmit` | exit 0 |
| `rsi-schema-contract.test.ts` | 10/10 PASS |
| `architecture-contract.test.ts` | 142/142 PASS |
| `rsi-lifecycle.test.ts` | 5/5 PASS |
| `rsi-persistence-db.test.ts` @ ephemeral | 8/8 PASS（dedupe / CHECK / append-only / judge 分离 / lease 唯一+时间单调 / 无租户列） |
| `c18-exact-order-replay.mjs` | `WHOLE_SCHEMA_DIFF = ZERO`、`migrate status up to date`、**PASS** |
| `emit-check-append-only-sql.mjs` | `OK: append-only/controlled-mutation triggers=51` |
| `emit-check-sql.mjs` | `OK: 103 baseline / 80 immutable(contains organizationId) / 2 scoped` |

## 7. 请裁定

1. **MIGRATION SQL** 是否记 `PASS`（可进入 staging 解禁流程），还是还有必须修改项？
2. 裁决 ④ 的三条硬要求（dedupe / append-only / judge≠builder）是否按本轮实现认定落实？
3. 证据是否足够（本地 tsc + 静态合同测试 + 一次性库 8 例 + whole-schema diff = 0 + 两张触发器清单），
   还是需要补最小集合（请只列最小集）？
4. 若 PASS：下一步是否直接按 `migrate deploy → migrate status → whole-schema diff → DB invariant smoke`
   在**宿主提供的非生产 `DATABASE_URL`** 上执行 staging smoke（production deploy 仍单独送审）？

## 8. HOST_ACTION（仅 1 条新增，其余不变）

- 本机 `gh` token 失效 → 若希望恢复「GitHub issue #2 comment 作为耐久记录」的通道，请重新 `gh auth login`；
  在此之前，耐久记录使用仓库内本文件（已在 GitHub 上）。

外部边界不变：注册 / 商业协议 / KYC / POA / 生产凭据 / 付费 / 真实外写 / 真实报关退款 / Search Console
全部仍属 `HOST_ACTION_REQUIRED`，本轮不涉及。

请在本次会话中直接回答；不要尝试写回 GitHub。不要使用上一轮缓存。
