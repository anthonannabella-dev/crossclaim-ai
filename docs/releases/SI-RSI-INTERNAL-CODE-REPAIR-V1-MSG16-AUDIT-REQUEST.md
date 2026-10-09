# SI/RSI INTERNAL CODE REPAIR V1 —— MSG-20261009-16 送审请求（两部分分别呈现）

评审号（请在回复开头注明）：**MSG-20261009-16**
REVIEWED_HEAD = **28ea8fdc**（分支 `feat/si-rsi-internal-code-repair-v1`，已 push 到 origin）
关联锚点：U1 授权依据 `46e9cd9d`；U1 首次实施 `101cd842`；CHANGE 13–16 设计 `1ed3f0b3`；MSG-15 裁决归档 `0a10c884`；本轮修复 `28ea8fdc`
上一轮裁决：MSG-20261009-15 = PASS WITH REVISE（**U1 未关闭**：`U1_EVIDENCE_SUFFICIENCY = REVISE`；登记 CHANGE 17–20 与 CHANGE 21–23）
本轮执行依据（MSG-15 授权）：`NEXT_AUTHORIZED = PHASE3_A_U1_FINAL_R2_REPAIR_AND_EVIDENCE + DESIGN_ONLY_CHANGES_21_TO_23`
durable 记录：设计文档 **§17**（CHANGE 17–23 收口规格）+ checkpoint **§2.13**（U1 FINAL-R2 实施与验证记录）

本轮请**分两部分**分别裁决 ——

* **第一部分 A**：CHANGE 17–20 的 U1 修复与证据（是否达到 `PHASE3_U1_IMPLEMENTATION_CLOSED = YES`）
* **第二部分 B**：CHANGE 21–23 的设计收口（**仅设计**，是否可接受）

请在**本会话直接回复**；不要写入我的仓库或任何外部系统（网页侧写入会静默失败）。

=== 第一部分 A：U1 FINAL-R2 修复（CHANGE 17–20）===

## A1. 文件白名单（本轮仅改 3 个代码 / 测试文件 + 2 个文档；未改 schema / migration / 其它文件）

* `apps/api/src/services/self-repair/trusted-facts-adapter.ts`（只读适配器 + 只读 Prisma 端口 + 边界声明）
* `apps/api/src/__tests__/phase3a-u1-trusted-facts-adapter.test.ts`（端口级 38 用例）
* `apps/api/src/__tests__/phase3a-u1-trusted-facts-adapter-db.test.ts`（真实 PostgreSQL 6 用例）
* `docs/releases/SI-RSI-INTERNAL-CODE-REPAIR-V1-PHASE3-DESIGN.md`（追加 §17）
* `docs/releases/SI-RSI-INTERNAL-CODE-REPAIR-V1.md`（追加 checkpoint §2.13）

`git diff --stat`（本轮提交）：5 files changed, 848 insertions(+), 212 deletions(-)。
**未**新增 Scheduler / Controller / Runtime；**未**改 Prisma schema / migration / 任务队列 / `rsi-durable-task-source` / 任何写路径。

## A2. CHANGE 17（P0）授权唯一性 —— 逐条对照

1. 读取端由 `findStandingAuthorization`（`findFirst` + `orderBy: authorizationVersion desc`）改为
   **`listStandingAuthorizations`（`findMany`，返回该组织全部授权行）**；适配器不再预取"最高版本"。
2. 匹配维度：`revocationState = ACTIVE` ∧ `effectiveAt <= at < expiresAt` ∧ `allowedActionTypes ∋ actionType`
   ∧ 资源范围（`provider` / `platformAccountId` / `domain` / `jurisdiction`）。
   资源范围**未提供的维度不构成约束**；提供了但为空串 ⇒ 不匹配（不降级）。
3. 0 条按原因细分：无任何行 ⇒ `AUTHORIZATION_NOT_FOUND`；有行但动作不在范围 ⇒ `ACTION_TYPE_NOT_ALLOWED`；
   范围不匹配 ⇒ `AUTHORIZATION_NOT_FOUND`；范围内无有效行 ⇒ 存在非 ACTIVE 行则 `AUTHORIZATION_REVOKED`，否则 `AUTHORIZATION_NOT_EFFECTIVE`。
