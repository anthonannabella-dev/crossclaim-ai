# U2-PRECONDITION-READINESS-PACK

> 授权：`PHASE3_A_U2_PRECONDITION_PREPARATION_READ_ONLY`（本轮**仅**编制申请/证据/实验方案；**不实施**、**不连接生产**、**不执行外部写入**、**不启用多实例自动写入**、**不恢复心跳或 OS 定时任务**）。
> 基线：`e57468d1`（功能分支 `feat/si-rsi-internal-code-repair-v1`）；U1 封板 `9ee36837`（未改动）。
> U2 设计状态：**PASS / CLOSED**（MSG-20261009-46）。U2 实施状态：**NOT_AUTHORIZED**。
> 本文档为**申请与方案**，不是任何能力的证明；全部外部能力与目标环境事实仍为 `NOT_VERIFIED`。

---

## 0. 结论摘要（先读）

| 项 | 结论 |
| --- | --- |
| P1 数据库安全能力 | 需要宿主提供**非生产 PostgreSQL 16** 实例、角色与最小权限、栅栏/串行化能力与提交归因能力；**能力现状未知** |
| P2 目标环境证据 | 仓库内可读到**部分**部署与运行事实（systemd unit、env 契约、manifest）；**实例数量、实际写入者全集、挂载/文件系统语义、门禁绕过路径**仍缺失 |
| 关键发现 | 现网 RSI runtime 的跨实例排斥机制是**数据库租约（AutonomyLease + ownerRef + expiresAt）**，而 U2 设计选定的生产协议是 **`flock` 整文件锁** ⇒ **协议一致性缺口**（详见 §2.3 F-01） |
| P3 隔离实验 | 方案已编制；**本轮不执行**、**未获授权** |
| 实施 | `U2_IMPLEMENTATION_AUTHORIZED=NO`、`PRODUCTION_WRITE_AUTHORIZED=NO` |

---

## 1. P1 — PostgreSQL 数据库安全能力**申请清单**

### 1.1 引擎与版本

| 项 | 申请/依据 |
| --- | --- |
| 引擎 | PostgreSQL |
| 版本 | **16**（依据：`apps/api/.env.example` 注释「数据库（PostgreSQL 16）」；`deploy/release-manifest.json` → `runtime.database = "PostgreSQL 16"`） |
| 实例性质 | **非生产**、**不承载真实客户数据**、可丢弃（可重建） |
| 交付方式 | 由宿主**密钥管理注入** `DATABASE_URL`（依据：`deploy/install-rsi-service.sh` 明确「DATABASE_URL 由宿主密钥管理注入（本脚本不写）」） |

### 1.2 角色与最小权限（申请明确答复）

请宿主明确回答并给出**权限矩阵**（角色 → 对象 → 允许动作）：

| 角色（示例名） | 用途 | 申请的最小权限 |
| --- | --- | --- |
| **应用运行角色**（如 `crossclaim_rsi_app`） | U2 候选写入路径 | 仅 `INSERT` 于 `AutonomyCandidate`；`SELECT` 于对账所需对象；**禁止** `UPDATE`/`DELETE`（含证据表）；**禁止** DDL |
| **迁移角色**（已存在概念） | `prisma migrate deploy` | DDL（`CREATE/ALTER/INDEX/TRIGGER`），**不得**被应用运行路径使用 |
| **只读审计角色**（如 `crossclaim_audit_ro`） | 独立核验、证据导出 | 仅 `SELECT`（含必要的系统列/函数权限） |
| **DBA/应急角色** | 人工运维 | 明确**是否存在**、由谁持有、是否可绕过门禁（诚实披露即可，不要求共享凭据） |

**必须一并回答的四问**：

