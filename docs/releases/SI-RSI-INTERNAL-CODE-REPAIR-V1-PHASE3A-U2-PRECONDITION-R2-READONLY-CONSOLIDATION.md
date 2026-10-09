# U2-PRECONDITION-R2-READONLY-CONSOLIDATION

> 授权：`PHASE3_A_U2_PRECONDITION_R2_READ_ONLY`（**只读**：完成 CHANGE 86–90 的文档修订、锁协议方案比较、宿主能力申请与缺失证据登记）。
> 基线：`f611847e`（R2 开始时的记录锚点）；被审前置包提交 `f3952664`；U1 封板 `9ee36837`（未改动）。
> 来源裁决：`MSG-20261009-47 = PASS WITH REVISE`（`READINESS_PACK_ACCEPTED_WITH_REQUIRED_CHANGES`；`F01_STATUS=OPEN_P0`、`PREFERRED_LOCK_ROUTE=LEASE_REVIEW_FIRST`）。
> 本轮**不**实施产品代码、**不**连接数据库、**不**运行实验、**不**恢复心跳或 OS 定时任务、**不**新增 schema/migration。

---

## 材料 1 — F-01 锁协议决策建议 + 写入域清单（CHANGE 86）

### 1.1 三者不等价（先明确边界）

| 语义 | 作用 | 当前由谁承担（仓库证据） | 是否等于"候选写入互斥" |
| --- | --- | --- | --- |
| **①任务领取互斥** | 防止两个执行器认领同一任务 | **durable lease**（`AutonomyLease`：`taskId UNIQUE`、`ownerRef`、`acquiredAt/renewedAt/expiresAt`、`status`）+ `dedupeKey`（`deploy/systemd/crossclaim-rsi.service` 注释、`apps/api/src/services/autonomy/rsi-continuation-engine.ts`） | **否** |
| **②候选写入互斥** | 防止对同一受保护资源产生不允许的写入 | **未定义**（U2 设计拟用 `flock`；产品代码中**不存在**任何 file lock） | — |
| **③提交时 fencing** | 防止失去所有权的旧执行器在**接管之后**仍然成功提交 | **不存在** | — |

> 结论：**已有 lease ≠ 候选写入已受 lease 完整保护**；`flock` **也不会**自动与 PostgreSQL lease 形成共同互斥域。

### 1.2 路线建议（方案选择，不是实施变更）

| 路线 | 建议 | 说明 |
| --- | --- | --- |
| **A 统一到 durable lease（推荐评审）** | **建议优先** | 复用既有数据库持久化语义与既有 `AutonomyLease` 事实；只需在**一个**存储层内证明不变量，避免同时维护两套互斥协议 |
| B 统一到 `flock` | 暂不推荐 | 需迁移既有执行器、引入文件系统依赖（挂载/网络 FS 语义）并整体回归 |
| C 证明写入域不相交 | 保留备选 | 须严格证明资源、主体与因果依赖不重叠；**仅证明"用不同表"或"`dedupeKey` 唯一"不足以认定互不相交** |

**重要声明（避免越权）**：以上仅为**方案建议**。U2 设计（R21）已 PASS/CLOSED，其选定协议是 `flock`；
若最终选择路线 A，则**需要一次单独授权的设计修订**把排斥机制改写为 lease 语义，并重新走审——**本轮不做**。

### 1.3 路线 A 的成立条件（须逐条举证，缺一不可）

| 编号 | 需证明 | 当前状态 |
| --- | --- | --- |
| A-1 | U2 与既有 RSI 使用**同一受保护资源身份定义** | 未证明 |
| A-2 | lease 的**领取/续租/到期/接管/版本变更**具有确定的**数据库事务语义** | 未证明（需 E-10） |
| A-3 | 受保护写入携带**可验证执行身份 + fencing generation** | 未实现（需 CHANGE 87 的 `FENCE_CONTRACT`） |
| A-4 | 旧持有者失效后**不能在新持有者接管之后**提交陈旧写入 | 未证明（需 S3/S8） |
| A-5 | **所有**写入入口遵守统一协议，应用**无权旁路** | 未证明（需 E-08/E-12/E-15） |
| A-6 | 中断/超时/重连/进程崩溃下不变量仍成立 | 未证明（需 S4/S9/S11） |

### 1.4 `LOCK_DOMAIN_AND_WRITER_INVENTORY`（只读清单；模板 + 已知/缺失）

