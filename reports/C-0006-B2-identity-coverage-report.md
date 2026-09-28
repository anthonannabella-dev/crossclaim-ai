# C-0006-B2 — Canonical Identity Coverage 最终报告（Step 3 前置）

- 分支：`gate/4-canonical-fact-layer`
- HEAD：`23bfa11`
- 结论：身份分层、覆盖率监控与切换门槛均已实现并被真实数据库测试逐项断言；**当前 `canSwitch = false`（存在 1 条 DUPLICATE_TARGET），不得进入 Step 3**

## 1. 身份定义

| 身份 | 组成 | 状态 |
|---|---|---|
| 旧身份 `RuleEvaluation.dedupeKey` | organization + ruleVersion + invoiceTransaction + trackingTransaction | 保留、仍为唯一约束与幂等依据 |
| 新身份 `RuleEvaluation.canonicalDedupeKey` | sha256(organization + ruleVersion + canonicalFact) | 双写中；逻辑唯一由 `@@unique([organizationId, ruleVersionId, canonicalFactId])` 保证，hash 单列唯一为二级完整性约束 |

## 2. 覆盖率观察值（真实 PostgreSQL 断言）

| 场景 | 评估数 | 带新身份 | 覆盖率 | 证据 |
|---|---|---|---|---|
| 正常（事实全 ACTIVE） | 2 | 2 | `1.0000` | `identity-step2-db.test.ts` 用例 1 |
| 重复执行同一检测（Run #2） | 0 新增 / 2 复用 | 2 | `1.0000` | 同上（零意外增量、parity 仍 OK） |
| 事实被置为 CONFLICT | 2 | 1 | `0.5000` | 同上用例 3（`evaluationsWithoutCanonicalIdentity = 1`，显式告警） |
| 回填后（1 条历史冲突行拒绝覆盖） | 4 | 3 | `0.7500` | 同上用例 2；最终 `unmapped = { DUPLICATE_TARGET: 1 }` |

## 3. unmapped 分类与处置建议

| 分类 | 含义 | 处置 |
|---|---|---|
| `NO_SOURCE_TRANSACTION` | 评估没有原始行引用 | 保持 NULL，禁止猜测 |
| `NO_ACTIVE_FACT` | 原始行没有任何事实层记录 | 保持 NULL，等事实补齐后再回填 |
| `CONFLICT_FACT` | 对应事实为 CONFLICT | 保持 NULL；这是"数据不可确定"，不是缺数据 |
| `AMBIGUOUS_FACTS` | 一条原始行对应多条事实（异常） | 人工复核 |
| `DUPLICATE_TARGET` | 目标身份已被其他行占用 | 由 duplicate-resolution-report 给出等价性与建议，禁止自动覆盖/删除 |

处置建议由 `buildDuplicateResolutionReport()` 产出（只读）：原 RuleEvaluation id、目标 canonicalFact、已存在身份行、是否等价（同规则版本 + 同原始行）、`KEEP_EXISTING` / `MANUAL_REVIEW` / `NO_ACTION`。

## 4. 切换门槛（Step 3 前置条件）

`canSwitch = (unmapped 全为 0)`，五类计数全部必须为 0。当前实测：`DUPLICATE_TARGET = 1` → **门槛未满足**。

## 5. 证据索引

- `apps/api/src/services/canonical/identity-backfill.ts`（planner + apply，dry-run 默认）
- `apps/api/src/services/canonical/identity-parity.ts`（覆盖率 / 重复身份 / 事实链一致性）
- `apps/api/src/services/canonical/duplicate-resolution.ts`（重复来源分析，只读）
- `apps/api/src/services/rules/prisma-detection-repository.ts`（同事务双写 + MISSING 标记）
- 测试：`identity-backfill-db.test.ts`(2)、`identity-step2-db.test.ts`(4)
- CI：27 test files / 350 tests，9 条 migration，19 个租户触发器（HEAD `23bfa11`）
