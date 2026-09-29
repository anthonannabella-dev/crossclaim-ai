# KILL-SWITCH-CHANGE-ENTRY-DESIGN — 变更入口（设计稿，v1）

> 依据架构方 **MSG-20260929-54**：P1.1 = **KILL-SWITCH-CHANGE-ENTRY-DESIGN（DESIGN ONLY）**。
> 只定义变更入口（POST）的契约、状态机、幂等、权限、审计与回滚；**不实现**。变更入口属控制面，需额外审计 CSRF / 鉴权边界 / 并发 / 幂等 / 审计完整性。
> 读取层已在 MSG-20260929-54 收口（GET /admin/kill-switch，PASS）。

## 1. 端点与契约（草案）

| 方法 | 路径 | 用途 | 权限 |
|---|---|---|---|
| GET | `/admin/kill-switch` | 读取状态（已实现） | OWNER/ADMIN 全量；OPS 摘要；FINANCE/VIEWER 403 |
| POST | `/admin/kill-switch` | 发起变更（拉闸 / 申请开启 / 确认开启） | OWNER 发起；确认允许 OWNER/ADMIN（且 ≠ 发起人） |

请求体（同一端点，动作由 `target` + `phase` 决定）：

```
{
  "scope": "submission" | "billing" | "integration" | "platform_connector" | "workflow" | "observability",
  "target": "enabled" | "disabled",
  "phase": "request" | "confirm",
  "reasonCode": "SECURITY_INCIDENT" | "PLATFORM_FAILURE" | "MAINTENANCE" | "TESTING" | "OTHER",
  "note": "≤200 字符；禁止凭据（见 §5）",
  "idempotencyKey": "<uuid，客户端生成>",
  "requestId": "<仅在 phase=confirm 时必填：被确认的申请 id>"
}
```

响应：

- `200 { status: "applied" | "awaiting_confirmation", scope, value, requestId?, confirmationBy? }`
- `400 INVALID_INPUT`（scope/target/phase/reasonCode 非法；note 超长或含凭据）
- `403 FORBIDDEN`（角色不足、同人闭环、非本人申请确认）
- `404 NOT_FOUND`（requestId 不存在）
- `409 CONFLICT`（申请已过期、已被确认、scope 正在被其他请求锁定）
- `405 METHOD_NOT_ALLOWED`（非 GET/POST）

## 2. 状态机

```
（当前值 = disabled，本设计默认）

   ┌──────── request(target=enabled, phase=request) ────────┐
   │                                                        ▼
disabled ── request(target=disabled, phase=request) ──▶ disabled（applied，写审计）
                                                      │
                              PENDING_ENABLE(15min) ──┘
                                     │  confirm(其他人, phase=confirm)
                                     ▼
                                  enabled（applied，写审计）
                                     │  request(target=disabled)
                                     ▼
                                  disabled（applied）

申请过期（>15min）→ 自动失效（惰性判定：确认时判超窗即 409）
```

规则：**关闭容易、恢复困难**（拉闸单人即时；开启必须双人）。申请期间若已有人拉闸 → 申请作废（409）。

## 3. 幂等（idempotencyKey）

- 服务端以 `(organizationId, idempotencyKey)` 为幂等键（v1 进程内 + 审计可追溯；若需持久化 → Schema Delta 审批）。
- 同键重复提交：**返回首次结果**，不重复写审计（`200`，`replayed: true`）。
- 幂等键缺失或非法（非 UUID）→ `400 INVALID_INPUT`。
- 同一 `scope` 同时只允许一个未完成申请；并发第二个申请 → `409 CONFLICT`。

## 4. 鉴权与 CSRF 边界

- 认证：沿用 `cc_session` HttpOnly Cookie；**不引入 Token/Bearer**。
- CSRF：POST 必须校验 `Origin`/`Referer` 与 `Host` 同源，且要求自定义头 `x-crossclaim-csrf: 1`（服务端强制，不仅是前端约定）；失败 → `403 FORBIDDEN`。
- 不做前端「按钮置灰」式防护：无权限即无控件（延续 P0 纪律）。
- 速率限制：同一 `(organizationId, actorUserId, scope)` 每分钟最多 5 次 POST；超限 `429`。

