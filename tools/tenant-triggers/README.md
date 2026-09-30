# tenant-triggers —— 必需租户保护触发器清单与 CI 校验

B2-FIX R1 / MSG-20260930-06 CHANGE D 要求：既有租户保护必须按**名称 + 所属表（+ 事件类型/启用状态）清单**核对，
不能只用「总数 ≥ 28」这类下限断言（下限无法证明每一条必要保护都存在）。

## 内容

- `required-triggers.json`：清单真源。
  - `baselineTriggers`：28 条 `cc_tenant_*` 租户完整性触发器（tgtype=23 = ROW|BEFORE|INSERT|UPDATE）。
  - `immutablePrefix` / `immutableTgtype`：`cc_tenant_immutable__<表>` 归属不可变触发器（BEFORE UPDATE）。
  - `scopedTriggers`：规则归属类触发器，必须限定 schema 与表。
- `emit-check-sql.mjs`：把清单编译成一段 `DO $$ ... $$` 校验 SQL，打印到 stdout。

## 用法

```bash
node tools/tenant-triggers/emit-check-sql.mjs \
  | PGPASSWORD=... psql -h localhost -U crossclaim -d crossclaim -v ON_ERROR_STOP=1
```

CI 中由 `.github/workflows/ci.yml` 的 “Verify tenant-integrity triggers (checklist)” 步骤执行。

本地（Docker Postgres）等价验证：

```powershell
node tools/tenant-triggers/emit-check-sql.mjs | docker exec -i crossclaim-postgres psql -U crossclaim -d crossclaim -v ON_ERROR_STOP=1
```

## 校验规则

1. 清单中每个触发器都必须存在、挂在指定表上、事件类型匹配且 `tgenabled = 'O'`。
2. 运行库不得出现清单之外的启用 `cc_tenant_*`（`cc_tenant_immutable__*` 除外）：
   新增 tenant-owned 表若只补迁移不更新清单，CI 会失败（MSG-20260930-06 CHANGE G 的动态挂载盲区）。
3. 每张含 `organizationId` 的表都必须有 `cc_tenant_immutable__<表>`（BEFORE UPDATE）。
4. `scopedTriggers` 必须限定 `current_schema()` 与指定表。

任一条不满足 → `RAISE EXCEPTION` → psql 非零退出 → CI 红灯。
