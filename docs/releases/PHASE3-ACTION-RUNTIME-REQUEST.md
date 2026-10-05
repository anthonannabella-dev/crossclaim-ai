# PHASE 3 — ACTION RUNTIME 送审请求（U1–U6）

- 仓库/分支：`D:\crossclaim-ai` / `gate/7-commercial-validation`
- **Reviewed HEAD：`add99ec3`**
- 上游授权：HOST 2026-10-06「PHASE 3 ACTION RUNTIME：provider adapter interface / credential port /
  external-write gate / idempotency / exactly-once / retry-reconcile / HITL / result normalization /
  sandbox-mock / failure-degraded / audit-evidence」
- 前置已 CLOSED：`STEP_3_RUNTIME_POLICY_WIRING = PASS / CLOSED`（MSG-20261005-47，HEAD 795f65a5）；
  `PHASE 2 MODEL GATEWAY RUNTIME = PASS / CLOSED`（MSG-20261005-50，HEAD 338f30b4）

---

## 1. 本轮交付范围（U1–U6）

全部为**契约 / 端口 / 纯逻辑 + sandbox mock**：没有任何真实 provider、网络、凭据、外写、支付、运输调用。

| 单元 | 内容 | 实现文件 | commit |
|---|---|---|---|
| U1 | Provider Adapter 契约：能力元数据、HOLD fail-closed、external-write gate、结果归一化、sandbox mock | `apps/api/src/services/action-runtime/provider-adapter-contract.ts` | `9151ca5b` |
| U2 | credential port：只接受 opaque ref；形如密钥（长随机 / `sk-` / `Bearer`）一律 REJECT | `apps/api/src/services/action-runtime/provider-execution-guard.ts` | `9eb7dd15` |
| U3 | idempotency / exactly-once：同 key 二次 `begin` → `DUPLICATE`，不重复执行 | 同上 | `9eb7dd15` |
| U4 | retry / reconcile 有界策略；UNKNOWN / 未确认无副作用 → `MANUAL_REVIEW` | 同上 | `9eb7dd15` |
| U5 | Action Pack 运行时：HITL 落点 + external-write gate + exactly-once 串接 | `apps/api/src/services/action-runtime/action-pack-runtime.ts` | `add99ec3` |
| U6 | audit / evidence 输出：结构化、无凭据、无原始 payload/响应 | 同上 | `add99ec3` |

测试文件：

- `apps/api/src/__tests__/provider-adapter-contract.test.ts`（7 条）
- `apps/api/src/__tests__/provider-execution-guard.test.ts`（8 条）
- `apps/api/src/__tests__/action-pack-runtime.test.ts`（16 条）

---

## 2. Action Pack 运行时链路（固定顺序，任一步 fail-closed 即停止）

```
adapter 契约
 → credential ref（opaque；simulated 不取真实凭据）
 → HITL 判定
 → external-write gate
 → idempotency.begin（exactly-once）
 → provider invoke（仅 sandbox mock / simulated）
 → 结果归一化
 → idempotency.complete
 → retry / reconcile 判定
 → evidence 记录
```

---

## 3. 语义保证（对照授权要求逐条）

### 3.1 外写一律 HOLD

- 外写集合**直接复用共享 Action Guard 的 `GUARD_ENFORCED_ACTIONS`**（`services/action-guard/guard-enforcement.ts`）
  并并入 `customs.filing`；本模块**不**另行维护第二份动作清单（避免漂移）。
- `isExternalWriteAction(action) === true` ⇒ 一律 `EXTERNAL_WRITE_HOLD`，**provider invoke = 0**；
  即使补齐 `approvalRef`、transport 打开、guard = ALLOW 也不放行。
- 非外写动作仅在 `simulated` adapter 且 guard ≠ DENY/REQUIRES_APPROVAL 时跑通管道，且 `externalWritePerformed` 恒为 `false`。

### 3.2 HITL 落点

- `guardDecision = REQUIRES_APPROVAL` → `REQUIRED`（理由 `GUARD_REQUIRES_APPROVAL`）
- `riskClass = HIGH` → `REQUIRED`（`HIGH_RISK`）
- owner-gated 动作（= 外写集合）→ `REQUIRED`（`OWNER_GATED_ACTION`）
- 需要 HITL 但缺 `approvalRef` ⇒ `BLOCKED`，**provider invoke = 0**，不自动继续。

### 3.3 exactly-once

- `idempotency.begin` 先于 `provider.invoke`；同 `idempotencyKey` 二次投递 → `DUPLICATE_REPLAY`，
  **provider invoke 总数 = 1**（验收 P3U5_9）。
- 缺 `idempotencyKey` ⇒ `ACTION_PACK_IDEMPOTENCY_KEY_REQUIRED`，`BLOCKED`，不进入任何下游。

