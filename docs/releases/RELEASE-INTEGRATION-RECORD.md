# RELEASE INTEGRATION RECORD（main ← gate）

- 时间：2026-10-04；依据 HOST DIRECTIVE「FINAL ACCEPTANCE → RELEASE INTEGRATION → LAYER 3 ENTRY」

## 1. 结果

| 项 | 值 |
|---|---|
| 合并方式 | **PR #12 merge commit**（未使用 force push / reset） |
| Merge commit（main 新 head） | `5a340bc` |
| Main CI | run `37159776098` → **success**（5/5 job） |
| RELEASE_CANDIDATE / FROZEN ACCEPTANCE TREE | `0f7f7ac`（已随合并进入 main 历史） |
| RELEASE_BASELINE_READY | **YES**（依据：main 自身 CI SUCCESS，非沿用 gate CI） |

## 2. Divergence 处理

- 初始状态：`main` = `16b47a2`、`gate` tip = `2948612`，status = diverged（gate ahead 900 / behind 2），PR 首次合并报 **405 merge conflicts**。
- 冲突文件 4 个：`.github/workflows/ci.yml`、`DOMAIN_MODEL.md`、`tools/tenant-triggers/required-triggers.json`、`tools/upgrade-verify/two-stage-upgrade.mjs`。
- 处置：在 gate 本地 `git merge origin/main`，4 个冲突**一律取 gate（演进后）版本**，并核验 gate 版本保留 main 侧能力：
  - `ci.yml` 仍含 migration checksums / tenant-integrity triggers / append-only triggers / two-stage upgrade / acceptance-consistency 全部步骤；
  - `required-triggers.json` baseline 触发器 **99 项**（main 侧 40 项的超集）。
- 结果：生成合并提交 `a6ba5e8`，使 `origin/main` 成为 gate 的祖先 → PR 可无冲突合并。
- main 独有 2 个提交（`e40d4f9` / `16b47a2`）的实质内容**已在 gate 中等价包含并演进**（见 `RELEASE-INTEGRATION-PLAN.md` §2 的 12 项逐件核验），故**未 cherry-pick**，也未丢失任何 main 侧内容。

## 3. 合并前闸门（gate 树实测）

fresh DB 66 迁移 / prisma validate / api+web tsc / `next build` / **全量套件 277 文件 2725 用例** / 并发专项 4 文件 60 用例 / 四域 golden path / security negative paths —— **全 PASS**；PR CI 5/5 success。

## 4. main 分支保护（已启用，非宿主待办）

| 设置 | 值 |
|---|---|
| Require pull request before merging | 开 |
| Required approvals | 0（`dismiss_stale_reviews=true`；见 §5 待决） |
| Require status checks（strict） | 开：`API · migration + typecheck + tests`、`Web · typecheck + build`、`Deploy smoke · fresh install + migration upgrade`、`许可证闸门`、`Backup restore verify · synthetic dataset` |
| Do not allow bypassing（enforce_admins） | 开 |
| Allow force pushes | 关 |
| Allow deletions | 关 |
| Require conversation resolution | 开 |

## 5. 待宿主决策（不阻塞 RELEASE_BASELINE_READY）

1. **Required approvals 建议 ≥1**：当前设为 0，原因是仓库目前只有单一维护者（token 属主），设置 1 会导致自审 PR 无法合并而阻塞 release；若有第二位 reviewer，请告知以调升。
2. **release tag**：生产候选 commit 确定后打 tag（属宿主生产决策）。
3. **仓库可见性**：当前为 `public`；如需变更为 private（或反之）属宿主授权项，本轮未改动。

## 6. Layer 3 状态（未变）

INTEGRATION_COMPLETE = NO · REAL_VALIDATION_COMPLETE = NO · PRODUCTION_READY = NO；
`networkImplemented=false` / `platformWriteEnabled=false` / `transportEnabled=false` / `oauth·refresh·revoke.implemented=false` / `productionCredentials=ABSENT` / `bindExecuted=false`；
`PROVIDER_CONTRACT_READY = YES` 但 `REAL_PROVIDER_INTEGRATION = NO`。
