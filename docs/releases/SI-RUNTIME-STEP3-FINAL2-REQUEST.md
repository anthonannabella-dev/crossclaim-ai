> **[HISTORICAL_SNAPSHOT]** 本文是历史审计 / 证据快照，原文保留不改写（历史裁决不删除）。
> 其中关于 `RUNTIME_WIRING` / `STEP_3_RUNTIME_POLICY_WIRING` / `RSI_OUTCOME_SINK_RUNTIME_WIRING`
> 的**当时状态**已被后续实现取代：SUPERSEDED_BY=c0b61792（STEP_3_RUNTIME_POLICY_WIRING：
> Recovery SI 作为 domain capability pack 接入 ONE CrossClaim SI Runtime；后续 FINAL-2..6 与 PHASE 2
> 见 ca23b1df / adcab905 / ca298187 / 5f9ce46f / 6e98e66e）。
> 唯一**现行**状态请以 `docs/releases/CURRENT-SI-RSI-STATUS.md` 为准
> （SUPERSEDED_BY=cdd95258 为该状态件的基线 HEAD）。

# STEP_3_RUNTIME_POLICY_WIRING FINAL-2（CHANGE A / B 已落地）

前置：`MSG-20261005-41` = **PASS WITH REVISE**（3A/3B/3D contract-only/3F = PASS；3C Guard-Action Wiring = REVISE；
3E Evidence-Judge = REVISE；两个阻断点 = Judge self-consumption 漏洞 + Action Guard 未进入执行链；
`STEP3_FINAL2_REQUIRED = YES`）。

REVIEWED_HEAD = `ca23b1df`

## ① CHANGE A —— Runner proposal 与 Judge verdict 彻底分离

- `attachContinuationToController`：runner 结束后**只保存 proposal**（`proposals[]`，新增只读访问器 `proposal()`）；
  park 时调用 `engine.markWaitingForVerdict(null)` —— **runner 永不写 Judge verdict**。
- `composeRsiRuntime`：domainPacks 路径**强制 park-for-judge**（`awaitVerdict` 默认 true，`false` 不可绕过）。
- watchdog 只在 `verdict !== null`（真实 external verdict）时消费；verdict 为 null 时只能继续等待。
- 保留：`markWaitingForVerdict(verdict)` 仍为 external verdict adapter 的专属写入口。

## ② CHANGE B —— Shared Action Guard / Control Plane 进入真实执行链

- 新链路：`intent → resolveGuardAction → shared Action Guard / Control Plane dry-run → ALLOW → deterministic read tool`。
- 新增 `RsiRecoveryGuardPort`（`decision: ALLOW | DENY | REQUIRES_APPROVAL`、`degraded`、`killSwitchActive`）；
  缺省适配器 `createFailClosedRecoveryGuardPort()` = **DENY**（未接共享 Guard 时任何执行路径都 BLOCK）。
- 非 ALLOW / degraded / kill switch → `BLOCK`，`reasonCodes` 含 `RECOVERY_GUARD_BLOCKED`，**read tool 调用数 = 0**；
  tenant mismatch 由 Guard 端口返回 DENY → 同样 tool = 0。
- CUSTOMS / unmapped：`resolveGuardAction()` 为 null → **零 Guard 调用**直接 BLOCK（L5 永久禁止未放宽）。
- `rsi-domain-pack` 派发层不再丢弃 guard 决策：`dispatchLog()` 携带 `guardActions`。

## ③ 新增测试（9 例，均 PASS）

| 用例 | 证据 |
|---|---|
| STEP3F2_A1 | runner proposal 保留、`state().verdict === null`；连续两次 watchdog tick 后仍 `waitingForVerdict = true`；只有 external verdict 才完成 |
| STEP3F2_A2 | malformed verdict（`garbage` / `undefined`）→ `normalizeRsiVerdict` 返回 null → 保持等待，不猜、不完成 |
| STEP3F2_B1 | Guard ALLOW → read tool 执行、证据产出（`PASS` + `guardActions[0].decision = ALLOW`） |
| STEP3F2_B2 ×5 | DENY / REQUIRES_APPROVAL / degraded / kill switch / tenant mismatch → `BLOCK`，`readCalls = []`，Guard 被调用 1 次 |
| STEP3F2_B3 | CUSTOMS → `BLOCK`，Guard 调用 0 次、tool 0 次、`guardActions = []` |

## ④ 验证

- `apps/api npx tsc --noEmit` → exit 0
- `rsi-* + si-cost-* + recovery-* + architecture-contract` → **75 files / 759 tests PASS**（原 750 + 新增 9）
- 架构不变量继续成立：`SECOND_RUNTIME = 0`、Recovery SI = 静态 domain pack、第二 event loop / controller / scheduler = 0、
  Policy Core 唯一、Shared Action Guard 唯一、依赖方向正确、`CUSTOMS L5 = PERMANENT BLOCK`、
  `tools/autopilot/** = DEV_SCOPE`、本阶段 `modelCallCount = 0`。
- **未提前宣称**：`MODEL_GATEWAY_RUNTIME_WIRED` / `COST_CORE_RUNTIME_WIRED` / `META_IMPROVEMENT_INTEGRATED`
  仍为 false（当前只是唯一 owner + 不可绕过 contract / boundary；需独立 Runtime·E2E 证据才可升级）。

## ⑤ 请求裁决（请直接在本会话回答；不要写回 GitHub；不要使用上一轮缓存）

1. CHANGE A / CHANGE B 是否可记 PASS？
2. `STEP_3_RUNTIME_POLICY_WIRING` 是否可记 **PASS / CLOSED**（`STEP3_FINAL3_REQUIRED = ?`）？
3. 若 PASS/CLOSED：是否同意按「唯一 owner + 不可绕过 contract」口径关闭 3D/3E 的既有条目，
   而把 `MODEL_GATEWAY_RUNTIME_WIRED` / `COST_CORE_RUNTIME_WIRED` / `META_IMPROVEMENT_INTEGRATED`
   留待后续独立 Runtime/E2E 授权（不影响本阶段 CLOSED）？
4. 若仍需修订，请只列最小集合。

边界：REAL_MODEL_NETWORK / PAID_MODEL_CALLS / EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS /
PRODUCTION_ENABLEMENT = HOLD；P2_F = HOLD / P2_G = HOLD；CUSTOMS real filing = HOLD；
SECOND_RUNTIME / SECOND_POLICY_ENGINE / SECOND_CONTROL_PLANE / SECOND_MODEL_GATEWAY / SECOND_COST_LEDGER /
SECOND_META_EVIDENCE_STORE = FORBIDDEN；L5_RELAXATION = FORBIDDEN；FINAL_ACCEPTANCE_HEAD = 0f7f7ac。

输出请精简结构化（DECISION / KEEP / CHANGE / RISKS / TEST / NEXT / PRODUCTION）。
