# CLAIM TRACKING — SCHEMA DELTA REQUEST

> 类型：**Schema Delta Request（仅请求批准；不含 migration、不含实现）**
> 依据：架构方 **MSG-20260929-21**（CLAIM-TRACKING-DESIGN = GO_DESIGN_APPROVED，`NEXT = Submit CLAIM-TRACKING-SCHEMA-DELTA-REQUEST`）
> 分支 `gate/7-commercial-validation` · Codex · 2026-09-29

---

## 1. 请求内容（全部为**扩展**，不改现有字段语义）

| # | 变更 | 类型 / 默认 | 可空 | 目的 |
|---|---|---|---|---|
| S1 | `Claim.platformCaseRef` | `String?` | 是 | 平台侧案件号（与 `externalRef`＝我方提交引用**语义分离**） |
| S2 | `Claim.deadlineSource` | `String?` | 是 | `dueAt` 的来源（参照数据版本 / 人工录入）；**无来源不得有 `dueAt`** |
| S3a | `Claim.approvedByUserId` | `String?` | 是 | 人工批准证据（仅 OWNER/ADMIN 可写） |
| S3b | `Claim.approvedAt` | `DateTime?` | 是 | 批准时间 |
| S4 | `Claim.terminalReasonCode` | `String?` | 是 | 终局原因**枚举化**（禁自由文本入库） |
| S5 | `Claim @@index([organizationId, status, dueAt])` | 索引 | — | 到期看板查询 |

**不包含**：新表、枚举类型新增、现有字段改类型、现有数据回填、触发器变更。

---

## 2. 为什么不用自由文本 / 不用新表

- S4 用**代码值**而非自由文本：终局原因会被看板与通知消费，自由文本无法聚合，且历史审计里已出现把原始值写进备注的教训（读写两侧都不放自由文本）。
- 不新增「ClaimEvent」表：时间轴由既有 `AuditLog`（同一事务权威）+ `Claim` 字段 + 交付物状态合成只读投影（设计 §4），避免第二份真相来源。

---

## 3. 不变量（服务层 + 必要时的数据库约束）

| # | 不变量 | 落点 |
|---|---|---|
| I1 | `dueAt != null` ⇒ `deadlineSource != null` | 服务层写入前校验；后期可评估加 CHECK |
| I2 | `status ∈ {APPROVED, PARTIALLY_APPROVED}` ⇒ 存在批准留痕（S3a/S3b） | 服务层 |
| I3 | `status = PARTIALLY_APPROVED` ⇒ `responseAmount != null` | 服务层（设计已定） |
| I4 | 终局态不可回退（CAS：`updateMany where status = expectedFrom`） | 服务层（已定风格） |
| I5 | `terminalReasonCode != null` ⇒ `status` 为终局态之一 | 服务层 |

> 说明：I1/I5 目前以服务层保证，**不请求新增触发器**（27 个租户触发器口径不变）。

---

## 4. 迁移计划（**获批后才执行**）

1. 生成迁移：仅 5 处 `ALTER TABLE "Claim" ADD COLUMN ...` + 1 个 `CREATE INDEX`。
2. 全部新列**可空且无默认回填** → 对既有行零影响（不重写数据）。
3. 不新增/修改任何触发器；迁移执行后仍应为 **27 个 `cc_tenant%` 触发器**（CI 已校验该数量）。
4. 顺序：`prisma validate` → `migrate deploy`（CI 全新库）→ `generate` → 触发器数量校验 → `tsc` → 全量测试。

回滚：
- 代码先回滚（新列不被读取）→ 再执行 `DROP COLUMN`（5 列）/`DROP INDEX`（1 个）；
- 由于全部可空且无回填，回滚不丢业务数据。

---

## 5. 兼容性与影响面

| 面 | 影响 |
|---|---|
| 既有读写路径 | 零影响（新列默认 NULL，未改任何现有查询） |
| API 契约 | 本 Delta **不改**任何端点；后续实现阶段才新增只读投影 |
| 权限 | 不改矩阵；S3a/S3b 仅 OWNER/ADMIN 可写（实现阶段校验） |
| 审计 | 迁移本身不写业务审计；实现阶段每次写入写 `AuditLog` |
| 资金链路 | **零改动**（不触碰 Settlement/RecoveryLedger/Fee/Billing） |
| 规则引擎 | **零改动** |

---

## 6. 验收（实现阶段将提交的证据）

1. `prisma validate` 通过；CI 全新库 `migrate deploy` 通过；触发器数仍为 27。
2. 迁移后既有测试全绿（回归）。
3. 新列写入/读取单测（含 NULL 语义与 I1–I5 校验）。
4. 真实库集成：CAS 并发（两个并发迁移只有一个成功，另一个返回稳定错误码）。
5. 只读投影测试：时间轴不重复、不丢事件；到期查询命中索引（EXPLAIN 记录）。

---

## 7. 请裁决

NEED: **GO / REVISE / HOLD**（CLAIM-TRACKING-SCHEMA-DELTA-REQUEST）

- 若 GO：我执行迁移（仅 S1–S5），随后实现判定与只读投影并提交 Implementation Checkpoint（含上述 5 项证据）。
- 若 REVISE：请指明需要增删的字段或不变量落点。
- 若 HOLD：我保持现状，不做任何 Schema 变更。
