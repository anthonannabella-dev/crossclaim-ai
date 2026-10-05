# RSI-P1-06 —— Policy Engine（L0–L5 分级 + 永久 OWNER 硬禁清单）

- 分支：`gate/7-commercial-validation`
- 模块：`apps/api/src/services/autonomy/rsi-policy-engine.ts`（纯函数，零 IO）
- 重要声明：**本模块不授予任何新权限**。它只把 OWNER 规格里已经存在的层级/门禁整理成可判定的决策函数，
  所有默认值都是「拒绝」，L5 是**永久禁区**；它不执行动作、不落库、不发网络、不读凭据，也没有被接进运行时执行路径。

## 1. 层级定义

| 级别 | 含义 | 对应 stage |
| --- | --- | --- |
| L0 | 确定性规则 / 只读观察（不调用模型） | `OBSERVE` |
| L1 | 低成本模型调用（分类/生成 incident） | `AUTO_INCIDENT` |
| L2 | 强模型升级（根因分析 / 文档生成） | `AUTO_PATCH` |
| L3 | 沙箱内代码变更提案与验证 | `AUTO_PATCH` / `AUTO_VALIDATE` |
| L4 | 独立判定与低风险提升 | `AUTO_JUDGE` / `AUTO_PROMOTE_LOW_RISK` |
| L5 | **特权动作：永久禁止 RSI 自治执行** | —（只能由 OWNER 走人工通道） |

## 2. 决策规则（`decideRsiPolicyAction`）

1. **未登记的动作 → fail-closed**：按 L5 处理（`UNKNOWN_ACTION_FAIL_CLOSED` + `PERMANENTLY_FORBIDDEN_FOR_RSI`）。
2. **L5 / 既有 OWNER 清单 → 永久禁止**：`allowedForRsi = false`，即便带上 `ownerApprovalRef` 也不放宽
   （批准只代表「由人执行」，不代表 RSI 可以执行）。
3. **Kill Switch（`RSI_PAUSED`）**：新工作（incident / patch / validate / judge）全部 `KILL_SWITCH_PAUSED` 拒绝；
   仅 `readOnly` 动作（`OBSERVE_STATE` / `HEALTH_CHECK` / `RUN_RULE_ENGINE`）允许，标记 `PAUSED_READ_ONLY_ALLOWED`。
4. **总开关关闭（`RSI_ENABLED=false`）**：连只读动作也拒绝（`RSI_DISABLED`）。
5. **stage 关闭**：该层级动作拒绝（`STAGE_DISABLED:<STAGE>`）。
6. **L4 提升**：必须同时满足「stage 开关打开」+「显式 `autoPromoteEnabled`」+「`riskClass = LOW`」，
   否则拒绝并标记 `AUTO_PROMOTE_DISABLED` / `AUTO_PROMOTE_LOW_RISK_ONLY`，同时要求 OWNER 批准。

`reasonCodes` 去重后排序，决策是纯函数（同输入同输出）。

## 3. 验收

`apps/api/src/__tests__/rsi-policy-engine.test.ts` 10 例：默认放行已登记内部动作、L5 永久禁止（含带批准仍不放行）、
Kill Switch 只放行只读、总开关关闭全拒、stage 关闭拒绝、L4 默认关闭 + 仅 LOW 放行、未知动作 fail-closed、
层级取值与「只有 L5 是永久禁区」、决策确定性、边界常量。

`tsc --noEmit` exit 0；门禁 `api-contract` / `audit-coverage` / `autopilot-rules` 全 OK。

## 4. 边界

```
EXTERNAL_WRITE = HOLD
PAYMENT = HOLD
TRANSPORT = HOLD
PRODUCTION_CREDENTIALS = HOLD
RSI_MODEL_NETWORK = HOLD
RSI_PAID_MODEL_CALLS = HOLD
```

本模块**没有**接进 `rsi:run` 的执行路径，也没有改变任何运行时开关默认值；
若架构方认为「层级 → 动作」映射本身需要独立复核，可作为下一次窄审计的输入，但当前实现是**更严格**而非更宽松。
