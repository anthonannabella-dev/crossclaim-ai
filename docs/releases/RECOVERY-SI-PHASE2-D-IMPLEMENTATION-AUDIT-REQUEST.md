# Recovery SI P2-D v1（Action Guard dry-run）Implementation Audit —— 送审请求

- 分支：`gate/7-commercial-validation`；**REVIEWED_HEAD = `7c3efa11`**（实现提交）
- 前置：**MSG-20261005-19 = PASS WITH REVISE**（`REVIEWED_HEAD = 79618507`；FNV `50b12347` / 528 行 / `FULL_COPY_OK`），要求「新增静态 Guard-action 映射 + 复用可信 Production Control Plane」后送本次实施审计。
- 耐久记录：`docs/releases/RECOVERY-SI-PHASE2-D-EVIDENCE.md`

## 1. 必修 A 的落地

- 新增 `RECOVERY_GUARD_ACTION_MAP`（`READY_FOR_EXECUTION` 执行意图）：`PLATFORM / CARRIER / INDEPENDENT_SITE → claim.submit`、**`CUSTOMS → null`**；
- 新增 `RECOVERY_ACTION_GUARD_MAP`（非执行类）：`EXECUTE_READ_ONLY_CHECK → evidence.read`、`PREPARE_PACKAGE → claim.prepare`，其余 `null`；
- 新增 `RECOVERY_ALLOWED_GUARD_ACTIONS` 白名单；未映射 / 非白名单 → **DENY 且零 Guard 调用**（`GUARD_ACTION_UNMAPPED` / `GUARD_ACTION_UNMAPPED_L5_NO_CATALOG_ACTION` / `GUARD_ACTION_NOT_ALLOWLISTED`）；
- 未使用 `RECOVERY_ACTION_TO_POLICY_ACTION`（RSI Policy Engine 映射）作为 Guard action；未把 `CUSTOMS_FILING` 偷换成 `customs.recovery.start`；
- `execution basis` 增加 `guardAction`，最终十字段：`basisVersion / organizationId / opportunityRef / domain / recoveryActionKind / toolRef / guardAction / snapshotObservedAt / planDigestVersion / planDigest`。

## 2. 必修 B 的落地

- 唯一 capability 来源：`ProductionControlPlane.snapshotFor(organizationId)` → `{ config, degraded }`；判定入口 `evaluateWithoutAudit(input, config)`（不写 Action Guard audit）；
- 本模块**从不**传 `capabilities` 字段（测试断言传给 Guard 的 capabilities = `null`）；`degraded` → DENY 且零 Guard 调用。

## 3. 最小证据 D1–D10（`recovery-si-phase2-d.test.ts`，10 例）

D1 fresh verified only（篡改 → 零调用）｜D2 basis 十字段 + catalog 真实性｜D3 actor 租户错配 → fail-closed｜D4 Control Plane degraded → DENY 零调用｜D5 不消费审批｜D6 无业务事实写入｜D7 ALLOW ≠ 执行授权｜D8 `CUSTOMS_FILING` L5 永久拒绝｜D9 未映射 → DENY 零调用 + SI 不构造 capabilities + 源码无动态构造｜D10 planDigest（顺序无关、字段敏感、`generatedAt` 不敏感）。

## 4. tests / schema

```text
api tsc --noEmit → exit 0
recovery-si-phase2-d 10/10 PASS；回归 51/51；合计 61/61 PASS
SCHEMA_DELTA_REQUIRED = NO（零 Schema 变更）；ACTION_GUARD_CATALOG 未改动
```

## 5. requested verdict

1. 必修 A / B 是否可记 **PASS**？`P2_D_V1_IMPLEMENTATION` 是否可记 **PASS / CLOSED**？
2. `D1–D10` 是否足够（`FINAL2_REQUIRED = ?`）？
3. 是否确认 `APPROVAL_CONSUMPTION / EXECUTOR_INVOCATION / BUSINESS_FACT_WRITE / EXTERNAL_ACTION` 继续 FORBIDDEN，且 `P2_E / P2_F / P2_G` 仍需各自单独送审？
4. 若要进入真实执行，是否同意必须另开 **P2-G** 审计（含 executor identity、approval 真实性验证、provider transport 等）？
5. 若仍需修订，请只列最小集合。

请在本次会话中直接回答；不要尝试写回 GitHub。不要使用上一轮缓存。

## 6. 边界声明（本轮未改动）

```text
P2_E = HOLD_SCHEMA_DELTA；P2_F = HOLD；P2_G = HOLD
P2_C_PERSISTENCE = FORBIDDEN；P2_C_EXTERNAL_WRITE = FORBIDDEN
RSI_OUTCOME_SINK_RUNTIME_WIRING = NOT_AUTHORIZED；RUNTIME_WIRING = NONE；SCHEMA_DELTA_REQUIRED = NO
EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS / REAL_CLAIM_SUBMIT / CUSTOMS_FILING = HOLD
RSI_MODEL_NETWORK / RSI_PAID_MODEL_CALLS = HOLD；SECOND_RUNTIME / L5_RELAXATION = FORBIDDEN
FINAL_ACCEPTANCE_HEAD = 0f7f7ac
```