4. **同一请求下 ≥2 条有效记录 ⇒ `AUTHORIZATION_AMBIGUOUS`（fail-closed）**，不再"取最高版本"。
5. provenance 记录**唯一命中**授权行的 `authorizationId` + `authorizationVersion` + `scopeDigest` + `currency`（可追溯到具体行）。

## A3. CHANGE 18（P0）金额与币种显式规则

请求**必须显式**声明 `monetaryAction: boolean`（缺失 / 非布尔 ⇒ `MONETARY_INPUT_INVALID`，**不设默认值**）。

| 情形 | 结果 |
| --- | --- |
| `monetaryAction = true` 且缺 `amountUsd` 或 `currency` | `MONETARY_INPUT_INVALID` |
| 金额非「≤4 位小数非负十进制」（科学计数法 / 负号 / 空串 / 5 位小数） | `MONETARY_INPUT_INVALID` |
| 请求 `currency` 非 USD | `MONETARY_INPUT_INVALID` |
| **授权行 `currency` 非 USD** | `MONETARY_INPUT_INVALID` |
| `monetaryAction = false` 却携带 `amountUsd` / `currency` | `MONETARY_INPUT_INVALID` |
| 金额 ≤ 上限 | 通过 |
| 金额 > 上限，或授权上限不可解析 | `MONETARY_LIMIT_EXCEEDED` |

十进制比较按**字符串**（整数位长度 + 字典序 + 补零小数位）实现，**不使用浮点**：`0999.9999 < 1000.0000` 判为不超限。
导出纯函数 `exceedsMonetaryLimit(amountUsd, limitUsd)` 供独立断言。

## A4. CHANGE 19（P0）来源边界与版本失效

1. 调用方白名单：`caller ∈ { SERVER_REQUEST_GATE, RUNTIME_MEMBER }`，由**可信执行上下文注入**
   （不是请求字段、不是模型字段）；其余值（`BUILDER` / `MODEL` / `CLIENT` / 空串）⇒ `CALLER_NOT_TRUSTED`。
2. 版本失效：调用方可传 `expectedFactVersion`，与本次读取得到的
   `factVersion = org:<identityVersion>|auth:<authorizationVersion>` 比对；不一致 ⇒ `STALE_FACT_VERSION`
   （**不得以旧事实取得新的提交权限**）。`identityVersion` 当前取 `Organization.updatedAt` 的 ISO 串 ——
   审计已指出它**只是行修订信号**，不是完整单调版本；完整版本单调性属 U2 及之后的授权范围，本轮**未**声明已解决。
3. `operationRecheck` 仍由上下文注入；`NOT_CONFIRMED` ⇒ `OPERATION_RECHECK_NOT_CONFIRMED`。

## A5. CHANGE 20（P1）证据补强 —— 强只读与负向证据

1. **全部读取置于只读事务**：`SET TRANSACTION READ ONLY` 作为事务内**第一条**语句
   （Prisma `$transaction` + `$executeRawUnsafe(READ_ONLY_TRANSACTION_SQL)`，语句以常量导出）。
   已确认：全部读取（`Organization.findUnique`、`StandingAuthorization.findMany`）与失败路径都在同一事务包裹内执行，且**不嵌套**第二事务。
2. **写入被数据库直接拒绝**（可执行证据）：在同一只读事务内执行
   `DELETE FROM "StandingAuthorization" WHERE "id" = 'u1-probe-nonexistent'` 与
   `CREATE TABLE IF NOT EXISTS "u1_readonly_probe" (...)` 均被 PostgreSQL 拒绝（错误含 `read-only transaction`）。
   因此证据是「**数据库拒绝写入**」，而非「源码静态检查没看到写方法」。两条探针均为**非破坏性**（零匹配行 / 不存在的表）。
3. **全相关表前后比较**：解析前后比较 `Organization` / `StandingAuthorization` / `AuditLog` / `RecoveryOpportunity` /
   `AutonomyTask` / `AutonomyLease` / `AutonomyIncident` 的计数，并核对 `Organization.updatedAt` 未变化。
   （不再以「三张 Autonomy 表不变」代替全部相关性检查。）
