# KILL-SWITCH-MIGRATION-APPLIED — KillSwitchRequest 迁移执行报告

> 类型：**MIGRATION APPLIED CHECKPOINT**
> 依据：**MSG-20260929-59**（RESULT: GO / STATUS: MIGRATION APPROVED / NEXT: EXECUTE MIGRATION + VALIDATION）
> 分支：`gate/7-commercial-validation` @ **bec1210**（归档提交 `96e0bf9` + 迁移提交 `bec1210`）
> 性质：Schema Enablement —— **不是** Production Enablement

---

## 1. 交付物

| 类别 | 内容 |
|---|---|
| 迁移 | `apps/api/prisma/migrations/20260930090000_kill_switch_request/migration.sql`（新增） |
| Schema | `apps/api/prisma/schema.prisma`：+2 枚举（`KillSwitchTarget` / `KillSwitchRequestState`）、+1 模型（`KillSwitchRequest`）、`Organization.killSwitchRequests` 反向关系 |
| CI | `.github/workflows/ci.yml` 触发器断言 27 → **28**（含输出文案） |
| 架构契约测试 | `apps/api/src/__tests__/architecture-contract.test.ts`：模型总数 37 → **38**（35 core + 3 join）；`KillSwitchRequest` 纳入 CORE / TENANT_OWNED / TRIGGERED；新增 5 条 Kill Switch 断言（幂等唯一键、枚举取值、部分唯一索引、第 28 个触发器、不触碰资金模型） |
| 文档 | `DOMAIN_MODEL.md`（38 模型 + 控制面小节 + 迁移清单补齐 4 条历史迁移与新迁移）、`ARCHITECTURE_CONTRACT.md`（§5.2 覆盖范围 24 表 / 28 触发器；新增 §5.6 登记新触发器事实；RecoveryPayout 例外段更新为「届时 28 → 29」）、`PRODUCTION-READINESS-CHECKLIST.md`（38 模型 / 19 迁移 / 28 触发器）、`README.md`、`SECURITY.md`、`DEPLOYMENT.md`（19 迁移 / 28 触发器） |
| 请求文档状态 | `KILL-SWITCH-MIGRATION-REQUEST.md` 标题加「**已执行**」状态横幅（§2 DDL 原文未改动） |
| 裁决归档 | `AI-ARCHITECT-INBOX.md` 追加 `### [MSG-20260929-59]`（逐字全文，自检 `RESULT: FULL_COPY_OK`，141 行逐行一致） |

## 2. 已执行的 DDL（与批准原文逐条对应）

| 批准项（§2） | 执行情况 |
|---|---|
| 枚举 `KillSwitchTarget`（ENABLED, DISABLED） | 已执行 |
| 枚举 `KillSwitchRequestState`（PENDING_ENABLE, APPLIED, EXPIRED, CANCELLED） | 已执行 |
| 表 `KillSwitchRequest`（15 列，`id` 主键，state 默认 `PENDING_ENABLE`） | 已执行（列名/类型/默认值与批准原文一致） |
| FK `KillSwitchRequest.organizationId → Organization.id`（CASCADE） | 已执行 |
| 唯一 `(organizationId, idempotencyKey)` / `(organizationId, id)` | 已执行 |
| 索引 `(organizationId, scope, state)` / `(expiresAt)` | 已执行 |
| 部分唯一索引 `kill_switch_request_pending_unique`（`WHERE state='PENDING_ENABLE'`） | 已执行（原生 SQL，Prisma 不支持） |
| 新租户触发器（总数 → 28） | 已执行，名 `cc_tenant_kill_switch_request`（**差异见 §5**） |
| 零数据回填 / 零既有表字段改动 | 已遵守 |
| 不允许扩展（Claim / Settlement / Billing / Submission / 自动动作） | 已遵守，未触碰 |

## 3. 验收结果（MSG-20260929-59「执行阶段验收要求」逐项）

**Schema**

| 项 | 结果 |
|---|---|
| `prisma migrate deploy` 成功 | ✅ `All migrations have been successfully applied.` |
| 全新库成功 | ✅ 临时库 `crossclaim_ms59_fresh`：19 条迁移全部 applied（001→019），验证后已 DROP |
| 已有库成功 | ✅ 本地 `crossclaim`：仅应用 `20260930090000_kill_switch_request`，累计 19 条 |

**Tenant Isolation**

| 项 | 结果 |
|---|---|
| `cc_tenant_kill_switch_request` 存在 | ✅ `pg_trigger` 中定义：`... BEFORE INSERT OR UPDATE ON "KillSwitchRequest" ... EXECUTE FUNCTION crossclaim_assert_tenant_integrity()` |
| trigger count = 28 | ✅ 全新库 28 / 已有库 28 / CI 日志 `OK: 28 tenant triggers present` |

**索引**

| 项 | 结果 |
|---|---|
| `kill_switch_request_pending_unique` 存在 | ✅ 全新库 `pg_indexes` 返回该索引（表上共 6 个索引） |
| 行为验证（超出书面要求，作为证据） | ✅ 同租户同 scope 第二条 `PENDING_ENABLE` → `duplicate key value violates unique constraint "kill_switch_request_pending_unique"` |
| 幂等唯一键行为 | ✅ 同 `(organizationId, idempotencyKey)` 第二条 → `KillSwitchRequest_organizationId_idempotencyKey_key` 冲突 |

