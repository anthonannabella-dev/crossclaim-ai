# SI-RSI V2-02 — Provider 全出口 Gate 覆盖与绕过检测

> 授权：HOST DIRECTIVE 2026-10-09「CUSTOMS OPPORTUNITY UNLOCK & AUTO-COMMISSION V2」PHASE A / PHASE D。
> 基线：`aa549755`（V2-01）。分支：`feat/customs-opportunity-unlock-v2`。
> 目的：确认"免费阶段收费调用触达次数"与"Provider 全出口覆盖"，并锁死绕过 Gate 的路径。

## 1. 只读核实结论（V2-02 前置检查）

| 核实项 | 方法 | 结论 |
| --- | --- | --- |
| 生产代码是否直接调用 provider 出站方法 | 全仓 `rg` + 静态扫描测试 | **0 处**（全部命中都在 `__tests__`） |
| `services/customs` 内是否存在出站 HTTP | 全目录搜索 `fetch(` / `axios` / URL 字面量 | **0 处** |
| server 注入的 provider 依赖形状 | `server.ts` 类型声明 | `{ providerId, capabilities }` —— **不含方法**，仅用于路由与能力展示 |
| `filingProvider` 在业务代码中的用法 | `ior-recovery-chain.ts:209-210` | 只读能力位（`filingCapabilityEnabled` / `credentialPresent`），非调用 |
| 真实 Provider 接入状态 | 组合点检查 | 仍为 `HOLD_EXTERNAL`，尚未接线 |

**含义**：当前"免费流程触达收费 API"的实际风险不是"已有调用漏拦"，而是**未来接线时缺少强制通道**。
V2-02 因此交付"唯一组合点 + 全出口覆盖断言 + 绕过检测回归"。

## 2. 发现并修复的出站覆盖漏洞

V2-01 的 `PAID_CUSTOMS_OPERATIONS` **漏了 `getSubmission`**（C15 的提交读出口）——
即 C15 契约 7 个出站方法中只有 6 个受 Gate 约束，`getSubmission` 可直接绕过。

修复：

- 新增操作 `SUBMISSION_READ` → 方法 `getSubmission`，纳入 Gate。
- 新增 `CUSTOMS_FILING_PROVIDER_OUTBOUND_METHODS`（9 项，含非 C15 的 `readData` / `lookupRate`）。
- 新增**双向穷尽映射** `METHOD_BY_OPERATION` / `OPERATION_BY_METHOD`：
  任一方向少一个成员 → **编译失败**，不可能再"悄悄"新增未受约束的出口。
- 新增 `assertProviderFullyGated()`：若包装结果仍直接暴露原函数（漏包 / 被还原）→ 抛
  `CustomsProviderUngatedExitError`，fail-closed。

## 3. 唯一组合点

`apps/api/src/services/customs/customs-paid-provider-composition.ts`

```text
composeGatedCustomsFilingProvider({ provider, resolveContext, counter?, now? })
  → provider === null                 → { provider: null, gated: false }（回落 CLAIM_READY / BROKER_HANDOFF）
  → provider !== null                 → 包装 → 全出口断言 → Object.freeze（gated: true）
  → 断言失败                          → 抛错，不返回半成品
```

未改 `server.ts`：其 `customsFilingProvider` 依赖是**无方法的窄结构**，当前不存在可被包装的注入点；
本组合函数即为未来真实 Provider 接入时的指定入口（接线属后续切片）。

## 4. 交付物

| 文件 | 说明 |
| --- | --- |
| `customs-paid-api-gate.ts`（改） | `SUBMISSION_READ` + 双向穷尽映射 + `assertProviderFullyGated` |
| `customs-paid-provider-composition.ts`（新） | 唯一组合点 + 冻结 + 边界自证 |
| `customs-paid-provider-composition.test.ts`（新） | 10 项：全出口覆盖 / 冻结 / 漏包检测 / 静态绕过扫描 |
| `customs-paid-api-gate.test.ts`（改） | 映射期望更新为 9 项 + 双向一致性断言 |

## 5. 回归结果（本机真实执行）

```text
VITEST  customs-paid-api-gate            33/33 PASS
VITEST  customs-paid-provider-composition 10/10 PASS
        （含静态扫描：apps/api/src 全树非 __tests__ 文件对 provider 出站方法的调用数 = 0）
TSC     apps/api --noEmit                0 error
```

## 6. 仍未证明（不伪造）

```text
FREE_SCAN_PAID_API_CALLS=0   仅证明于 Gate/组合范围内；真实 Provider 尚未接线，端到端待接线后重判
REAL_PROVIDER_VALIDATION=NO   未接入真实 Provider（HOLD_EXTERNAL）
POSTGRESQL_IT=NOT_RUN         本机无 PostgreSQL（127.0.0.1:5432 不可达、Docker 未运行）
LINUX_SYSTEMD=NOT_VERIFIED    本机 Windows
```

## 7. 边界自证

`CUSTOMS_PROVIDER_COMPOSITION_BOUNDARY`：`externalCallPerformed=false`、`providerInvoked=false`、
`chargedAmount=null`、`paymentCaptured=false`、`autoCollectionEnabled=false`、`transportEnabled=false`、
`productionCredentials='ABSENT'`。未新增调度器 / Runtime，未触碰 `main` / release / U1 封板。
