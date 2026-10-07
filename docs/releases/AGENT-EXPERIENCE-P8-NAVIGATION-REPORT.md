# NAVIGATION PROGRESSIVE DISCLOSURE（P8）—— 交付与证据

授权：HOST 2026-10-07「AGENT EXPERIENCE LAYER + DURABLE AUTHORIZATION + GOAL ORCHESTRATION」P8。
`EXACT_HEAD = e9ce6731`（基线 `ce26644e`）

结论：**P8 = CLOSED**。客户导航改为分层信息架构：一级 5 项，其余进 More / Advanced；
**未删除任何 route**，所有既有入口仍可达（有断言逐一核对 href）。

---

## 1. 交付内容

| 文件 | 变更 |
|---|---|
| `apps/web/app/components/nav-model.ts` | `buildCustomerNav` 重构为三级：Main（Home / Recoveries / Money / Needs Attention / Connections）+ More（Opportunities / Cases / Customs / Accounts / Upload）+ Advanced（Billing / Plan / Authorizations） |
| `apps/web/app/recoveries/page.tsx` | 新增 Recoveries 索引页：列出客户自己记录的目标（`GET /agent-goals`），并链到既有 `/recoveries/runs/:id` |
| `apps/web/i18n/dictionaries/*.ts` ×5 | `customerShell` 新增 5 键（navRecoveries / navNeedsAttention / navAuthorizations / groupMore / groupAdvanced）+ 新增 `recoveriesPage` 段（10 键） |
| `apps/web/scripts/ui-check-entry.tsx` | 新增 7 条断言 |

## 2. 信息架构

```
一级（Main）
  Home              /
  Recoveries        /recoveries            ← 新增索引页（目标列表 → 执行详情）
  Money             /money
  Needs Attention   /#customer-tasks
  Connections       /connections

More
  Opportunities /opportunities   Cases /cases         Customs /customs
  Accounts /accounts             Upload /upload

Advanced
  Billing /billing   Plan /plan   Authorizations /authorizations
```

**没有任何 route 被删除或改名**：`isBareRoute` / 既有 URL / API contract 全部不变；
移动端 drawer 结构不变（`customer-nav-drawer` / `aria-expanded` / Esc 关闭）；Goal Console 仍是首页主区域。

## 3. 测试证据

| 门禁 | 结果 |
|---|---|
| `tools/i18n/check-i18n.mjs` | **OK** — locales=5 keys=**798** statusCodes=13 customerHardcodes=**0** |
| UI render check | **OK checks=133**（原 126 + 新增 7：一级 Recoveries / Needs Attention / Connections 文案、More 与 Advanced 分组、**12 个必需 href 全部存在**（`nav.no.route.removed`）、一级恰好 5 项） |
| `web tsc --noEmit` | exit 0 |
| `next build` | exit 0（30/30 静态页；`/recoveries` 索引与 `/recoveries/runs/[id]` 均构建成功） |

## 4. 边界（未解锁）

导航调整不改变任何业务能力：不新增事实源、不改变 API、不解除任何 HOLD；
ADMIN / OPS / DEBUG 路由（`/admin/*`、`/operations`、`/integration-status`、`/platform-recovery-state`）仍**不**出现在客户导航中。

## 5. 下一步

P9 —— OAuthAuthorizationSession / ConnectionSyncState 最小补强（B2 PARTIAL 的真实缺口）：
复用现有 `SourceConnection` / `PlatformAccount` / lineage，不新增第二连接事实源；
SecretVault 不在无生产凭据阶段强行实现。