1. 应用运行角色**能否**执行 `UPDATE`/`DELETE`？（若可以，是否有触发器层面的兜底？）
2. **所有权/超级权限**：是否存在可绕过权限模型的所有者角色或迁移角色？
3. `AutonomyCandidate` 上是否只有应用角色可 `INSERT`？是否还有其他可写入主体？
4. 是否存在**超出仓库范围**的写入渠道（DBA 手工、外部脚本、复制、物化作业）？
> 设计侧相关依据：仓库既有裁决倾向「以 **append-only 触发器**为主，而非仅 `REVOKE UPDATE/DELETE`」，理由是**权限模型可能被 owner/migration 角色绕过**（见 `docs/releases/C18-SCHEMA-DELTA-PROPOSAL.md`，同文出现两处同一结论）。

### 1.3 事务与锁能力（申请明确答复）

请确认下列能力**是否存在、是否授予应用角色**：

| 能力 | 用途（对应设计条款） | 申请 |
| --- | --- | --- |
| `pg_current_xact_id()`（`xid8`） | 事务身份捕获（§26.4／§28.3） | 允许执行 |
| 读取行系统列（如 `xmin`） | **辅助**证据（§28.3：已降级，不作独立归因权威） | 允许 `SELECT` |
| `pg_advisory_xact_lock()` / `pg_advisory_lock()` | 事务级串行化候选 | 允许执行（并说明会话/事务语义与超时行为） |
| 事务隔离级别可设性（含 `SERIALIZABLE`） | 串行化候选 | 允许并说明重试语义 |
| **唯一约束冲突语义** | 去重权威（`AutonomyCandidate.dedupeKey` 已有 UNIQUE） | 确认实际存在且不可被绕过 |

### 1.4 栅栏（fencing）与提交归因能力——**本轮最关键的申请**

设计要求（MSG-20261009-46 关项意见）：**未来实施必须证明「栅栏检查与实际提交之间不存在陈旧持有者可成功写入的窗口」**；且**栅栏令牌校验必须与受保护写入及栅栏失效操作具备数据库层面的正确串行化关系**（仅在事务开始时检查一次、随后允许旧事务提交**不足以**实现该不变量）。

请宿主在下列候选中明确**可授权的一种**（或给出等价方案）：

| 候选 | 机制 | 所需能力 | 说明 |
| --- | --- | --- | --- |
| **F-A 条件化写入（首选）** | 把「栅栏仍归本执行所有」作为**同一条 SQL** 的条件（如 `INSERT ... SELECT ... WHERE EXISTS (fence owner = me AND version = v)`），由**数据库**决定成败 | 允许新增**栅栏表/字段**（DDL 授权）**或**指定一个可复用的既有对象 | 陈旧持有者的写入在**数据库侧**被拒绝；不依赖客户端存活 |
| **F-B 事务级 advisory lock + 短事务** | 决策与写入在同一事务内，锁由数据库管理 | advisory lock 权限 | 需评估：连接中断时锁随会话释放，是否仍存在"提交在途"窗口 |
| **F-C 同事务审计记录（归因）** | 在同事务写入一条 `{executionRef, candidateId}` 审计记录，作为**因果绑定** | 允许新增审计表/约束（DDL 授权） | 用于 `THIS_EXECUTION_COMMITTED`；**当前配置下不可用**⇒归因上限为 `UNKNOWN` |

**如实声明**：在不新增 schema 的约束下，`F-A`/`F-C` 均不可用 ⇒ 目前 `EXCLUSION_PROOF_STATUS = NOT_PROVEN`、`COMMIT_ATTRIBUTION_PROOF = NOT_AVAILABLE_IN_CURRENT_CONFIGURATION`。

### 1.5 故障注入测试要求（P1 申请的一部分：允许我们在非生产实例上做）

须在非生产实例上允许执行（**只读/可丢弃**范围内）：
①并发竞争事务（同一 `dedupeKey`）；②`SIGKILL` 写入进程（提交前/提交后各一次）；③连接中断（提交在途）；④容器/进程重启期间的竞争；
⑤人为使栅栏令牌失效后，陈旧持有者尝试写入（期望被**数据库拒绝**）；⑥事务身份与归因证据的取证（含 `xmin` 辅助校验）。
**禁止**：任何生产实例操作、任何真实业务数据、任何外部写入通道。