| 证明对象 | 最小证据 | 当前已知（仓库） | 缺失（宿主） |
| --- | --- | --- | --- |
| **任务领取者** | 入口、进程、角色、lease 关联 | `rsi-run`（systemd `crossclaim-rsi`，专用用户）；`claimNextSafeTask()` + lease | 实际运行实例数（E-01）、实际角色（E-03） |
| **U2 候选写入者** | 所有 `INSERT` 入口、数据库角色 | 设计已定：仅 `AutonomyCandidate` INSERT；**代码尚不存在** | 未来实施角色与权限（E-08） |
| **现有 RSI 写入者** | 任务/候选/Incident 等实际写入路径 | 运行时代码路径（`apps/api/src/services/autonomy/*`） | 实际启用的 unit 与作业全集（E-11/E-12） |
| **保护资源** | `taskId`、`dedupeKey`、`candidateId` 关系 | schema 关系存在（migration `:146`、FK `:179-191`） | 运行库对象与约束实际状态（E-11/E-12） |
| **锁的作用域** | 全局 / 租户 / 任务 / 候选 | lease 作用域 = `taskId`（`AutonomyLease.taskId @unique`）；U2 拟用**整文件**锁（作用域=全局）。**两者作用域不同** | 实际部署拓扑与文件系统（E-04/E-09） |
| **失效行为** | 旧持有者何时/如何失去写入权 | lease：`expiresAt` 到期可被接管（**时间驱动**）；`flock`：进程终止即释放（**进程驱动**） | 实际 lease 状态转移实现（E-10） |
| **统一协议** | 选定路线 + 未选路线的**停用或隔离证明** | 未选定；`flock` 在代码中不存在（无需停用） | 若选 A：现有 lease 是否已覆盖候选写入域（需 A-1~A-6 举证） |

---

## 材料 2 — P1 fencing 与提交归因机制修订（CHANGE 87、88）

### 2.1 CHANGE 87：`FENCE_CONTRACT`（替代"单语句条件检查"）

**审计方否证**：普通 MVCC 可见性下，一条语句"看到"有效 owner，**并不排除**另一事务随后把该 owner 失效并提交 ⇒ `INSERT ... SELECT ... WHERE EXISTS(fence owner=me)` **不充分**。

**修订后的契约（F-A′）**：

```text
FENCE_ROW(resourceKey PK, ownerRef, fenceGeneration BIGINT, state, updatedAt)

写入事务 W 必须：
  W1  对 FENCE_ROW(resourceKey) 取【行锁】（SELECT ... FOR UPDATE）
  W2  校验 ownerRef = 本执行 AND fenceGeneration = 本执行持有的 generation（否则拒绝）
  W3  执行受保护写入（候选 INSERT）
  W4  COMMIT（行锁在 COMMIT 时刻释放）

接管事务 T 必须：
  T1  对同一 FENCE_ROW(resourceKey) 取【同一行锁】
  T2  ownerRef := 新持有者；fenceGeneration := fenceGeneration + 1；COMMIT

⇒ W 与 T 在同一行上形成【全序】：T 无法插入到 W2 与 W4 之间；
   W 若在 T 之后提交，其 W1 必然阻塞到 T 提交后，且 W2 会发现 generation 已变 ⇒ 拒绝。
```

**关键点（必须写入实施验收）**：

1. **覆盖提交时刻**：证明对象不是"`INSERT` 执行时刻"，而是**从校验到 `COMMIT` 的整个窗口**；行锁/状态迁移必须**保持到 `COMMIT`**。
2. **串行化关系**：栅栏校验与栅栏失效-接管必须落在**同一行的同一锁**上（或等价的受控状态迁移）。
3. **替代实现（等价可接受）**：①`UPDATE fence SET owner=:new, gen=gen+1 WHERE gen=:old` 由数据库返回受影响行数（0 ⇒ 陈旧方失败）；
   ②受约束的写入接口（`SECURITY DEFINER` 函数内完成"校验 + 插入"两件事，事务由函数调用者控制）。
4. **`SERIALIZABLE` 路径**：若采用，必须证明对 `FENCE_ROW` 的读写依赖**确实产生**所需序列化约束，
   且**正确处理 `40001`**（重试必须**重新校验** generation，并依赖 `dedupeKey` 唯一键避免重复创建）；
   **不得**仅凭"设置了 `SERIALIZABLE`"宣称安全。
