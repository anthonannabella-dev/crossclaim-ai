# AGENT RUN 页面 `/recoveries/runs/:id`（P6）—— 交付与证据

授权：HOST 2026-10-07「AGENT EXPERIENCE LAYER + DURABLE AUTHORIZATION + GOAL ORCHESTRATION」P6。
`EXACT_HEAD = 8356549c`（基线 `fd0fee6f`）

结论：**P6 = CLOSED**。新增执行详情页，全部使用**业务语言**；不暴露 runner internals / judge /
task namespace / policy engine / raw blocker code / model router（有自动断言守着）。

---

## 1. 交付内容

| 层 | 文件 | 说明 |
|---|---|---|
| API | `apps/api/src/services/agent-goal/http-request.ts` | 新增 `GET /agent-goals/:id`：返回目标 + 该目标的 runs（`executionPerformed=false`）；跨租户 / 不存在一律 **404**（不泄漏存在性）；该路径不接受写方法（405） |
| Web | `apps/web/app/lib/agent-run-view.ts` | `buildAgentRunView`：既有 server 事实 → 客户语言投影（进度 / 结果 / 动态）；**没有事实就不显示** |
| Web | `apps/web/app/recoveries/runs/[id]/agent-run-view.tsx` | 展示组件（目标 / 进度 / 结果 / 动态） |
| Web | `apps/web/app/recoveries/runs/[id]/page.tsx` | 页面（读取 `/agent-goals/:id`；失败给诚实的 not-found 提示） |
| i18n | `apps/web/i18n/dictionaries/*.ts` ×5 | 新增 `agentRun` 段（49 键 × 5 语言） |
| 检查 | `apps/web/scripts/ui-check-entry.tsx` | 新增 10 条断言 |

## 2. 页面内容（HOST 要求）

* **Goal**：客户原话 + 状态（业务语言）+ 范围（平台账户 / 物流 / 关税 / 独立站）+ 时间范围 + 自动执行上限；
* **Progress**：4 步（目标已记录 → 已生成计划 → 正在检查 → 结果汇总），状态严格按真实 goal status 推进，
  未发生的步骤保持「待开始」，**不虚构进度**；
* **Results**：发现的机会 / 自动处理中 / 等待你批准 / 等待补件 / 已到账（均为**计数**），
  预计可追回**只接受逐币种结构**（`estimatedRecoverableByCurrency`），逐条展示，**绝不跨币种求和**；
  没有 run / 没有 summary → 诚实空状态（"目标已记录，等待授权后才会开始检查"）；
* **Activity**：业务语言时间线（目标已记录 / 开始检查 / 本次检查完成），按时间排序；
* 页面固定展示 HOLD 说明：真实平台提交尚未开启。

## 3. 内部实现不外泄（自动断言）

断言 `agent.run.no.internals` 检查渲染结果**不含** `runner` / `judge` / `policy engine` /
`model router` / `task:recovery`；断言 `agent.run.no.cross.currency` 检查逐币种结果只有 1 条（不合并）。

## 4. 测试证据

| 门禁 | 结果 |
|---|---|
| `agent-goal-http-db` | **6/6**（新增 PG-AGH6：详情面 200 + runs；跨租户 / 不存在 → 404；POST → 405） |
| `api tsc --noEmit` | exit 0 |
| `tools/i18n/check-i18n.mjs` | **OK** — locales=5 keys=**741** statusCodes=13 customerHardcodes=**0** |
| UI render check | **OK checks=113**（原 103 + 新增 10：目标文案 / 业务化范围 / 时间范围 / 进度步骤 / 空状态诚实 / HOLD 文案 / 无内部术语 / 结果渲染 / 无跨币种合并 / 动态时间线） |
| `web tsc --noEmit` | exit 0 |
| `next build` | exit 0（新路由 `/recoveries/runs/[id]` 构建成功） |

## 5. 边界（未解锁）

页面只读取与展示：不推进状态、不执行动作、不触发 provider；`PAYMENT_ACTION` 与外部提交继续 HOLD；
高金额 HITL **KEEP**；SA ≠ Broker POA。

## 6. 下一步

P7 —— Authorization 管理 UI（`/authorizations`）：状态全部来自后端 Standing Authorization；
前端不得生成 `scopeDigest`、不得指定 server-only 权限字段（需要先把 P0 的 durable store 暴露为只读 HTTP 面）。
