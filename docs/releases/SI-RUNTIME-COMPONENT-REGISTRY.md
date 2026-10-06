> **[HISTORICAL_SNAPSHOT]** 本文是历史审计 / 证据快照，原文保留不改写（历史裁决不删除）。
> 其中关于 `RUNTIME_WIRING` / `STEP_3_RUNTIME_POLICY_WIRING` / `RSI_OUTCOME_SINK_RUNTIME_WIRING`
> 的**当时状态**已被后续实现取代：SUPERSEDED_BY=c0b61792（STEP_3_RUNTIME_POLICY_WIRING：
> Recovery SI 作为 domain capability pack 接入 ONE CrossClaim SI Runtime；后续 FINAL-2..6 与 PHASE 2
> 见 ca23b1df / adcab905 / ca298187 / 5f9ce46f / 6e98e66e）。
> 唯一**现行**状态请以 `docs/releases/CURRENT-SI-RSI-STATUS.md` 为准
> （SUPERSEDED_BY=cdd95258 为该状态件的基线 HEAD）。

# SI-RUNTIME-COMPONENT-REGISTRY —— ONE CrossClaim SI Runtime 组件注册表（v1 / docs-only）

> 依据：MSG-20261005-28（SI-RSI Unification 设计 = **PASS WITH REVISE**；`OPTION_A_LOGICAL_UNIFICATION = APPROVED`）
> 性质：**逻辑架构注册表**。当前 `RUNTIME_WIRING = NONE`；本文件不表示 Recovery SI 已实际运行在 RSI event loop 中。
> 约束：`NO_CODE_CHANGE / NO_RENAME / NO_MOVE / NO_DELETE`；不得改动 `RSI_*` env vars、`runtime/rsi-*` 文件名、DB/API 名与既有已审计标识符。

## 1. 唯一 owner 表（U1 / U2）

| 组件（概念） | 唯一 owner（路径） | SI Runtime 成员 | 第二 owner |
| --- | --- | --- | --- |
| Action Catalog / 执行授权 enforcement | `apps/api/src/services/action-guard/action-guard.ts` | 是（共享地基） | **禁止**（`SECOND_ACTION_CATALOG = FORBIDDEN`） |
| Control Plane（可信能力快照） | `apps/api/src/services/action-guard/control-plane.ts` | 是（共享地基） | **禁止**（`SECOND_CONTROL_PLANE = FORBIDDEN`） |
| Policy Core（L0–L5 + 永久 OWNER 硬禁） | `apps/api/src/services/autonomy/rsi-policy-engine.ts` | 是（共享地基） | **禁止**（`SECOND_POLICY_ENGINE = FORBIDDEN`） |
| Kill Switch 源 | `apps/api/src/services/operations/kill-switch.ts`（+ `kill-switch-resolver.ts`） | 是（共享地基） | **禁止** |
| Kill Switch 适配器 | `apps/api/src/services/action-guard/kill-switch-adapter.ts` | 是（共享地基） | **禁止**（SI 不得自判开关） |
| Model Gateway | `apps/api/src/services/autonomy/rsi-model-router.ts`（+ `rsi-model-provider-composition.ts`、`rsi-local-sim-adapter.ts`） | 是（共享地基；真实网络 HOLD） | **禁止** |
| Cost Core | `apps/api/src/services/autonomy/rsi-cost-ledger.ts` + `rsi-cost-policy.ts` | 是（共享地基） | **禁止**（`SECOND_COST_LEDGER = FORBIDDEN`；`SI-COST-OPTIMIZATION` 在本核心扩展） |
| Judge orchestration | `apps/api/src/services/autonomy/rsi-judge-orchestration.ts` | 是（共享地基） | **禁止** |
| 平台级 meta 证据账本 | `apps/api/src/services/autonomy/rsi-evidence-ledger.ts`（+ `rsi-evidence-verifier.ts`） | 是（共享地基） | **禁止**（`SECOND_META_EVIDENCE_STORE = FORBIDDEN`） |
| 客户域业务事实 / lineage | 既有 DB 实体：`RecoveryPackage` / `RecoveryPackageArtifact` / `FileAsset` / `AuditLog` | 是（客户域） | **禁止双写**（`NO_DOUBLE_WRITE`） |
| Recovery 域能力包 | `apps/api/src/services/intelligence/**` | 是（domain capability pack） | **禁止**（不设第二域引擎） |
| Recovery Guard-Action Binding | `apps/api/src/services/intelligence/recovery-guard-dry-run.ts`（`RECOVERY_GUARD_ACTION_MAP` / `RECOVERY_ACTION_GUARD_MAP`） | 是（domain binding，留在 Pack 内） | **禁止**迁入 Policy Core |
| Product SI Runtime（事件循环 / 恢复 / continuation） | `apps/api/src/runtime/rsi-controller.ts` / `rsi-event-loop.ts` / `rsi-controller-continuation.ts` / `rsi-restart-reconcile.ts` / `rsi-verdict-watcher.ts` / `rsi-supervisor-policy.ts` / `rsi-task-runner.ts` | 是（唯一产品运行时） | **禁止**（`SECOND_RUNTIME = FORBIDDEN`） |
| 开发期自动化 | `tools/autopilot/**` | **否**（`PRODUCT_SI_RUNTIME_MEMBER = false` / `DEV_SCOPE = true`） | 不适用（dev-scope） |

