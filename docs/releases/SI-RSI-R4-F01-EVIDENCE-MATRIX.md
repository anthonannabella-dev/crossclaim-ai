# SI-RSI-R4-F01-EVIDENCE-MATRIX

> 授权：`PHASE3_A_U2_PRECONDITION_R4_READ_ONLY_EVIDENCE_CLOSURE`（R4-05 + R4-01/02/04 汇总；**只读**）。
> 基线：`7485f1bd`；审计依据 `MSG-20261009-49`（`CHANGE 91 = PASS_SCOPED`、`92 = PASS`、`93 = PASS_SCOPED`；`F01_STATUS=OPEN_P0`）。
> 分级口径：`PROVEN`（有可复核的仓库事实）/ `DESIGN_ONLY`（只有设计文本）/ `NOT_PROVEN`（无证据）/ `BLOCKED`（需宿主或额外授权）。
> **纪律**：`INTERNAL_READ_ONLY_WORK_COMPLETE` ≠ `HOST_EVIDENCE_VERIFIED`。静态分析完成**不得**表述为真实数据库能力已验证。

---

## 1. F-01 证据矩阵（逐项）

| 编号 | 断言/不变量 | 已验证事实（仓库） | 设计证据 | 缺失证据 | 阻断原因 | 后续 PG16 隔离实验**必要**验证点 |
| --- | --- | --- | --- | --- | --- | --- |
| **A-1** | U2 与既有 RSI 使用**同一受保护资源身份定义** | RSI 现以 **`taskId`** 为资源身份（`AutonomyLease.taskId @unique`；claim/settle 均按 `taskId`） | 设计 §26.2/§27.2 拟以**文件/全局锁**为身份 ⇒ **两者不一致** | 「U2 资源身份 = ?」的裁决 | **设计未选定** | 以同一资源身份并发写入，验证互斥是否按同一键生效 |
| **A-2** | lease 的领取/续租/到期/接管/版本变更具有**确定的事务语义** | **PROVEN（仓库）**：claim = 同事务「任务 CAS + 租约 upsert」（`:251-276`）；回收 = 同事务两步 CAS（`:295-321`）；settle = 同事务「租约 CAS 释放 + 任务 CAS 终态」（`:339-392`） | — | 目标库实际执行计划/隔离级别行为 | 无（可继续） | 并发 claim/reclaim 交叉验证：**恰好一个**赢 |
| **A-3** | 受保护写入携带**可验证执行身份 + fencing generation** | **部分 PROVEN**：`ownerRef`（执行身份）已存在且被用于 fencing | 设计 §29.1 拟引入 `fenceGeneration` | **`AutonomyLease` 无 generation 列**（schema：`taskId/ownerRef/acquiredAt/renewedAt/expiresAt/status`） | **需 schema 变更（HOLD）** | 旧 owner 在接管后以旧身份写入必须被拒绝 |
| **A-4** | 旧持有者失效后**不能在新持有者接管之后**提交陈旧写入 | **部分 PROVEN**：`settle()` 的 C2 fencing 注释与实现显式拒绝 `LEASE_NOT_ACTIVE` / `FENCED_OWNER_MISMATCH` / `FENCED_LEASE_EXPIRED` / `FENCED_LEASE_RACE` | 设计 §29.4 状态机 | **提交时刻覆盖**的形式化论证；候选写入路径不存在 | 设计 + 覆盖缺口 | S3b：接管已提交后，旧 generation 写入必须失败 |
| **A-5** | **所有**写入入口遵守统一协议，应用**无权旁路** | **NOT_PROVEN**：仓库内 RSI 域有 3 条 CAS 路径，但**仓库外写入者未知**；且候选写入路径尚不存在 | 设计 §27.2（`DEPLOYMENT_INVENTORY`） | E-02（全部潜在写入者）、E-08（权限与所有权）、E-12（触发器/绕过路径） | `WAITING_ON_HOST_EVIDENCE` | S10：特权角色与旁路写入必须受控或被登记 |
| **A-6** | 中断/超时/重连/崩溃下不变量仍成立 | **NOT_PROVEN**（无目标环境证据） | 设计 §28.1 失败模型 F1–F6、§29.1 `(P1)/(P2)` | E-09/E-14/E-15 | 需宿主 + 实验授权 | S4/S9/S11 |
| **A-7** | 主节点切换后 generation **单调性不回退** | **NOT_PROVEN**；且**当前无 generation 列** | 设计（本轮新增） | E-09（切换仲裁/同步异步复制/防旧主写入） | `WAITING_ON_HOST_EVIDENCE` | S9：主从切换 + 连接池重连期间不得出现陈旧提交 |
| **A-8** | 角色/对象所有权/特权入口构成**可审计权限闭环** | **NOT_PROVEN**：仓库内**无** `GRANT/REVOKE/角色定义`（仅迁移文本可查） | 设计 §27.2 | E-08（含 schema 权限/继承角色/`SECURITY DEFINER`/RLS）、E-15 | `WAITING_ON_HOST_EVIDENCE` | S10：特权豁免必须登记并受独立运维控制 |
| **CHANGE 91-1** | 接管侧 CAS `affectedRows=1` **≠ 接管事务已 COMMIT** | 设计已写入（§29 条件） | 设计 §29.1 | 实验证据（提交结果绑定） | 需实验授权 | 以数据库提交结果证明接管成功 |
| **CHANGE 91-2** | `SERIALIZABLE` 需证明**实际约束**而非仅隔离级别 | 设计已写入（W-B 候选） | 设计 §29.1 | 实验证据 | 需实验授权 | 验证接管提交与旧 generation 写入提交之间的真实约束；外部副作用不绕过事务保护 |
| **CHANGE 91-3** | 租约**时间语义**（时间源/过期判断点/等待后复验/撤销期 fail-closed） | 实现使用应用侧 `now()` 与 `expiresAt` 比较（`:338-344`、`:378`） | 设计 §29.1 | 数据库时间源与时钟偏差证据 | 需宿主/实验 | 时钟漂移与等待后复验行为 |
| **CHANGE 92** | 违例判定：接管提交后旧 generation 写入成功 = FAIL；ST-4 合规 | 设计已写入 | 设计 §29.2 | 实验证据 | 需实验授权 | S3a/S3b 两场景 + 四种状态 |

