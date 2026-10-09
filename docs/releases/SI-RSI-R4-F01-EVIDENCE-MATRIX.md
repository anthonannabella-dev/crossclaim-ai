# SI-RSI-R4-F01-EVIDENCE-MATRIX（R5 修订版）

> 授权：`PHASE3_A_U2_PRECONDITION_R5_READ_ONLY_CLOSURE`（按 MSG-20261009-50 的 CHANGE 95/96/97 修订 R4-05）。
> 基线：`bbc7536e`；本版取代 R4 初版的 ①载体维度分级 ②证据状态分级 ③不变量清单。
> 分级：`PROVEN` / `PARTIAL_PROVEN` / `DESIGN_ONLY` / `CODE_VERIFIED(_PARTIAL)` / `MIGRATION_TEXT_VERIFIED` / `NOT_PROVEN` / `BLOCKED`。
> **纪律**：`INTERNAL_READ_ONLY_WORK_COMPLETE ≠ HOST_EVIDENCE_VERIFIED`。

---

## 1. 载体七维评估（CHANGE 95 修订后的分级）

| 维度 | v2 分级 | 依据 |
| --- | --- | --- |
| ① 资源身份 | **`PARTIAL_PROVEN / IDENTITY_MISMATCH`** | 现有 RSI 已确认以 `taskId` 为身份（`AutonomyLease.taskId @unique`）；但 **U2 拟用身份（文件/全局锁）与之不一致** ⇒ 不能整体判 PROVEN |
| ② 行锁或可序列化约束 | **拆三项**：`CAS_PATTERN = CODE_VERIFIED`；`ROW_LOCK_OR_SERIALIZABLE_EQUIVALENCE = NOT_PROVEN`；`COMMIT_TIME_FENCING = NOT_PROVEN` | 仓库确实存在 CAS 条件更新（claim/reclaim/settle/fail/renew）；但**事务内 CAS ≠ 覆盖提交时刻的 fencing**，等价性与提交时刻覆盖均未验证 |
| ③ generation 单调性 | **NOT_PROVEN（且缺列）** | `AutonomyLease` 无 generation 列；现保护为 `ownerRef + status + expiresAt` |
| ④ 事务边界 | **PROVEN（仓库）** | claim / reclaimExpired / settle / **fail** 均显式 `$transaction`；**`renew` 无显式事务**（read-then-CAS，须单列验证项）；`rsi-restart-reconcile` 由 store 侧带前置条件 update 保证幂等 |
| ⑤ 授权与数据库权限闭环 | **BLOCKED** | 仓库无角色/GRANT 定义；需 E-08（含 schema 权限/继承角色/`SECURITY DEFINER`/RLS） |
| ⑥ 故障切换与旧主隔离 | **BLOCKED** | 需 E-09（切换仲裁、同步/异步复制、防旧主继续写入） |
| ⑦ 全写入入口保护覆盖 | **NOT_PROVEN** | 候选写入路径不存在；`RSI_CORE_PATHS_MAPPED_PARTIAL · ALL_REPO_WRITERS_NOT_EXHAUSTIVELY_PROVEN` |

**必要条件声明（CHANGE 95）**：权限闭环（⑤）与切换语义（⑥）**不是可无限期推后的次要条件**——
载体获批时它们与 ②③⑦ 同属**必要条件**。

```text
CARRIER_DECISION = HOLD（维持）
```

---

## 2. 证据状态：双层分级（CHANGE 96）

