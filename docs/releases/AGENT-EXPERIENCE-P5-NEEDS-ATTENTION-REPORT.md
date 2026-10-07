# NEEDS YOUR ATTENTION —— 单一待办中心升级（P5）—— 交付与证据

授权：HOST 2026-10-07「AGENT EXPERIENCE LAYER + DURABLE AUTHORIZATION + GOAL ORCHESTRATION」P5。
`EXACT_HEAD = AGENT-EXPERIENCE-P5-HEAD`（基线 `caf35cba`）

结论：**P5 = CLOSED**。**复用**既有 `task-center.tsx` 升级为 Needs Your Attention，
未新建第二套待办中心；类别模型可承载 HOST 要求的 10 类，且既有 2 个 scope 能力不丢失。

---

## 1. 先扫描再实现

* 既有 `TaskCenter`（`apps/web/app/components/ui/task-center.tsx`）已有「发生了什么 / 影响什么 / 为什么需要我 / 一个明确 CTA」四条结构 —— 本次**只在其上加类别与语义**，不重建组件；
* 既有 `buildTasks`（`dashboard-view.ts`）已把 `/recovery-states`（scope = CONNECTION / IMPORT / CASE）映射为客户语言；
* 授权 / 重连类事实**已经存在**于 `/accounts`（`connection.status` 与 `actions.reconnect`，含 `REAL_OAUTH_EXTERNAL_GATE` 语义）—— 本次从该既有事实派生，不新增事实源、不猜测原因。

## 2. 交付内容

| 文件 | 变更 |
|---|---|
| `apps/web/app/lib/dashboard-view.ts` | 新增 `TASK_KINDS`（12 类 = HOST 10 类 + 既有 CONNECTION / IMPORT）与 `TaskKind`；`TaskView` 增加 `kind`；新增 `buildConnectionTasks`（从 `/accounts` 派生 CONNECTION_REAUTH / ACCOUNT_RECONNECT）；新增 `mergeNeedsAttention`（按 id 去重合并，单一列表）；新增 `buildTaskKindLabels` |
| `apps/web/app/components/ui/task-center.tsx` | 同一组件升级：类别徽标（客户语言）+ `role="list"` / `role="listitem"` + `data-task-kind`；技术 code 不上主文案 |
| `apps/web/app/page.tsx` | `/recovery-states` 任务与 `/accounts` 派生任务**合并为一个**待办列表后再渲染 |
| `apps/web/i18n/dictionaries/*.ts` ×5 | 新增 `needsAttention` 段（21 键 × 5 语言） |
| `apps/web/scripts/ui-check-entry.tsx` | 新增 8 条断言 |

## 3. 类别覆盖（HOST 要求）

`TASK_KINDS` = `AUTHORIZATION` · `APPROVAL` · `CUSTOMS_POA` · `CUSTOMS_SIGNER` · `PROVIDER_AUTHORIZATION` ·
`CONNECTION_REAUTH` · `EVIDENCE_CONFLICT` · `ACCOUNT_RECONNECT` · `PAYMENT_ACTION` · `CASE` ·（+ 既有）`CONNECTION` · `IMPORT`

本轮**真实接入**的类别（有既有 server truth 支撑，均可追溯到 `/recovery-states` 或 `/accounts`）：

* `CONNECTION_REAUTH` ← `connection.status === 'NEEDS_AUTH'` 或 `actions.reconnect.available === true`；
* `ACCOUNT_RECONNECT` ← `connection.status === 'ERROR'`；
* `CASE` / `CONNECTION` / `IMPORT` ← 既有 `/recovery-states`。

其余类别（`AUTHORIZATION` / `APPROVAL` / `CUSTOMS_POA` / `CUSTOMS_SIGNER` / `PROVIDER_AUTHORIZATION` /
`EVIDENCE_CONFLICT` / `PAYMENT_ACTION`）**已可承载但本轮不伪造数据**：其真实来源分别是
Standing Authorization 管理面（P7）、HITL 审批面、Customs 授权中心与证据解析冲突（后续单元）。
**这是刻意的 fail-closed 选择**：宁可不显示，也不显示没有事实支撑的待办。

## 4. 客户语言（示例）

「Amazon US · AMAZON_FBA · 平台授权已过期，需要重新授权」→ 为什么需要我：「重新授权后，CrossClaim 会继续执行原来的任务。」
→ 唯一 CTA：「重新授权」。技术原因码（如 `REAL_OAUTH_EXTERNAL_GATE`）**不出现在主文案**（有断言守着）。

## 5. 测试证据

| 门禁 | 结果 |
|---|---|
| `tools/i18n/check-i18n.mjs` | **OK** — locales=5 keys=**692** statusCodes=13 customerHardcodes=**0** |
| UI render check | **OK checks=103**（原 95 + 新增 8：CONNECTION_REAUTH 类别与 CTA、合并去重、12 类标签齐备、重连文案、类别徽标、list 语义、技术 code 不出现在主文案） |
| `web tsc --noEmit` | exit 0 |
| `next build` | exit 0 |

## 6. 边界（未解锁）

待办中心只展示**状态与下一步**：`PAYMENT_ACTION` 文案明确「支付状态仅作展示；收款与付款仍处于 HOLD」；
不解除任何 HOLD、不触发任何外部动作、不做业务判定。高金额 HITL **KEEP**；SA ≠ Broker POA。

## 7. 下一步

P6 —— Agent Run 页面 `/recoveries/runs/:id`（业务语言；不暴露 runner internals / judge / task namespace /
policy engine / raw blocker code / model router）。