---

## 2. P2 — 目标部署环境证据清单

### 2.1 仓库内**已可读到**的事实（只读勘验结果）

| 事实 | 来源 |
| --- | --- |
| 运行栈：Node 22.x、PostgreSQL 16、systemd、部署根 `/opt/crossclaim` | `deploy/release-manifest.json → runtime` |
| 服务集合：`crossclaim-api` / `crossclaim-web` / `crossclaim-rsi`（unit 文件存在） | `deploy/systemd/*.service`、`deploy/release-manifest.json → services` |
| RSI 单元以**专用系统用户** `crossclaim-rsi` 运行，`ProtectSystem=strict`、`ProtectHome=true`、`PrivateTmp=true`、空 `CapabilityBoundingSet`、`StateDirectory=crossclaim-rsi`（`/var/lib/crossclaim-rsi`） | `deploy/systemd/crossclaim-rsi.service` |
| 该 unit 声明**单实例**（无 `@` 模板实例、无其它 unit 引用同一入口），且注明**跨实例互斥由 durable lease（`ownerRef` = 进程启动 UUID + pid，租约到期才可被接管）承担** | 同上（unit 注释） |
| 必需环境变量：`DATABASE_URL`（唯一必需项）；生产另需 `RSI_RECONCILE_REQUIRED=true`（缺 URL ⇒ **拒绝启动**，fail-closed） | `DEPLOYMENT.md`、`deploy/systemd/crossclaim-rsi.service`、`deploy/install-rsi-service.sh` |
| 明文生产凭据**不得**写入仓库/环境文件；由密钥管理注入 | `apps/api/.env.example`、`deploy/install-services.sh`、`deploy/install-rsi-service.sh` |
| 证据表**append-only 触发器**（`cc_append_only__*`）已存在；`AutonomyCandidate.dedupeKey` **UNIQUE 索引**已存在；builder/judge 分离触发器已存在 | `apps/api/prisma/migrations/20261005000000_rsi_autonomy_state_persistence/migration.sql` |
| 部署分支白名单：**`feat/*` 与 `main` 均为禁用部署分支**（本 U2 工作分支不可部署） | `deploy/release-manifest.json → forbiddenDeploymentBranches` |
| 验证工具链已存在（可用于 P3 方案复用）：`tools/backup-verify`、`tools/smoke`、`tools/tenant-triggers`、`tools/secrets`、`tools/verification`、`tools/verdict-diff` 等 | `tools/` 目录 |
| **无** `docker-compose` / `compose*.yml`：数据库供给**不在仓库内**，须由宿主提供 | 仓库全量检索 |
| **无任何** `flock` / `LOCK_EX` / `O_CLOEXEC` / `SCM_RIGHTS` 代码：U2 设计选定的文件锁协议**当前不存在于产品代码** | `apps/api/src` 全量检索 |
| RSI 运行时的排斥语义为 **durable lease**（`claimNextSafeTask()` 依据 lease 领取；`AutonomyLease(taskId UNIQUE, ownerRef, acquiredAt, renewedAt, expiresAt, status)`） | `apps/api/src/services/autonomy/rsi-continuation-engine.ts`、`apps/api/prisma/schema.prisma` |

### 2.2 需要宿主补充的证据（清单 + 采集方式）

