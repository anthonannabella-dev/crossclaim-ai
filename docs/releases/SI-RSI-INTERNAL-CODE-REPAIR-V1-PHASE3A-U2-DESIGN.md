# PHASE 3-A · U2 设计（候选记录与 Incident↔Candidate↔Task 关联）—— **仅设计，未实施**

> 授权来源：`MSG-20261009-25 = PASS / U1_FINAL_CLOSURE=YES` →
> `NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_READ_ONLY_AND_IMPLEMENTATION_PREPARATION_ONLY`。
> 本文件是 **U2 设计与最小实施边界** 的送审材料（MSG-20261009-26），**不含任何产品代码改动**。

| 锚点 | 值 |
| --- | --- |
| U1 关闭锚点（封板代码） | `9ee36837`（`9ee3683725ad694123092e5bafce9a32b75d3fd2`） |
| 本设计所在分支 | `feat/si-rsi-internal-code-repair-v1` |
| U2 实施授权 | **NO**（`U2_IMPLEMENTATION_AUTHORIZED=NO`） |
| U3–U5 实施授权 | **NO** |
| 外部副作用 | `EXTERNAL_WRITE=HOLD`、`AUTO_MERGE/AUTO_DEPLOY=FORBIDDEN`、`PRODUCTION_READY=NO` |

---

## 1. 功能定义

U2 = PHASE 3 设计文档 §13 表中的 **P3-04 前置**：为内部故障建立**候选记录**，并把
`Incident → Candidate → Task` 三者用**确定性键**关联起来，使同一故障在重启/重放后**不重复**产生候选，
且**身份版本（identityVersion）变化后旧候选立即失效**。

**范围（允许）**

1. 从既有 `AutonomyIncident`（`kind='INTERNAL_FAULT'`、`status='DIAGNOSED'`）读取故障事实；
2. 生成/复用 **候选记录（Candidate）**，并写入**确定性 `dedupeKey`**；
3. 维护 `Incident ↔ Candidate ↔ Task` 的**关联**（外键 + 关联键），保证一对一/一对多关系可审计；
4. 维护 **identityVersion 失效规则**：候选绑定生成时的身份版本，版本变化 ⇒ 旧候选标记失效、**不得复用**；
5. 为上述全部路径产出**机器可读证据行**（供审计复算）。

**非目标（禁止）**

- 不改既有队列语义（`CUSTOMER_GOAL_QUEUE` 的 `admit/claim/settle` 行为不变）；
- **不新增** 队列 / Scheduler / Controller / Runtime / 第二套容器；
- **不触发执行**：不 `claim`、不 `settle`、不重放、不产生任何外部副作用；
- 不修改 U1 已封板的可信事实契约（`TRUSTED_FACTS_ACTION_SCOPE_POLICY`、
  `AsyncLocalStorage` 只读事务隔离、只读边界与失败关闭语义**保持字节级不变**）；
- 不触碰 `main`、`release/rc-20261008-linux-deploy-v1`、Action Guard / 权限 / 支付 / 外写门禁代码。

---

## 2. 输入输出契约

```ts
/** 只读输入：来自既有 AutonomyIncident 与 U1 适配器，二者均为只读来源。 */
export interface U2CandidateInput {
  incidentId: string;
  /** 既有约定：`incident:<signalKey>` —— 全局唯一（AutonomyIncident.dedupeKey UNIQUE）。 */
  incidentDedupeKey: string;
  /** 既有约定：`task:<signalKey>`。 */
  taskDedupeKey: string;
  /** 组织身份（平台级 scope 例外表不存客户数据；此处仅承载既有键）。 */
  organizationId: string;
  platformAccountId: string;
  provider: string;
  /** 身份规范版本（schema: Account.identityVersion，默认 'v1'）。 */
  identityVersion: string;
  /** 故障上下文（用于去重与失效判定，不参与授权）。 */
  faultClass: string;
  faultDetectedAt: string;
  /** U1 适配器提供的只读事实快照标识（不得作为执行许可）。 */
  factsSnapshotRef: string;
}

export interface U2CandidateDecision {
  outcome: 'CANDIDATE_RECORDED' | 'CANDIDATE_REUSED' | 'CANDIDATE_INVALIDATED' | 'REJECTED';
  /** 稳定、可断言、可审计的原因码。 */
  reason: string;
  candidateId: string | null;
  candidateDedupeKey: string | null;
  /** 逐项前置检查结果（失败项即 reason 来源），与 U1 的 checks 风格一致。 */
  checks: readonly { id: string; ok: boolean }[];
  /** 显式声明：本调用**不是**执行授权，也不产生队列/执行副作用。 */
  executionAuthorized: false;
}
```