5. **失败语义**：任何一步失败（`0` 行受影响、`40001` 超限、generation 不匹配）⇒ **不得**声称提交成功；按 §29.4 的状态机处置。

**所需能力**：新增 `FENCE_ROW` 载体（表/行）⇒ **需 DDL 授权**（当前 `SCHEMA_MIGRATION=HOLD`）。若宿主指定**可复用的既有对象**，须给出该对象的唯一键与写权限证据。

### 2.2 CHANGE 88：三个**互不推导**的证明字段

| 字段 | 证明范围 | 可接受的证据 | **不能**据此推导 |
| --- | --- | --- | --- |
| **`DEDUPE_PROOF`** | 在给定唯一键范围内，系统**不能同时保留两条同键记录** | 唯一索引存在 + DB 实测（S1） | 排他权归属；旧持有者失效后不可写；本次执行是否提交 |
| **`EXCLUSION_PROOF`** | 在受保护窗口内，**只有栅栏持有者**的受保护写入能提交 | `FENCE_CONTRACT` 实现 + 故障注入 S3/S7/S8/S10 结果 | 去重（唯一键本身即可满足）；提交归因 |
| **`COMMIT_ATTRIBUTION_PROOF`** | 目标行**由本次执行**提交 | **同事务**审计记录/回执（F-C）；`xmin` **仅辅助** | 排他；去重 |

**硬规则**：三者**任一项 PASS 不得推导其它两项**（对应审计方 CHANGE 88 原文要求）。
**现状**：`DEDUPE_PROOF = DESIGN_EVIDENCE_ONLY`（唯一索引存在，但未在目标库实测）；`EXCLUSION_PROOF = NOT_PROVEN`；`COMMIT_ATTRIBUTION_PROOF = NOT_AVAILABLE_IN_CURRENT_CONFIGURATION`。

**澄清**：`F-C`（同事务审计记录）是**提交归因**机制，**不是** fencing 的替代品。

---

## 材料 3 — E-08 ~ E-16 缺失证据登记 + 宿主采集清单（只读）

> 采集纪律：**只回传名称、布尔值、计数、时间与对象名**；**禁止**回传连接串、密码、密钥、令牌或任何业务数据行内容。
> 所有命令均为**只读**；不得在生产执行任何写入、DDL 或 `ALTER`。

