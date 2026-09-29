# AUDIT READ API DESIGN — CrossClaim AI

> 状态：**DESIGN ONLY（未实现）** · 依据架构方 **MSG-20260929-10 Q2：GO，但需要 Design First**
> 分支：`gate/7-commercial-validation` · 作者：Codex · 日期：2026-09-29
> 本文档只设计，不改代码、不改 Schema、不新增依赖。获批后才进入实现。

---

## 1. 问题与目标

现状：`AuditLog` **只写不读**。`OPERATIONS.md` §7 的事件响应第 3 步是「导出该租户的 AuditLog」，
但运营只能直连数据库；没有接口意味着：

- 无法回答「这条金额是谁在什么时候改的」（事故复盘的第一问）；
- 无法在不出示数据库凭据的前提下完成取证；
- 审计覆盖面（`tools/audit-coverage` 闸门）无法被人真正消费。

目标：提供一个**只读、租户作用域、脱敏**的审计事件查询接口，使运营/财务/负责人在**不接触数据库**的前提下完成取证。

非目标（明确不做）：

- 不做审计写入、修改、删除（审计日志 append-only 的性质不变）；
- 不做全库查询、跨租户查询；
- 不做审计数据的二次聚合分析（报表属产品化阶段）；
- 不暴露 `changes` 中的原始业务值、PII、凭据引用值与 token。

---

## 2. 接口形态（设计）

