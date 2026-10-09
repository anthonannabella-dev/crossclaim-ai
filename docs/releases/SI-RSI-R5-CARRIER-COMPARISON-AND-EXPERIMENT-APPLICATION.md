# SI-RSI-R5-CARRIER-COMPARISON-AND-EXPERIMENT-APPLICATION

> 授权：`PHASE3_A_U2_PRECONDITION_R5_READ_ONLY_CLOSURE`（允许：路线 A/B 比较与**载体决策建议**、**编写**隔离实验申请但**不执行**、接收脱敏宿主证据）。
> 基线：`bbc7536e`；依据：`MSG-20261009-50`（`CARRIER_DECISION=HOLD`，R5 证据不足须以 HOLD 结案）。
> 本轮**未连接任何数据库、未执行任何查询或实验、未修改产品代码、未启动任何定时任务**。

---

## 1. 载体路线比较（A vs B）

| 维度 | **路线 A：数据库端 fencing（优先）** | **路线 B：隔离部署 / 文件锁等** |
| --- | --- | --- |
| 现有基础 | **已有**：`AutonomyTask`/`AutonomyLease` 的 CAS + `$transaction`（claim/reclaim/settle/**fail**）；**且仓库另有 `pg_advisory_xact_lock` 先例**（`services/billing/invoice-issue.ts:129`，以稳定业务身份为键、在 `$transaction` 内获取） | **无**：产品代码中不存在任何 `flock`/文件锁；U2 设计的 `flock` 属**全新引入**能力 |
| 与 U2 设计的冲突 | 需把 U2 的排斥机制从"文件锁"改写为"数据库端"（**需单独授权的设计修订**） | 与现网 RSI 的 lease 互斥形成**两套互斥域**（F-01 本质问题） |
| 单调版本 | **缺 generation 列** ⇒ 需 schema 变更或等价物（HOLD） | 可用 inode 身份，但**无版本单调性**语义 |
| 提交时刻覆盖 | 可通过**行锁/受控状态迁移/advisory lock + 同事务**达成（**待证明**） | 进程崩溃/连接中断即释放，**更难覆盖在途提交** |
| 权限闭环 | 依赖数据库角色与对象所有权（需 E-08） | 依赖部署隔离与文件系统语义（需 E-04/E-15） |
| 故障切换 | 需证明 generation 不回退（A-7；需 E-09） | 依赖单实例部署假设（更脆弱） |
| 跨域一致性 | 与业务域既有做法一致（billing 已用 advisory lock） | 引入第二套机制，运维面扩大 |

**决策建议（本轮）**：**继续优先评审路线 A**；`CARRIER_DECISION = HOLD`（理由同 `MSG-20261009-50`：②③⑦ NOT_PROVEN、⑤⑥ BLOCKED）。
**必要条件**：generation（或等价单调物）+ 全入口覆盖 + 提交时刻覆盖论证 + 权限闭环 + 切换语义（后两者**不得推后**）。

---

## 2. R5 只读检查结果（CHANGE 94 输入）

| 检查项 | 结果 |
| --- | --- |
| `fail()` | 显式 `$transaction`；含租约 CAS 释放 + 任务 CAS（`READY`/`DEAD_LETTER`，`attempts+1`、`nextAttemptAt`）；失败路径**无部分写入** |
| `renew()` | **无显式 `$transaction`**（`findUnique` → `updateMany` CAS，`FENCED_LEASE_RACE`）⇒ 列为**待验证项 U-9** |
| `rsi-restart-reconcile` | 契约明确（6 条收敛规则）；由 store 侧带状态前置条件 update 保证幂等；**不创建/删除行**；**与租约代际无关联**（缺口） |
| 原生 SQL | **存在**（server/appeals/claims/config-execution-durability/billing/consistency）⇒ 已更正 R4 绝对断言；另有 `pg_advisory_xact_lock` 先例 |
| 候选对象旁路入口 | `AutonomyCandidate` **无任何产品代码写入**；潜在旁路=仓库外写入者 + 特权角色（需 E-02/E-08/E-12） |

---

## 3. 隔离实验申请（**草案，未执行、未获批**）

> 目的：在**非生产**隔离环境验证 F-01 的未获证不变量；**本轮仅编写**，执行需**单独授权**。

### 3.1 申请范围

| 项 | 内容 |
| --- | --- |
| 环境 | 隔离 PostgreSQL **16**（可丢弃）+ 一次性锁/状态目录 + 专用非特权账号；**无生产连接串** |
| 数据 | 仅合成数据；禁止真实客户数据/凭据 |
| 资源边界 | 单次 ≤60 分钟；超时未完成记 **`INCONCLUSIVE`**（不得为按时结束而宣布通过） |
| 结束后处置 | 销毁环境或删除专用 schema，并留存销毁记录 |

### 3.2 必测场景（承接 R2 的 S1–S11，另加 U-11/U-12 两项）

| 编号 | 场景 | 通过条件 |
| --- | --- | --- |
| S1 | 并发同 `dedupeKey` | 恰好一行；记录冲突路径；**去重 ≠ fencing** |
| S3a | 旧事务先取得栅栏行锁 | 接管**必须等待**；不得插入其"校验→提交"之间 |
| S3b | 新持有者先完成接管 | 旧 generation 写入**必须失败** |
| S4 | 连接中断（结果未知） | 默认 `UNKNOWN`；禁止自动重放 |
| S5 | 跨实例阻断 | 所有受控入口停止 |
| S7 | 双协议并存（lease vs 文件锁） | 以**并发竞争**证明互斥有效性 |
| S8 | 旧 token 写入 | 覆盖"旧事务未开始/已开始"两态 |
| S9 | 主从切换 + 连接池重连 | 无未经证明的自动重放或陈旧提交 |
| S10 | 特权角色与旁路写入 | 非豁免入口均受保护；特权豁免登记并受独立运维控制 |
| S11 | 故障注入与阻断恢复 | 未重新取得授权与栅栏前保持只读/停止 |
| **S12（新增）** | **ABA：同一 `ownerRef` 在不同执行实例/重启后重现**（U-11） | 旧尝试**不得**凭重现的 owner 标识获得写入权 |
| **S13（新增）** | **部分失败/回滚/负结果**（U-12）：`affectedRows=0`、函数返回 `false`、事务异常、回滚、结果未知 | 分别有确定处置；**不得**以"未抛异常"判定协议完成；结果未知不得重复外部副作用 |

### 3.3 必须留存的证据

单调时间线 + DB 时间、参与者身份（进程/会话/角色）、SQL 与结果码、栅栏/generation 状态快照、DB 侧观察（行数、系统列）、原始命令与输出（可复现）。

### 3.4 安全退出与回滚

观察到**未受控双写**或**生产连通** ⇒ 立即中止并冻结；结束销毁隔离环境；共享非生产实例须前后状态比对。

---

## 4. 宿主证据接收状态（R5）

```text
HOST_EVIDENCE_RECEIVED = NONE（本轮未收到任何宿主证据）
WAITING_ON_HOST：E-01 / E-02(仓库外) / E-03 / E-08 / E-09 / E-11 / E-12(实际生效) / E-14
接收纪律：仅接收【已获宿主只读取证授权】且【经脱敏】的材料（名称/布尔/计数/时间/对象名）；
         禁止连接串、密码、密钥、令牌与业务数据行；不满足者不作为合规证据。
```

---

## 5. 本轮结论

```text
CARRIER_DECISION = HOLD（证据不足，不以"为关闭而放行"结案）
F01_STATUS = OPEN_P0
R5_READONLY_REVISIONS = DONE（R4-03 → v2；R4-05 → v2；本文件为路线比较与实验申请草案）
R5_HOST_EVIDENCE_RECEPTION = WAITING（未收到证据）
R5_EXPERIMENT_APPLICATION = DRAFTED（未执行、未获批）
P3_EXPERIMENT_AUTHORIZED = NO · U2_IMPLEMENTATION_AUTHORIZED = NO · PRODUCTION_WRITE_AUTHORIZED = NO
```
