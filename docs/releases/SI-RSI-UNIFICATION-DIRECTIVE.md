# HOST 架构指令（冻结）：UNIFY RSI + SI → CrossClaim SI Runtime

> 性质：**架构收口约束**，不代表 Production Enablement；不解锁任何真实 Provider / External Write / Payment / Production Credential。
> 记录目的：本指令先落耐久记录，再按顺序执行；**不得**在 inventory / design audit 之前删除任何现有 RSI 模块。

## 1. 最终形态：单一顶层 Runtime

正式名称：**CrossClaim SI Runtime**。最终禁止并存两套并行运行系统（RSI Runtime 与 Recovery SI Runtime / SI Runtime）；不得存在两套独立 Controller、Scheduler、Event Loop、State Machine、Judge、Policy、Kill Switch。

目标结构：

```
CrossClaim SI Runtime
├── Observation / Inspection
├── Intelligence
├── Recovery Intelligence
├── Improvement Engine
├── RSI / Meta-Improvement Engine
├── Governance
└── Persistence / Evidence / Lineage
```

## 2. 旧 RSI 不删除，能力下沉

已完成的 RSI 能力（Runtime、Continuation Engine、Continuous Autopilot、Global Backlog Dispatcher、Builder、Judge/Evaluator、Policy Engine、Model Router/Provider Adapter、Inspection、State/Health、Kill Switch、Acceptance/Stop Protocol、Cost control、Drift/capability-gap detection）**全部保留**，统一下沉为 SI Runtime 的通用基础设施。**禁止无必要重写。**

## 3. RSI 的定位

RSI 不再是独立系统，而是 SI 内部的 **Meta-Improvement Capability**，专门负责改善：prompt、skill、model routing、task decomposition、eval、builder strategy、judge strategy，以及改善机制本身。
即：**SI = 总系统；RSI = SI 内部「改进改进机制」的高级能力。**

## 4. Recovery SI 作为领域能力接入

当前 P2-E 正在实施的 `RecoveryPlan` / `DecisionEvidence` / `RecoveryPackage` / `planDigest` / `packageDigest` / lineage / persist gate / transaction boundary / DB DELETE guard / capability gap 继续实施，
但必须接入既有 CrossClaim SI Runtime；**不得**新建第二套 runtime / scheduler / state store / controller / judge / policy engine / kill switch。

## 5. 单一控制平面（ONE CONTROL PLANE）

所有 SI / RSI / Recovery SI 动作统一经过：

```
Observe → Task Generator → Builder → Evaluator/Judge → Policy → Action Guard → Executor → Evidence → Outcome → Learning
```

高风险动作继续 fail-closed，**不因合并而自动解锁**：`claim.submit`、`appeal.submit`、`platform.write`、customs external filing、`payment.capture`、production credentials、production enablement。

## 6. 权限分层

| 层级 | 含义 | 门禁 |
| --- | --- | --- |
| L1 | Observe / Diagnose | 可自动执行 |
| L2 | Prompt / Skill / Routing / Recovery Plan 改进 | 必须过 eval / judge |
| L3 | Workflow / Rule / 可执行行为变更 | CI + Judge + Policy + rollout guard |
| L4 | RSI Meta-Improvement（修改 Builder / Judge / Evaluator / task-generation / improvement strategy 本身） | 更高等级审计与证据 |
| L5 | 真实外部写 / 资金 / 报关 / 高风险动作 | Action Guard / HITL / Production Gate，RSI 不得自解锁 |

## 7. Runtime 交付目标

生产只启动一个智能运行服务（例如 `crossclaim-si`），内部加载：Core RSI capabilities、Recovery SI、Inspection、Continuation Engine、Scheduler/Event Sources、Model Router、Governance、Health/State。
**禁止**要求宿主分别启动 `crossclaim-rsi` 与 `crossclaim-si`。

## 8. 当前施工顺序（冻结）

1. **先完整完成 P2-E**：Prisma migration、RecoveryPackage DELETE guard trigger、trigger manifest sync、transaction port wiring、lineage persistence、`prisma validate` / migrate、trigger verification、Implementation Audit。
   （现状：DELETE guard 迁移 + manifest sync 已完成 `c1c23382`；transaction port wiring 已完成 `8a7cabe6`；lineage persistence 与 DB 级验证、Implementation Audit 待做。）
2. 然后建立 **SI-RSI-UNIFICATION-DESIGN**。
3. repo-wide inventory：RSI Runtime / Recovery SI / autopilot / continuation / inspection / scheduler / model router / state·health / judge / policy / kill switch。
4. 标记 **KEEP / REUSE / MERGE / DEPRECATE / DUPLICATE**。
5. 提交最小统一方案供架构审计。

**禁止**在 inventory / design audit 之前删除现有 RSI 模块；**禁止**立即进行大范围 rename/refactor；**不得**回滚已通过审计的 P2-D / P2-E 工作。

## 9. 最终验收标准（`SI_RSI_UNIFICATION = COMPLETE` 的必要条件）

顶层只有一个 CrossClaim SI Runtime；RSI 能力仍存在；Recovery SI 已接入；无重复 Controller / Scheduler / Event Loop / Judge / Policy Engine / Kill Switch；无双 State Source of Truth；所有现有安全边界保持；原有 RSI regression 全绿；Recovery SI regression 全绿；Runtime E2E 全绿；reboot reconcile 验证；Linux/systemd 或生产 supervisor autostart 验证；Kill Switch 能停止**整个** SI 而非某一个子系统。

目标不是删除 RSI，而是：**RSI capabilities + Recovery SI → ONE CrossClaim SI Runtime**。
