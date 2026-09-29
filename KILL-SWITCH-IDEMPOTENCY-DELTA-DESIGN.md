# KILL-SWITCH-IDEMPOTENCY-DELTA-DESIGN — 幂等与请求持久化（Schema Delta 设计稿）

> 依据架构方 **MSG-20260929-56**：变更入口设计 R1 = PASS_WITH_NEXT_DELTA；**实现前必须先完成本 Delta 设计**。
> 本稿只定义 Schema 变更与语义；**未执行任何迁移**，需架构方批准后才生成 migration。

## 1. 为什么需要 Delta

变更入口的幂等键 `(organizationId, idempotencyKey)` 与双人确认状态机（PENDING_ENABLE / EXPIRED_REQUEST）必须**跨进程、跨重启、跨多实例**成立；进程内 Map 会在重启、多实例、容器扩容时失效，因此不能作为生产控制面方案（架构方 D3 = REVISE）。

## 2. 新增模型（唯一提案：方案 A）

```prisma
enum KillSwitchRequestState {
  PENDING_ENABLE
  APPLIED
  EXPIRED
  CANCELLED
}

model KillSwitchRequest {
  id             String                 @id @default(uuid())
  organizationId String
  scope          String
  target         String                  // v1 恒为 "enabled"（拉闸不落库，直接生效）
  state          KillSwitchRequestState @default(PENDING_ENABLE)
  reasonCode     String
  note           String?
  requestedBy    String                  // actorUserId（同租户成员）
  requestedAt    DateTime                @default(now())
  expiresAt      DateTime                // requestedAt + 15min
  confirmedBy    String?
  confirmedAt    DateTime?
  idempotencyKey String
  createdAt      DateTime                @default(now())

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@unique([organizationId, idempotencyKey])
  @@unique([organizationId, id])
  @@index([organizationId, scope, state])
  @@index([expiresAt])
}
```

同时需要在 `Organization` 上增加反向关系 `killSwitchRequests KillSwitchRequest[]`。

**不修改**任何既有模型字段；不修改既有迁移语义。

## 3. 租户隔离触发器（关键影响）

本仓库以 **27 个租户完整性触发器**强制隔离，CI 逐步断言数量为 27。新增 tenant-scoped 表 `KillSwitchRequest` 必须：

1. 在迁移中新增对应触发器（`cc_tenant_kill_switch_request`），使总数变为 **28**；
2. 同步修改 CI 断言（`.github/workflows/ci.yml` 中触发器数量检查 27 → 28）；
3. 在 `ARCHITECTURE_CONTRACT.md` / `DOMAIN_MODEL.md` 中登记「28 触发器 / 新增模型」。

→ 该三点属 **Delta 审批范围**，需架构方一并批准。

## 4. 语义与约束

| 项 | 规则 |
|---|---|
| 幂等 | 同 `(organizationId, idempotencyKey)` 重复请求：返回首次结果，不重复写审计；并发同键由唯一约束兜底（`P2002` → 读取既有记录返回） |
| 同 scope 单飞 | 同租户同 scope 仅允许一条 `state=PENDING_ENABLE`；并发第二条 → `409 CONFLICT` |
| 过期 | `expiresAt <= now()` 的记录不得被确认（`409`），并标记 `state=EXPIRED`（惰性：确认时或读取时判定） |
| 拉闸 | 不创建 request 记录（直接生效）；若存在 PENDING_ENABLE → 置 `state=CANCELLED` |
| 确认 | 仅另一 OWNER/ADMIN；服务端强制 `confirmedBy !== requestedBy` |
| 审计 | 每次状态变化写 `AuditLog(action=killswitch.changed)`；`changes` 附带 `requestId`；幂等重放不写第二条审计 |
| 事务 | 请求写入/状态变更 + 审计写入 + 幂等键落库**同一事务**；任一步失败即整体回滚 |
| 事实保护 | 本表只记录控制面请求，绝不触碰 Claim / Settlement / Billing / AuditLog 既有记录（R2） |

## 5. 保留与清理

- 记录保留：`state=APPLIED/CANCELLED/EXPIRED` 保留 ≥180 天（审计对照），由后续运维清理任务处理（v1 不实现自动清理）。
- `note` 仍受变更入口设计 §11.5 约束（≤200 字符、拒绝凭据样式）。

## 6. 备选方案（不推荐，供裁决）

- **方案 B**：不新增表，改为「以 AuditLog + 唯一约束投影推导幂等」。缺点：无法用数据库约束保证唯一性、并发下需额外锁、审计表承担控制面状态（与「审计只追加事实」的既有语义冲突）→ **不建议**。

## 7. 迁移计划（获批后执行）

1. `prisma/schema.prisma` 增补模型 + 关系；
2. 生成迁移 `20260930xxxxxx_kill_switch_request`（仅 `CREATE TYPE` / `CREATE TABLE` / 索引 / 触发器）；
3. 更新 CI 触发器断言 27 → 28；
4. 更新 `ARCHITECTURE_CONTRACT.md`、`DOMAIN_MODEL.md`、`PRODUCTION-READINESS-CHECKLIST.md`；
5. 跑 `prisma validate` + `migrate deploy`（全新库）+ `tsc` + 全量测试；
6. 提交 IMPLEMENTATION CHECKPOINT（含 Schema 变更与测试证据）。

## 8. 待裁决

- **D1**：采用方案 A（新增 `KillSwitchRequest`）是否批准？
- **D2**：租户触发器由 27 → 28 并同步修改 CI 断言、文档登记，是否批准？
- **D3**：记录保留 ≥180 天（v1 不做自动清理）是否接受？
- **D4**：拉闸不落库（直接生效、仅审计）是否接受？还是也要求落一条 request 记录以便对照？
- **D5**：`note` 是否需要在表中持久化（当前设计持久化），还是只保留在 AuditLog？