## 2. 依赖方向（U5）

```text
ALLOWED:   Recovery Policy Pack（services/intelligence/recovery-policy.ts）
             → ONE Policy Core（services/autonomy/rsi-policy-engine.ts）        [STATIC_MODULE_COMPOSITION]
ALLOWED:   domain pack → shared substrate（action-guard / control-plane / kill-switch adapter /
             model gateway / cost core / judge）                                  [consumer 方向]

FORBIDDEN: POLICY_CORE_DEPENDS_ON_DOMAIN_PACK = FORBIDDEN
FORBIDDEN: DYNAMIC_SELF_REGISTRATION = FORBIDDEN
FORBIDDEN: RUNTIME_MUTABLE_POLICY_REGISTRY = FORBIDDEN
FORBIDDEN: AUTOPILOT_AS_PRODUCT_RUNTIME_FAILOVER = FORBIDDEN
FORBIDDEN: PRODUCT_RUNTIME_SPAWNS_AUTOPILOT = FORBIDDEN
```

## 3. dev-scope 定义（U3 / U4）

```text
tools/autopilot/**
  PRODUCT_SI_RUNTIME_MEMBER = false
  DEV_SCOPE = true
  允许职责：开发期 runner crash / stale heartbeat / lost wake-up / backlog·audit orchestration
  禁止职责：产品 SI Runtime 的故障接管层（产品侧恢复由 runtime/rsi-restart-reconcile /
            rsi-controller-continuation / rsi-verdict-watcher 自身承担）
```

证据（本轮机械核对）：`rg -n "autopilot" apps/api/src` → **0 命中**（产品代码不引用、不 spawn autopilot）。

## 4. 三层分离（U6）

```text
POLICY_LEVEL_OWNER            = services/autonomy/rsi-policy-engine（L0–L5）
RECOVERY_INTENT_MAPPING_OWNER = services/intelligence/recovery-guard-dry-run（intent → catalog action）
ACTION_CATALOG_OWNER          = services/action-guard/action-guard（唯一 catalog）

CUSTOMS_FILING → RECOVERY_GUARD_ACTION_MAP.CUSTOMS = null（继续 L5 永久拒绝，未放宽）
```

## 5. 客户域 ↔ 平台级边界（U7 相关）

```text
META_EVIDENCE           = rsi-evidence-ledger（append-only；writesDatabase=false / storesRawOutput=false）
CUSTOMER_BUSINESS_FACTS = 既有 DB 实体 + AuditLog
NO_DOUBLE_WRITE / NO_SECOND_META_EVIDENCE_LEDGER
CROSS_DOMAIN_HARD_LINEAGE_V1 = NOT_REQUIRED（本轮不新增字段；P2_E_LINEAGE_WHITELIST_CHANGE = FORBIDDEN）
未来若需要：单向引用 customer-domain AuditLog → platform meta evidence（使用**新的独立 AuditLog action**，
  不得修改已 CLOSED 的 `recovery.si_package_persisted` 9 键白名单；最小字段为
  lineageVersion / metaEvidenceId / metaEvidenceKind / metaEvidenceDigest / consumerEntityType /
  consumerEntityId / decisionBasisDigest；organizationId 由客户域 AuditLog 自身字段提供）
```

## 6. 当前状态与后续门

```text
P2_E_V1_OPTION_A = PASS / CLOSED（边界 KEEP / DO NOT MODIFY）
RUNTIME_WIRING = NONE（Recovery SI 尚未接入 RSI event loop；本注册表仅逻辑归属）
STEP_3_RUNTIME_POLICY_WIRING = NOT_AUTHORIZED（必须单独送审）
SI-COST-OPTIMIZATION = QUEUED（本任务 PASS/CLOSED 后 → READY_FOR_DESIGN；不构成 AUTO_IMPLEMENTATION_AUTHORIZED）
```
