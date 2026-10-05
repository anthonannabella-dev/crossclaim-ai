# Recovery SI P2-D v1（Action Guard dry-run）实施证据

- 授权：**MSG-20261005-19 = PASS WITH REVISE**（`REVIEWED_HEAD = 79618507`；FNV `50b12347` / 528 行 / `FULL_COPY_OK`）
- 范围：**dry-run only** —— `fresh verified READY_FOR_EXECUTION → immutable execution basis → trusted Control Plane snapshot → Action Guard dry-run → ALLOW / DENY / REQUIRES_APPROVAL → STOP`
- 交付：`apps/api/src/services/intelligence/recovery-guard-dry-run.ts` + `apps/api/src/__tests__/recovery-si-phase2-d.test.ts`（10 例）

## 1. 必修 A —— 静态 Guard-action 映射（不复用 RSI policy 映射）

```text
RECOVERY_GUARD_ACTION_MAP（READY_FOR_EXECUTION 的执行意图）
  PLATFORM / CARRIER / INDEPENDENT_SITE → claim.submit
  CUSTOMS → null                 （customs filing 在 ACTION_GUARD_CATALOG 无等价 action）
RECOVERY_ACTION_GUARD_MAP（非执行类）
  EXECUTE_READ_ONLY_CHECK → evidence.read
  PREPARE_PACKAGE → claim.prepare
  其余（REQUEST_* / WAIT_PROVIDER / FILE_MODE_FALLBACK / HOLD）→ null
RECOVERY_ALLOWED_GUARD_ACTIONS = ['claim.submit', 'claim.prepare', 'evidence.read']（白名单，非 catalog 名字即 fail-closed）
```

未映射 / 非白名单 / Control Plane 降级 → **DENY 且零 Guard 调用**；`CUSTOMS_FILING` 继续
`decideRecoveryExecutionRequest('CUSTOMS_FILING') → L5 permanentlyForbidden`，**不偷换**成 `customs.recovery.start`。

## 2. 必修 B —— capabilities 只来自可信 Control Plane

```text
ProductionControlPlane.snapshotFor(organizationId)      → { config, degraded }
ProductionControlPlane.evaluateWithoutAudit(input, config) → ActionGuardResult（不写 Action Guard audit）
SI_SELF_SUPPLIED_CAPABILITIES = FORBIDDEN（本模块从不传 capabilities 字段）
```

## 3. 最小证据 D1–D10

| # | 证据 |
| --- | --- |
| D1 | 只有 fresh verified `READY_FOR_EXECUTION` 进入 Guard；篡改 plan → `guardEvaluated` 全 false、Guard 调用 = 0 |
| D2 | execution basis 十字段齐全；`guardAction='claim.submit'` 且经 `evaluateActionGuard` 验证为**既有 catalog action**（非 `ACTION_GUARD_UNKNOWN_ACTION`） |
| D3 | actor 租户错配 → `TENANT_MISMATCH`、零 Guard 调用 |
| D4 | Control Plane `degraded` → 全部 DENY、零 Guard 调用 |
| D5 | `approvalConsumed = false`（边界常量 `approvalConsumption = FORBIDDEN`） |
| D6 | `businessFactWrite = FORBIDDEN`（无任何业务事实写入路径） |
| D7 | Guard ALLOW 仍 `executionAuthorized = false` / `executorInvoked = false` |
| D8 | `CUSTOMS_FILING` → L5 永久拒绝；`RECOVERY_GUARD_ACTION_MAP.CUSTOMS = null`（零 Guard 调用） |
| D9 | 未映射意图 → `GUARD_ACTION_UNMAPPED_L5_NO_CATALOG_ACTION`（Customs）/ `GUARD_ACTION_UNMAPPED`，零调用；传给 Guard 的 `capabilities` 为 `null`（SI 不构造）；源码无 `new Function` / `eval(` / `require(` |
| D10 | planDigest：同一 canonical plan 与 actions 逆序 → digest 相同；篡改任一 execution-relevant 字段 → digest 改变；`generatedAt` 变化不影响（`plan-digest/v1`） |

验证：`recovery-si-phase2-d` 10/10 + 回归 51/51 = **61/61 PASS**；api `tsc --noEmit` exit 0。

## 4. 未改动 / 继续冻结

```text
APPROVAL_CONSUMPTION / EXECUTOR_INVOCATION / BUSINESS_FACT_WRITE / EXTERNAL_ACTION = FORBIDDEN
P2_E = HOLD_SCHEMA_DELTA；P2_F = HOLD；P2_G = HOLD
P2_C_PERSISTENCE / P2_C_EXTERNAL_WRITE = FORBIDDEN；RSI_OUTCOME_SINK_RUNTIME_WIRING = NOT_AUTHORIZED
RUNTIME_WIRING = NONE；SCHEMA_DELTA_REQUIRED = NO（本模块零 Schema 变更）
ACTION_GUARD_CATALOG 未改动；审批/HITL 语义未改动（approval 真实性/撤销/过期/绑定仍由既有 verifier 验证）
SECOND_RUNTIME / L5_RELAXATION = FORBIDDEN；FINAL_ACCEPTANCE_HEAD = 0f7f7ac
```
