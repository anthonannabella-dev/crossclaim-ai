# STEP_3_RUNTIME_POLICY_WIRING —— Runtime / Policy / Guard / Model / Evidence wiring

前置：`SI_RSI_UNIFICATION_V1 = PASS / CLOSED`（MSG-20261005-29）；`SI_COST_OPTIMIZATION = PASS / CLOSED`（MSG-20261005-40）；
`SAFE_CONTINUATION_QUEUE = EMPTY`。唯一 owner 表见 `docs/releases/SI-RUNTIME-COMPONENT-REGISTRY.md`。

REVIEWED_HEAD = `c0b61792`
耐久证据：`docs/releases/SI-RUNTIME-STEP3-WIRING-EVIDENCE.md`

## ① STEP 3A —— Runtime Composition（把 Recovery SI 作为 domain capability pack）

- 新增 `runtime/rsi-domain-pack.ts`：`RsiDomainCapabilityPack` 合同 + **唯一派发层**
  `createRsiDomainPackRunner()`；`describeRsiRuntimeMembers()` 输出 `SECOND_RUNTIME = 0`。
- 新增 `runtime/recovery-si-pack.ts`：Recovery SI pack（`packId = recovery-si`），
  执行链为 **Recovery Policy Pack → 唯一 Policy Core → Guard-Action Binding → 确定性只读工具 → 证据**。
- `runtime/rsi-run.ts#composeRsiRuntime` 新增 `domainPacks`：未显式注入 runner 时，domain pack 派发层
  即唯一 runner；**不创建**第二个 event loop / controller / scheduler。链路线性一致：
  Signal → Task → Policy Core → Domain Pack → Runner → Evidence → Judge → Verdict → Continuation/Reconcile。

## ② STEP 3B —— Policy Wiring（单一 Policy Core + 静态组合）

- Policy Core 仍唯一 = `services/autonomy/rsi-policy-engine.ts`；Recovery Policy Pack
  (`services/intelligence/recovery-policy.ts`) 继续只作 domain consumer：
  `ALLOWED: DOMAIN_PACK → POLICY_CORE`（既有静态 import）。
- 回归断言：`services/autonomy/**` **不得** import `services/intelligence/**`
  （`POLICY_CORE_DEPENDS_ON_DOMAIN_PACK = FORBIDDEN`）；无动态 self-registration、
  无 runtime mutable policy registry（派发层为静态数组）。

## ③ STEP 3C —— Guard / Action Wiring（未绕过任何门）

- Recovery intent → `resolveGuardAction()` → `RECOVERY_GUARD_ACTION_MAP` / `RECOVERY_ACTION_GUARD_MAP`
  → 仅 `RECOVERY_ALLOWED_GUARD_ACTIONS`（`claim.submit` / `claim.prepare` / `evidence.read`）允许声明；
  pack **只声明 intent**，授权裁决仍属共享 Action Guard / Control Plane / Kill Switch / HITL。
- guard action = null（执行类 intent，含 CUSTOMS 执行路径）→ `BLOCK`
  （`RECOVERY_GUARD_ACTION_L5_FORBIDDEN`）；CUSTOMS L5 永久禁止边界**未放宽**。

## ④ STEP 3D —— Model Gateway Wiring

- 本阶段只做 contract wiring：Recovery pack 为 deterministic-first，`modelCallCount = 0`；
  任何未来模型调用仍必须经过唯一 `rsi-model-router`（含 Necessity Gate / cache / durable ledger /
  tenant budget / Cost Safe Mode / cheap→strong bounded escalation）。
- `REAL_MODEL_NETWORK = HOLD`、`PAID_MODEL_CALLS = HOLD` 未改动；本批零真实 provider 调用。

## ⑤ STEP 3E —— Evidence / Judge

- Meta 证据仍为 `rsi-evidence-ledger`；客户域事实仍为 `RecoveryPackage` / Artifact / FileAsset / AuditLog
  （**无双写**）。pack 产出的是 `recovery-si:<domain>:<sha256-12>` 引用型证据，不含客户内容。
- Judge 保持 `SELF_JUDGE_FORBIDDEN`：runner 结果只作提案，`awaitVerdict = true` 时任务停在等待裁决，
  由 verdict artifact 收口（PASS / REVISE / BLOCK 归一化，无法识别即不猜）。

## ⑥ STEP 3F —— Restart / Reconcile

- E2E 复用 `runRsiRestartReconcile`：过期 `ACTIVE` lease → 标 EXPIRED + 任务回 READY；
  终止态（`PROMOTED`）**不重放**；重复运行 `idempotentNoop = true`。
- `tools/autopilot/**` 保持 `DEV_SCOPE = true` / `PRODUCT_SI_RUNTIME_MEMBER = false`（产品代码 0 引用）。

## ⑦ STEP 3G —— Runtime Acceptance（十条 E2E）

`rsi-si-runtime-e2e.test.ts` 覆盖：① Recovery signal 进入唯一 runtime ② task 生成
③ Policy Core 评估 ④ Recovery Pack 被调用 ⑤ 确定性只读工具执行 ⑥ 证据生成 ⑦ Judge（park-for-judge）
⑧ PASS / REVISE 路径可用 ⑨ continuation 继续推进 ⑩ restart/reconcile 正确恢复。
并断言 `SECOND_RUNTIME = 0` + 架构回归（见 ②）。

## ⑧ 验证

- `apps/api npx tsc --noEmit` → exit 0
- STEP 3 定向：`rsi-domain-pack-wiring` 10/10 + `rsi-si-runtime-e2e` 2/2 = **12/12 PASS**
- 回归：`rsi-* + si-cost-* + recovery-* + architecture-contract` → **75 files / 750 tests PASS**
- 无 Schema / migration 变更（本阶段为接线，不改 DB 事实）

## ⑨ 请求裁决（请直接在本会话回答；不要写回 GitHub；不要使用上一轮缓存）

1. STEP 3A/3B/3C/3D/3E/3F 接线是否可记 PASS？
2. `STEP_3_RUNTIME_POLICY_WIRING` 是否可记 **PASS / CLOSED**（`STEP3_FINAL2_REQUIRED = ?`）？
3. 若 PASS/CLOSED：是否确认 `CROSSCLAIM_SI_RUNTIME_WIRING` 的完成条件中
   ONE runtime / Recovery Pack integrated / Meta-Improvement capability integrated / Policy Core wired /
   Model Gateway wired / Cost Core wired / Judge wired / Action Guard preserved / restart-reconcile E2E green /
   no second runtime / regression green 已满足（仅剩架构审计签署）？
4. 若仍需修订，请只列最小集合。

边界：REAL_MODEL_NETWORK / PAID_MODEL_CALLS / EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS /
PRODUCTION_ENABLEMENT = HOLD；P2_F = HOLD / P2_G = HOLD；CUSTOMS real filing = HOLD；
SECOND_RUNTIME / SECOND_POLICY_ENGINE / SECOND_CONTROL_PLANE / SECOND_MODEL_GATEWAY / SECOND_COST_LEDGER /
SECOND_META_EVIDENCE_STORE = FORBIDDEN；L5_RELAXATION = FORBIDDEN；FINAL_ACCEPTANCE_HEAD = 0f7f7ac。

输出请精简结构化（DECISION / KEEP / CHANGE / RISKS / TEST / NEXT / PRODUCTION）。
