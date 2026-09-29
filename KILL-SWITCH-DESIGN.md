# KILL-SWITCH-DESIGN — 全局/租户级熔断开关（设计稿，v1）

> 依据架构方 **MSG-20260929-51**：P1 = **KILL-SWITCH-DESIGN.md（DESIGN ONLY，勿实现）**。
> 本稿只定义语义、权限、审计、默认值与回滚策略；**不含实现**，不含 Schema 变更。任何落地实现需先过 Delta 审批。

## 1. Scope（熔断哪些能力）

| 开关 | 熔断对象 | 关闭时的行为 | 现状对应 |
|---|---|---|---|
| `submission` | 提交准备/执行（Submission Adapter 路径） | 一律拒绝，恒返回 `NEEDS_MANUAL`；人工流程可继续 | 现状已由 `supportsClaimSubmission=false` + `SUBMISSION_TRANSPORT_ENABLED=false` 硬冻结 |
| `billing` | 账单状态推进与佣金对账（含 dry-run 之外的任何推进） | 拒绝推进；只读查询保留 | 现状 `PAYMENTS_ENABLED` 默认关闭 |
| `integration` | 外部平台/承运商连接器（Sync / 抓取 / 上传） | 拒绝外部调用；本地文件路径不受影响 | 连接器 HOLD |
| `workflow` | 工作流写入面（复核、建案、条款、结果确认等写端点） | 拒绝新写操作；读取与导出视图不受影响 | 新增（设计） |
| `observability`（可选） | `/metrics` 等可选出口 | 关闭即 404 | 现状 `METRICS_ENABLED` 默认关闭 |

**层级**：`global`（实例级）→ `tenant`（组织级）。优先级 **tenant 覆盖 global**（更严格优先）；两者同时存在时取「更严格」结果。

## 2. 权限模型（不简单复用普通管理员）

- **开启（解除熔断）= 高风险动作**：仅 `OWNER` 可发起，且需要**双人确认**（发起人与确认人必须是同一租户内两个不同的 `OWNER`，或 `OWNER` + `ADMIN` 且发起人为 `OWNER`）。
- **关闭（拉闸）= 低风险动作**：`OWNER` 单人可以立即执行（安全方向允许单边）。
- `ADMIN`：可查看开关状态与历史，不能单独开启。
- `OPS / FINANCE / VIEWER`：只读查看状态（是否需要可见待裁决 D4）。
- 双人确认窗口：确认必须由**另一个人**在 **≤15 分钟**内完成，逾期视为失败并留痕。

## 3. 审计模型（最低字段）

每次状态变更必须写入既有 `AuditLog`（不新增表）：

```
actorUserId     谁
createdAt       何时（UTC）
action          killswitch.changed
entityType      KillSwitch
entityId        <scope>:<switch>（如 global:submission / tenant:<orgId>:billing）
changes         { switch, scope, oldValue, newValue, reason, confirmationBy? }
```

要求：`reason` 必填（自由文本，禁止粘贴凭据）；`confirmationBy` 在「开启」时必填；读取开关**不写审计**（保持读不污染审计的既有原则）。

## 4. 默认状态与 fail-closed

- 未配置 / 配置缺失 / 解析失败 / 未知取值 → **一律视为 `disabled`（熔断开启）**。
- 默认值（无任何配置时）：`submission=disabled`、`billing=disabled`、`integration=disabled`、`workflow=enabled`（即工作流本身默认可用，其写面仍受各自权限约束）。
- 只接受显式白名单取值：`enabled` / `disabled`；其他字符串一律按 `disabled` 处理并记安全日志（不含配置内容）。
- 环境变量与租户配置冲突 → 取更严格者；两者都缺失 → `disabled`。

## 5. 回滚策略

| 场景 | 动作 | 记录 |
|---|---|---|
| **误开**（错误解除熔断） | 立即单边拉闸（`OWNER` 单人即可）；随后 24h 内复盘 | 两条审计：误开 + 拉闸；复盘写入 `OPERATIONS.md` 事件记录 |
| **紧急关闭** | `OWNER` 直接拉闸，无需确认；系统向审计通道与运维通道各发一次告警（告警通道需宿主决策） | 审计必填 reason（如 `INCIDENT`） |
| **恢复流程** | 排查 → 在预发环境以合成数据复验 → 提交「重新开启」双人确认 → 开启 → 观察窗口（建议 24h） | 审计 + 复盘结论 |

回滚**不涉及数据删除**：熔断只影响后续动作，不逆转已发生的事实（已写入的 Claim/Settlement 不因拉闸而回滚）。

## 6. 与现有机制的关系（不新增权限键）

- 复用既有 env 开关（`SUBMISSION_TRANSPORT_ENABLED` / `PAYMENTS_ENABLED` / `METRICS_ENABLED`）作为**实例级**兜底；Kill Switch 的 `global` 层是其逻辑上位。
- **不新增 RBAC 权限键**；权限判断沿用 `OWNER/ADMIN` 的既有矩阵 + 本稿的双人确认规则。
- 不新增数据库表（v1）：状态可来自运行时配置 + 审计历史推导；若未来需要持久化状态表 → 走 Schema Delta 审批。

## 7. 实现边界（未来实现时）

允许：配置读取层、权限判断、双人确认流程、审计写入、只读状态端点（`GET /admin/kill-switch`）、测试（含 fail-closed、优先级、确认超时、审计字段）。
禁止：新事实表、自动开启、绕过双人确认、把熔断与资金/提交逻辑耦合进既有服务（必须通过显式检查点调用）。

## 8. 待裁决（D1–D5）

- **D1**：Scope 五项（submission / billing / integration / workflow / observability）是否接受？是否需要新增 `platform_connector` 单列？
- **D2**：双人确认规则（OWNER 发起 + 另一 OWNER/ADMIN 确认，15 分钟窗口）是否接受？
- **D3**：审计写入既有 `AuditLog`（不新增表、动作名 `killswitch.changed`）是否接受？
- **D4**：`OPS/FINANCE/VIEWER` 是否可见状态（只读）？
- **D5**：`workflow` 默认 `enabled` 是否接受？还是要求 v1 默认 `disabled`（更保守）？