## 5. 审计（复用 AuditLog；不新增表）

`action = killswitch.changed`；`entityType = KillSwitch`；`entityId = <scope>`。

```
changes = {
  scope, oldValue, newValue, reasonCode, note?,
  phase: "request" | "confirm",
  requestId?,            // 开启流程：申请与确认两条审计共享
  confirmationBy?,       // 仅 confirm 记录
  idempotencyKeyHash     // 只存哈希，便于对账且不泄露客户端标识
}
```

- **note 约束（架构方 R1 追加要求）**：长度 ≤200 字符；拒绝包含凭据样式内容的输入（大小写不敏感的 `secret|token|key|password` 后接 `:`/`=`，或长度 ≥32 的连续 base64/hex 串）→ `400 INVALID_INPUT`。
- 读取状态**不写审计**（延续「读不污染审计」）。
- 审计写入与状态变更同一事务；审计失败即整体失败（不得出现"状态变了没记录"）。

## 6. 权限矩阵

| 动作 | OWNER | ADMIN | OPS | FINANCE | VIEWER |
|---|---|---|---|---|---|
| 读取（全量） | ✅ | ✅ | — | ❌ | ❌ |
| 读取（摘要） | — | — | ✅ | ❌ | ❌ |
| 拉闸（target=disabled） | ✅ | ❌ | ❌ | ❌ | ❌ |
| 发起开启 | ✅ | ❌ | ❌ | ❌ | ❌ |
| 确认开启 | ✅（≠发起人） | ✅（≠发起人） | ❌ | ❌ | ❌ |

## 7. 回滚与紧急路径

| 场景 | 路径 | 说明 |
|---|---|---|
| 误开 | `POST target=disabled`（OWNER 单人） | 立即生效；审计 reasonCode=SECURITY_INCIDENT 或 OTHER |
| 紧急关闭 | 同上，且**不受速率限制**（专用 `reasonCode=SECURITY_INCIDENT` 时跳过 429 限制） | 先保护系统，后复盘 |
| 申请需要撤回 | 发起人再次 `POST target=disabled` → 申请作废 | 审计记录 request 与 cancel |
| 恢复流程 | 预发合成数据复验 → 双人确认开启 → 24h 观察 | 观察期用 dashboard/health 只读面监控 |

**硬约束（R2 延续）**：任何变更都不删除 Claim、不修改 Settlement、不回滚 Billing、不删除 AuditLog；只影响未来动作。

## 8. 并发与一致性

- 同一 `scope` 的变更走「乐观锁 + 审计序列号」：确认时校验申请未过期、未被撤销、当前值仍为 `disabled`；否则 `409`。
- 跨 scope 并发互不影响（各自独立）。
- 所有变更在单事务内完成：状态写入（v1 为进程内/配置态）+ 审计写入；审计失败 → 回滚并 `500 SYSTEM_ERROR`（页面/接口不暴露细节）。

## 9. 实现边界（下一阶段，待批准）

允许：POST 路由 + CSRF 校验 + 幂等键 + 状态机 + 双人确认 API + 审计 + 速率限制 + 单元/HTTP 测试（含并发、幂等重放、同人闭环、超窗、note 约束、CSRF 缺失）。
禁止：新表（v1）、新权限键、前端控制入口（仅 API）、把 kill switch 与业务服务深度耦合（必须显式检查点调用）。

## 10. 待裁决（D1–D5）

- **D1**：单一端点 `POST /admin/kill-switch` + `phase=request|confirm` 是否接受？还是拆分为 `/request` 与 `/confirm` 两个端点？
- **D2**：CSRF 采用「同源校验 + 自定义头 `x-crossclaim-csrf`」是否足够（v1 无 State 表）？
- **D3**：幂等键 `(organizationId, idempotencyKey)` 进程内实现（不建表）是否接受？
- **D4**：`reasonCode=SECURITY_INCIDENT` 时跳过速率限制（紧急关闭优先）是否接受？
- **D5**：note 约束阈值（≤200 字符 + 凭据样式拒绝）是否接受，是否需要更严格（例如 ≤120 字符）？
