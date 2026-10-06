> **[HISTORICAL_SNAPSHOT]** 本文是历史审计 / 证据快照，原文保留不改写（历史裁决不删除）。
> 其中关于 `RUNTIME_WIRING` / `STEP_3_RUNTIME_POLICY_WIRING` / `RSI_OUTCOME_SINK_RUNTIME_WIRING`
> 的**当时状态**已被后续实现取代：SUPERSEDED_BY=c0b61792（STEP_3_RUNTIME_POLICY_WIRING：
> Recovery SI 作为 domain capability pack 接入 ONE CrossClaim SI Runtime；后续 FINAL-2..6 与 PHASE 2
> 见 ca23b1df / adcab905 / ca298187 / 5f9ce46f / 6e98e66e）。
> 唯一**现行**状态请以 `docs/releases/CURRENT-SI-RSI-STATUS.md` 为准
> （SUPERSEDED_BY=cdd95258 为该状态件的基线 HEAD）。

# SI-RSI Unification —— 设计/实施边界送审请求（ONE CrossClaim SI Runtime）

- 分支：`gate/7-commercial-validation`；仓库 `anthonannabella-dev/crossclaim-ai`
- 依据：HOST 架构指令 `docs/releases/SI-RSI-UNIFICATION-DIRECTIVE.md`
- 前置：`P2-E = PASS / CLOSED`（MSG-20261005-27，实现 HEAD `054ab732`）；`SI-COST-OPTIMIZATION` 已登记
  （`docs/releases/SI-COST-OPTIMIZATION-REGISTRATION.md`，P1，依赖本任务 PASS/CLOSED）
- **本轮零代码、零 rename、零删除、零运行时接线**；只提交盘点 + 最小统一方案
- 盘点证据：`docs/releases/SI-RSI-UNIFICATION-INVENTORY.md`（文件级计数 + 概念级分类 + 目标形态）

## 1. 目标

```text
RSI capabilities + Recovery SI → ONE CrossClaim SI Runtime
· 一个 SI 运行时（domain capability packs 挂载）
· ONE Control Plane / ONE Policy Core / ONE Kill Switch / ONE Model Gateway / ONE Cost Core
· 平台级 meta 证据与客户域业务事实分域并存（不双写、不新建第二账本）
```

## 2. 盘点结论（摘要，详见 inventory）

| 概念 | 统一后 owner | 分类 |
| --- | --- | --- |
| 动作目录 / 执行授权 | `action-guard/action-guard`（唯一 catalog） | KEEP + REUSE |
| 策略分级 L0–L5 | `rsi-policy-engine`（Recovery 策略降为 Policy Pack） | KEEP + MERGE（域内挂载） |
| 控制面 | `action-guard/control-plane` | KEEP（唯一） |
| Kill Switch | `operations/kill-switch(+resolver)` + `action-guard/kill-switch-adapter` | KEEP（唯一） |
| 模型网关 | `rsi-model-router`(+composition/local-sim，真实网络 HOLD) | KEEP（唯一） |
| 成本核心 | `rsi-cost-ledger` + `rsi-cost-policy` | KEEP + EXTEND（SI-COST-OPTIMIZATION 在此扩展） |
| Judge / 质量门 | `rsi-judge-orchestration` | KEEP（唯一） |
| 持续执行 / 调度 | `runtime/rsi-*`（产品 SI 运行时）；`tools/autopilot/**`（dev-scope） | KEEP（分层，不并入） |
| Recovery 域能力 | `services/intelligence/**`（含 P2-E 已关闭的 persist 边界） | KEEP（作为 domain pack） |
| 证据 / 审计 | 平台级 = `rsi-evidence-ledger`；客户域 = 既有 DB 实体 + AuditLog | KEEP SEPARATE |

## 3. 最小统一方案（建议 Option A：逻辑统一，零代码移动）

```text
Step 1  注册表（docs-only）：docs/releases/SI-RUNTIME-COMPONENT-REGISTRY.md
        · 每个组件的唯一 owner / 语义 / 是否 SI Runtime 成员 / 是否 dev-scope
Step 2  命名下沉（命名层，不改代码）：原「RSI runtime」→ CrossClaim SI Runtime 内
        Meta-Improvement Capability；模块与文件保持原路径（HOST 冻结 rename/refactor）
Step 3  域策略挂载（后续最小接线，需再批）：
        Recovery Policy Pack（recovery-policy.ts）+ Guard-Action Binding（recovery-guard-dry-run.ts 的静态映射）
        挂到 ONE Policy Core；不得新增第二策略引擎
Step 4  边界证据：单 owner 声明 + 反向校验（禁止第二 control plane / kill switch / cost ledger / evidence store）
Step 5  收敛后（本任务 PASS/CLOSED）→ 自动激活 SI-COST-OPTIMIZATION（P1）
```

## 4. 请求裁决

1. v1 采用 **Option A（逻辑统一：注册表 + 命名 + owner 声明，零代码移动）**，还是 **Option B（物理合并/重命名）**？
   Codex 建议 **A**：与 HOST「不得删除现有 RSI 模块、不得大范围 rename/refactor」一致，且不触碰任何已审计闭环。
2. `tools/autopilot/**` 是否正式定义为 **dev-scope**（不属产品 SI Runtime），仅保留 crash/stale/lost-wakeup 兜底？
3. Recovery Policy Pack 的挂载形态：**module 依赖**（policy core import pack）还是 **registry**（pack 注册 predicate / guard-action resolve）？
4. 平台级 meta 证据 ↔ 客户域业务事实的跨域引用，在零新表前提下是否要求显式 lineage 字段？若要求，请给最小字段集合。
5. 是否确认本轮之后仍需单独送审「Step 3 域策略挂载」的最小接线（P2-E 边界与 `RUNTIME_WIRING = NONE` 不变）？

