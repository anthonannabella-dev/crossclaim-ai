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
