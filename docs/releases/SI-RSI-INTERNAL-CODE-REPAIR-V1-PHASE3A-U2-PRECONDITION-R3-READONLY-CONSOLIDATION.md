# U2-PRECONDITION-R3-READONLY-CONSOLIDATION

> 授权：`PHASE3_A_U2_PRECONDITION_R3_READ_ONLY_CHANGES_91_TO_93`（**只读**：仅修订 CHANGE 91–93；接收宿主已授权采集的只读证据；完成路线 A 静态设计论证与写入域映射）。
> 基线：`0ffad444`（R2 裁决归档提交）；来源裁决：`MSG-20261009-48 = PASS WITH REVISE`（`REQUIRED_CHANGES=91_P0,92_P0,93_P1`；`F01_STATUS=OPEN_P0`）。
> 本轮**不**运行 P3、**不**创建 `FENCE_ROW`、**不**迁移 schema、**不**恢复 runtime、**不**开放生产写入、**不**恢复心跳或 OS 定时任务、**不**新增 schema/migration。

---

## 1. CHANGE 91（P0）—— `FENCE_CONTRACT` 收紧：CAS ≠ 写入侧保护

### 1.1 接受否证并明确分工

**接受审计方判断**：`UPDATE fence SET owner=:new, gen=gen+1 WHERE gen=:old` **只能**用于**接管侧的原子版本递增**；
**不能单独视为**完整 fencing 等价实现——仅凭它**无法证明写入事务在提交前一直持有有效栅栏**。

**修正后的契约（两侧职责分离）**

```text
【接管侧 TAKEOVER】允许用 CAS：
   UPDATE FENCE_ROW
      SET ownerRef = :newOwner, fenceGeneration = fenceGeneration + 1, state = 'OWNED', updatedAt = now()
    WHERE resourceKey = :key
      AND fenceGeneration = :expectedOldGen
      AND state = 'OWNED';
   受影响行数 = 1 ⇒ 接管成功；= 0 ⇒ 接管失败（陈旧或状态不符）

【写入侧 WRITER】【禁止】只做 CAS；必须持有可验证的栅栏保护（见 1.2），
   该校验必须与受保护写入处于【同一事务】，并【持续到 COMMIT 或 ROLLBACK】。
```

### 1.2 写入侧必须持有的保护（两种合法实现，二选一）

| 实现 | 机制 | 必须证明 |
| --- | --- | --- |
| **W-A 行锁（首选）** | 同一事务内 `SELECT ... FROM FENCE_ROW WHERE resourceKey=:key FOR UPDATE` → 校验 → 受保护写入 → `COMMIT` | 行锁**保持到提交**；接管侧若先持锁，写入侧**阻塞**；写入侧若先持锁，接管侧**阻塞** |
| **W-B SERIALIZABLE** | 以可序列化依赖建立约束 | 读写依赖**确实**产生所需序列化关系；**正确处理 `40001`**（重试须**重新校验** generation，依赖 `dedupeKey` 唯一键避免重复创建）；不得仅凭设置隔离级别宣称安全 |

### 1.3 校验字段集合（不得只验 `ownerRef` + `generation`）

```text
REQUIRED_FENCE_CHECK := {
  resourceKey       = 本次受保护资源身份（须与路线 A-1 的身份定义一致）,
  ownerRef          = 本执行身份（与 executionRef / 实例标识绑定）,
  fenceGeneration   = 本执行持有的 generation,
  state             = 'OWNED'（或约定的合法状态）,
  leaseValidity     = 租约有效（未过期、未被接管）——若采用 lease 语义,
  authorizationScope= 本次授权范围（操作类型/资源范围/有效期）
}
任一字段不满足 ⇒ 拒绝受保护写入（fail-closed），置 outcome='REJECTED'
```

### 1.4 端到端不变量（实施验收必须逐条证明）

| 编号 | 不变量 |
| --- | --- |
| `INV-1` | **所有**受保护写入入口**必须**遵循同一协议（不存在未走的旁路入口） |
| `INV-2` | 栅栏校验与受保护写入位于**同一事务**，保护**持续到提交或回滚** |
| `INV-3` | 接管侧的 generation 递增与写入侧的校验在**同一保护对象**上形成全序 |
| `INV-4` | **不得**因 CAS 返回一行就认定候选写入已安全提交 |
| `INV-5` | 任一校验失败（含 `0` 行受影响、`40001` 超限、generation/state/scope 不符）⇒ **不得**声称提交成功 |

### 1.5 载体选择（澄清）