```
GET /audit-events?eventType=&from=&to=&actorUserId=&actorRef=&entityType=&entityId=&correlationId=&limit=&cursor=
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `eventType` | 否 | 审计动作名（如 `payment.processing_replayed`）；支持前缀通配 `claim.*`（**前缀匹配固定以 `.` 结尾**，不做正则） |
| `from` / `to` | 否 | ISO 时间（含时区）。默认窗口 **最近 7 天**；上限 **31 天**（超出 → 400 `RANGE_TOO_WIDE`） |
| `actorUserId` | 否 | 按操作者过滤（UUID） |
| `actorRef` | 否 | 系统/外部执行者（如 `payment-retry-worker`、`STRIPE`） |
| `entityType` / `entityId` | 否 | 按实体定位（如 `PaymentProcessingAttempt` + 事件 id） |
| `correlationId` | 否 | 端到端串联（当前写入 `changes` 内的关联字段；若历史数据缺失则返回空而不是猜） |
| `limit` | 否 | 默认 50，上限 200（超出夹取，不报错） |
| `cursor` | 否 | 不透明游标（`createdAt` + `id` 的复合键，**只前向翻页**） |

响应（稳定形状）：

```json
{
  "items": [
    {
      "id": "…",
      "createdAt": "2026-09-29T05:00:00.000Z",
      "action": "payment.processing_replayed",
      "actorType": "USER",
      "actorUserId": "…",
      "actorRef": null,
      "entityType": "PaymentProcessingAttempt",
      "entityId": "…",
      "changeKeys": ["paymentEventId", "newAttemptNo", "reason"],
      "ipHashPresent": true,
      "userAgentPresent": false
    }
  ],
  "nextCursor": "…或 null",
  "window": { "from": "…", "to": "…" },
  "truncated": false
}
```

关键设计：**`changes` 只回键名（`changeKeys`），不回值**。需要看值时走对应的业务只读端点
（例如支付重放看 `/payments`，回收金额看 `/cases/:id/recovery-review`）。
理由：`changes` 是写入方定义的开放载荷，历史上已出现过把原始值塞进 message 的做法；
「不回值」是唯一不依赖逐字段白名单的稳定边界。

---

## 3. 角色可见范围（权限模型）

复用既有权限矩阵 `services/workflow/permissions.ts`，新增权限位 **`viewAuditLog`**（fail-closed：
未知角色一律 false）。

| 角色 | 可见范围 | 不可见 |
|---|---|---|
| OWNER | 全部动作 | `changes` 值、IP 原值、token |
| ADMIN | 全部动作 | 同上 |
| OPS | **运营类动作**：导入/连接/复核/案件/交付物/支付执行与恢复 | 权限与凭据类动作（成员、连接凭据轮换）、`changes` 值 |
| FINANCE | **财务类动作**：账单、回收结果、支付、佣金对账 | 案件内容类、权限与凭据类 |
| VIEWER | 无（403） | 全部 |

动作 → 类别映射必须**显式列白名单**（`AUDIT_ACTION_CATEGORY`），未列出的动作默认只有 OWNER/ADMIN 可见
（fail-closed，新增动作不会被自动放开）。该白名单与 `OPERATIONS.md` §3 的动作清单保持同一来源，
并由现有 `tools/audit-coverage` 闸门保证二者不漂移。

---

## 4. 租户隔离与查询约束

1. **作用域强制**：`organizationId` 永远取自服务端会话（`Session → Membership`），
   请求体/查询串中的任何 `organizationId` **一律忽略**（不是报错，而是不读取）。
2. **禁止全库查询**：没有 `organizationId` 的路径不存在；查询必然带 `organizationId = session.organizationId`。
3. **禁止跨租户**：`entityId` 指向其他租户时返回空列表（不是 403，避免泄漏存在性）。
4. **索引**：现有 `AuditLog` 索引若不含 `(organizationId, createdAt desc)`，本设计建议新增该复合索引
   （**普通索引，无 Schema 语义变化**；若需 Prisma Schema 变更则单独提 Schema Delta Request）。
5. **上限**：默认 7 天窗口、200 条/页；超限夹取而非报错，响应里用 `truncated` 明示。

---

## 5. 脱敏规则（硬边界）

| 字段 | 处理 |
|---|---|
| `ip` | **绝不返回原值**；只返回 `ipHashPresent: boolean`（写入时已加盐哈希） |
| `userAgent` | 只返回 `userAgentPresent: boolean` |
| `changes` | 只返回 `changeKeys`（键名），值一律不回 |
| `credentialRef` | 值不回；如需表达已轮换，用动作名 `connection.credential_ref_rotated` 即可 |
| 任何疑似秘密 | 写入侧已由 `prepareAuditInsert` 做长度截断与 `<redacted>`；读取侧再按 key 白名单过滤一层 |

> 双层防线：写入侧脱敏 + 读取侧投影。任一层的 bug 都不会直接泄漏秘密。

---

## 6. 错误码

| 场景 | 状态 | 错误码 |
|---|---|---|
| 未登录 | 401 | `UNAUTHENTICATED` |
| 角色无 `viewAuditLog` | 403 | `FORBIDDEN` |
| `from`/`to` 非法或窗口 > 31 天 | 400 | `INVALID_INPUT` / `RANGE_TOO_WIDE` |
| `cursor` 非法 | 400 | `INVALID_CURSOR` |
| 其他 | 200 | 空列表（跨租户/无数据不报 404） |

---

## 7. 测试矩阵（实现时必须覆盖）

1. 未登录 401；VIEWER 403；OPS 可见运营动作、不可见权限/凭据动作；FINANCE 只见财务动作。
2. 跨租户：用 ORG_B 的 `entityId` 查询 → 空列表（**不是** 403/404）。
3. 脱敏：响应序列化后不得包含 IP、User-Agent、`changes` 值、`credentialRef` 值、任何 token 形状字符串。
4. 窗口守护：默认 7 天；31 天边界通过；32 天 → 400。
5. 分页：`limit` 夹取 200；写 3 条构造两页，游标前向翻页不重复不遗漏。
6. 前缀过滤：`claim.*` 只匹配 `claim.` 前缀动作；不含 `.` 的 `claim` 不得匹配 `claim_x`。
7. 只读性：本端点不会产生任何 `AuditLog` 写入（读取审计不产生审计噪音，避免自激增长）。

---

## 8. 需要架构方裁定的点

| # | 问题 | Codex 建议 |
|---|---|---|
| A1 | `changes` 是否只回键名 | 建议**只回键名**（见 §2 理由）；若要回值，需要按动作逐个定义白名单，成本高且易漏 |
| A2 | OPS/FINANCE 的动作分类白名单来源 | 建议复用 `OPERATIONS.md` §3 + `tools/audit-coverage` 闸门作为唯一来源 |
| A3 | 读取审计是否需要自身留痕 | 建议**不留痕**（避免自激），但可在 `/metrics` 上计数 |
| A4 | `(organizationId, createdAt)` 复合索引 | 若是普通索引即可，建议由其实施加；若被视为 Schema 变更则请指明走 Schema Delta Request |
| A5 | 是否允许导出 CSV | **建议暂不做**（导出会放大泄漏面，属产品化阶段；与 Q3 HOLD 一致） |

---

## 9. 实施影响面（若获批）

- 代码：`services/auth/data-routes.ts` 新增只读处理器 + 权限位 + 动作分类白名单（约 1 个模块）；
- Schema：仅在需要复合索引时才动（见 A4）；
- 依赖：无新增；
- 安全边界：新增**只读**数据暴露面 → 本设计即为此而写；
- 资金链路 / 规则引擎 / 对外动作：**零改动**。