4. **静态来源断言（仍保留，作为补充而非替代）**：源码不含 `payload` / `modelOutput` 字样、不含
   `.create(` / `.update(` / `.delete(` / `.upsert(` / `.updateMany(` / `.deleteMany(`；
   唯一原生调用必须是 `$executeRawUnsafe(READ_ONLY_TRANSACTION_SQL)`（用正则枚举断言，等价于断言"唯一原生 SQL 是只读语句"）。

## A6. 验证证据（本机可实测）

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 端口级单元测试 | `vitest run src/__tests__/phase3a-u1-trusted-facts-adapter.test.ts` | **38 / 38 PASS** |
| 真实 PostgreSQL 只读端口 | `vitest run src/__tests__/phase3a-u1-trusted-facts-adapter-db.test.ts`（隔离库 `crossclaim_p3r2_iso`） | **6 / 6 PASS** |
| 类型检查 | `apps/api tsc --noEmit` | **0 error** |

负向用例覆盖（全部 fail-closed，逐一有断言）：
缺租户上下文 / 伪造调用方（MODEL、BUILDER、CLIENT、空）/ 组织不存在 / 无授权行 / 资源范围无匹配 / 资源范围空串 /
授权已撤销 / 未生效（未来生效）/ 已过期 / **多授权冲突** / 动作类型不在授权范围 / 缺 `monetaryAction` / 非布尔 / 缺金额 / 缺币种 /
金额形态非法（科学计数法、负号、>4 位小数、空串）/ 请求币种非 USD / 授权行币种非 USD / 非金额动作携带金额 / 携带币种 /
超限 / 上限不可解析 / 期望事实版本不一致 / 期望事实版本空串 / 运行时复核未确认。

## A7. U1 明确**未**做（边界申报）

* 不写任何业务数据（不建任务 / 不建候选 / 不领取租约 / 不调用 ONE SI Runtime / 不做外部调用）；
* 不新增 Scheduler / Controller / Runtime；不改 Prisma schema / migration；不改任务队列 / `rsi-run` / 任何执行体；
* 未实现 U2–U5（未授权）；`runtimeSourceIsolationImplemented = false` 仍为硬声明（未推翻）。

**如实标注（NOT VERIFIED）**：Linux / systemd 实机、真实浏览器验收、真实 Provider / 模型调用（HOLD）、CI、生产环境 —— 均未在本机验证。
本机可实测的只有上表三项（本机 Windows + 隔离 PostgreSQL `crossclaim_p3r2_iso`）。

=== 第二部分 B：CHANGE 21–23 设计收口（仅设计，未实施）===

（全文见设计文档 §17.5–§17.7；以下为要点摘录，便于逐项裁决）

## B1. CHANGE 21（P0，设计）撤销 ↔ 文件发布的**共同排序权威**

* 必须由**同一个**协调器同时掌控：撤销检查、fencing 与发布顺序（等价于"以数据库提交 / 撤销写入作为发布闸门"）。
* 若**无法证明**该排序 ⇒ **禁止发布**（拒绝或降级为 `staging-only`），不得把 DB CAS 的保证外推到文件系统或外部系统。
* 摘要路径已存在时必须**无覆盖发布**（新建 / 冲突则取用原作者选择，绝不覆盖既有内容）。
* 发布完成后必须**校验内容与摘要一致**（"目录存在"不等于"内容不可篡改"）。
* 在以上任一项关闭前，`ISOLATED_WRITE` **不得授权实施**。

## B2. CHANGE 22（P1，设计）fencing 与身份规范化

* `fencingGeneration` 必须**持久化原子递增**（跨进程、跨重启不重复）；不得仅依赖进程内计数器。
* `candidateDigest` / 租户 / 事实版本 / 目标内容须**规范化身份编码**（确保语义不同者不折叠为同一业务身份）。
* `identityVersion` 的**读取与提交检查之间**必须有明确的事务 / fencing 边界。
* TestRunner 必须位于 **Builder 不可修改**的可信执行边界；镜像 / 依赖 / 入口 / 环境变量 / 策略版本纳入环境摘要的效力范围。
* **禁止**把工作区内的 hook / 构建脚本 / 测试脚本直接当作可信执行入口；环境摘要须由执行器在**可信侧**生成，Builder 不可改写。

