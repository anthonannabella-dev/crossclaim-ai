# SI-RSI-EXPERIMENT-APPLICATION-ADDENDUM-R6

> 授权：`MSG-20261009-52` 的 `NEXT_AUTHORIZED = SUBMIT_ISOLATED_EXPERIMENT_APPLICATION_WITH_CHANGE_101_102_ADDENDUM_ONLY`
> （`EXPERIMENT_APPLICATION_SUBMISSION = ALLOWED`；`P3_EXPERIMENT_AUTHORIZED = NO`、`AUTO_R7 = NOT_AUTHORIZED`）。
> 基线：`03e6ce91`；本附件并入 R5 的隔离实验申请草案，作为其**验收附件**（**不执行实验**）。
> 纪律：未获宿主「隔离环境 + 最小权限账号 + 明确实验执行授权」之前，不得宣称 U2 前置条件已通过真实数据库验证。

---

## 1. CHANGE 101（P1）—— 修正 S13b 并发反例的**可达性**

**审计方否证**：R6 原时序写「旧 reconcile 已将租约标为 `EXPIRED`，随后新实例调用 `reclaimExpired()`」——
但 `reclaimExpired()` 的前置条件是「**租约仍为 `ACTIVE`** 且 `expiresAt <= now`」（`rsi-durable-task-source.ts:298-303`）。
租约已被标 `EXPIRED` 后，该方法**选不中**它 ⇒ 原 T2 的「任务被放回 READY」**不可达**。该否证成立。

### 1.1 修正后的**可执行**时序（三个实例 A/B/C）

```text
T0  A（reconcile）读取快照：租约 L(owner=O_old, status=ACTIVE, expiresAt<=now) 已过期；任务 T=IN_PROGRESS
T1  A 调 markLeaseStatus(L → EXPIRED)      —— 成功（L 原为 ACTIVE）
    ※ 同一时刻 B（另一实例的 reconcile）也持有自己的快照（同样看到 L 过期、T=IN_PROGRESS）
T2  B 调 markLeaseStatus(L → EXPIRED)      —— 【0 行命中】（L 已 EXPIRED）
    ★ 关键：markLeaseStatus() 返回值为 void，CAS 影响行数被忽略 ⇒ B 继续执行下一步
T3  B 调 requeueTask(T：IN_PROGRESS → READY) —— 成功（任务状态前置条件满足）
T4  C（或任一实例）claim：任务 CAS(T：READY → IN_PROGRESS) + 租约 upsert(owner=O_new, status=ACTIVE, expiresAt=未来)
T5  A 调 requeueTask(T：IN_PROGRESS → READY) —— 【命中 C 的任务】⇒ 把 O_new 正在处理的任务改回 READY
结果：O_new 仍持 ACTIVE 租约，但任务已 READY ⇒ 可被再次领取 ⇒ 并发重复处理风险
```

**可达性要点（三条，缺一不可）**：

1. 触发 `requeue` 的**不是** `reclaimExpired`，而是**另一个 reconcile 实例的 `requeueTask`**（其唯一前置是任务状态）；
2. 该 reconcile 的 `markLeaseStatus` 返回 **0 行**却**被忽略**（Prisma store 实现返回 `void`）⇒ 流程继续；
3. `T5` 的陈旧 `requeueTask` **只校验任务状态、不校验租约归属** ⇒ 命中新持有者的任务。

### 1.2 S13b 的**确定性交错控制点**（实验设计）

| 控制点 | 位置 | 注入方式（隔离环境） | 期望 |
| --- | --- | --- | --- |
| **CP-1** | A 的 `markLeaseStatus` 之后、`requeueTask` 之前 | 在 A 与 B 之间插入同步屏障（实验驱动脚本控制两进程推进顺序） | 允许 B、C 完成 T2–T4 |
| **CP-2** | B 的 `markLeaseStatus` 返回后 | 断言影响行数 = 0（记录证据）并允许流程继续（复现「忽略 CAS 结果」） | B 继续 requeue |
| **CP-3** | C 的 claim 完成后 | 断言租约 `owner=O_new`、`status=ACTIVE`，任务 `IN_PROGRESS` | 建立「新持有者」状态 |
| **CP-4** | A 的 `requeueTask` 执行前 | 断言此时任务仍为 C 的 `IN_PROGRESS` | 触发违例 |

