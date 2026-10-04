# CUSTOMER_PRODUCT_BASELINE（UI-1…UI-8 收口）

- 时间：2026-10-04T01:59:34.722Z
- HEAD：`17fda50`
- 分支：`gate/7-commercial-validation`

## 1. 证据

| 项 | 结果 |
|---|---|
| Full API suite（真实 PostgreSQL） | Test Files  282 passed / Tests  2777 passed |
| Web typecheck | `tsc --noEmit` EXIT=0 |
| Web build | `next build` OK（含 /customs） |
| UI 渲染验收 | 81/81 PASS |
| i18n | OK（5 语言 parity，562 键，13 状态码） |
| Customer UI 硬编码 | 0（棘轮基线 0） |

## 2. 已交付客户面

- Customer App Shell（桌面侧栏 + 移动抽屉 + skip-link + Escape 关闭 + aria-current）
- Dashboard（Hero + 状态自适应 CTA + 按币种 4 核心指标 + 平台覆盖 + 待办中心 + 机会卡 + 安全条）
- Opportunity 客户视图（客户语言状态筛选 + 工程筛选折叠）
- Account / Connection 客户视图（客户语言状态 + 操作本地化 + 工程字段折叠）
- Case 详情（8 阶段追回管线 + 人工提交 HOLD 明确）与 Claim Package（材料就绪 vs 需人工提交）
- Money / Billing / Plan 客户视图（预计≠已到账、已计算≠已扣款、Payment HOLD）
- Customs 客户视图 `/customs`（预计 vs 确认、还缺什么、下一步、钱到哪、未向海关提交）
- 全局 404 / error / loading + a11y 语义（role=alert/status、aria-busy、sr-only）

## 3. 边界（未改变）

External Write = HOLD · Payment = HOLD · Provider Transport = HOLD · Production Credentials = HOLD · TRANSPORT=false · `FINAL_ACCEPTANCE_HEAD = 0f7f7ac` 未改动。

## 4. 后续队列

CA-2 AuthorizedSignerFact → CA-3 生命周期持久化 → CA-4 BrokerAuthorizationSession 契约 → CA-5 Customs Authorization Center UI → CA-6 一键追回授权 UX。

## 5. 全量套件尾部输出

```text
   ✓ PC-04 — error / recovery states HTTP contract > import：FAILED → REUPLOAD_REQUIRED；PARTIAL → IMPORT_PARTIAL（含计数与安全错误报告链接） 1098ms
 Test Files  282 passed (282)
      Tests  2777 passed (2777)
   Duration  1171.04s (transform 3.65s, setup 829ms, collect 47.05s, tests 1057.45s, environment 54ms, prepare 23.84s)
```