## B3. CHANGE 23（P1，设计）A11 / A12 故障矩阵

| 目标 | 需覆盖的故障注入 | 判定 |
| --- | --- | --- |
| A11 终态完整性 | 进程崩溃（提交前 / 提交后）、重复 `settle`、fencing owner 变更、回放 | 已确认的提交事实在恢复后保持**不可篡改**；非 owner 不得改写终态；不得重复对外动作 |
| A12 工作区发布边界 | 并发发布、发布前中断、重试、文件系统持久化失败 | 必须有**可验证的线性化顺序**；无法证明时**无候选进入公共可见位置** |

## B4. 声明

第二部分**全部为设计文本**（设计文档 §17）；**未实施**、**未授权实施**。
`PHASE3_A_U2_TO_U5_AUTHORIZED = NO`；`AUTONOMOUS_CODE_REPAIR / BUILDER_EXECUTION / JUDGE_EXECUTION / PATCH_APPLY = NO`。
`EXTERNAL_WRITE = HOLD`；`AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN`；`PRODUCTION_READY = NO`。

=== 本 轮 裁 决 请 求 ===

请分别裁决（并要求同格式两部分）：

第一部分（U1 修复）：

1. `U1_CHANGE17_AUTHORIZATION_UNIQUENESS`（唯一性 + 多授权冲突 fail-closed + provenance 追溯）
2. `U1_CHANGE18_MONETARY_EXPLICITNESS`（显式金额 / 币种 / 上限）
3. `U1_CHANGE19_CALLER_AND_VERSION_BOUNDARY`（调用方白名单 + 期望事实版本）
4. `U1_CHANGE20_READ_ONLY_EVIDENCE`（只读事务 + 写入被拒 + 全相关表比较）
5. `U1_EVIDENCE_SUFFICIENCY`（38 + 6 + tsc 0 + 负向矩阵是否已足以关闭 U1）
6. `U1_SCOPE_COMPLIANCE`（是否严格未越界）

第二部分（设计）：

7. `CHANGE21_COMMON_ORDERING_AUTHORITY`
8. `CHANGE22_FENCING_AND_IDENTITY_NORMALIZATION`
9. `CHANGE23_A11_A12_FAULT_MATRIX`

总体：

10. `SCOPE_HONESTY`

请以如下机器可读块收尾：

```text
MSG-20261009-16 / FINAL
AUDIT_ID=MSG-20261009-16
REVIEWED_HEAD=28ea8fdc
FINAL_VERDICT=PASS | PASS_WITH_REVISE | REVISE | BLOCK
U1_CHANGE17_AUTHORIZATION_UNIQUENESS=...
U1_CHANGE18_MONETARY_EXPLICITNESS=...
U1_CHANGE19_CALLER_AND_VERSION_BOUNDARY=...
U1_CHANGE20_READ_ONLY_EVIDENCE=...
U1_EVIDENCE_SUFFICIENCY=...
U1_SCOPE_COMPLIANCE=...
CHANGE21_COMMON_ORDERING_AUTHORITY=...
CHANGE22_FENCING_AND_IDENTITY_NORMALIZATION=...
CHANGE23_A11_A12_FAULT_MATRIX=...
SCOPE_HONESTY=...
PHASE3_U1_IMPLEMENTATION_CLOSED=YES | NO
PHASE3_A_U2_TO_U5_AUTHORIZED=YES | NO
REQUIRED_CHANGES=<下一轮必须执行的修订编号，如无则 NONE>
NEXT_AUTHORIZED=<贵方确认授权的下一最小单元 / 范围>
NEXT_AUDIT=MSG-20261009-17
EXTERNAL_WRITE=HOLD
AUTO_MERGE=FORBIDDEN
AUTO_DEPLOY=FORBIDDEN
PRODUCTION_READY=NO
```

请在本会话直接回复；不要尝试写入我的仓库或外部系统。不要因为收到唤醒消息就默认通过 —— 请按上面的项目逐项给出证据性判断。