**S13b 通过条件（以修正后的时序为准）**：在 CP-1~CP-4 控制下，**A 的陈旧 `requeueTask` 必须不生效**
（即实现须已具备 §1.3 的任一前置）——若任务被改回 `READY`，判 **FAIL**。

### 1.3 对应的验收前置（实现方式留待单独授权）

① `requeueTask` 与租约快照**原子绑定**（同事务 + 同一前置条件，含租约身份/到期时间）；
② `requeueTask` 增加前置「**该任务不存在 ACTIVE 租约**」；
③ 以租约 **generation / owner** 作为 `requeueTask` 的附加前置；
④ 至少：`markLeaseStatus` 的 **CAS 影响行数必须被检查**（0 行时不得继续 requeue）。

---

## 2. CHANGE 102（P1）—— 强化 S13a / S13c / S13d 的验收证据

### 2.1 S13a（部分提交）

| 要素 | 规定 |
| --- | --- |
| 故障注入方式 | 让**第一步 CAS 命中、第二步 CAS 返回 `count=0`**：在两步之间（实验驱动脚本控制的确定点）用受控会话改动第二步目标状态，使第二步前置条件不满足 |
| 观测 | **事务提交后的最终数据库状态**（不得以应用返回值判定） |
| 证据 | **实验前后数据库快照**（目标行）+ 影响行数记录 + 时间线 |
| 通过条件 | 不存在半转换：不得出现 `lease=EXPIRED/RELEASED` 而 task 未变，或 task 已变而 lease 未变 |

### 2.2 S13c（ABA）

必须**同时**覆盖三种情形（不能只比较 owner 字符串）：

1. `ownerRef` **相同**、**generation 不同**（或等价身份不同）；
2. 旧实例**延迟提交**（旧事务在接管完成后才尝试提交）；
3. 旧实例**重启后**以相同 `ownerRef` 重现。

**通过条件**：三种情形下旧尝试均**不得**通过身份校验并提交受保护写入。

### 2.3 S13d（结果未知 / 外部副作用）

1. 除**数据库最终状态**外，必须核验**外部副作用模拟器**或**可信操作账本**，证明**没有重复执行**；
   **仅看数据库无法证明外部副作用未发生**。
2. 通过条件：提交结果未知时**不得**重新触发任何不可证明幂等的外部副作用；状态须为 `UNKNOWN`。

---

## 3. 精度补充（承接 CHANGE 100）

`hashtext(...)` 返回 **32 位哈希值**，转换为 `bigint` **不会增加有效哈希位数**。
这不改变 R6 的两项结论（可能碰撞；advisory lock 仅约束同协议参与者），但若后续采用哈希键方案，须按 **32 位**有效宽度评估碰撞概率。

---

## 4. 提交口径（本附件）

```text
EXPERIMENT_APPLICATION = READY_FOR_SUBMISSION（含本附件）
本附件内容：CHANGE 101（S13b 可达性修正 + CP-1~CP-4 + 四项验收前置）
           CHANGE 102（S13a/S13c/S13d 证据强化）
           CHANGE 100 精度补充（32 位有效哈希宽度）
P3_EXPERIMENT_AUTHORIZED = NO（执行须宿主【单独】授权：隔离环境 + 最小权限账号 + 明确实验执行许可）
READ_ONLY_LOOP = STOP（不再自动开启 R7）
R6_TASK_STATE = AWAITING_HOST_EVIDENCE_AND_EXPERIMENT_AUTHORIZATION
F01_STATUS = OPEN_P0 · CARRIER_DECISION = HOLD · U2_IMPLEMENTATION_AUTHORIZED = NO · PRODUCTION_READY = NO
```

**边界**：本附件为**文档/申请材料**，未执行任何实验、未连接数据库、未修改产品代码、未恢复任何定时任务。
