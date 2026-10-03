# RELEASE INTEGRATION PLAN（main ← gate/7-commercial-validation）

- 时间：2026-10-04；依据 HOST DIRECTIVE「FINAL ACCEPTANCE → RELEASE INTEGRATION → LAYER 3 ENTRY」§三
- FINAL_ACCEPTANCE_HEAD = `0f7f7ac`；CI `37142365134` = SUCCESS；INDEPENDENT ARCHITECT AUDIT = PASS

## 1. Divergence analysis（实测）

| 项 | 值 |
|---|---|
| `main`（origin/main） | `16b47a2`（Merge PR #11） |
| `gate/7-commercial-validation` | `23b92ef`（本分支 tip；含本轮 STATE 救济后为最新） |
| merge-base | `fc4e18f` |
| status | **diverged**（gate ahead 900 / behind 2） |
| main 独有提交 | `e40d4f9`（B2-FIX R1 集成提交）、`16b47a2`（其合并提交，second parent = e40d4f9） |

## 2. main 独有 2 个提交的处置判断

`e40d4f9` 触碰 21 个文件（B2 归属不可变迁移、三份 B2 行为测试、tenant-trigger 清单式 CI、migration checksum 工具、two-stage upgrade 工具、B2 文档）。

**逐件核验结果：全部 12 个关键产物均已存在于 gate 分支**（`git cat-file -e origin/gate…:<path>` 全部成功）：

```
IN_GATE  .github/workflows/ci.yml
IN_GATE  apps/api/src/__tests__/b2-tenant-ownership-behavior-db.test.ts
IN_GATE  apps/api/src/__tests__/b2-reference-behavior-db.test.ts
IN_GATE  apps/api/src/__tests__/b2-ruleset-ownership-behavior-db.test.ts
IN_GATE  tools/tenant-triggers/emit-check-sql.mjs
IN_GATE  tools/tenant-triggers/required-triggers.json
IN_GATE  tools/migration-checksum/check-migration-checksums.mjs
IN_GATE  tools/migration-checksum/pinned-checksums.json
IN_GATE  tools/upgrade-verify/two-stage-upgrade.mjs
IN_GATE  docs/releases/B2-FIX-R1-RECORD-CORRECTIONS.md
IN_GATE  B2-MIGRATION-HISTORY-ALIGNMENT.md
IN_GATE  B2-TENANT-IMMUTABILITY-PLAN.md
```

结论：main 独有的 2 个提交属于**合并拓扑独有**（gate 未包含该合并提交本身），其实质内容在 gate 中**已等价包含且为演进后版本**（B2 不可变触发器、行为测试、迁移校验工具在 gate 的 CI 中持续运行）。

→ **处置：不需要 cherry-pick；需要一次 merge（合并提交）**，因为两侧历史已 diverge，禁止 force / reset（HOST DIRECTIVE §三.1）。

## 3. 内容差异（main → gate）

- 696 个文件变化，`+176590 / -863` 行；差异集中于产品代码（apps/api、apps/web、prisma）与工程流水线（tools/**、.github/**）。
- `-863` 行属**同一文件的旧版本行**被新版替代（如 `server.ts`、`payment.ts`、`http-routes.ts` 的重构），非“main 独有内容丢失”：
  - 抽查 `apps/api/src/server.ts`：main 4 行旧实现 → gate 162 行新实现（净增）。
  - 抽查 `tools/tenant-triggers/required-triggers.json`：清单由 40 行扩到 407 行（新增触发器，无删除清单项导致的回归）。
- 反向确认：`git diff --name-status origin/gate..origin/main` 中针对 gate 为 `D` 的条目（`.autopilot/*`、`.github/workflows/audit-bridge.yml` 等）都是 **gate 新增文件**，不属于 main 独有内容。

## 4. Integration 方式（选定）

**PR merge（merge commit）**，不使用 force push、不使用 reset：

1. 在本分支完成最后一轮提交（STATE 救济 + 本计划）。
2. 开 PR：`gate/7-commercial-validation` → `main`，PR 正文附本计划与验收证据。
3. 启用 main 分支保护（PR-only + required checks + 禁 force/delete + 禁直推 + 1 review）。
4. 等 PR CI 全绿后 merge（merge commit）。
5. **在 main 自身**重新跑完整 CI；只有 main 自身 CI SUCCESS 才判 `RELEASE_BASELINE_READY = YES`。

## 5. 合并前闸门（本轮已在 gate 树实测）

| 闸门 | 结果 |
|---|---|
| fresh DB（空库 66 迁移） | PASS（78 表 / 173 FK / 208 唯一索引 / 175 CHECK / 237 触发器） |
| `prisma validate` | PASS |
| API typecheck / Web typecheck + build | 0 / 0 + `next build` 0 |
| Full PostgreSQL suite | PASS（全量 277 文件 / 2725 用例） |
| critical concurrency suite | PASS（4 文件 / 60 用例专项 + 内嵌断言） |
| four-domain golden path | PASS（Platform / Carrier / Customs / Independent-site） |
| security negative paths | PASS |

## 6. 合并后必须满足

- main 包含：Final Acceptance 产品代码、全部有效 migration、CI、tests、docs、安全边界、Layer 3 HOLD 状态。
- main 自身 CI SUCCESS（不得沿用 gate 的 CI 自证）。

## 7. 分支保护配置清单（拟应用于 main）

| # | 设置 | 值 |
|---|---|---|
| 1 | Require a pull request before merging | 开 |
| 2 | Required approvals | 1 |
| 3 | Dismiss stale approvals / require review of new commits | 开 |
| 4 | Require status checks to pass | 开（`API · migration + typecheck + tests`、`Web · typecheck + build`、`Deploy smoke · fresh install + migration upgrade`、`许可证闸门`、`Backup restore verify · synthetic dataset`） |
| 5 | Require branches to be up to date before merging | 开 |
| 6 | Do not allow bypassing（含 admins） | 开 |
| 7 | Allow force pushes | 关 |
| 8 | Allow deletions | 关 |
| 9 | Require conversation resolution（建议） | 开 |
| 10 | release tag 绑定生产候选 commit | 生产候选确定后打 tag（HOST 决策） |