**确定性键规则（沿用仓库既有约定，不发明第二套）**

- Incident：`incident:<signalKey>`；Task：`task:<signalKey>`（`apps/api/src/services/autonomy/rsi-task-generator.ts`）。
- Candidate：`candidate:<signalKey>#<identityVersion>#<baselineRef>`；
  ID 由 `stableId('cand', candidateDedupeKey)`（sha256 前缀）派生 ⇒ **跨重启稳定**。
- 唯一性由既有约束保证：`AutonomyCandidate.@@unique([dedupeKey])`。

---

## 3. 调用关系（不新增任何运行时组件）

```
[既有] fault-incident-intake  →  AutonomyIncident(kind=INTERNAL_FAULT, status=DIAGNOSED)
        │
[既有] fault-triage-sweep ──► FaultTriageDecision（仅分类，不含执行）
        │
[U2 新增·服务层] candidate-record-service   ← 只读取 Incident + U1 适配器事实
        │  （写入 AutonomyCandidate / 关联 AutonomyTask）
        └─► [既有] 队列入口保持**未被调用**：createPrismaTaskQueuePort().admit() / createAutonomyTaskSource().claim()
```

要点：

1. U2 只落在**服务层**；**不**接入 `rsi-run.ts` / `rsi-controller-continuation.ts` / `server.ts` 的运行时装配；
2. U2 **不调用** `admit()` / `claim()` / `settle()`；「候选生成」与「进入执行」之间保持**设计上的断路**；
3. 既有 `INTERNAL_FAULT` 与 `CUSTOMER_GOAL_QUEUE` 的结构隔离不变（执行器只信任 `CUSTOMER_GOAL_QUEUE`）。

---

## 4. 数据与权限矩阵

| 数据 | 读 | 写 | 说明 |
| --- | --- | --- | --- |
| `AutonomyIncident` | ✅（U2） | ❌ | 仅消费 `kind=INTERNAL_FAULT`、`status=DIAGNOSED` |
| `AutonomyTask` | ✅ | ⚠️ 设计允许（仅补 `incidentId` 关联行；不改 status/attempts/lease 语义） | 实施前需单独授权 |
| `AutonomyCandidate` | ✅ | ⚠️ 设计允许（新增候选行；不改既有候选） | 需 schema 批次可得 |
| `AutonomyLease` | ❌ | ❌ | 属执行面，U2 恒不触碰 |
| 客户租户业务表 / 凭据 / token | ❌ | ❌ | U2 不读取客户数据 |
| Action Guard / 审批链 | 只读引用 | ❌ | 执行前重验仍由既有链路负责 |

---

## 5. 四项显式声明（评审方条件 ③）

| 维度 | U2 声明 |
| --- | --- |
| 新增**持久化** | **是**：使用既有 `AutonomyCandidate` / `AutonomyTask` 模型（同批 RSI 平台级表，已含 `@@unique([dedupeKey])`）；**不新增表、不新增第二容器**。 |
| 数据库**写入** | **是（受限）**：仅新增候选行与关联行；不 UPDATE 既有候选、不删除、不改迁移文件。 |
| **Runtime 接线** | **否**：不接入 `rsi-run` / `rsi-controller` / `server.ts`；候选生成与执行入口保持断路。 |
| **模型调用** | **否**：U2 不调用任何模型/Provider；事实来自 U1 只读适配器。 |

**依赖前置（须先确认，否则 U2 不得实施）**：既有 RSI 平台级 schema 批次**尚未 `migrate deploy`**（设计阶段 HOLD）。
U2 若要落库，需在**隔离数据库**先应用该批次并给出前后 `pg_dump --schema-only` 摘要证据；
生产迁移仍 `HOLD`。

---

## 6. identityVersion 失效规则（评审方条件 ①/④）