| 编号 | 需要的证据 | 为什么需要 | 建议采集方式（只读） |
| --- | --- | --- | --- |
| E-01 | **实际运行实例数量**（每个 unit 的实例数、是否有额外手动启动、是否多主机） | 决定「单实例」假设是否成立 | `systemctl list-units 'crossclaim-*'`；`systemctl show -p MainPID,ActiveState crossclaim-rsi`；进程列表 |
| E-02 | **全部潜在写入者**（服务、作业、迁移、DBA、外部脚本） | `DEPLOYMENT_INVENTORY` 的完整性是准入门禁（§27.2/§29.2） | 列出 cron/systemd timer；DB 侧按角色统计；询问 DBA |
| E-03 | **数据库连接路径**与角色映射（哪个 unit 用哪个角色） | 最小权限与「谁可绕过」判定 | `/etc/crossclaim/*.env`（**只看键名，不要回传值**）；`pg_roles` 只读查询 |
| E-04 | **锁目录/状态目录的文件系统类型与挂载参数**（本地 ext4/xfs？NFS/SMB？）+ 该目录的生命周期与权限 | `flock` 语义与网络文件系统差异（§26.2/§27.2）；CHANGE 74 要求固定并核验 | `findmnt -T /var/lib/crossclaim-rsi`；`stat -f -c '%T' <path>`；`ls -ld <path>` |
| E-05 | **是否存在绕过门禁的写入路径**（人工 SQL、外部任务、历史服务） | CHANGE 84 四项前置条件之一 | 访谈 + 角色/触发器盘点 + 变更记录抽查 |
| E-06 | **目标 PostgreSQL 版本与参数**（`server_version`、`vacuum_freeze_min_age`、`autovacuum_freeze_max_age`、实例 XID 消耗速度） | §27.5 的归因窗口论证；§29 的 P1/P2 | `SHOW server_version; SHOW vacuum_freeze_min_age; SHOW autovacuum_freeze_max_age;`（只读） |
| E-07 | **非生产 `DATABASE_URL`**（经密钥管理交付） | 没有它，任何 DB 侧能力都无法验证 | 宿主交付；**不要**写入仓库 |

### 2.3 已识别的**协议一致性缺口**（F-01，须在授权前解决）

**事实**：现网 RSI 运行时的跨实例互斥是 **durable lease**（数据库侧，`AutonomyLease` + `ownerRef` + 租约到期接管）；而 U2 设计（§26.2 起）选定的**唯一生产锁协议**是 **`flock` 整文件锁**。
**含义**：二者是**不同的互斥域**。若 U2 的写入路径使用 `flock`，而既有运行时仍以 lease 协调，则**同一时刻可能有两个主体各自认为"获得了独占"**——这正是 CHANGE 68/74/84 明令禁止的情形。
**待决**：请在下列之一中作出选择（属 P1/P2 交界，须在实施授权前明确）：
1. **统一到 lease**（复用既有 `AutonomyLease` 语义；U2 设计需相应改写排斥机制）；
2. **统一到 `flock`**（需把既有运行时也迁移到同一文件锁协议并整体重验）；
3. **明确二者互不相交的写入域**（例如 U2 只写 `AutonomyCandidate` 且不与 lease 保护的资源重叠），并给出**该前提的证明责任与证据**。

> 说明：本条**不**要求现在做决定，只要求把它作为**实施授权前的显式前置**登记在案。

---

## 3. P3 — 独立隔离实验方案（**仅方案，未执行、未授权**）

### 3.1 边界与前提

| 项 | 规定 |
| --- | --- |
| 环境 | **非生产** PostgreSQL 16（可丢弃容器或独立实例）+ 一次性锁目录 + 专用非特权 OS 用户；**无**任何生产连接串 |
| 数据 | 仅合成数据；**禁止**真实客户数据、真实凭据、真实外部写入 |
| 时间盒 | 单次实验 ≤ 60 分钟；结束后环境销毁或回滚 |
| 回滚 | 首选**销毁实验环境**；若采用共享非生产实例，则仅允许在专用 schema/临时表中操作并在结束时删除 |
| 禁止 | 生产写入、迁移生产库、启用多实例自动写入、真实 provider/payment/customs/transport 通道 |

### 3.2 实验矩阵（S1–S8）

