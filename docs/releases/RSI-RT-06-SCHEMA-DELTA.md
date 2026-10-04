# RSI-RT-06 — RSI 自治运行时状态持久化 Schema Delta

- 依据裁决：**MSG-20261005-01 = PASS WITH REVISE**（`RSI_SCHEMA_DELTA = APPROVED_WITH_REVISIONS`）
- 送审基线：`reviewed HEAD = 328592d`；本文件随首批落地提交
- 目标：让 RSI Controller 在 `reboot` 后能 reconcile、不重复创建 incident / candidate / promotion、能回收 lease、并留下不可篡改的证据
- **本批只做 schema + migration draft + 临时库验证；`migrate deploy` 未执行**（`MIGRATION_APPLIED = NO`）

---

## 1. 归属：平台级（带显式契约例外）

```
RSI_SCOPE = PLATFORM_LEVEL
RSI_PLATFORM_SCOPE_EXCEPTION = APPROVED
```

RSI 管的是**系统运行**（运行健康 / 自动化循环状态 / incident-candidate-evaluation-promotion-rollback / agent-controller 生命周期），
不是客户业务对象，因此**不引入** `organizationId` / `tenantId` / `customerId` —— 否则会把「客户数据域」和「RSI 运维自治域」混在一起。

契约例外明确写死：

- RSI 表**不是**业务租户表；
- RSI **不保存**客户数据；
- RSI **不保存**客户授权；
- RSI **不参与** recovery claim / payment / provider execution。

> 这条例外不允许被当作「绕过租户隔离」的通行证：`rsi-schema-contract.test.ts` 会逐表断言 RSI 模型里
> 不出现任何租户列；仓库自带的 `emit-check-sql.mjs` 也会断言「含 `organizationId` 的表必须有
> `cc_tenant_immutable__*`」，RSI 表不在该集合内 —— 两个方向同时锁死。

## 2. 八张表

| 模型 | 关键列 | 约束 |
| --- | --- | --- |
| `AutonomyIncident` | `kind`, `dedupeKey`, `status`, `riskClass`, `sourceRefs(JSON)`, `detectedAt` | `UNIQUE(dedupeKey)`；`status` / `riskClass` CHECK |
| `AutonomyTask` | `incidentId`, `status`, `riskClass`, `ownerGateRequired`, `dedupeKey` | `UNIQUE(dedupeKey)`；FK → Incident |
| `AutonomyCandidate` | `taskId`, `status`, `builderRef`, `baselineRef`, `codeCommitRef`, `promptVersion`, `dedupeKey` | `UNIQUE(dedupeKey)`；`builderRef` 非空；FK → Task |
| `AutonomyEvaluationRun` | `candidateId`, `kind`, `status`, `startedAt`, `finishedAt` | `kind` / `status` CHECK；FK → Candidate |
| `AutonomyMetricResult` | `evaluationRunId`, `name`, `value DECIMAL(18,6)`, `unit`, `recordedAt`, `supersedesId` | **append-only**；FK → EvaluationRun |
| `AutonomyPromotionDecision` | `candidateId`, `dedupeKey`, `decision`, `reason`, `judgeRef`, `decidedAt`, `supersedesId` | **append-only**；`UNIQUE(dedupeKey)`；`judgeRef <> candidate.builderRef` |
| `AutonomyRollbackRecord` | `candidateId`, `targetRef`, `reason`, `triggeredBy`, `recordedAt`, `supersedesId` | **append-only**；FK → Candidate |
| `AutonomyLease` | `taskId`, `ownerRef`, `acquiredAt`, `renewedAt`, `expiresAt`, `status` | `UNIQUE(taskId)`；`status` CHECK；时间单调 CHECK |

### 2.1 `renewedAt`（裁决 ②）

只有 `expiresAt` 无法区分「正常续租 / controller 卡死 / 时钟漂移 / 网络延迟」。
新增 `renewedAt` 后，健康判断有唯一依据：`now - renewedAt`。状态值域 `ACTIVE | EXPIRED | RELEASED`。

### 2.2 生命周期状态：TEXT + CHECK，不用 PostgreSQL enum（裁决 ③）

RSI 是自治系统、状态会迭代；用 DB enum 意味着新增状态要 `ALTER TYPE` + migration deploy，风险更高。
因此：

- `status` / `decision` / `kind` 一律 `TEXT NOT NULL CHECK (... IN (...))`；
- 值域**单源**在 `apps/api/src/services/autonomy/rsi-lifecycle.ts`
  （`RSI_INCIDENT_STATES` / `RSI_TASK_STATES` / `RSI_CANDIDATE_STATES` / `RSI_LEASE_STATES` /
  `RSI_EVALUATION_KINDS` / `RSI_EVALUATION_RUN_STATES` / `RSI_PROMOTION_DECISIONS` / `RSI_RISK_CLASSES`）；
- `rsi-schema-contract.test.ts` 把 migration 里的 CHECK 值域与上述常量**逐项比对**，任一侧漂移即 CI 红。
- 内部不可变分类（`IncidentSeverity` / `CandidateType` / `PromotionAction`）继续由应用层枚举管理，不落 DB 类型。