### 3.4 结果归一化与失败/degraded 路径

- 畸形/含凭据字段的 provider 结果 → `UNKNOWN`（fail-closed，不得推断成功）。
- `FAILED` 且确认无副作用 → `RETRY_ELIGIBLE`（`retry=RETRY`）；
  `UNKNOWN`/degraded → `MANUAL_REVIEW`（`retry=MANUAL_REVIEW`），不盲目重试。

### 3.5 audit / evidence

- evidence 只含结构化引用：`action / organizationId / provider / idempotencyKey / status / reasonCodes /
  attempts / modelCallCount=0 / externalWritePerformed=false / credentialRef / evidenceRef`。
- `credentialRef` 是 **opaque 引用**（simulated 下为 `null`），**不是**密钥本身；
  其键名含 `credential` 关键词，因此凭据字段扫描前显式剔除该白名单键，避免 happy-path 误判。
- `modelCallCount` 语义 = Model Gateway 调用次数（**不是** provider attempt）。

### 3.6 无第二实现

- 无第二 Action Runtime / 第二 Control Plane：本模块只做**判定**与端口编排，授权仍归共享 Action Guard。
- `ACTION_PACK_RUNTIME_BOUNDARY.secondActionRuntime = 'FORBIDDEN'`。

---

## 4. 验收证据（本地，`apps/api`）

| 项目 | 结果 |
|---|---|
| `tsc --noEmit` | **0 error** |
| 目标验收 `action-pack-runtime` | **16 / 16 PASS** |
| 回归集（`rsi-* / si-cost-* / recovery-* / architecture-contract / provider-adapter-contract / provider-execution-guard / action-pack-runtime`） | **93 files / 938 tests PASS** |
| 全量 `vitest run`（在 `add99ec3` 上重跑） | **394 files / 3680 tests，2 failed**（两项均为既有失败，见 4.1；本单元新增失败 = 0） |
| GitHub CI | `NOT_OBSERVED`（仅本地运行，未观测到对应 commit 的 Actions run） |

### 4.1 关于全量套件中的 2 项失败（**本单元之前即已存在**，非本单元引入）

用「把本单元两个新文件临时移出仓库」的 HEAD baseline 对照验证：

1. `action-guard-enforcement.test.ts > 07`（受保护动作字面量静态约定）：
   baseline（无本单元文件）offender = 4 条，全部在 `services/intelligence/`：
   `recovery-guard-dry-run.ts :: claim.submit`、
   `recovery-persist-gate.ts :: claim.submit / appeal.submit / platform.write`。
   加入本单元后 offender **仍为同样 4 条**（本单元新增 0 条：外写集合改为复用 `GUARD_ENFORCED_ACTIONS`，不再出现受保护动作字面量）。
2. `recovery-si-phase2-e-db.test.ts > P2E-DB5`（期望 `prisma.payment.count() === 0`）：
   全量并发下受影响；**单独运行该文件 20 / 20 PASS**，属既有跨文件 DB 隔离缺陷，与本单元无关。

本单元**新增失败 = 0**。

---

## 5. 边界（本轮未解锁，保持 HOLD / FORBIDDEN）

`REAL_MODEL_NETWORK` / `PAID_MODEL_CALLS` / `EXTERNAL_WRITE` / `PAYMENT` / `TRANSPORT` /
`PRODUCTION_CREDENTIALS` / `PRODUCTION_ENABLEMENT` / `P2_F` / `P2_G` / `CUSTOMS real filing` = **HOLD**；
`SECOND_RUNTIME` / `SECOND_POLICY_ENGINE` / `SECOND_CONTROL_PLANE` / `SECOND_MODEL_GATEWAY` /
`SECOND_COST_LEDGER` / `SECOND_META_EVIDENCE_STORE` = **FORBIDDEN**；`L5_RELAXATION` = **FORBIDDEN**。

下列标记**仍为 false**，本轮不主张：
`MODEL_GATEWAY_RUNTIME_WIRED` / `ACTION_RUNTIME_PRODUCTION_ENABLED` /
`META_IMPROVEMENT_INTEGRATED` / `PRODUCTION_READY`。

---

## 6. 请求裁决

1. 以上 U1–U6 是否可作为 **PHASE 3 ACTION RUNTIME** 的阶段性 CLOSED（真实 provider 仍逐个开闸）？
2. `EXTERNAL_WRITE_ACTIONS = GUARD_ENFORCED_ACTIONS ∪ {customs.filing}` 这一「单一事实来源」做法是否认可？
3. 第 4.1 节的 2 项既有失败是否要求在本阶段内一并窄修（涉及 `services/intelligence/` 与 DB 隔离，
   不在本单元改写范围内）？

（若裁决为 `PASS WITH REVISE`，将按裁决继续窄修；本轮不自行 CLOSED。）