| 编号 | 场景 | 验证目标 | 期望结果 |
| --- | --- | --- | --- |
| **S1** | 两个写入者并发写入同一 `dedupeKey` | 去重权威 | **恰好一行**被创建；另一方走零行冲突路径；**不得**双写 |
| **S2** | 写入进程在 **提交前** 被 `SIGKILL` | 失败模型 F2 | 无候选行；恢复流程按 §29.4 状态机处置（**不得**推断已提交） |
| **S3** | 提交请求**已发出**后进程被 `SIGKILL` | 失败模型 F2/F5（核心） | 在 `F-A` 栅栏能力下：**陈旧持有者的写入被数据库拒绝**；无该能力时：记录风险并保持 `EXCLUSIVE_WINDOW_UNAVAILABLE`（**不得**以"窗口很小"通过） |
| **S4** | 连接在提交期间中断（结果未知） | 失败模型 F4 | 归因必须为 `UNKNOWN`；**禁止**自动重放同一业务 `INSERT` |
| **S5** | 两实例竞争 + 触发跨实例阻断条件 | `R84-INVARIANT` | 所有无法证明共享阻断状态的实例**停止** `INSERT`/恢复写入/下游自动化 |
| **S6** | 提交归因取证 | `THIS_EXECUTION_COMMITTED` 的可证明性 | 无同事务审计记录/回执 ⇒ 必须 `UNKNOWN`；`xmin` **仅**作辅助证据 |
| **S7** | 锁协议一致性（`flock` vs lease/advisory） | F-01 | 明确二者是否构成同一互斥域；若不一致 ⇒ 实验结论必须记录为**不可用于生产授权** |
| **S8** | 人为使栅栏令牌失效后陈旧持有者写入 | 栅栏正确串行化 | 写入**必须失败**；若仍成功 ⇒ 该栅栏方案**不可用于授权** |

### 3.3 每个场景必须留存的证据

时间线（单调时钟 + DB 时间）、参与者身份（进程/会话）、SQL 与结果码、锁/栅栏状态快照、DB 侧观察（行数、系统列、角色）、失败与重试记录、以及**原始命令与输出**（可复现）。

### 3.4 安全退出与回滚

①任一场景观察到**未受控双写**或**生产连通**⇒ 立即中止并冻结实验；②实验结束执行环境销毁（或专用 schema 删除）并留存销毁记录；
③若在共享非生产实例上操作，须在开始前记录初始状态、结束后比对。

### 3.5 验收矩阵（P3）

| 判据 | 通过条件 |
| --- | --- |
| S1 | 恰好一行；无重复 |
| S2/S4 | 状态为 `NOT_COMMITTED`/`UNKNOWN`，**无**自动重放 |
| S3/S8 | 陈旧写入被**数据库**拒绝（需 `F-A`/`F-B` 能力）；否则判为**未通过**并保持不可授权 |
| S5 | 阻断条件触发后，无实例继续写入 |
| S6 | 归因分级正确（存在性 ≠ 本次提交） |
| S7 | 互斥域一致性结论明确 |

**本轮声明**：`P3_EXPERIMENT_AUTHORIZED=NO`（仅方案；执行需单独授权）。

---

## 4. 证据矩阵（当前状态）

| 项 | 状态 | 来源/说明 |
| --- | --- | --- |
| PostgreSQL 版本契约（16） | **PRESENT（仓库文本）** | `.env.example`、`release-manifest.json` |
| 必需环境变量与 fail-closed 行为 | **PRESENT（仓库文本）** | `DEPLOYMENT.md`、unit、安装脚本 |
| 服务与 unit 清单 | **PRESENT（仓库文本）** | `deploy/systemd/*`、manifest |
| 最小权限硬化（unit 级） | **PRESENT（仓库文本）** | `crossclaim-rsi.service` |
| 去重权威（`dedupeKey` UNIQUE） | **PRESENT（仓库文本）** | migration `:146`、schema `:3256` 区 |
| append-only 与 judge 分离触发器 | **PRESENT（仓库文本）** | 同 migration `:297-332` |
| **实例数量/实际写入者全集** | **MISSING** | 需宿主（E-01/E-02） |
| **数据库角色与权限矩阵** | **MISSING** | 需宿主（E-03） |
| **文件系统类型与挂载语义** | **MISSING** | 需宿主（E-04） |
| **栅栏/串行化能力授权** | **MISSING** | 需 DDL/能力决定（§1.4） |
| **同事务归因载体（审计记录/回执）** | **MISSING** | 需 DDL/能力决定（§1.4 F-C） |
| **非生产 `DATABASE_URL`** | **MISSING** | 需宿主交付（E-07） |
| **锁协议一致性（F-01）** | **OPEN（已登记）** | §2.3 |
| 目标 PostgreSQL 参数与冻结语义 | **MISSING** | 需宿主（E-06） |
| 真实运行测试（PG/Vitest/tsc/Linux/CI/生产） | **NOT_VERIFIED** | 本机为 Windows，无法执行 |

