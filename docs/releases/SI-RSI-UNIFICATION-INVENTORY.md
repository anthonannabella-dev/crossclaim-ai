# SI-RSI Unification —— repo-wide inventory（KEEP / REUSE / MERGE / DEPRECATE / DUPLICATE）

> 依据：HOST 架构指令（docs/releases/SI-RSI-UNIFICATION-DIRECTIVE.md，2026-10-05）
> 目标：RSI capabilities + Recovery SI → **ONE CrossClaim SI Runtime**
> 本轮性质：**只读盘点 + 分类**（零代码、零 rename、零删除、零运行时接线）
> 边界不变：P2_F = HOLD / P2_G = HOLD；REAL_MODEL_NETWORK / PAID_MODEL_CALLS = HOLD；
> EXTERNAL_WRITE / PAYMENT / PRODUCTION_CREDENTIALS = HOLD；FINAL_ACCEPTANCE_HEAD = 0f7f7ac

## 1. 盘点范围与机械计数（按实际文件）

| 区域 | 位置 | 文件数 | 备注 |
| --- | --- | --- | --- |
| RSI 能力层 | `apps/api/src/services/autonomy/**` | 20 | lifecycle / observer / task-generator / runner / evidence / judge / policy / cost / continuation / inspection / drift / fixtures / model-router |
| RSI 运行层 | `apps/api/src/runtime/rsi-*.ts` | 14 | controller / event-loop / event-sources / supervisor／continuation / restart-reconcile / verdict-watcher / e2e-loop / admin snapshot / local sources / project executor |
| RSI 测试 | `apps/api/src/__tests__/rsi-*.test.ts` | 46 | 覆盖上表全部模块（含 cost-e2e / judge / policy / no-autopass / verdict wiring） |
| Recovery SI 能力层 | `apps/api/src/services/intelligence/**` | 14 | state / prioritizer / planner / verifier / policy / guard-dry-run / preview / persist-gate / persist-prisma-port / read-tools(+adapters) / tool-registry / outcome-signal / supervisor |
| 统一地基（共享） | `apps/api/src/services/action-guard/**` | 5 | action-guard（唯一动作目录）、control-plane(+status/wiring)、kill-switch-adapter |
| Kill Switch | `apps/api/src/services/operations/**` | 2 | kill-switch / kill-switch-resolver（唯一开关源） |
| 开发期自动化 | `tools/autopilot/**` | 28 | dispatcher / runner / continuous-runner / watchdog / acceptance-* / backlog / units |

## 2. 概念级归属（unification 的核心：每个概念只能有一个 owner）

| 概念 | 现状（多个实现点） | 分类 | 统一后 owner |
| --- | --- | --- | --- |
| 动作目录与执行授权 | `action-guard/action-guard.ts`（唯一 catalog）、`recovery-guard-dry-run.ts` 的静态映射、`recovery-policy.ts` | **KEEP**（catalog）+ **REUSE**（映射/策略作为域内绑定） | `action-guard` = 唯一 enforcement；域内只允许「意图 → catalog action」的静态映射 |
| 策略分级 L0–L5 | `rsi-policy-engine.ts`（L0–L5 + 永久 OWNER 硬禁）、`recovery-policy.ts`（Recovery 执行请求裁决，含 CUSTOMS L5 永久拒绝） | **KEEP**（RSI 策略核心）+ **MERGE_INTO_BOUNDARY**（Recovery 策略作为「Recovery Policy Pack」挂到同一策略核心，不新增第二引擎） | ONE Policy Core = `rsi-policy-engine`；域策略 = pack |
| 控制面（能力快照） | `action-guard/control-plane.ts`（trusted snapshot / evaluateWithoutAudit）；`rsi-runtime-config.ts`（运行时配置） | **KEEP**（control-plane 唯一）+ **REUSE**（runtime-config 仅作配置源） | ONE Control Plane = `action-guard/control-plane` |
| Kill Switch | `operations/kill-switch.ts` + `kill-switch-resolver.ts` + `action-guard/kill-switch-adapter.ts` | **KEEP**（唯一开关源 + 唯一适配器） | 所有 SI 调用必须经 adapter（禁止第二套开关判定） |
| 模型调用 | `rsi-model-router.ts` + `rsi-model-provider-composition.ts` + `rsi-local-sim-adapter.ts`（仅本地仿真） | **KEEP**（唯一 Model Gateway）；Recovery SI 当前**无**模型调用（P2_F = HOLD） | ONE Model Gateway；P2-F 若获授权必须复用同一 router |
| 成本账本 / 预算 | `rsi-cost-ledger.ts` + `rsi-cost-policy.ts` | **KEEP + EXTEND**（`SI-COST-OPTIMIZATION` 在同一核心上加 durable ledger 与四级预算；**禁止**第二套成本控制） | ONE Cost Core |
| 证据 / 审计 | `rsi-evidence-ledger.ts` + `rsi-evidence-verifier.ts`（平台级 meta 证据）；RecoveryPackage / Artifact / AuditLog（客户域业务事实） | **KEEP SEPARATE（按语义分域）** | 平台级证据 = RSI evidence；客户域 lineage = 既有 DB 实体（不合并、不双写） |
| Judge / 质量门 | `rsi-judge-orchestration.ts`（builder/judge 分离） | **KEEP**；Recovery SI 的 P2-C/P2-D 校验是确定性 validator | ONE Judge orchestration（仅在确有 AI 调用时进入；由后续 OPT-5 复用） |
| 持续执行 / 调度 | `runtime/rsi-controller.ts` / `rsi-event-loop.ts` / `rsi-controller-continuation.ts` / `rsi-supervisor-policy.ts` / `rsi-task-runner.ts`；`tools/autopilot/{dispatcher,runner,continuous-runner,watchdog}.mjs` | **KEEP 分层**：RSI runtime = 产品侧 SI 运行时；autopilot = **开发期** backlog 调度（非产品运行时） | ONE SI Runtime = `runtime/rsi-*`（重定位为 CrossClaim SI Runtime）；autopilot 保持 dev-scope，不并入产品运行时 |
| 只读工具调用 | `recovery-read-tools.ts` + `recovery-read-tool-adapters.ts` + `recovery-tool-registry.ts` | **KEEP**（域内只读工具边界；已含 verify-at-invocation + tenant 绑定） | 保留为 SI Runtime 的 Recovery 域工具包 |
| 持久化写入口 | `recovery-persist-gate.ts` + `recovery-persist-prisma-port.ts`（唯一公开写 API = `persistRecoverySiPackageWithinTransaction`） | **KEEP**（P2-E 已 PASS/CLOSED 的边界，不动） | 保留；unification 不触碰 P2-E 结论 |

