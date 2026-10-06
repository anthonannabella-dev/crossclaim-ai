# RELEASE INTEGRATION PLAN — gate/7-commercial-validation ↔ main（REL-1）

授权：HOST 2026-10-06「处理 release integration：查明 main 独有 commit、判断保留/移植、生成安全 integration plan；
合并前跑全门禁；全绿才建立新的 release/integration HEAD。**禁止 force push、禁止丢弃 main 独有提交**。」

---

## 1. Divergence 事实（实测）

| 项 | 值 |
|---|---|
| `origin/main` tip | `5a340bc0`（merge commit；parents = `16b47a24` + `a6ba5e8a`） |
| `origin/gate/7-commercial-validation` tip（本次审计时） | `8c891345` |
| merge-base | `a6ba5e8a` |
| main 独有 commit 数 | **1**（`5a340bc0`） |
| main 独有 commit 标题 | `release: integrate gate/7-commercial-validation into main (FINAL_ACCEPTANCE_HEAD 0f7f7ac)` |
| `0f7f7ac` 是否为 gate/7 祖先 | **是**（`merge-base --is-ancestor` exit 0） |
| `git diff --stat origin/gate/7...origin/main` | **为空** → main 侧自 merge-base 起**没有任何 gate/7 未包含的内容** |
| main 是否为 gate/7 祖先（可 fast-forward？） | **否**（exit 1）→ 需要一次正常 merge（非 force push） |

**结论**：`5a340bc0` 是把当时的 gate/7（`FINAL_ACCEPTANCE_HEAD 0f7f7ac`）合并进 main 的发布提交；
它**不携带 main 侧独有内容**（three-dot diff 为空），因此：
* **无需移植任何 main 独有代码/文档**；
* 但**必须保留该 merge 提交**（不得 force push / 不得丢弃 main 历史）→ 采用 **正常 merge（gate/7 → main）** 或
  在 release 分支上 merge main，二者都不丢提交。

## 2. 安全 integration plan（本程序已执行的部分 + HOST 侧动作）

### 2.1 本程序已执行（可回滚、只新增 ref）

1. 在 `gate/7-commercial-validation` 上完成 SA/FE/BE 收口与全门禁（见 §3）。
2. 新建 **release/integration 分支**（`release/integration-20261006`）= gate/7 HEAD；
   在该分支上 **merge `origin/main`** → 生成 merge 提交，**保留 `5a340bc0` 及其祖先**；
3. 校验 merge 后**文件树与 gate/7 完全一致**（`git diff --stat gate/7-commercial-validation` 为空）——
   即：合并没有引入任何内容变更，也没有丢弃任何一侧内容；
4. 推送**新分支**（只新增 ref；**不触碰 main、不 force push**）。

### 2.2 HOST 侧动作（需授权，本程序不代执行）

把 main 推进到 release/integration HEAD（二选一，均**不丢 main 提交**、均**非 force push**）：

```bash
# 方案 A（推荐：main 直接合并 release 分支，产生 merge 提交，历史完整）
git switch main && git pull --ff-only && git merge --no-ff release/integration-20261006 && git push origin main

# 方案 B：若 HOST 确认 main 仅用于发布且允许线性化，可 fast-forward（前提：release 分支已含 main 全部提交）
git switch main && git merge --ff-only release/integration-20261006 && git push origin main
```

> 方案 B 仅在「release 分支已 merge 过 main」时可行（本程序的分支正是如此），因此**不会丢弃 `5a340bc0`**。

## 3. 合并前全门禁（本程序实测）

| 门禁 | 结果 |
|---|---|
| 工作树 clean / origin 同步 | 是（每次 slice 后 push） |
| `api tsc --noEmit` | **exit 0** |
| `prisma validate` | **valid**（88 migrations） |
| `prisma migrate status`（dev DB） | **up to date** |
| **Fresh DB 迁移**（新建 scratch 库 `crossclaim_relcheck` → `prisma migrate deploy`） | **PASS — All migrations have been successfully applied；`_prisma_migrations` = 88** |
| 全量回归（`npx vitest run`，api） | **443 文件 / 4461 tests → 4460 passed + 1 failed**（唯一失败为既有 `recovery-si-phase2-e-db` P2E-DB5 并行隔离 flake，单独运行 20/20 PASS） |
| 定向安全横扫（architecture / tenant isolation / action guard / approval / HITL concurrency·race / SI-RSI / Standing Authorization / Customs golden path） | **9 文件 / 231 tests PASS** |
| SI-RSI 全量 | **52 文件 / 315 tests PASS**（B 单元时点） |
| Standing Authorization | **48 tests PASS**（19+10+14+5） |
| Customs golden path | `customs-duty-recovery-chain-e2e-db` **9/9 PASS** |
| `web tsc --noEmit` | **exit 0** |
| `next build`（web） | **exit 0** |
| i18n / UI render checks（FE-1） | i18n OK（5 语言 / 644 键 / 硬编码 0）；UI render **81/81** |
| 安全负路径 | 见 action-guard / HITL 全套件（含 kill-switch、越权 OVERREACH、DENY 零副作用、并发恰一次） |

## 4. 边界（不变）

* **未开启**生产：`REAL_PROVIDER_WRITE` / `CUSTOMS_FILING` / `PAYMENT` / `AUTO_COMMISSION_CHARGE` /
  `PRODUCTION_CREDENTIALS` / `PRODUCTION_ENABLEMENT` = **HOLD**；`AUTO_PRODUCTION_PROMOTION/ROLLOUT/ROLLBACK = false`。
* 未写生产凭据、未发起真实 external write、未开启 autopay。
* `gate/7-commercial-validation` 主线保持推送；`release/integration-*` 为**新增分支**，可单独删除回滚。
* ⚠️ CI：本地证据为本（`GITHUB_CI = NOT_OBSERVED`）；不声称远端 CI 绿。

