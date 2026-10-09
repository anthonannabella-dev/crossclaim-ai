# SI-RSI V2-07 — ONE SI Runtime 接线（执行链 + domain pack）

> 授权：HOST DIRECTIVE 2026-10-10「V2-AUTONOMOUS-20261010-01」§二。
> 基线：`21e49891`（V2-06）。分支：`feat/customs-opportunity-unlock-v2`。

## 1. 只读审查结论（接线前必查）

| 审查项 | 结论 |
| --- | --- |
| 是否已有第二 runtime / 调度器 | **无**：`apps/api/src/runtime/rsi-domain-pack.ts` 明确"唯一 runtime，只做派发" |
| pack 合同 | `RsiDomainCapabilityPack = { packId, domain, matches, run }`，由 `createRsiDomainPackRunner` 静态组合派发 |
| 保留命名空间 | `task:recovery:` 为 FINAL-6 保留路由，只允许 reserved pack（`recovery-si`）消费 |
| Pack 能否自授权外写 | **不能**：`externalWritePerformed=true` 会被派发层降级为 `BLOCK`；guard 决策属共享地基 |
| Runner 状态取值 | `RsiRunnerStatus = 'PASS' \| 'REVISE' \| 'BLOCK'` |

## 2. 交付物

| 文件 | 说明 |
| --- | --- |
| `apps/api/src/services/customs/customs-execution-chain.ts` | 11 状态执行链判定（纯函数） |
| `apps/api/src/runtime/customs-unlock-si-pack.ts` | 接入既有派发器的 domain capability pack |
| `apps/api/src/__tests__/customs-execution-chain.test.ts` | 19 项单测 |
| `apps/api/src/__tests__/customs-unlock-si-pack.test.ts` | 7 项单测 |

## 3. 状态链与门禁（顺序推进，第一个不满足即停）

```text
FREE_DISCOVERY                    归属 / 存在性 / Kill Switch / 超时
→ WAITING_CUSTOMER_START          客户必须主动启动（点击 ≠ 付款）
→ WAITING_VERIFIED_PAYMENT        真实付款 + 有效权益 + 额度 > 0（付款 ≠ 授权）
→ TASK_CLAIMED                    任务已被领取
→ RECHECK_ENTITLEMENT_AND_AUTHORIZATION  领取后必须复查（含 Standing Authorization）
→ PROFIT_GATE                     Profit Gate 必须早于 Provider
→ PROVIDER_READY                  Provider 可用 + 有报价 + 外写授权 + Action Guard 审批
→ EVIDENCE_VERIFICATION           证据已核验
→ CASE_PROGRESS                   争议 / 冲正 / 未证实结算在此止步
→ VERIFIED_SETTLEMENT             必须有可信结算事实（结算号 + 正金额 + 已验证）
→ SUCCESS_FEE_RECEIVABLE          仅以已验证实际回款为基数计 15%（定点向下取整到分）
```

`nextAllowedState` 在 HOLD 时给出"门禁解除后会进入的状态"，便于控制器与审计定位。

## 4. 关键不变式的可测证据

| 不变式 | 测试 |
| --- | --- |
| 客户点击 ≠ 已付款 | 已启动但未验证付款 → `WAITING_VERIFIED_PAYMENT` + `VERIFIED_PAYMENT_REQUIRED` |
| 已付款 ≠ 有授权/权益 | 已付款但无权益 → `ENTITLEMENT_REQUIRED`；额度 0 → `QUOTA_EXHAUSTED` |
| 领取前后都要复查 | 领取后未复查 → `POST_CLAIM_RECHECK_REQUIRED` |
| Profit Gate 先于 Provider | `profitGate=HOLD` → 停在 `PROFIT_GATE`，`externalWritePermitted=false` |
| 外写需双重门禁 | 缺 Action Guard 审批或缺外写授权 → 不放行，原因码各异 |
| 无真实回款不计费 | 未证实 / 缺结算号 / 金额 0 → 成功费 `NONE` |
| 同一回款不重复计费 | 已计费 settlementId 再次出现 → `DUPLICATE_SUCCESS_FEE_SUPPRESSED`，费用 `NONE` |
| 分批回款正确计费 | 2000/3000/5000 → `300.00 / 450.00 / 750.00` |
| 自动收款恒 HOLD | 所有结果 `autoCollection='HOLD'`、`chargedAmount=null` |
| pack 不自报外写 | `externalWritePerformed` 恒 false；通过时 guard 决策为 `REQUIRES_SHARED_GUARD_DECISION` |
| pack 不吞他域任务 | `task:recovery:` 保留命名空间一律不匹配；匹配规则由 host 注入 |
| 事实缺失即 BLOCK | 缺租户绑定 / 读取抛错 / 返回 null → `BLOCK`（绝不 PASS） |

## 5. 回归结果（本机真实执行）

```text
VITEST  customs-execution-chain    19/19 PASS
VITEST  customs-unlock-si-pack      7/7 PASS
VITEST  V2 套件合计               150/150 PASS
TSC     apps/api --noEmit           0 error
```

## 6. 未接线与阻断（不伪造）

```text
PACK_REGISTRATION=NOT_WIRED
   本 pack 尚未注册进生产 composition（recovery-si-product-composition / rsi-run）。
   理由：注册即会让运行时开始消费 CUSTOMS 任务；在权益·授权·Provider·Action Guard
   等真实门禁未开闸前，宿主明令"不得激活业务 Runtime"。pack 本身是 fail-closed 的，
   接线属下一授权动作（需 host 明确批准）。
MATCHING_RULE=HOST_INJECTED   匹配规则由 host 注入，pack 不自带启发式匹配，避免误吞他域任务
REAL_RUNTIME_E2E=NOT_VERIFIED 未跑真实控制器端到端（需 DB + 运行时启动授权）
POSTGRESQL_IT=NOT_RUN         本机无 PostgreSQL（127.0.0.1:5432 不可达、Docker 未运行）
```

## 7. 边界自证

`CUSTOMS_EXECUTION_CHAIN_BOUNDARY` / `CUSTOMS_UNLOCK_SI_PACK_BOUNDARY`：
`createsRuntime=false`、`createsScheduler=false`、`externalWritePerformed=false`、
`chargedAmount=null`、`autoCollection='HOLD'`、`modelCallCount=0`、`productionCredentials='ABSENT'`。
未触碰 `main` / release 分支 / U1 封板代码，未重开 U2 Design R21。