**回归**

| 项 | 结果 |
|---|---|
| `prisma validate` | ✅ `The schema at prisma\schema.prisma is valid` |
| `prisma generate` | ✅ `Generated Prisma Client (v5.22.0)` |
| `tsc --noEmit` | ✅ exit 0 |
| full test suite（本地） | ✅ Test Files **108 passed (108)** / Tests **1004 passed (1004)** |
| API contract check | ✅ `implemented=53 documented=54` / `API_CONTRACT_OK` |
| audit coverage check | ✅ `AUDIT_COVERAGE_OK` |
| CI（HEAD bec1210） | ✅ run `36594999232` 三作业 SUCCESS（API / Web / 许可证闸门）；CI 内 `19 migrations found` → `OK: 28 tenant triggers present` → `Test Files 108 passed (108)` / `Tests 1004 passed (1004)` |

## 4. 本地执行证据（命令与关键输出）

```text
# 全新库
$ docker exec crossclaim-postgres psql -U crossclaim -d postgres -c "CREATE DATABASE crossclaim_ms59_fresh;"
$ npx prisma migrate deploy        # DATABASE_URL 指向 crossclaim_ms59_fresh
19 migrations found in prisma/migrations
Applying migration `20260930090000_kill_switch_request`
All migrations have been successfully applied.

$ ... -c "select count(*) from _prisma_migrations where finished_at is not null;"   -> 19
$ ... -c "select count(*) from pg_trigger where tgname like 'cc_tenant%';"          -> 28
$ ... -c "select indexname from pg_indexes where tablename='KillSwitchRequest';"
  KillSwitchRequest_organizationId_idempotencyKey_key
  KillSwitchRequest_organizationId_id_key
  KillSwitchRequest_organizationId_scope_state_idx
  KillSwitchRequest_expiresAt_idx
  KillSwitchRequest_pkey
  kill_switch_request_pending_unique

# 已有库
$ npx prisma migrate deploy
Applying migration `20260930090000_kill_switch_request`
All migrations have been successfully applied.
-> 19 migrations / 28 tenant triggers / 6 indexes on KillSwitchRequest
```

## 5. 与批准文本的差异（1 处，必须明示）

批准原文 §2 第 5 项写的是占位函数名 `cc_assert_tenant_closure()`，并在同段要求「**触发器函数名以现有迁移中使用的租户校验函数为准（实现时读取既有迁移确认名称，不新建函数）**」。

执行结果：

- 函数名采用既有函数 **`crossclaim_assert_tenant_integrity()`**（未新建任何函数）；
- 该表唯一外键指向**租户根 `Organization`**，表内没有跨表 tenant 引用，因此调用时**不带 `TG_ARGV` 参数对**（`crossclaim_assert_tenant_integrity()` 在无参数时对 `organizationId IS NULL` 之外不做拦截）。
- 结论：第 28 个 `cc_tenant%` 触发器在 catalog 中**真实存在**（计数契约成立），但它的运行期拦截强度**弱于**其余 26 个有跨表引用的触发器。表本身的隔离由 FK → `Organization`、`(organizationId, id)`、`(organizationId, idempotencyKey)`、部分唯一索引与应用层租户过滤承担。

已按「不扩权」原则如实登记在 `ARCHITECTURE_CONTRACT.md` §5.6。**若架构方要求更强的数据库级闭合**（例如 `requestedBy` / `confirmedBy` 必须是该租户成员，比照 `cc_audit_actor_membership`），属**租户隔离语义变更**，请裁决后我再实现；本轮未自行扩权。

## 6. 回滚（A3 = APPROVED_WITH_NOTE）

```sql
DROP TRIGGER IF EXISTS cc_tenant_kill_switch_request ON "KillSwitchRequest";
DROP TABLE IF EXISTS "KillSwitchRequest";
DROP TYPE IF EXISTS "KillSwitchRequestState";
DROP TYPE IF EXISTS "KillSwitchTarget";
```

当前迁移**尚未被运行时调用**（无任何代码路径引用 `KillSwitchRequest`），因此纯 DROP 回滚不影响任何业务事实。

一旦 `POST /admin/kill-switch`（幂等请求 / 审批流程）进入生产使用，回滚必须升级为：`disable code path` → `export pending requests` → `migration rollback`，**不允许直接 DROP**。

## 7. 边界确认（本轮未越界）

- ❌ 未接线 `POST /admin/kill-switch`（Change Entry Implementation 尚未开始）
- ❌ 未新增任何自动动作、未触碰 Claim / Settlement / Billing / Submission / AuditLog 既有记录
- ❌ 未修改任何既有表、既有字段、既有数据；无回填
- ✅ Kill Switch 当前状态仍为：Read PASS / Implementation PASS / Change Entry **未上线** / 真实外部动作 **未开启**

## 8. 合并状态

| 提交 | 内容 | main 状态 |
|---|---|---|
| `6a433e9` | Migration Request 文档（不改变运行行为） | ✅ 已按 MSG-20260929-59 的 APPROVED 执行 **fast-forward merge**（`7a6c123..6a433e9`）；该提交 CI = `completed success`；未 force、未绕过保护 |
| `96e0bf9` / `bec1210` | MSG-59 裁决归档 + KillSwitchRequest 迁移实现 | ⏸ **未合并到 main**，等待架构方裁决 |