## 3. 三条硬要求（裁决 ④）

**A. dedupe**：`AutonomyIncident` / `AutonomyTask` / `AutonomyCandidate` / `AutonomyPromotionDecision`
各有 `UNIQUE(dedupeKey)`。`reboot → controller restart → 重复创建 incident → 重复 promotion` 在 DB 层被拒绝。

**B. PromotionDecision fail-closed**：`cc_rsi_promotion_judge_separation()` 触发器在
`BEFORE INSERT` 时读 `AutonomyCandidate.builderRef`，若 `NEW.judgeRef = builder` 直接
`RAISE EXCEPTION 'RSI_BUILDER_JUDGE_SAME_ACTOR'`；候选不存在则 `RSI_PROMOTION_CANDIDATE_MISSING`。
生成者不能自我批准。

**C. 证据表 append-only**：`cc_rsi_evidence_append_only()` 触发器挂在
`AutonomyMetricResult` / `AutonomyPromotionDecision` / `AutonomyRollbackRecord` 的
`BEFORE UPDATE OR DELETE`，任何改写直接 `RAISE EXCEPTION 'RSI_EVIDENCE_APPEND_ONLY'`。
新事实只能是**新记录 + `supersedesId`**。

## 4. migration 流程（裁决 ⑤，与 C18 同级）

```
APPROVED → 人工审 SQL → 生成 migration → ephemeral database deploy → whole-schema diff = 0 → 测试 → staging unlock
                                                                                              ↑ 当前到这里为止
PRODUCTION = HOLD（不改变，不允许 migration → production deploy）
```

migration 目录：`apps/api/prisma/migrations/20261005000000_rsi_autonomy_state_persistence/migration.sql`

- 结构部分由 `prisma migrate diff`（一次性库先应用全部既有 migration → 当前 `schema.prisma`）生成，
  只含 RSI-RT-06 的 8 张新表 + 索引 + 外键；
- 尾部手工追加 DB 不变量（CHECK / append-only / judge 分离），全部是 `ADD CONSTRAINT` / `CREATE TRIGGER`；
- 只 DROP 本 migration 自建的触发器（保证可重复执行），不删表、不改列型、不导出数据、不建 PG 类型。

## 5. RSI 权限边界（裁决 ⑥）

```
RSI_ALLOWED   : read system state / internal orchestration / health-reconcile / retry scheduling
                / lifecycle management / metrics collection
RSI_FORBIDDEN : External Write / Payment / Transport / Provider API mutation / Customer action
                / Credential handling / Token storage
保持          : TRANSPORT=false, EXTERNAL_WRITE=HOLD, PAYMENT=HOLD, PRODUCTION_CREDENTIALS=HOLD
```

## 6. 本批证据

| 证据 | 结果 |
| --- | --- |
| `prisma validate` | valid（93 个模型） |
| `npx tsc --noEmit`（apps/api） | `EXIT=0` |
| `rsi-schema-contract.test.ts` | 10/10 PASS（平台级无租户列 / TEXT+CHECK 单源 / dedupe / renewedAt / append-only / judge 分离 / 结构安全 / 恰好 8 张表） |
| `architecture-contract.test.ts` | 142/142 PASS（模型总数 85 → 93） |
| `rsi-lifecycle.test.ts` | 5/5 PASS（新增常量不改变既有状态机语义） |
| `rsi-persistence-db.test.ts`（一次性库） | 8/8 PASS（真实 PG：dedupe、CHECK、append-only、judge 分离、lease 唯一与时间单调、无租户列） |
| `c18-exact-order-replay.mjs` | `EXACT_ORDER_DIFF_LINES=0` / `WHOLE_SCHEMA_DIFF = ZERO` / `migrate status up to date` / **PASS** |
| `emit-check-append-only-sql.mjs` | `OK: append-only/controlled-mutation triggers=51` |
| `emit-check-sql.mjs` | `OK: required tenant triggers=103 baseline, 80 immutable, 2 scoped`（organizationId 表数未变） |

## 7. 边界与未做

- `migrate deploy` **未执行**；`MIGRATION_APPLIED = NO`；未接触 dev / shared / production 库（只在一次性库 `crossclaim_*` 上验证后 DROP）。
- 未注册任何 HTTP 路由；未开 External Write / Payment / Transport / 生产凭据。
- 未写任何 reconcile / 幂等业务逻辑 —— 那属于本 Delta 通过后的下一个单元。
- `staging unlock` 与 `production enablement` 仍 BLOCKED。

## 8. 下一步（等审查）

1. 提交 migration SQL 审计材料（GitHub issue #2 耐久记录 + 本文件引用）。
2. 审查通过后：在一次性库按 exact-order 复跑 → 再解禁 staging（需宿主提供非生产 `DATABASE_URL`）。
3. 之后才实现 reconcile / 去重 / lease 回收的运行时逻辑。