---

## 5. 风险清单

| 编号 | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| R-01 | **锁协议不一致**（U2 `flock` vs 既有 lease） | 可能形成两个互不互斥的"独占域" ⇒ 未受控双写 | 先做 §2.3 的三选一决定，并在 P3 S7 验证 |
| R-02 | 无数据库端栅栏能力 | 提交窗口内锁失效不可阻止 ⇒ 排他不可证明 | 申请 §1.4 `F-A`；否则保持 `EXCLUSIVE_WINDOW_UNAVAILABLE` |
| R-03 | 归因只能到 `UNKNOWN` | 无法宣称"本次执行已提交" | 申请 `F-C`；在此之前报告中保持 `UNKNOWN` |
| R-04 | 未登记写入者（DBA/脚本/复制） | 破坏门禁完整性 | E-02/E-05 + `R84-INVARIANT`（无法证明即禁写） |
| R-05 | 网络文件系统锁语义差异 | 互斥假设失效 | E-04 固定并核验；未知即 fail-closed |
| R-06 | 权限模型被 owner/migration 角色绕过 | 仅靠权限收敛不足 | 以触发器兜底（既有裁决方向）+ 明确 owner 边界 |
| R-07 | 把设计 PASS 误解为实施授权 | 越权实施 | 本文档与 checkpoint 明确 `U2_IMPLEMENTATION_AUTHORIZED=NO` |

---

## 6. 最终报告（本轮）

```text
P1_STATUS = PACK_COMPLETE_AWAITING_HOST_CAPABILITY（申请清单已编制；数据库能力/角色/栅栏/归因均 NOT_VERIFIED）
P2_STATUS = PACK_COMPLETE_PARTIAL（仓库文本证据已整理；实例数、写入者全集、角色权限、挂载语义、绕过路径 MISSING）
P3_EXPERIMENT_AUTHORIZED = NO（仅方案，未执行）
U2_IMPLEMENTATION_AUTHORIZED = NO
PRODUCTION_WRITE_AUTHORIZED = NO
EXCLUSION_PROOF_STATUS = NOT_PROVEN
COMMIT_ATTRIBUTION_PROOF = NOT_AVAILABLE_IN_CURRENT_CONFIGURATION
MULTI_INSTANCE_AUTOMATED_WRITE = NOT_AUTHORIZED
SCHEMA_MIGRATION = HOLD
RUNTIME_WIRING / MODEL_CALL / PROVIDER_CALL = FORBIDDEN
EXTERNAL_WRITE = HOLD
AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN
PRODUCTION_READY = NO
POSTGRESQL_INTEGRATION_TEST / VITEST / TSC / LINUX_SYSTEMD / CI / PRODUCTION = NOT_VERIFIED
NEXT = 等待独立审计重新裁决（不自动进入实施阶段）
```

**本轮边界声明**：未实施 U2 产品代码；未启动 U3–U5；未修改 U1 封板代码；未连接或修改生产数据库；未执行任何真实外部写入；未启用多实例自动写入；未恢复心跳或 OS 定时任务；未新增 schema/migration。
