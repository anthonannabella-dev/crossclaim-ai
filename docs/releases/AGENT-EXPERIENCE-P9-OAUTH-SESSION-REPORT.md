# OAUTH AUTHORIZATION SESSION + CONNECTION SYNC STATE（P9）—— 交付与证据

授权：HOST 2026-10-07「AGENT EXPERIENCE LAYER + DURABLE AUTHORIZATION + GOAL ORCHESTRATION」P9。
`EXACT_HEAD = AGENT-EXPERIENCE-P9-HEAD`（基线 `4d66ed1c`）

结论：**P9 = CLOSED**。补上 B2 的真实缺口（durable OAuth 会话 + 连接同步检查点），
并让「主动授权」与「按需授权」两条 UX 都成立；Customs 授权复用既有中心。

---

## 1. 先扫描：什么已经存在（不重复造）

| 既有能力 | 位置 | 结论 |
|---|---|---|
| OAuth state 生成 + PKCE + TTL + 契约校验 | `services/connect/oauth-state.ts`（PC-11A） | **复用**（P9 不改语义） |
| 回调编排（consume → exchange → scope 校验 → 身份验证 → bind plan） | `services/connect/provider-callback.ts` | **复用** |
| 连接事实（身份 / 状态 / 生命周期） | `SourceConnection` + `PlatformAccount` | **复用**，不新增第二事实源 |

真实缺口：state store **只有内存实现**（重启即丢）、没有 durable 会话记录、没有
「callback 成功后恢复原 goal」的绑定、没有连接同步检查点。

## 2. 交付内容（2 表，无新增枚举）

| 表 | 用途 | 关键约束 |
|---|---|---|
| `OAuthAuthorizationSession` | durable OAuth 授权会话（redirect → callback → verified connection → **resume goal**） | `stateDigest`（sha256，**原始 state 不落库**）唯一 → 重放保护；CHECK：状态词表 / digest 长度 / 窗口 / 已消费必须带 `consumedAt`；身份不可改写触发器 |
| `ConnectionSyncState` | 既有连接的**同步检查点投影**（cursor / 上次成功 / 上次错误 / 连续失败 / 重试状态） | `(organizationId, connectionId)` 唯一（每连接恰好一条）；`connectionId → SourceConnection` 同租户校验；CHECK：`retryState ∈ {IDLE,BACKOFF,NEEDS_REAUTH}`、失败计数 ≥ 0；身份不可改写触发器 |

服务模块：

- `services/connect/prisma-oauth-session-store.ts`：`initiateOAuthAuthorizationSession`（复用既有 state/PKCE 逻辑 + 落 durable 行）、
  `createPrismaOAuthStateStore`（durable `OAuthStateStore`，`take` 用行级 CAS 把 PENDING → CONSUMED）、
  `succeedOAuthAuthorizationSession`（绑定 connectionId / credentialRef，保留 `resumeGoalId`）、`failOAuthAuthorizationSession`、读取面。
- `services/connect/prisma-connection-sync-state.ts`：`recordConnectionSyncSuccess` / `recordConnectionSyncFailure` /
  读取面 + **纯函数** `computeSyncRetryState`（指数退避 + 上限；连续失败达阈值 → `NEEDS_REAUTH`）。
  **不含任何定时器 / 循环**（不建第二 scheduler）。

## 3. 「主动授权 + 按需授权」两条 UX（HOST 要求 2）

* **主动**：`/authorizations`（P7）+ `/connections` —— 客户可提前查看 / 撤销授权。
* **按需**：首页 `Needs Your Attention` 新增 `AUTHORIZATION` 项 —— 当客户**已记录的目标**仍处于
  `PROPOSED`（等待授权）时自动出现：「这个目标需要你授权 / 完成授权后，CrossClaim 会继续执行原来的目标，
  不需要你重新提交 / [去授权]」；授权完成后该待办**自动消失**（由目标状态派生，无需重新提交目标）。
  有断言守着（`authz.task.*`）。

## 4. Customs 授权复用（HOST 要求 3）

`/authorizations` 页面显式链到**既有**关税授权中心 `/customs/authorization`，并如实说明
「关税（报关 / 委托书 / 签署人）的授权仍在既有中心管理，自动追回授权不能替代它」—— **没有重建**任何 Customs 授权判定。

## 5. 测试证据

| 门禁 | 结果 |
|---|---|
| `oauth-session-connection-sync-db` | **6/6**（真实 PostgreSQL）：只落 state 摘要 + 一次性消费 + 重放拒绝；**新连接（重启等价）仍可消费**；过期 fail-closed；callback 成功绑定连接/凭据并保留 resumeGoalId；失败不得转成功；跨租户读恒空、操作 NOT_FOUND；state 摘要唯一兜底；同步检查点推进/退避/连续失败转 NEEDS_REAUTH/跨租户 connectionId 被租户触发器拒绝 |
| `api tsc --noEmit` | exit 0 |
| `prisma validate` / `migrate deploy` | valid / 91 migrations 全部成功 |
| 触发器清单 | required **118 baseline / 95 immutable / 2 scoped**；append-only **72** 全 OK |
| architecture-contract | **167/167**（模型总数 113；两表纳入 CORE / TENANT_OWNED） |
| i18n | **OK** — 5 语言 / 803 键 / 客户硬编码 **0** |
| UI render check | **OK checks=138** |
| `web tsc` | exit 0 |

## 6. 边界（未解锁）

`REAL_PROVIDER_WRITE` / `CUSTOMS_FILING` / `PAYMENT` / `AUTO_COMMISSION_CHARGE` / `PRODUCTION_CREDENTIALS` /
`PRODUCTION_ENABLEMENT` / `EXTERNAL_WRITE` / `TRANSPORT` = **HOLD**；
`SECOND_RUNTIME` / `SECOND_SCHEDULER` / `SECOND_GUARD` / `SECOND_POLICY_ENGINE` = **0**；
OAuth 会话 `productionAuthorizationEnabled = false`、`bindExecuted = false`；不持有生产凭据（只存 `credentialRef` 引用名）。

## 7. 下一步

FINAL —— 全量回归 + 自包含 FINAL AUDIT PACKAGE + 右侧 ChatGPT 独立架构/安全/产品验收。