| 编号 | 优先级 | 需要的内容 | 建议只读采集方式（示例） | 充分性判据 |
| --- | --- | --- | --- | --- |
| **E-08** | P0 | 数据库实际权限与**对象所有权**：表/schema/sequence/函数、默认权限、role membership、`BYPASSRLS`、`SUPERUSER`、触发器修改权限 | `SELECT rolname, rolsuper, rolbypassrls, rolcreaterole FROM pg_roles;`<br>`SELECT relname, pg_get_userbyid(relowner) FROM pg_class WHERE relname LIKE 'Autonomy%';`<br>`SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_name='AutonomyCandidate';`<br>`SELECT * FROM pg_default_acl;` | 能回答"谁能 INSERT/UPDATE/DELETE/DDL/停用触发器"，并区分应用角色与特权角色 |
| **E-09** | P0 | 真实数据库拓扑：主库、只读副本、代理、连接池、故障切换、复制与写入路由 | `SELECT pg_is_in_recovery();`<br>`SELECT application_name, state, sync_state FROM pg_stat_replication;`<br>外部：连接池/代理配置的**存在性**（不回传串） | 能回答"写入是否只落到单一主库；故障切换期间是否有第二条写入路径" |
| **E-10** | P0 | lease 实际状态转移：`claim`/`renew`/`expire`/`takeover`/`commit` 的实现路径与**事务边界** | 代码路径（已有）+ `SELECT status, count(*) FROM "AutonomyLease" GROUP BY status;`<br>`SELECT max(acquiredAt), max(renewedAt), max(expiresAt) FROM "AutonomyLease";` | 能给出每个状态转移的 SQL 与事务边界，并说明接管在何条件下发生 |
| **E-11** | P0 | 生产版本对应关系：部署 SHA、迁移状态、实际 unit 内容与仓库 HEAD 的差异 | `git -C /opt/crossclaim rev-parse HEAD`<br>`systemctl show -p FragmentPath crossclaim-rsi`<br>`systemctl cat crossclaim-rsi`（比对 `deploy/systemd/crossclaim-rsi.service`）<br>`SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY finished_at DESC LIMIT 5;` | 能回答"实际运行的是哪个提交、迁移到哪一步、unit 是否与仓库一致" |
| **E-12** | P0 | 写入行为与触发器覆盖：DML、`ON CONFLICT`、`TRUNCATE`、**trigger disable**、复制模式等绕过路径 | `SELECT tgname, tgenabled, tgrelid::regclass FROM pg_trigger WHERE NOT tgisinternal;`（`tgenabled='D'` 表示被停用）<br>`SHOW session_replication_role;`<br>检索是否存在 `DISABLE TRIGGER` / `TRUNCATE` 脚本 | 能回答"非豁免入口是否全部受保护"以及"谁可以停用保护" |
| **E-13** | P1 | 文件锁身份与生命周期：目录与 inode 稳定性、文件替换/删除、FD 继承、进程崩溃、重启 | `findmnt -T <lockdir>`、`stat -f -c %T <lockdir>`、`stat -c '%d %i %h %a %U:%G' <lockfile>`<br>重启前后比对 `(device, inode)` | 能回答"锁对象身份在运行与重启期间是否稳定、是否存在被替换风险" |
| **E-14** | P0 | 提交结果取证能力：提交回执、事务关联、审计记录、**断连后只读对账**能力 | `SELECT pg_current_xact_id();`（需权限）<br>`SELECT has_table_privilege(current_user,'"AutonomyCandidate"','SELECT');`<br>是否允许读行系统列（`xmin`）与 WAL/日志只读访问 | 能回答"断连后能否只读地判断某行是否由某事务提交" |
| **E-15** | P1 | 实际配置生效证据：systemd 覆盖、环境变量优先级、实际权限与运行身份 | `systemctl show -p User,Group,ProtectSystem,ProtectHome,PrivateTmp,CapabilityBoundingSet,EnvironmentFiles crossclaim-rsi`<br>`systemd-analyze security crossclaim-rsi`（只读） | 能证明仓库声明的硬化**确实生效**（而不是仅写在文件里） |
| **E-16** | P1 | 监测与冻结能力：阻断传播、告警、人工接管、**停止写入的时延与验证方法** | 现有 kill-switch / 告警通道的清单与演练记录（如有） | 能给出"从发现到停止写入"的可测时延与验证步骤 |

> **再次强调（审计方原文要点）**：仓库中声明的 systemd 硬化 **≠** 目标服务器上已生效；
> migration 文件中的触发器定义 **≠** 目标数据库已部署该迁移，也 **≠** 拥有特权的操作者无法停用触发器。
> **E-08 / E-10 / E-11 / E-12 / E-14 为任何实施授权前的必要证据**（E-01/E-02/E-03 为首批只读证据）。

### 3.1 宿主优先顺序（审计方建议）

```text
第一优先（不需要生产数据库密码，也不开放生产写入）：
  E-01 实例数量 · E-02 全部潜在写入者 · E-03 角色↔unit 映射 · E-08 权限与所有权
  · E-10 lease 状态转移 · E-11 部署版本对应关系 · E-12 写入与触发器覆盖
第二优先（在 fencing 方案经只读评审之后）：
  隔离 PostgreSQL 16 实验环境 + 最小权限账号 + 【单独】实验执行授权
```

---

## 材料 4 — P3 实验矩阵修订（S1–S11；**仅方案，未执行**）

> 修订依据：CHANGE 89（S3/S7/S8 判据）与 CHANGE 90（新增 S9/S10/S11）。
> 纪律：**≤60 分钟仅为单次实验的资源边界**；超时未完成必须记 **`INCONCLUSIVE`**，**不得**为按时结束而宣布通过。

