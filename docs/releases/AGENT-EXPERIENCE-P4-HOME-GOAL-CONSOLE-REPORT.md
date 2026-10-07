# 首页 AI RECOVERY MANAGER / GOAL CONSOLE（P4）—— 交付与证据

授权：HOST 2026-10-07「AGENT EXPERIENCE LAYER + DURABLE AUTHORIZATION + GOAL ORCHESTRATION」P4。
`EXACT_HEAD = 999998b1`（基线 `87eb36ae`）

结论：**P4 = CLOSED**。首页上半部分升级为 Goal Console + 四张核心结果卡；
既有 Dashboard 内容**全部保留**（资金概览 / 待处理事项 / 平台卡片 / 追回机会 / 上传批次 / 安全条 / CTA / HOLD 提示）。

---

## 1. 交付内容

| 层 | 文件 | 说明 |
|---|---|---|
| API | `apps/api/src/services/agent-goal/http-request.ts`（P4a, `ba3e8cb0`） | `POST /agent-goals` = P1 编译 → 服务端校验 → P3 落库 → 计划预览；`GET /agent-goals` 列表；恒 `executionPerformed=false` |
| API | `apps/api/src/server.ts`（P4a） | `/agent-goals` 分派（位于 workflow 分派之前；会话由 `resolveSession` 解析） |
| Web | `apps/web/app/components/ui/goal-console.tsx` | 客户端 Goal Console：输入 + 建议任务 + 提交 + 「已记录 + 计划 + 当前 HOLD」结果面板 |
| Web | `apps/web/app/components/ui/recovery-headline-cards.tsx` | 四张核心结果卡（金额逐币种原样展示） |
| Web | `apps/web/app/lib/dashboard-view.ts` | `buildHeadlineCards`（从 `/recovery-money` 的 byCurrency 取值，**零算术**） |
| Web | `apps/web/app/page.tsx` | Goal Console + 四张卡置于页首；既有 Dashboard 顺序与内容不变 |
| i18n | `apps/web/i18n/dictionaries/*.ts` ×5 | 新增 `goalConsole` 段（27 键 × 5 语言） |
| 检查 | `apps/web/scripts/ui-check-entry.tsx` | 新增 14 条渲染断言 |

## 2. 硬要求逐条落实

| HOST P4 要求 | 落实 |
|---|---|
| 不删除现有 Dashboard | 原有区块逐段保留（hero / HOLD 提示 / 资金概览 / 待处理事项 / 平台 / 机会 / 上传 / 安全条）；仅在其上方新增两块 |
| 四张卡：Recoverable / In Recovery / Recovered / Needs Your Attention | `buildHeadlineCards` 固定返回 4 张 |
| **禁跨币种求和** | 金额逐币种**原样**取自后端持久化字符串（`bucket.discovered/expected/recovered`）；前端不做解析、换算或求和；UI 断言 `headline.no.cross.currency.sum` |
| 必须用 persisted / server-derived 状态 | 金额来自 `/recovery-money`；「需要你处理」是 `/recovery-states` 的**计数**，不是金额 |
| UI 不得伪造业务状态 | Goal Console 只展示服务端返回的 `interpretation` 与 `plan.tasks.length`；响应 `executionPerformed=false` → 面板明说「本阶段只做检查与准备，外部提交仍处于 HOLD」；断言 `goal.console.no.fake.execution` |
| 客户可见字符串进 dictionary（5 语言 parity，硬编码 0） | `goalConsole` 段 27 键 × 5 语言；`check-i18n` 报告 `customerHardcodes=0` |

## 3. 测试证据

| 门禁 | 结果 |
|---|---|
| `agent-goal-http-db` | **5/5**（真实 HTTP + PostgreSQL；P4a） |
| P4 定向回归 | **57/57**：`agent-goal` 29 + `agent-goal-runtime-wiring` 7 + `agent-goal-persistence-db` 8 + `agent-goal-http-db` 5 + `commercial-policy-http-db` 8（既有 workflow HTTP 套件，证明 server 分派未被破坏） |
| `tools/i18n/check-i18n.mjs` | **OK** — locales=5 keys=**671** statusCodes=13 customerHardcodes=**0** |
| UI render check | **OK checks=95**（原 81 + 新增 14：goal console 标题/建议/提交/无假装执行/英文 parity；四张卡数量与四种标签；逐币种原样；需要处理计数；无跨币种求和；逐币种说明） |
| `web tsc --noEmit` | exit 0 |
| `next build`（生产构建） | exit 0 |
| `api tsc --noEmit` | exit 0 |

## 4. 边界（未解锁）

Goal Console 只是**入口与投影**：不执行动作、不调用 provider、不授予权限；
`REAL_PROVIDER_WRITE` / `CUSTOMS_FILING` / `PAYMENT` / `AUTO_COMMISSION_CHARGE` / `PRODUCTION_CREDENTIALS` /
`PRODUCTION_ENABLEMENT` / `EXTERNAL_WRITE` / `TRANSPORT` = **HOLD**；高金额 HITL **KEEP**；SA ≠ Broker POA。
客户可见文案如实表达 HOLD（"尚未开启真实平台提交…外部提交仍处于 HOLD"）。

## 5. 下一步

P5 —— 复用 `apps/web/app/components/ui/task-center.tsx` 升级为 Needs Your Attention（不建第二套待办中心），
覆盖 AUTHORIZATION / APPROVAL / CUSTOMS_POA / CUSTOMS_SIGNER / PROVIDER_AUTHORIZATION / CONNECTION_REAUTH /
EVIDENCE_CONFLICT / ACCOUNT_RECONNECT / PAYMENT_ACTION（仅状态）/ CASE。
