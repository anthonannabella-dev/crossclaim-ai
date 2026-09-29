# ADMIN — USER / MEMBERSHIP VIEW — DESIGN（P4 / A2, R0）

> 类型：**Design Only**（MSG-20260929-38：P4 = A2 User/Membership View，DESIGN-FIRST）
> PREVIOUS: MSG-20260929-38（Admin Phase 3 = PASS_CLOSE；P4 GO_DESIGN_FIRST）
> 分支 `gate/7-commercial-validation` · Codex · 2026-09-29 · ROUND: **R0**

**定位**：身份治理的**只读视图**。Admin 看到「谁在这里、什么角色、什么状态」，
但**不做任何治理动作**——邀请、改角色、停用、删除、重置凭据全部不在 v1。

---

## 0. 允许 / 禁止

| 可以（只读） | 禁止（v1 一律不做） |
|---|---|
| 查看成员与角色 | ❌ 邀请用户 |
| 查看成员状态（ACTIVE / 非 ACTIVE） | ❌ 修改角色 |
| 查看权限矩阵（只读展示） | ❌ 停用 / 删除用户 |
| 查看会话**计数与状态** | ❌ 吊销会话 |
| 查看邀请**状态** | ❌ 重发 / 撤销邀请 |
| 查看最后登录时间 | ❌ 重置密码 / 重置 MFA |

治理动作若未来需要：`ADMIN-GOVERNANCE-DESIGN`（必须带权限、审计与双人复核）。

---

## 1. 六个关键取舍（按 MSG-20260929-38 要求逐项回答）

| # | 问题 | 本设计取舍 | 理由 |
|---|---|---|---|
| Q1 | **角色展示粒度** | 展示 `Membership.role` 原值 + `isActive`；**不**展示角色的「可编辑」态 | 角色值即事实；可编辑属治理动作 |
| Q2 | **是否显示邮箱** | **显示**（仅 OWNER/ADMIN）；页内只读，**不导出** | 邮箱是识别成员的最小必要信息；导出会扩大 PII 面 |
| Q3 | **Session 是否展示** | 仅展示**计数**与状态分布（活跃 / 过期）；**不**展示 `tokenHash`、IP、UA、单条会话明细 | 会话明细属安全敏感面；计数足以判断「是否有异常登录规模」 |
| Q4 | **最后登录时间** | 展示 `User.lastLoginAt`；同时展示 `status` 与「是否锁定」布尔 | 登录时间是运维必要信息；锁定状态是安全信号 |
| Q5 | **邀请状态** | 展示邀请 `status` / `expiresAt` / `attemptCount`（计数）；**不**展示 `tokenHash`、邀请链接 | 邀请链接等同凭据 |
| Q6 | **权限矩阵** | 展示**只读**矩阵（角色 × 权限键布尔值），来源为代码常量 `permissionsFor` | 矩阵是解释「为什么该角色能做/不能做」的文档化视图；**不可编辑** |

---

## 2. 数据来源与字段白名单（全部既有）

| 视图 | 来源 | 白名单字段 |
|---|---|---|
| 成员列表 | `Membership` + `User` | userId / displayName / email / role / isActive / lastLoginAt / status / locked（布尔） |
| 成员详情 | 同上 + `Session` 聚合 | 会话总数 / 活跃数 / 过期数（**不返回单条会话**） |
| 邀请 | `UserInvitation` | status / expiresAt / attemptCount |
| 权限矩阵 | `permissionsFor`（代码常量） | 角色 → 权限键布尔值 |

**永久禁键**（任何响应不得出现）：`passwordHash`、`tokenHash`、`inviteToken`、`secret`、`credential`、`storageKey`、`ip`、`userAgent`、`amount`、`currency`。

---

## 3. 权限（沿用 D1 角色表，不新增权限键）

| 视图 | 角色 |
|---|---|
| A2 全部只读视图 | OWNER / ADMIN（新增 Admin 模块分层 `userMembership`） |
| OPS / FINANCE / VIEWER | 403（fail-closed；OPS 的 Admin 权限仅限 importValidation 与 systemHealth） |

---

## 4. 查询模型（草案；全部 GET + 只读）

```
GET /admin/members?cursor=&limit=
GET /admin/members/:userId
GET /admin/permission-matrix
```

* 强制 `organizationId`；游标分页沿用既有口径（默认 25、上限 100）。
* 无写端点、无导出、无下载。

---

## 5. 实现阶段验收（等 GO 后提交）

1. 端点全为 GET；**无任何治理端点**（不存在 invite / role-update / deactivate / delete / session-revoke）。
2. 租户隔离：A 看不到 B 的任何成员、邀请或会话计数（真实库断言）。
3. 白名单与禁键扫描：响应中不含 `passwordHash` / `tokenHash` / 邀请链接 / IP / UA / 金额（离线 + 真实库深度扫描）。
4. 权限矩阵只读：矩阵来自代码常量，响应中不含任何可写标记或变更入口。
5. 只读证明：读取前后 `User` / `Membership` / `Session` / `UserInvitation` / `AuditLog` 快照一致。

---

## 6. 请裁决

NEED: **GO / REVISE / HOLD**（ADMIN-USER-MEMBERSHIP-DESIGN）

* **D1 邮箱**：确认对 OWNER/ADMIN 展示成员邮箱（页内只读、不导出）？还是要求掩码（如 `a***@b.com`）？
* **D2 Session 粒度**：确认只出**计数与状态分布**（不出单条会话明细）？
* **D3 邀请字段**：确认 `status / expiresAt / attemptCount` 足够（不出 tokenHash 与邀请链接）？
* **D4 锁定状态**：是否允许展示「是否锁定」布尔位（配合 `status`）？还是完全不出？
* **D5 权限矩阵**：确认矩阵为**只读展示**且不出现在任何可编辑上下文中？

> 边界未变：只读、单租户、无新表、无写路径、无治理动作、无凭据与 PII 泄露；自动提交 FORBIDDEN、自动扣佣 HOLD。

---

## 7. R1 修订记录（MSG-20260929-39 = GO_WITH_MINOR_REVISE）

| 裁决项 | 最终口径 |
|---|---|
| D1 REVISE | **邮箱默认掩码**（例如 `a***@b.com`）；不返回完整邮箱，也不提供解掩码入口 |
| D2 GO | 会话仅计数与状态分布（无单条会话明细、无 IP/UA/tokenHash） |
| D3 GO | 邀请仅 `status` / `expiresAt` / `attemptCount`（无 tokenHash、无邀请链接） |
| D4 GO_WITH_MINOR_REVISE | **仅允许 `locked` 布尔**（不给失败次数、不给锁定原因，不给解锁入口） |
| D5 GO | 权限矩阵只读展示 |

### 7.1 硬约束：Admin v1 无任何写路径

不得出现（且实现期需静态扫描确认）：invite / updateRole / deactivate / delete / revokeSession / resetPassword 等任何写端点或导出函数。

### 7.2 实现期验收（补充）

1. 邮箱掩码单测（响应中不出现完整邮箱字符串，仅掩码形式）。
2. 锁定位仅布尔（响应中不出现失败次数或锁定原因字段）。
3. 无写路径扫描（导出面与端点层均无邀请/改角色/停用/删除/吊销会话/重置凭据）。
4. 只读证明：读取前后 `User` / `Membership` / `Session` / `UserInvitation` / `AuditLog` 快照一致。