| 编号 | 场景 | 通过条件（修订后） | 修订点 |
| --- | --- | --- | --- |
| **S1** | 两写入者并发同一 `dedupeKey` | 恰好一行被创建；另一方走零行冲突路径；记录冲突返回路径。**去重通过 ≠ fencing 通过** | 明示去重与排他分离 |
| **S2** | 提交**前** `SIGKILL` | **必须先确定数据库是否已接收 `COMMIT`**；未确认前**不得**统一判为 `NOT_COMMITTED` | 审计方要求 |
| **S3** | `COMMIT` 已发出后 `SIGKILL` | 四阶段确定性注入：**①旧事务已开始未提交 → ②旧持有者 fencing token 失效 → ③新持有者成功接管并提交 → ④旧事务随后尝试提交**；通过条件 = **不得出现违反既定 fencing 顺序的陈旧写入提交**（不得仅凭杀进程/观察到一条记录/事后查 `dedupeKey` 判定） | **P0** |
| **S4** | 连接中断（结果未知） | **默认 `UNKNOWN`**；仅在**可信对账证据**存在时才可进一步分类 | 审计方要求 |
| **S5** | 跨实例竞争 + 强制阻断 | 所有**受控写入入口**停止（`R84-INVARIANT`） | — |
| **S6** | 提交归因取证 | 存在性 ≠ 本次提交；`xmin` 保持**辅助**地位 | — |
| **S7** | 锁协议一致性 | **不得只检查配置**：必须用**并发竞争**证明互斥是否有效；须覆盖"两实例分别持有 lease 与文件锁，却同时认为自己具备写入资格" | **P0** |
| **S8** | 旧 token 写入 | 分别覆盖**旧事务尚未开始**与**已经开始**两种情况（不能只测"失效后新发起的 INSERT"） | **P0** |
| **S9**（新） | 数据库主从切换 + 连接池重连 | 持有者身份、锁与事务状态在连接生命周期变化时保持安全；**无未经证明的自动重放或陈旧提交** | CHANGE 90 |
| **S10**（新） | 特权角色与旁路写入 | 所有**非豁免**入口均受保护；**特权豁免必须登记并受独立运维控制** | CHANGE 90 |
| **S11**（新） | 故障注入与阻断恢复 | fail-closed 后**不得**因重启/旧缓存/计时器自动恢复写入；未重新取得有效授权与栅栏前**保持只读或停止** | CHANGE 90 |

**每场景必留证据**：单调时间线 + DB 时间、参与者身份（进程/会话/角色）、SQL 与结果码、锁/栅栏状态快照、DB 侧观察、原始命令与输出（可复现）、以及**是否出现任何违反 fencing 顺序的提交**。

**安全退出与回滚**：观察到未受控双写或生产连通 ⇒ **立即中止并冻结**；结束销毁隔离环境（或删除专用 schema）并留存销毁记录；共享非生产实例须前后状态比对。

**声明**：`P3_EXPERIMENT_AUTHORIZED = NO`（本轮仅修订方案；执行需**单独授权**）。

---

## 状态汇总（本轮结束时）

```text
AUTHORIZATION_SCOPE = PHASE3_A_U2_PRECONDITION_R2_READ_ONLY
NEXT_AUTHORIZED = PHASE3_A_U2_PRECONDITION_R2_READ_ONLY（本轮）→ 后续收口见裁决
F01_STATUS = OPEN_P0（未关闭）
PREFERRED_LOCK_ROUTE = LEASE_REVIEW_FIRST（本轮给出方案建议；未做设计变更）
LOCK_PROTOCOL_UNIFORMITY = NOT_PROVEN
DEDUPE_PROOF = DESIGN_EVIDENCE_ONLY
EXCLUSION_PROOF_STATUS = NOT_PROVEN
COMMIT_ATTRIBUTION_PROOF = NOT_AVAILABLE_IN_CURRENT_CONFIGURATION
MULTI_INSTANCE_AUTOMATED_WRITE = NOT_AUTHORIZED
P3_EXPERIMENT_AUTHORIZED = NO
U2_IMPLEMENTATION_AUTHORIZED = NO
PRODUCTION_WRITE_AUTHORIZED = NO
U1_CODE_CLOSURE = UNCHANGED（9ee36837）
U2_DESIGN_R21 = 未重开
SCHEMA_MIGRATION = HOLD / RUNTIME_WIRING / MODEL_CALL / PROVIDER_CALL = FORBIDDEN
EXTERNAL_WRITE = HOLD / AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN / PRODUCTION_READY = NO
POSTGRESQL_INTEGRATION_TEST / VITEST / TSC / LINUX_SYSTEMD / CI / PRODUCTION = NOT_VERIFIED
HEARTBEAT_RESTORED = NO / OS_TIMER_RESTORED = NO
```

**本轮边界**：仅文档修订与只读勘验；未实施产品代码、未连接任何数据库、未运行任何实验、未修改 U1 封板、未恢复心跳或 OS 定时任务、未新增 schema/migration。