---

## 2. R4-04 路线 A 载体评估（优先评审 `AutonomyLease`）

| 评估维度 | 结论 | 依据 |
| --- | --- | --- |
| ① 资源身份 | **PROVEN（taskId）**，但与 U2 拟用身份**不一致** | `AutonomyLease.taskId @unique`；claim/settle 按 `taskId`；U2 设计拟用文件锁 |
| ② 行锁或可序列化约束 | **DESIGN_ONLY** | 现有实现用 **CAS（`updateMany` 受影响行数）** 而非 `FOR UPDATE`；是否等价须在实验中验证 |
| ③ generation 单调性 | **NOT_PROVEN（且缺列）** | schema 无 generation；现有 fencing 依据 `ownerRef + status + expiresAt` |
| ④ 事务边界 | **PROVEN（仓库）** | 3 条关键路径均在 `$transaction` 内（claim / reclaim / settle） |
| ⑤ 授权与数据库权限闭环 | **BLOCKED** | 仓库无角色/GRANT 定义；需 E-08 |
| ⑥ 故障切换与旧主隔离 | **BLOCKED** | 需 E-09（切换仲裁、同步/异步复制、防旧主写入） |
| ⑦ 所有写入入口保护覆盖 | **NOT_PROVEN** | 候选写入路径不存在；仓库外写入者未知（E-02/E-12） |

**载体结论**：

```text
CARRIER_DECISION = HOLD
理由：①~⑦ 中仅 ④ 为 PROVEN；②为 DESIGN_ONLY；③⑦为 NOT_PROVEN；⑤⑥为 BLOCKED。
说明：不得仅凭「已存在 AutonomyLease」决定复用；若选路线 A，最小改动的缺口是
      【可证明的单调 fencing 版本（generation 或等价物）】+【覆盖全部写入入口】+【提交时刻覆盖的论证】，
      其次才是权限闭环与切换语义的宿主证据。
```

---

## 3. R4-01 / R4-02 证据状态（E-01~E-14）