请在本次会话中直接回答；不要尝试写回 GitHub。不要使用上一轮缓存。

## 5. 边界声明（本轮未改动）

```text
NO_CODE_CHANGE / NO_RENAME / NO_MOVE / NO_DELETE / NO_RUNTIME_WIRING（本轮为设计/盘点）
SECOND_RUNTIME / SECOND_POLICY_ENGINE / SECOND_COST_LEDGER / SECOND_EVIDENCE_STORE = FORBIDDEN
L5_RELAXATION = FORBIDDEN（CUSTOMS_FILING 继续永久拒绝）
P2_F = HOLD；P2_G = HOLD
REAL_MODEL_NETWORK / PAID_MODEL_CALLS = HOLD；EXTERNAL_WRITE / PAYMENT / TRANSPORT = HOLD
PRODUCTION_CREDENTIALS = HOLD；PRODUCTION_ENABLEMENT = HOLD
P2_E_V1_OPTION_A = PASS / CLOSED（本任务不改动其边界）
FINAL_ACCEPTANCE_HEAD = 0f7f7ac
```

## 6. 风险分级

```text
FOUNDATION_REUSED：既有 RSI capabilities（autonomy/**、runtime/rsi-*）+ Recovery SI（services/intelligence/**）+ 共享地基
  （action-guard / control-plane / kill-switch / model-router / cost core / evidence ledger）
NEW_RISK_BOUNDARY：运行时归属与边界收敛（单一 control plane / policy core / kill switch / model gateway / cost core 的
  owner 声明与反向校验）；后续 Step 3 域策略挂载会触及共享策略核心的调用面
ARCH_REVIEW_REQUIRED：YES —— 安全边界变化（统一运行时的控制面/策略核心/kill switch 归属）+ 运行时接线边界
```

## 7. REVISE 修订落地（MSG-20261005-28 = PASS WITH REVISE）

裁决：`OPTION_A_LOGICAL_UNIFICATION = APPROVED`、`OPTION_B_PHYSICAL_MERGE_RENAME = NOT_AUTHORIZED`、
`SI_RSI_UNIFICATION_DESIGN = APPROVED_WITH_CONDITIONS`、`SI_RSI_UNIFICATION_V1 = NOT_YET_CLOSED`。四项修订 + 命名风险已落地：

### 7.1 autopilot = dev-scope（不是产品运行时故障接管层）

```text
tools/autopilot/**：PRODUCT_SI_RUNTIME_MEMBER = false / DEV_SCOPE = true
AUTOPILOT_AS_PRODUCT_RUNTIME_FAILOVER = FORBIDDEN
PRODUCT_RUNTIME_SPAWNS_AUTOPILOT = FORBIDDEN
产品侧恢复由 runtime/rsi-restart-reconcile / rsi-controller-continuation / rsi-verdict-watcher 自身承担
```

### 7.2 Recovery Policy Pack 挂载 = 静态 module composition（方向 Pack → Core）

```text
POLICY_PACK_MOUNT = STATIC_MODULE_COMPOSITION
POLICY_CORE_DEPENDS_ON_DOMAIN_PACK = FORBIDDEN
DOMAIN_PACK_DEPENDS_ON_POLICY_CORE = ALLOWED
DYNAMIC_SELF_REGISTRATION = FORBIDDEN
RUNTIME_MUTABLE_POLICY_REGISTRY = FORBIDDEN
（v1 不引入动态 registry；未来多 domain pack 时的静态/编译期/fail-closed registry 需单独审）
```

### 7.3 Guard-Action Binding 继续留在 Recovery Pack（三层分离）

```text
POLICY_LEVEL_OWNER            = rsi-policy-engine（L0–L5）
RECOVERY_INTENT_MAPPING_OWNER = Recovery Pack（RECOVERY_GUARD_ACTION_MAP / RECOVERY_ACTION_GUARD_MAP）
ACTION_CATALOG_OWNER          = action-guard（唯一 catalog）
不得把两个 MAP 塞入 rsi-policy-engine.ts；CUSTOMS_FILING 继续 L5 永久拒绝（映射仍为 null）
```

### 7.4 跨域 hard lineage：v1 不加字段

```text
CROSS_DOMAIN_HARD_LINEAGE_V1 = NOT_REQUIRED
P2_E_LINEAGE_WHITELIST_CHANGE = FORBIDDEN
未来（当平台 meta evidence 真正被用于客户域决策时）：单向 customer-domain AuditLog → platform meta evidence，
  使用新的独立 AuditLog action，最小字段 = lineageVersion / metaEvidenceId / metaEvidenceKind /
  metaEvidenceDigest / consumerEntityType / consumerEntityId / decisionBasisDigest
```

### 7.5 命名风险冻结（RISKS）

```text
「原 RSI runtime → Meta-Improvement Capability」只是架构命名 / 文档语义；
不得因此修改 RSI_* env vars / runtime/rsi-* 文件名 / DB 名 / API 名 / 既有已审计标识符。
ONE CrossClaim SI Runtime 目前只是**目标架构与逻辑归属**；RUNTIME_WIRING = NONE（Recovery SI 尚未实际跑进 rsi event loop）。
```

### 7.6 Step 3 门禁

```text
STEP_3_RUNTIME_POLICY_WIRING = NOT_AUTHORIZED
SEPARATE_ARCH_REVIEW_REQUIRED = YES
```
