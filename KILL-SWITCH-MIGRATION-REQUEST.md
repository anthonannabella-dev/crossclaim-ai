# SCHEMA MIGRATION REQUEST — KillSwitchRequest（请求批准；**已执行**）

> **状态：已执行。** MSG-20260929-59（RESULT: GO / STATUS: MIGRATION APPROVED）批准后执行：
> 迁移 `20260930090000_kill_switch_request`；结果见 `KILL-SWITCH-MIGRATION-APPLIED.md`。
> 本文件 §2 的 DDL 为已批准原文，执行时按 §2 末尾说明把触发器函数名替换为既有函数名。

> 依据架构方 **MSG-20260929-58**：Delta R2 = PASS / SCHEMA DESIGN APPROVED；**NEXT: SCHEMA MIGRATION REQUEST REVIEW**。
> 本文件只列出将要执行的 DDL 与影响面。**在获得 Migration Approval 前，不修改 `schema.prisma`、不生成迁移、不部署。**

## 1. 迁移标识（拟）

- 目录：`apps/api/prisma/migrations/20260930090000_kill_switch_request/`
- 内容：`migration.sql`（下表 DDL）+ 无数据回填（纯新增，零数据迁移）

## 2. DDL（拟执行，逐条）

```sql
-- 1) 枚举
CREATE TYPE "KillSwitchTarget" AS ENUM ('ENABLED', 'DISABLED');
CREATE TYPE "KillSwitchRequestState" AS ENUM ('PENDING_ENABLE', 'APPLIED', 'EXPIRED', 'CANCELLED');

-- 2) 表
CREATE TABLE "KillSwitchRequest" (
  "id"             TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "scope"          TEXT NOT NULL,
  "target"         "KillSwitchTarget" NOT NULL,
  "state"          "KillSwitchRequestState" NOT NULL DEFAULT 'PENDING_ENABLE',
  "reasonCode"     TEXT NOT NULL,
  "note"           TEXT,
  "requestedBy"    TEXT NOT NULL,
  "requestedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"      TIMESTAMP(3) NOT NULL,
  "confirmedBy"    TEXT,
  "confirmedAt"    TIMESTAMP(3),
  "appliedAt"      TIMESTAMP(3),
  "idempotencyKey" TEXT NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 3) 外键与索引（Prisma 侧）
ALTER TABLE "KillSwitchRequest"
  ADD CONSTRAINT "KillSwitchRequest_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "KillSwitchRequest_organizationId_idempotencyKey_key"
  ON "KillSwitchRequest" ("organizationId", "idempotencyKey");
CREATE UNIQUE INDEX "KillSwitchRequest_organizationId_id_key"
  ON "KillSwitchRequest" ("organizationId", "id");
CREATE INDEX "KillSwitchRequest_organizationId_scope_state_idx"
  ON "KillSwitchRequest" ("organizationId", "scope", "state");
CREATE INDEX "KillSwitchRequest_expiresAt_idx" ON "KillSwitchRequest" ("expiresAt");

-- 4) 部分唯一索引：同 scope 仅一个 PENDING_ENABLE（Prisma 不支持 → 手写 SQL）
CREATE UNIQUE INDEX "kill_switch_request_pending_unique"
  ON "KillSwitchRequest" ("organizationId", "scope")
  WHERE "state" = 'PENDING_ENABLE';

-- 5) 租户完整性触发器（与既有 27 个同构；总数 -> 28）
CREATE TRIGGER "cc_tenant_kill_switch_request"
  BEFORE INSERT OR UPDATE ON "KillSwitchRequest"
  FOR EACH ROW EXECUTE FUNCTION "cc_assert_tenant_closure"();
```

> 说明：触发器函数名以现有迁移中使用的租户校验函数为准（实现时读取既有迁移确认名称，不新建函数）。

## 3. Prisma schema 变更（与 DDL 对应）

```prisma
enum KillSwitchTarget { ENABLED DISABLED }
enum KillSwitchRequestState { PENDING_ENABLE APPLIED EXPIRED CANCELLED }

model KillSwitchRequest {
  id             String                  @id
  organizationId String
  scope          String
  target         KillSwitchTarget
  state          KillSwitchRequestState  @default(PENDING_ENABLE)
  reasonCode     String
  note           String?
  requestedBy    String
  requestedAt    DateTime                @default(now())
  expiresAt      DateTime
  confirmedBy    String?
  confirmedAt    DateTime?
  appliedAt      DateTime?
  idempotencyKey String
  createdAt      DateTime                @default(now())

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@unique([organizationId, idempotencyKey])
  @@unique([organizationId, id])
  @@index([organizationId, scope, state])
  @@index([expiresAt])
}
```

并在 `Organization` 增加 `killSwitchRequests KillSwitchRequest[]`。

## 4. 影响面清单

| 影响项 | 内容 | 需同步 |
|---|---|---|
| 模型数 | 37 → 38 | `DOMAIN_MODEL.md`、`ARCHITECTURE_CONTRACT.md` |
| 枚举数 | 39 → 41（新增 2） | 同上 |
| 迁移数 | 18 → 19 | `PRODUCTION-READINESS-CHECKLIST.md` |
| 租户触发器 | 27 → 28 | `.github/workflows/ci.yml` 断言、`ARCHITECTURE_CONTRACT.md` |
| 现有表/字段 | **零变更**（纯新增） | — |
| 数据回填 | **无**（新表） | — |
| 运行时行为 | 无（本迁移不接入任何调用路径） | — |

## 5. 回滚方案

```sql
DROP TRIGGER IF EXISTS "cc_tenant_kill_switch_request" ON "KillSwitchRequest";
DROP TABLE IF EXISTS "KillSwitchRequest";
DROP TYPE IF EXISTS "KillSwitchRequestState";
DROP TYPE IF EXISTS "KillSwitchTarget";
```

回滚安全：新表未被任何代码引用（迁移阶段不接线），回滚不丢业务事实。

## 6. 执行与验证步骤（获批后）

1. 修改 `schema.prisma`（§3）并 `prisma validate`；
2. `prisma migrate dev --create-only` 生成迁移目录，按 §2 校正 SQL（含部分唯一索引与触发器）；
3. 本地 `prisma migrate deploy`（全新库 + 现有库各一次）；
4. CI：`migrate deploy` + 触发器断言改为 28 + `tsc --noEmit` + 全量测试；
5. 提交 **MIGRATION APPLIED** 报告（含迁移名、CI 结果、触发器计数）。

## 7. 待批准

- **A1**：批准执行本迁移（§2 DDL + §3 schema 变更）？
- **A2**：批准同步 CI 触发器断言 27 → 28 与文档登记（模型 37→38 / 枚举 39→41 / 迁移 18→19）？
- **A3**：批准回滚方案（§5，纯 DROP，无数据影响）？

> 未获批准前：不动 `schema.prisma`、不生成迁移、不部署。