审计方指出：**已有 `AutonomyLease` 并不意味着该表可直接作为满足 `FENCE_CONTRACT` 的载体**。
只有在完成**资源身份、行锁/序列化、版本单调性、事务边界与权限**的只读设计评审后，
才能决定**复用既有对象**或**未来申请新增 `FENCE_ROW`**。本轮**不创建**任何对象。

---

## 2. CHANGE 92（P0）—— S3 修订：两个场景（撤销"四阶段全部成功"的前提）

### 2.1 接受否证

**接受审计方判断**：若旧事务**已持有** `FENCE_ROW` 行锁，新持有者**无法**在旧事务结束前完成对同一行的接管
——**这正是 fencing 协议应提供的保护**。因此**不能**把「①旧事务已开始未提交 → ②旧 token 失效 → ③新持有者接管并提交 → ④旧事务再提交」
四个阶段**全部成功发生**设为所有测试路径的前提；否则**正确实现也可能无法完成测试**。

### 2.2 修订后的两个场景（取代原单一 S3）

| 编号 | 场景 | 预期结果（通过条件） |
| --- | --- | --- |
| **S3a** | **旧事务先取得栅栏行锁** | **接管必须等待**旧事务结束；**不得插入**旧事务「校验 → 提交」之间；旧事务合法提交后接管方可进行 |
| **S3b** | **新持有者先完成接管** | 旧事务**不得**以旧 `generation` 成功提交受保护写入（`0` 行受影响 / 校验失败 / 拒绝） |

### 2.3 必须区分的四种状态

| 状态 | 说明 | 期望 |
| --- | --- | --- |
| `ST-1` | 旧事务**已开始但尚未取得栅栏** | 取得栅栏时若 generation 已变 ⇒ 拒绝 |
| `ST-2` | 旧事务**已取得栅栏但尚未提交** | 接管**必须等待**其结束（S3a） |
| `ST-3` | 旧事务执行校验时 **token 已失效** | 拒绝（`STALE_FENCE`） |
| `ST-4` | 旧事务**先合法提交**、新持有者**随后**接管 | **合规**——**不属于**违反 fencing 顺序 |

### 2.4 测试目标与判定方法（写死）

```text
测试目标 = 证明【非法提交不会发生】，而不是要求所有事务按人为指定顺序成功推进。

违例（FAIL）判定示例：
  - 接管（generation 已递增并提交）之后，仍出现带【旧 generation】的受保护写入成功提交；
  = 即"旧事务在接管完成后、以过期栅栏身份提交了受保护写入"。

合规（PASS）示例：
  - 旧事务先持锁并合法提交，随后接管发生（ST-4）；
  - 旧事务因阻塞/拒绝而未提交（ST-1/ST-2/ST-3）。
```

---

## 3. CHANGE 93（P1）—— 只读取证命令与证据充分性修订

### 3.1 逐项修订

| 编号 | 修订要求（取代原采集方式） |
| --- | --- |
| **E-08** | 除 `role_table_grants` 外，**必须**补：role membership、**schema 级权限**、**对象所有者**、**继承角色**、`SECURITY DEFINER` 函数、**RLS** 相关信息（仅对象名/布尔/计数） |
| **E-09** | 除复制状态外，**必须**补：**故障切换仲裁机制**、fencing、**同步/异步复制**语义、以及**防止旧主继续写入**的机制证据（存在性） |
| **E-10** | lease 状态计数**不足以**证明事务边界 ⇒ 必须**结合真实代码路径与数据库操作语义**给出每个状态转移的 SQL 与事务边界 |
| **E-11** | `systemctl cat` **可能包含敏感环境配置** ⇒ **仅提取必要的非秘密字段**，输出前**脱敏**（不得回传任何值；只回传键名与"是否设置"） |
| **E-12** | 单会话 `session_replication_role` **不代表其他会话** ⇒ 补**角色与连接池配置**、以及**实际触发器生效状态** |
| **E-13** | 保留 inode 核验，但**仅重启前后比较不足**以证明运行过程中不会被替换 ⇒ 须给出**运行期不可替换**的论证或检测手段 |
| **E-14** | `pg_current_xact_id()` **可能分配事务 ID** ⇒ 只读取证**优先使用 `pg_current_xact_id_if_assigned()`**；**不得**把"事务 ID 存在"当作**提交证据** |
| **E-15** | `systemd-analyze security` 仅为**配置风险分析**，不是运行时权限的完整证明 ⇒ 须**同时**核验**实际进程身份、unit 覆盖与生效属性** |
| **E-16** | 增加三项：**①阻断传播时间上限**（可测的时延目标）**②阻断确认信号**（明确的"已停止写入"可观测证据）**③失效时默认停止写入**（不确定即停） |

### 3.2 新增纪律（写死）：**只读 SQL ≠ 可在生产随意执行**