## 3. 分类结论汇总

| 分类 | 内容 |
| --- | --- |
| **KEEP（不动）** | `action-guard/**`（含 control-plane / kill-switch-adapter）；`operations/kill-switch*`；`rsi-policy-engine`（策略核心）；`rsi-cost-ledger` / `rsi-cost-policy`（成本核心）；`rsi-model-router` / `model-provider-composition` / `local-sim-adapter`（模型网关）；`rsi-judge-orchestration`；`runtime/rsi-*`（SI 运行时）；`services/intelligence/**`（Recovery 域能力包，含 P2-E 已关闭的 persist 边界）；`tools/autopilot/**`（开发期工具，dev-scope） |
| **REUSE（复用，不新建）** | 控制面快照、Kill Switch 适配器、模型网关、成本核心、Judge、动作目录、DB 既有实体（RecoveryPackage/Artifact/FileAsset/AuditLog） |
| **MERGE（合并为单一核心）** | 策略判定入口：`recovery-policy.ts` 作为 **Recovery Policy Pack** 挂到 ONE Policy Core；`recovery-guard-dry-run.ts` 的静态映射作为 **Guard-Action Binding**（域内绑定层），不新增引擎 |
| **DEPRECATE（仅命名层，不删代码）** | 「RSI runtime」这一**顶层命名**：下沉为 ONE CrossClaim SI Runtime 内的 **Meta-Improvement Capability**；文件与模块保留（HOST 明令不得删除现有 RSI 模块、不得大范围 rename/refactor） |
| **DUPLICATE（需要显式去重的关系）** | 无文件级重复；存在**概念级**重复风险（策略 / 持续执行 / 成本 / 模型网关 / 证据）。去重方式 = 上述「每概念单一 owner + 其余降为域内包/消费者」，**不删除、不改名** |

## 4. 统一后目标形态（ONE CrossClaim SI Runtime）

```text
CrossClaim SI Runtime（唯一 SI 运行时）
├── Domain Capability Packs
│   ├── Recovery SI Pack（services/intelligence/**，含 P2-E 已关闭的持久化边界）
│   └── Meta-Improvement Pack（原 RSI：autonomy/** + runtime/rsi-*，命名下沉）
├── Shared Substrate（唯一实例，禁止第二套）
│   ├── Control Plane = action-guard/control-plane
│   ├── Action Guard  = action-guard/action-guard（唯一 catalog）
│   ├── Policy Core   = rsi-policy-engine（L0–L5；域策略以 pack 形式挂载）
│   ├── Kill Switch   = operations/kill-switch(+resolver) + action-guard/kill-switch-adapter
│   ├── Model Gateway = rsi-model-router(+composition/local-sim)   ← 当前仅本地仿真，真实网络 HOLD
│   └── Cost Core     = rsi-cost-ledger + rsi-cost-policy          ← SI-COST-OPTIMIZATION 在此扩展
└── Evidence / Audit
    ├── 平台级 meta 证据 = rsi-evidence-ledger（append-only）
    └── 客户域业务事实   = 既有 DB 实体 + AuditLog（不双写、不新建第二账本）
```

## 5. 明确不做（本轮 + v1）

```text
NO_CODE_CHANGE（本轮只读盘点）
NO_RENAME / NO_MOVE / NO_DELETE（HOST 冻结：不得删除现有 RSI 模块、不得大范围 rename/refactor）
NO_SECOND_RUNTIME / NO_SECOND_POLICY_ENGINE / NO_SECOND_COST_LEDGER / NO_SECOND_EVIDENCE_STORE
NO_RUNTIME_WIRING / NO_EXTERNAL_WRITE / NO_PAYMENT / NO_PRODUCTION_CREDENTIALS
L5_RELAXATION = FORBIDDEN（CUSTOMS_FILING 继续永久拒绝）
```

## 6. 待架构方裁决的开放问题（随设计请求一并提交）

1. v1 采用 **Option A（逻辑统一：注册表 + 命名 + owner 声明，零代码移动）** 还是 **Option B（物理合并/重命名）**？
   Codex 建议 **A**（与 HOST「不得大范围 rename/refactor」一致，且不触碰任何已审计闭环）。
2. `tools/autopilot/**` 是否正式定义为 **dev-scope**（不属产品 SI Runtime）？还是要求纳入统一运行时（会影响 CI/调度语义）。
3. Recovery Policy Pack 的挂载形态：作为 module 依赖（policy core import pack）还是 registry（pack 注册 resolveGuardAction/policy predicate）？
4. 平台级 meta 证据与客户域业务事实的**跨域引用**是否需要显式 lineage 字段（不新建表时的最小表达）？
