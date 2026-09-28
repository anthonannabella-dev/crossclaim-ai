# C-0006-B2 — Canonical Final Parity Report（Step 3 Final Gate 前置）

- 分支：`gate/4-canonical-fact-layer`
- HEAD：`0464c05`
- 范围：canonical 身份模式的最终对拍证据 + duplicate resolution + active unmapped 门禁
- 结论：技术验证全部通过，`active unmapped = 0`、`canSwitch = true`；**生产默认切换尚未开启**（等架构方最终裁定，且生产部署属 HOST APPROVAL REQUIRED）

## 1. canonical 模式两轮运行（真实 PostgreSQL）

| 指标 | Run #1 | Run #2 |
|---|---|---|
| evaluationsCreated | 2 | 0 |
| skippedExisting | 0 | 2 |
| evaluationsWithoutCanonicalIdentity | 0 | 0 |
| identity coverageRate | `1.0000` | `1.0000` |
| RuleEvaluation 总数 | 2 | 2（零意外增量） |

两轮都以 `canonicalDedupeKey` 判幂等；旧 `dedupeKey` 同时写入（双写保留回滚能力）。

## 2. identity parity（canonical 模式）

- `parity = OK`
- `duplicates = 0`（不存在"一个事实 + 一个规则版本"对应多行）
- `factLinkMismatches = 0`（每个 canonicalFactId 都能经 CanonicalFactSource 追溯回该行的原始行）
- `coverageRate = 1.0000`

## 3. fail-closed 证据（取消自动 fallback）

把 INV-1002 的事实置为 CONFLICT 后运行 canonical 模式：

- 抛 `CANONICAL_IDENTITY_REQUIRED`（整个检测在该评估处停止）
- 缺身份的发票**没有任何 RuleEvaluation 落库**
- 已可映射的发票按新身份正常写入

即：canonical 模式不会退化到旧键，也不会产生隐藏双轨。

## 4. rollback 再验证

canonical 跑完 → 切回 `legacy` → `evaluationsCreated = 0`、`skippedExisting = 2`：

- 两把键同时存在（`dedupeKey` 与 `canonicalDedupeKey` 均非空）
- 旧唯一约束从未删除，回滚不需要任何数据修复

## 5. duplicate resolution 与切换门禁

| 项目 | 值 |
|---|---|
| duplicate-resolution-report 条目 | 1（reason=`DUPLICATE_TARGET`，`equivalent=true`） |
| 处置建议 | `KEEP_EXISTING` + review-only（不删除、不覆盖） |
| 审计事件 `identity.duplicate_resolved` | 1 条，含 duplicateReport / originalRuleEvaluationId / retainedRuleEvaluationId / markedRuleEvaluationId / resolution / resolver |
| 重复行状态 | 仍存在，`canonicalFactId` 保持 NULL（review-only） |
| `resolved_unmapped` | 1 |
| `active unmapped` | **0** |
| `canSwitch` | **true** |

## 6. 证据索引

- 代码：`services/rules/identity-mode.ts`、`services/rules/prisma-detection-repository.ts`、`services/canonical/identity-{parity,backfill,resolution}.ts`、`services/canonical/duplicate-resolution.ts`
- 工具：`src/tools/identity-backfill.ts`、`src/tools/identity-duplicates.ts`、`src/tools/identity-resolve-duplicates.ts`
- 测试：`identity-step2-db.test.ts`（canonical 正常 / canonical fail-closed / rollback / duplicate resolution）、`identity-backfill-db.test.ts`
- CI：27 test files / 355 tests，9 条 migration，19 个租户触发器（HEAD `0464c05`）
