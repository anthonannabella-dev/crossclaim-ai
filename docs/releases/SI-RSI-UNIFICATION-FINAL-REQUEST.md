> **[HISTORICAL_SNAPSHOT]** 本文是历史审计 / 证据快照，原文保留不改写（历史裁决不删除）。
> 其中关于 `RUNTIME_WIRING` / `STEP_3_RUNTIME_POLICY_WIRING` / `RSI_OUTCOME_SINK_RUNTIME_WIRING`
> 的**当时状态**已被后续实现取代：SUPERSEDED_BY=c0b61792（STEP_3_RUNTIME_POLICY_WIRING：
> Recovery SI 作为 domain capability pack 接入 ONE CrossClaim SI Runtime；后续 FINAL-2..6 与 PHASE 2
> 见 ca23b1df / adcab905 / ca298187 / 5f9ce46f / 6e98e66e）。
> 唯一**现行**状态请以 `docs/releases/CURRENT-SI-RSI-STATUS.md` 为准
> （SUPERSEDED_BY=cdd95258 为该状态件的基线 HEAD）。

# SI-RSI Unification —— FINAL（docs-only 收口）送审请求

- 分支：`gate/7-commercial-validation`；仓库 `anthonannabella-dev/crossclaim-ai`
- **REVIEWED_HEAD = 本文件所在提交**（docs-only 收口提交；exact SHA 在本次会话正文给出，便于独立复核）
- 前置：**MSG-20261005-28 = PASS WITH REVISE**（`OPTION_A_LOGICAL_UNIFICATION = APPROVED`；
  `OPTION_B = NOT_AUTHORIZED`；`SI_RSI_UNIFICATION_DESIGN = APPROVED_WITH_CONDITIONS`；
  `SI_RSI_UNIFICATION_V1 = NOT_YET_CLOSED`）
- 本轮性质：**docs-only**（零产品代码、零 rename/move/delete、零运行时接线）

## 1. 新增 / 修订产物

| 文件 | 内容 |
| --- | --- |
| `docs/releases/SI-RUNTIME-COMPONENT-REGISTRY.md` | **新增**：组件注册表（唯一 owner 表 + 依赖方向 + dev-scope 定义 + 三层分离 + 跨域边界 + 状态/门禁） |
| `docs/releases/SI-RSI-UNIFICATION-DESIGN-REQUEST.md` | **修订**：新增 §7「REVISE 修订落地」（autopilot dev-scope / Policy Pack 静态组合方向 / Guard-Action Binding 留 Pack / 跨域 lineage 不加字段 / 命名风险冻结 / Step 3 NOT_AUTHORIZED） |
| `docs/releases/SI-RSI-UNIFICATION-INVENTORY.md` | 盘点（未改动） |

## 2. U1–U8 最小收口证据（逐条）

| 编号 | 要求 | 证据 | 结果 |
| --- | --- | --- | --- |
| U1 | `SI-RUNTIME-COMPONENT-REGISTRY.md` 存在；每个组件恰好一个 owner | 注册表 §1「唯一 owner 表」（13 行组件 × 单一 owner 列） | PASS |
| U2 | 第二 owner 不得出现（control plane / policy core / kill switch / model gateway / cost core） | 注册表 §1 末列「第二 owner = 禁止」；并显式冻结 `SECOND_CONTROL_PLANE / SECOND_POLICY_ENGINE / SECOND_COST_LEDGER / SECOND_META_EVIDENCE_STORE / SECOND_RUNTIME = FORBIDDEN` | PASS |
| U3 | `tools/autopilot/**`：`productRuntimeMember=false` / `devScope=true` | 注册表 §1 末行 + §3；`AUTOPILOT_AS_PRODUCT_RUNTIME_FAILOVER = FORBIDDEN`、`PRODUCT_RUNTIME_SPAWNS_AUTOPILOT = FORBIDDEN` | PASS |
| U4 | apps/api 产品 runtime 不 import / spawn `tools/autopilot` | `rg -n "autopilot" apps/api/src` → **0 命中** | PASS |
| U5 | Recovery Policy Pack → Policy Core；Policy Core 不反向 import 域包 | `rg -n "rsi-policy-engine" apps/api/src/services/intelligence/recovery-policy.ts` → 命中（第 11 行 import `decideRsiPolicyAction`）；`rg -n "services/intelligence|recovery-policy|recovery-persist" apps/api/src/services/autonomy/rsi-policy-engine.ts` → **0 命中** | PASS |
| U6 | Guard-Action Binding 仍只引用现有 `ACTION_GUARD_CATALOG`；`CUSTOMS_FILING` 不放宽 | `RGAM/RAGM` 定义于 `recovery-guard-dry-run.ts`（第 41/49 行）；`rsi-policy-engine.ts` 中 0 命中；`CUSTOMS: null`（第 45 行）与 `GUARD_ACTION_UNMAPPED_L5_NO_CATALOG_ACTION`（第 274 行）未改动 | PASS |
| U7 | P2-E exact closed boundary 无代码变化 | `git diff --name-only 054ab732..HEAD -- apps/api` → **0 行** | PASS |
| U8 | 本轮 git diff 无 runtime wiring / rename / move / delete | `git diff --name-status <前置簿记 HEAD>..HEAD` → 仅 `docs/releases/**`（新增/修改）+ `.autopilot/**` + `tools/autopilot/backlog.json`；无 `apps/api/**`、无 R/D 状态 | PASS |

## 3. 措辞冻结（避免把逻辑统一说成已接线）

```text
ONE CrossClaim SI Runtime = 目标架构 / 逻辑归属（本轮不表示 Recovery SI 已跑进 rsi event loop）
RUNTIME_WIRING = NONE
NO_CODE_CHANGE / NO_RENAME / NO_MOVE / NO_DELETE（维持）
STEP_3_RUNTIME_POLICY_WIRING = NOT_AUTHORIZED（必须单独送审）
```

## 4. 请求裁决

1. U1–U8 是否足够、`SI_RSI_UNIFICATION_V1` 是否可记 **PASS / CLOSED**（`FINAL2_REQUIRED = ?`）？
2. 是否确认 `STEP_3_RUNTIME_POLICY_WIRING = NOT_AUTHORIZED`，需单独架构审？
3. 是否确认 `SI-COST-OPTIMIZATION` 在本任务 PASS/CLOSED 后由 `QUEUED → READY_FOR_DESIGN`
   （**不**等于 `AUTO_IMPLEMENTATION_AUTHORIZED`；其 durable ledger / budget / model cache / AI necessity gate 仍需各自设计/实施审计）？
4. 若仍需修订，请只列最小集合。

请在本次会话中直接回答；不要尝试写回 GitHub。不要使用上一轮缓存。

## 5. 边界声明（本轮未改动）

```text
SECOND_RUNTIME / SECOND_POLICY_ENGINE / SECOND_COST_LEDGER / SECOND_META_EVIDENCE_STORE = FORBIDDEN
L5_RELAXATION = FORBIDDEN；CUSTOMS_FILING = FORBIDDEN（继续永久拒绝）
P2_F = HOLD；P2_G = HOLD
REAL_MODEL_NETWORK / PAID_MODEL_CALLS = HOLD
EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS / PRODUCTION_ENABLEMENT = HOLD
P2_E_V1_OPTION_A = PASS / CLOSED（边界 KEEP / DO NOT MODIFY）
FINAL_ACCEPTANCE_HEAD = 0f7f7ac
```