1. 候选生成时**必须**记录 `identityVersion`（进入 `dedupeKey` 与证据行）；
2. 同 `signalKey` + 不同 `identityVersion` ⇒ **新的 dedupeKey**，旧候选置 `INVALIDATED`（只新增状态记录，不覆盖历史）；
3. 复用前必须重新解析当前身份版本；解析失败 ⇒ `REJECTED`（fail-closed），**不得**回落旧候选；
4. 任何「授权状态在执行窗口内变化」的情形，仍由既有 claim 授权重解析 + fenced settle 兜住；
   U2 **不得**把 `autoRecoverAuthorized` / 事实快照当作执行许可。

---

## 7. 确定性验收用例 / 失败关闭路径 / 负向对照 / 证据归档（条件 ④）

| 用例 | 对应的设计矩阵条目 | 断言（确定性） |
| --- | --- | --- |
| U2-1 同因重复入队 | A10（dedupeKey + CAS） | 同一 `signalKey` 两次生成 ⇒ 第二次 `CANDIDATE_REUSED`，候选行数 **不增加** |
| U2-2 identityVersion 变化 | A4 | 旧候选 `INVALIDATED`，新候选使用新 dedupeKey；旧候选**不被复用** |
| U2-3 快照过期 | A5 | 过期快照 ⇒ `REJECTED`（fail-closed），不产生新候选 |
| U2-4 关联完整性 | A3 | `Candidate.taskId → Task.incidentId → Incident` 链可枚举，且 `candidateDigest` 可比对 |
| U2-5 跨事务 | A9 | 跨事务/外部副作用场景 ⇒ `BLOCK`（标记 `NOT_AUTHORIZED`），无候选产生 |
| U2-6 崩溃/重启后重放 | A6/A10 | 重启后同因不重复建候选；计数与去重键前后一致 |

**失败关闭路径**：身份解析失败、身份版本缺失、Incident 非 `DIAGNOSED`、快照过期、
dedupeKey 被其他 kind 占用（既有 intake 语义）⇒ 一律 `REJECTED`/`BLOCK`，**不写候选**、**不进队列**。
**负向对照**：把 identityVersion 从 dedupeKey 中移除的对照实现下，U2-2 必须失败（证明该断言能识别回归）。
**证据归档**：每个用例输出机器可读 `U2_EVIDENCE {...}` 行 + 原始 vitest/tsc 输出；
候选行、关联行、去重键与 `pg_dump --schema-only` 摘要一并落盘到 `tools/verification/self-repair/phase3a-u2-*`。

---

## 8. 代码写入 / 补丁 / 测试的隔离与审批边界（条件 ⑤）

- 候选补丁只在**受控候选分支**（本次为 `feat/si-rsi-internal-code-repair-v1`）产生，**永不直接落地**；
- 测试只在**隔离 PostgreSQL**（`127.0.0.1:55432`、库名 `crossclaim_p3r2_iso` 同级隔离库）执行，不接生产；
- 白名单外的路径（迁移、门禁、支付、外写、密钥）一律拒绝修改；
- 任何 U2 实施授权必须**单独送审**，不得由本设计裁决自动推导；U2 设计通过后**仅**授权其最小安全实施单元，
  **不得**据此自动启动 U3–U5。

---

## 9. 回滚方案

1. 新增候选行与关联行可整批删除（按 `dedupeKey` 前缀 `candidate:` 精确定位），不影响既有 incident/task；
2. schema 批次未 deploy 时可整体回退到 `9ee36837`（U1 封板）——U2 不修改任何既有文件字节；
3. 若身份版本判定异常，回滚只需停用服务层调用点（设计上该调用点**本就不在运行时装配内**）。

---

## 10. 未实施声明

本文件为**纯设计**：未新增任何产品代码、未新增表、未执行迁移、未接线运行时、未调用模型、
未生成任何候选或队列记录。`EXTERNAL_WRITE=HOLD`、`REAL_PROVIDER_EXECUTION=NOT_AUTHORIZED`、
`AUTO_MERGE=FORBIDDEN`、`AUTO_DEPLOY=FORBIDDEN`、`PRODUCTION_READY=NO`。
U1 封板锚点 `9ee36837` 保持不变。
