# GOAL INPUT UX GUIDANCE —— 输入引导（最小范围单元）

> 目标：让第一次使用 CrossClaim 的客户**无需理解 Amazon FBA / Customs / Logistics / Chargeback / SI Runtime
> 等内部术语**，也能知道输入框里该说什么，并用自然语言直接发起目标。
> 本单元只改 **Goal Hero / Goal Console 及其直接相关文案、建议项、前端交互与 i18n**。

## 1. 严格边界（本单元未触碰）

* 未改：已封板 UI V2 的信息架构、Goal-first 主流程、授权中心语义、Standing Authorization、
  SI / RSI Runtime、后端事实模型、金额计算。
* 未新增第二套执行入口；未修改 Active Recovery allowlist；未解锁任何 external write / provider / payment / production 能力。
* 后端证据：`git diff --name-status <BASE_HEAD> -- apps/api prisma` = **0 文件**（无 backend / runtime / schema 变化）。

## 2. 实现的 5 项

| # | 需求 | 实现 |
| --- | --- | --- |
| 1 | 输入框 Placeholder | `goalConsole.placeholder` 5 语言全部改为「告诉 CrossClaim 你想追回什么，或让我们检查哪里可能有损失……」；**只提示，不改变提交逻辑**；不含任何内部枚举 |
| 2 | 首次使用说明 | 新增 `goalConsole.firstUseHint`：「不用选择复杂菜单。直接描述你的目标，CrossClaim 会自动判断需要检查哪些账户、数据和授权。」渲染在输入区下方（`text-xs/sm text-slate-500`），不抢占 Hero 主视觉；措辞不暗示任何尚未开放的真实外部执行 |
| 3 | 可点击自然语言建议（4 条） | 4 条默认建议按需求替换：Amazon 90 天赔偿 / 物流延误与多收费 / 进口记录可追回关税 / 支付争议与未追回款项；点击**只填入输入框**（`setIntent`），**不自动提交** |
| 4 | Context-aware suggestions | `connectedGoalSignals()` 只读首页**已经获取**的 `GET /accounts` 事实（真实存在且 `status === 'ACTIVE'` 的连接）推导优先级，`orderGoalSuggestions()` **只改变排列**；无数据/无命中 → 默认 4 条顺序；不新建第二份 connection 状态、不猜测平台 |
| 5 | 宽泛输入辅助提示 | `isBroadGoalIntent()`（纯前端提示判定，**不参与任何校验**）命中时显示 `goalConsole.broadHint`：「可以。你可以再告诉我平台、时间范围或账户；也可以直接提交，我会先检查已连接的数据。」提交按钮**保持可用**，不强制补字段、不引入 Wizard、不改变后端 validation / admission |

## 3. 变更文件

| 文件 | 变化 |
| --- | --- |
| `apps/web/app/lib/goal-input-guidance.ts` | **新增**：建议项 key/排序、只读 signals 推导、宽泛输入判定（纯函数） |
| `apps/web/app/components/ui/goal-console.tsx` | 首次说明 + 宽泛提示渲染；建议项按 signals 排序；新增可选 `signals` prop（缺省 = 默认顺序） |
| `apps/web/app/page.tsx` | 传入 `connectedGoalSignals(accounts.body)`（首页已有只读事实，未新增请求） |
| `apps/web/i18n/dictionaries/{zh-CN,en-US,ja,es,de}.ts` | placeholder + 4 条建议（更新）；`firstUseHint` + `broadHint`（新增）；5 语言 key 对齐 |
| `apps/web/scripts/ui-check-entry.tsx` | 新增 13 项渲染级断言（含只读 signals 推导、排序不变式、宽泛判定；**不含**任何硬编码客户文案） |
| `apps/web/acceptance/customer-e2e/journey.mjs` | 新增 10 项真实浏览器断言（placeholder / 首次说明 / 4 条建议 / **点击只填充不提交** / 宽泛提示不阻断） |

## 4. 验收证据

| 门禁 | 结果 |
| --- | --- |
| web tsc | **0** |
| api tsc | **0** |
| `next build` | **0** |
| UI render check | **207/207 OK**（本单元新增 13 项） |
| i18n | **OK**：5 语言 / **885** 键 parity / 客户硬编码 **0** / `RAW_ENUM_FALLBACK_HITS=0` |
| 客户浏览器旅程（desktop 1440×900 + mobile 390×844） | **113/113 PASS**（原 103 + 本单元 10） |
| 浏览器证据目录 | `reports/acceptance/2026-10-07T23-47-14-860Z/` |
| 行为断言 | `home.goal.suggestion.click.fills.input` = PASS；`home.goal.suggestion.click.no.auto.submit` = PASS（点击前后 `/agent-goals` 条数不变）；`home.goal.broad.submit.still.enabled` = PASS；`home.goal.broad.no.wizard` = PASS |
| 定向回归（agent-goal / goal-admission / runtime wiring / architecture contract） | **5 文件 / 230 tests PASS** |
| Goal create / admit / authorization / runtime 链 | 不变（旅程内 `goal.recorded` → `goal.admitted.to.existing.queue` → `runtime.claimed.and.projected` 全绿） |
| revoke 后 DENY 语义 | 不变（沿用已 CLOSED 语义；上一单元链路探针 `chain.revoked.cannot.admit.again` = 403 `STANDING_AUTH_REVOKED`） |
| `externalActionPerformed` / `externalWritePerformed` 语义 | 不变（旅程 `admission.external.write.false` / `runtime.external.write.false` 全绿） |
| desktop + mobile 无横向溢出 | **PASS**（`a11y.*.no.horizontal.overflow` + `mobile.*`） |
| Goal Hero 仍是唯一主要入口 / 未新增竞争 CTA | PASS：未新增任何主 CTA；仅新增输入区下方的轻量说明与提示 |
| backend / runtime / schema 变化 | **无**（`apps/api`、`prisma` diff = 0） |

## 5. 产品原则映射

```
USER SAYS GOAL
  → SYSTEM UNDERSTANDS INTENT            （服务端 Goal compiler，未改动）
  → SYSTEM CHECKS EXISTING CONNECTION / AUTHORIZATION   （未改动）
  → EXISTING GOAL PIPELINE               （未改动）
  → ONE SI RUNTIME                       （未改动）
```

本单元只把**入口的表达成本**降下来：客户说目标即可，不需要学习模块、选择内部 domain 或填工程表单。

## 6. 状态

`GOAL_INPUT_UX_GUIDANCE = PASS / CLOSED`。

边界不变：`REAL_EXTERNAL_EXECUTION = NOT_EXECUTED`、`REAL_VALIDATION_COMPLETE = NO`、`PRODUCTION_READY = NO`；
全部 HOLD / FORBIDDEN 与 `SECOND_* = 0` 不变。