| 编号 | 内容 | 仓库可确认部分 | 状态 |
| --- | --- | --- | --- |
| **E-01** | 实际运行实例数量 | unit 声明**单实例**（无 `@` 模板、跨实例互斥由 lease 承担） | `WAITING_ON_HOST_EVIDENCE`（实际进程/主机数） |
| **E-02** | 全部潜在写入者 | 仓库内写入者已清点（见 `SI-RSI-R4-WRITE-DOMAIN-MAP.md` §2） | `PARTIAL_REPO` + `WAITING_ON_HOST_EVIDENCE`（仓库外） |
| **E-03** | 角色↔unit 映射 | unit 指定 `User=crossclaim-rsi`；`DATABASE_URL` 由密钥管理注入 | `WAITING_ON_HOST_EVIDENCE`（实际 PG 角色） |
| **E-08** | 权限与对象所有权 | 迁移中**无** `GRANT/REVOKE/角色定义` | `WAITING_ON_HOST_EVIDENCE` |
| **E-10** | lease 实际状态转移 | **代码路径 PROVEN**（claim/reclaim/settle 三处 + 事务边界） | `PARTIAL_REPO`；运行期观测待宿主 |
| **E-11** | 生产版本对应关系 | 仓库有 `release-manifest.json`（`rc-20261008-linux-deploy-v1`，`releaseCommit 04a93666…`） | `WAITING_ON_HOST_EVIDENCE`（实际部署 SHA 与迁移状态） |
| **E-12** | 写入与触发器覆盖 | 迁移含 `cc_append_only__*`、judge 分离触发器；`AutonomyTask` 状态 CHECK | `PARTIAL_REPO`；实际 `tgenabled`/角色待宿主 |
| **E-09** | 数据库故障切换与旧主隔离 | **无仓库证据** | `NOT_PROVEN` |
| **E-14** | 提交结果归因能力 | 设计已限定 `xmin` 仅辅助；现有实现未使用事务 ID | `NOT_PROVEN`（需目标库能力与权限） |

**须标注的关键区别（防误读）**：`E-10/E-12` 的**仓库部分**为 `PARTIAL_REPO`（代码/迁移文本），
**不代表**目标数据库已部署或已生效；`E-09/E-14` 完全依赖宿主/目标环境。

---

## 4. F-01 未获证不变量（供 R5 / P3 申请使用）

```text
UNPROVEN_INVARIANTS（当前全部视为 NOT_PROVEN / BLOCKED）：
  U-1  资源身份统一（A-1）
  U-2  单调 fencing 版本（A-3；缺 generation 列）
  U-3  提交时刻的 fencing 覆盖（A-4 / CHANGE 91-1）
  U-4  全入口覆盖（A-5）
  U-5  中断/超时/重连/崩溃下的不变量保持（A-6；S4/S9/S11）
  U-6  主节点切换后 generation 单调性（A-7）
  U-7  角色/所有权/特权闭环（A-8）
  U-8  SERIALIZABLE 实际约束与外部副作用隔离（CHANGE 91-2）
  U-9  租约时间语义与 fail-closed（CHANGE 91-3）
  U-10 去重/排他/提交归因的独立性（三项证明互不推导；当前 DEDUPE=DESIGN_ONLY、
       EXCLUSION=NOT_PROVEN、COMMIT_ATTRIBUTION=NOT_AVAILABLE_IN_CURRENT_CONFIGURATION）
```

---

## 5. 本轮状态

```text
INTERNAL_READ_ONLY_WORK_COMPLETE = YES（R4-01~R4-05 的仓库侧部分已完成）
HOST_EVIDENCE_VERIFIED = NO（E-01/E-02/E-03/E-08/E-09/E-11/E-12/E-14 待宿主）
F01_STATUS = OPEN_P0
CARRIER_DECISION = HOLD
P3_EXPERIMENT_AUTHORIZED = NO · U2_IMPLEMENTATION_AUTHORIZED = NO · PRODUCTION_WRITE_AUTHORIZED = NO
MULTI_INSTANCE_AUTOMATED_WRITE = NOT_AUTHORIZED
SCHEMA_MIGRATION = HOLD · RUNTIME_WIRING / MODEL_CALL / PROVIDER_CALL = FORBIDDEN
EXTERNAL_WRITE = HOLD · AUTO_MERGE / AUTO_DEPLOY = FORBIDDEN · PRODUCTION_READY = NO
POSTGRESQL_INTEGRATION_TEST / VITEST / TSC / LINUX_SYSTEMD / CI / PRODUCTION = NOT_VERIFIED
```

**边界**：本轮未连接任何数据库、未执行任何查询（含只读查询）、未运行实验、未修改产品代码、未恢复心跳或 OS 定时任务。