| 证据 | 仓库侧 | 目标运行侧 | 说明 |
| --- | --- | --- | --- |
| **E-01** 实例数量 | 部署声明可读（unit 单实例、跨实例互斥由 lease 承担） | `WAITING_ON_HOST` | 实际进程/主机数未知 |
| **E-02** 所有写入者 | `PARTIAL_REPO`（见写入域映射 v2 §1–§3） | `NOT_PROVEN` | 仓库外写入者未知 |
| **E-03** role↔unit | 配置声明可读（`User=crossclaim-rsi`；`DATABASE_URL` 由密钥管理注入） | `WAITING_ON_HOST` | 实际 PG 角色未知 |
| **E-08** 权限闭环 | `NOT_PROVEN`（迁移无 GRANT/角色定义） | `BLOCKED` | 需宿主权限矩阵 |
| **E-09** 故障切换 | `NOT_PROVEN` | `BLOCKED` | 需切换仲裁/复制语义/防旧主证据 |
| **E-10** 租约状态转移 | **`CODE_VERIFIED_PARTIAL`**（claim/reclaim/settle/fail/renew/reconcile 六处路径已读） | `NOT_PROVEN` | **业务性质的端到端验证仍为 NOT_PROVEN** |
| **E-11** 版本对应 | Manifest 可读（`rc-20261008-linux-deploy-v1`，`releaseCommit 04a93666…`） | `WAITING_ON_HOST` | 实际部署 SHA/迁移状态未知 |
| **E-12** 触发器覆盖 | **`MIGRATION_TEXT_VERIFIED`**（`cc_append_only__*`、judge 分离、状态 CHECK） | `NOT_PROVEN` | **迁移文件存在 ≠ 数据库对象生效** |
| **E-14** 提交归因 | `DESIGN_ONLY`（`xmin` 仅辅助；实现未用事务 ID） | `NOT_AVAILABLE` | 需目标库能力与权限 |

---

## 3. F-01 未获证不变量（U-1 ~ U-12）

| 编号 | 不变量 | 状态 |
| --- | --- | --- |
| U-1 | 资源身份统一（A-1） | NOT_PROVEN（IDENTITY_MISMATCH） |
| U-2 | 单调 fencing 版本（A-3） | NOT_PROVEN（缺 generation） |
| U-3 | 提交时刻的 fencing 覆盖 | NOT_PROVEN |
| U-4 | 全入口覆盖 | NOT_PROVEN |
| U-5 | 中断/超时/重连/崩溃下的不变量保持 | NOT_PROVEN |
| U-6 | 主节点切换后 generation 单调性（A-7） | BLOCKED（需 E-09） |
| U-7 | 角色/所有权/特权闭环（A-8） | BLOCKED（需 E-08） |
| U-8 | `SERIALIZABLE` 实际约束与外部副作用隔离 | NOT_PROVEN |
| U-9 | 租约时间语义与 fail-closed | NOT_PROVEN（**且 `renew` 读取不在事务内**，须单列验证） |
| U-10 | 去重/排他/归因三项互不推导 | DEDUPE=DESIGN_EVIDENCE_ONLY；EXCLUSION=NOT_PROVEN；COMMIT_ATTRIBUTION=NOT_AVAILABLE |
| **U-11**（新增） | **执行身份唯一性与 ABA 防护**：须证明一次执行尝试有独立、不可混淆的身份，且旧尝试不能凭"重新出现的相同 `ownerRef`"获得有效写入权 | NOT_PROVEN |
| **U-12**（新增） | **部分失败/回滚/负结果的可归因性**：`affectedRows=0`、函数返回 `false`、事务异常、事务回滚、结果未知**分别**如何处置；不得把"未抛异常"当作协议完成（`reclaimExpired` 两个 CAS 须**整体**成立；结果未知不得重复外部副作用） | NOT_PROVEN |

---

## 4. 状态

```text
INTERNAL_READ_ONLY_WORK_COMPLETE = YES（R4 + R5 文档侧）
HOST_EVIDENCE_VERIFIED = NO
F01_STATUS = OPEN_P0 · CARRIER_DECISION = HOLD
P3_EXPERIMENT_AUTHORIZED = NO · U2_IMPLEMENTATION_AUTHORIZED = NO · PRODUCTION_WRITE_AUTHORIZED = NO
MULTI_INSTANCE_AUTOMATED_WRITE = NOT_AUTHORIZED · SCHEMA_MIGRATION = HOLD
PRODUCTION_READY = NO · POSTGRESQL_INTEGRATION_TEST / VITEST / TSC / LINUX_SYSTEMD / CI / PRODUCTION = NOT_VERIFIED
```