```text
READ_ONLY_EVIDENCE_DISCIPLINE：
  即使查询不修改业务表，也必须：
    ① 事先取得【宿主的只读取证授权】（明确授予的查询范围与时间窗）；
    ② 限制查询权限（专用只读角色）、statement_timeout、以及并发度；
    ③ 限制输出内容（仅名称/布尔/计数/时间/对象名；禁止行级业务数据、
       禁止连接串/密码/密钥/令牌；必要时对输出做白名单字段化）；
    ④ 全程留痕（谁在何时执行了哪些查询），并可在事后复核。
  不符合上述条件的"只读查询"一律不视为合规证据。
```

### 3.3 更新后的宿主优先顺序

```text
【第一步】只读事实（不需要生产数据库密码、不开放生产写入，且须先有只读取证授权）：
   E-01 实例数量 · E-02 全部潜在写入者 · E-03 角色↔unit 映射
   · E-08 权限与对象所有权（含 schema/所有权/继承角色/SECURITY DEFINER/RLS）
   · E-10 lease 状态转移（代码路径 + 数据库语义）
   · E-11 部署版本对应关系（脱敏）
   · E-12 写入与触发器覆盖（角色/连接池/实际触发器状态）
【第二步】在【正式选择 fencing 方案之前】必须核验：E-09（切换与防旧主写入）、E-14（提交结果取证能力）
【第三步】其余证据（E-04~E-07、E-13、E-15、E-16）在后续授权前补齐
【第四步】以上完成 + 静态设计论证收口后，才能提出【单独的隔离 PostgreSQL 16 实验授权申请】
```

---

## 4. 路线 A 的细化：A-7 / A-8 与载体澄清

| 编号 | 追加条件（作为 A-5/A-6 的细化验收，**不重开 R21**） |
| --- | --- |
| **A-7** | 数据库**主节点切换**后，**已确认的 fencing generation 不得因异步复制回退而失去单调性保证** |
| **A-8** | 数据库角色、**对象所有权**与**特权入口**构成**可审计的权限闭环**，**不存在未受控的应用旁路** |

**载体澄清**：`AutonomyLease` **不等于**可直接用作 `FENCE_CONTRACT` 载体；
需先完成**资源身份 / 行锁或序列化 / 版本单调性 / 事务边界 / 权限**五项只读设计评审，再决定复用或新增。

---

## 5. 状态汇总（本轮结束时）

```text
AUTHORIZATION_SCOPE = PHASE3_A_U2_PRECONDITION_R3_READ_ONLY_CHANGES_91_TO_93
CHANGE_91 = 已修订（CAS 仅接管侧；写入侧同事务可验证保护并覆盖至提交/回滚；校验含 state/租约/授权范围；INV-1~INV-5）
CHANGE_92 = 已修订（S3 拆为 S3a/S3b + 四状态 + "旧写入先提交后接管"合规 + 违例判定口径）
CHANGE_93 = 已修订（E-08~E-16 逐项 + 只读取证纪律 + 宿主三步顺序）
F01_STATUS = OPEN_P0（未关闭；完成 91–93 不代表关闭）
PREFERRED_LOCK_ROUTE = LEASE_REVIEW_FIRST · A-7/A-8 已追加
LOCK_PROTOCOL_UNIFORMITY = NOT_PROVEN
DEDUPE_PROOF = DESIGN_EVIDENCE_ONLY · EXCLUSION_PROOF_STATUS = NOT_PROVEN
COMMIT_ATTRIBUTION_PROOF = NOT_AVAILABLE_IN_CURRENT_CONFIGURATION
MULTI_INSTANCE_AUTOMATED_WRITE = NOT_AUTHORIZED
P3_EXPERIMENT_AUTHORIZED = NO · U2_IMPLEMENTATION_AUTHORIZED = NO · PRODUCTION_WRITE_AUTHORIZED = NO
U1_CODE_CLOSURE = UNCHANGED（9ee36837）· U2_DESIGN_R21 = 未重开
SCHEMA_MIGRATION = HOLD / RUNTIME_WIRING / MODEL_CALL / PROVIDER_CALL = FORBIDDEN
EXTERNAL_WRITE = HOLD / AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN / PRODUCTION_READY = NO
POSTGRESQL_INTEGRATION_TEST / VITEST / TSC / LINUX_SYSTEMD / CI / PRODUCTION = NOT_VERIFIED
HEARTBEAT_RESTORED = NO / OS_TIMER_RESTORED = NO
```

**本轮边界**：仅文档修订；未实施产品代码、未连接任何数据库、未执行任何只读或写入查询、未运行任何实验、未修改 U1 封板、未恢复心跳或定时任务、未新增 schema/migration。
