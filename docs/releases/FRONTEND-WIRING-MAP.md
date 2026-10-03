# FRONTEND WIRING MAP（G5 / G10 证据）

扫描日期：2026-10-03（HEAD `311cb74`）
扫描范围：`apps/web`（Next.js App Router，49 个 TS/TSX 源文件；排除 node_modules/.next）

## 1. 前端当前真实调用的后端路径（34 条）

```text
/admin/audit, /admin/audit${query}, /admin/imports, /admin/imports/quality-summary, /admin/kill-switch,
/admin/members, /admin/permission-matrix, /admin/recovery-review, /admin/system-health, /admin/tenant-overview,
/api/accounts, /api/auth/login, /api/auth/signup, /api/billing/${invoiceId}/status, /api/cases/,
/api/entitlements, /api/opportunities/${opportunityId}/${action}, /api/opportunities/insights.csv,
/api/recovery-money, /api/recovery-states, /api/uploads,
/billing, /cases, /cases/, /cases/${id}, /cases/${id}/appeal-package, /cases/${id}/claim,
/cases/${id}/evidence, /cases/${item.id}, /connections, /connections/${item.id}/credential-ref,
/connections/${item.id}/status, /opportunities/insights
```

## 2. 尚未接线的新能力（G5 缺口，按本次差集重算）

| 后端能力 | 路由 | 前端现状 | 处置 |
|---|---|---|---|
| Carrier response 读模型（Queue #10） | GET `/carrier-claim-packages/:packageId/responses` | **未接线** | 纳入 UI 批次（只读展示 status/history/provenance） |
| Carrier response 人工补录 | POST 同路径 | **未接线** | 纳入 UI 批次（仅 USER_REPORTED 语义；需先有 package truth 来源） |
| Customs 内部追回准备（C21） | POST `/customs-opportunities/:id/start-recovery` | **未接线** | 纳入 UI 批次（展示 READY_TO_FILE 与 blockers，不显示“已申报”） |
| Customs filing status（C19） | GET `/customs-opportunities/:id/filing-status` | **未接线** | 纳入 UI 批次（只读状态史 + 来源等级） |
| Estimated fee preview（C10–C11） | 契约层（尚无 HTTP） | 不适用 | 待 UI/HTTP 契约明确后接线 |

结论：G5 = **CONFIRMED_GAP（只读 UI 接线待做）**；不涉及任何外部写或资金动作，属 SAFE_CONTINUATION_QUEUE。

## 3. 后端 service → 路由映射（G10 复核）

已接线（本轮及近期批次）：carrier manual submission、carrier response、customs start-recovery、customs filing-status、platform write、claim submit/prepare/package、billing draft、evidence read、provider readiness 等。
未接线但仍属内部完成的 service：customs C15 filing provider 契约（供 C21 使用）、C16 授权就绪（供 C21 使用）、C19 trusted ingest port（供未来 provider webhook 使用，HOLD_EXTERNAL）、C20 refund→fee 契约（供未来资金链路使用，HOLD_EXTERNAL）、commercial fee preview（契约层）。
