# PHASE 3-A · U2 设计 R2（候选记录与 Incident↔Candidate↔Task 关联）—— **仅设计，未实施**

> 授权来源：`MSG-20261009-25 = PASS / U1_FINAL_CLOSURE=YES` →
> `MSG-20261009-26 = REVISE` → `NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_R2_READ_ONLY_CHANGES_1_TO_4`。
> 本文件是 **U2 设计 R2** 送审材料（MSG-20261009-27），**不含任何产品代码改动**。

| 锚点 | 值 |
| --- | --- |
| U1 关闭锚点（封板代码，未被改动） | `9ee36837` |
| U2 设计 R1 | `065f950e`（同一路径 `docs/releases/SI-RSI-INTERNAL-CODE-REPAIR-V1-PHASE3A-U2-DESIGN.md`） |
| 本设计所在分支 | `feat/si-rsi-internal-code-repair-v1` |
| U2 实施授权 | **NO** · `SCHEMA_MIGRATION=HOLD` · `RUNTIME_WIRING/MODEL_CALL=FORBIDDEN` |
| 外部副作用 | `EXTERNAL_WRITE=HOLD` · `AUTO_MERGE/AUTO_DEPLOY=FORBIDDEN` · `PRODUCTION_READY=NO` |

## 0. R1 → R2 修订记录（逐条对应 MSG-20261009-26 的 CHANGE 1–4）

| 变更 | 原 R1 问题 | R2 处置 |
| --- | --- | --- |
| **CHANGE 1（P0）** | §2 引用 `Account.identityVersion`；未定义解析规则；未禁止信任调用方字符串 | §2 改为**已验证的 `PlatformAccount` 身份**：`organizationId + platform + externalAccountId + identityVersion`（schema `@@unique([organizationId, platform, externalAccountId, identityVersion])`；`identityVersion @default("v1")`，语义是**身份规范版本、不是凭据版本**，也不能证明授权仍有效）；契约只携带**服务端解析结果**，不接受调用方字符串；身份未解析 / 版本缺失 / 身份冲突 / 账户状态不可用 ⇒ **fail-closed**（§2、§6） |
| **CHANGE 2（P0）** | §6 要求把旧候选置 `INVALIDATED`，与 §4/§5「禁止 UPDATE 既有候选」自相矛盾；`AutonomyCandidate` 无失效事件模型 | §6 改为**逻辑失效（实时有效性判定）**：旧候选记录**保持不变**，在**重用或消费前**重新校验身份版本；不匹配则返回 `CANDIDATE_INVALIDATED`；**不写任何 status、不引入失效事件存储**；措辞明确为「实时判定」而非「数据库状态已更新」（§6） |
| **CHANGE 3（P1）** | §4 允许改 `AutonomyTask.incidentId`（与 §5 冲突）；`candidateDigest` 无契约；§9 允许批量删除 | §4/§5 统一为**只 INSERT**：**不得改写 `AutonomyTask.incidentId`**；缺失 Task ⇒ **`REJECTED`**（不新建可执行 Task）；`candidateDigest` 定义为**纯函数证据摘要**（§7.2，**不落库、不虚构字段**）；写入采用**事务原子 + 唯一冲突后校验复用**；§9 回滚改为**停用 U2 服务入口 + 保留历史**，**禁止批量删除**候选 |
| **CHANGE 4（P1）** | 验收矩阵缺并发/原子性/失效负向；`factsSnapshotRef`、`baselineRef` 可信性未定义 | §7.1 新增 **U2-7 ~ U2-10**（并发同键复用、同键不同关联拒绝、事务失败不留半成品、身份版本竞争）；§7.3 定义 `factsSnapshotRef`（来自 U1 只读适配器 + 有效期）与 `baselineRef`（来自可信基线解析，**调用方不得指定**） |

---

## 1. 功能定义

U2 = PHASE 3 设计文档 §13 表中的 **P3-04 前置**：为内部故障建立**候选记录**，并把
`Incident → Candidate → Task` 关联起来，使同一故障在重启/重放后**不重复**产生候选，
且**身份版本变化后旧候选立即失效**。

**范围（允许）**

1. 只读消费既有 `AutonomyIncident`（`kind='INTERNAL_FAULT'`、`status='DIAGNOSED'`）；
2. 生成/复用**候选记录（`AutonomyCandidate`）**，写入确定性 `dedupeKey`；
3. 维护 `Incident ↔ Candidate ↔ Task` 关联（**只读既有 Task，不建 Task、不改 Task**）；
4. **逻辑失效**规则（§6）；
5. 产出机器可读证据行（供审计复算）。

**非目标（禁止）**

- 不改既有队列语义（`CUSTOMER_GOAL_QUEUE` 的 `admit/claim/settle` 行为不变）；
- **不新增** 队列 / Scheduler / Controller / Runtime / 第二套容器；
- **不触发执行**：不 `claim`、不 `settle`、不重放、无任何外部副作用；
- **不新增 schema / migration**，不做生产迁移；
- **不 UPDATE / DELETE** 任何既有 `AutonomyIncident` / `AutonomyTask` / `AutonomyCandidate` / `AutonomyLease` 记录；
- 不修改 U1 已封板的可信事实契约（`TRUSTED_FACTS_ACTION_SCOPE_POLICY`、
  `AsyncLocalStorage` 只读事务隔离、只读边界与 fail-closed 语义**字节级不变**）；
- 不触碰 `main`、`release/rc-20261008-linux-deploy-v1`、Action Guard / 权限 / 支付 / 外写门禁代码。

---

## 2. 身份来源与输入输出契约（CHANGE 1 修订）

**身份唯一来源**：`PlatformAccount`（`organizationId + platform + externalAccountId + identityVersion`）。
`identityVersion` 是**外部账户身份规范（canonicalization scheme）版本**，**不是凭据版本**，
也**不能**证明授权仍然有效（授权仍须由既有链路在执行前重验）。

```ts
/** 由服务端可信路径解析出的身份快照；**不接受**调用方直接传入的字符串。 */
export interface ResolvedPlatformAccountIdentity {
  platformAccountId: string;
  organizationId: string;
  platform: string;              // Platform 枚举既有取值
  externalAccountId: string;
  identityVersion: string;       // PlatformAccount.identityVersion（默认 'v1'）
  resolvedAt: string;            // 可信库（Prisma 读）解析时间
  resolverVersion: string;
}

/** 只读输入：全部来自既有可信来源（Incident 行 + U1 适配器 + 身份解析器）。 */
export interface U2CandidateInput {
  incidentId: string;
  incidentDedupeKey: string;      // 既有约定 `incident:<signalKey>`
  taskDedupeKey: string;          // 既有约定 `task:<signalKey>`
  identity: ResolvedPlatformAccountIdentity;
  faultClass: string;
  faultDetectedAt: string;
  /** U1 只读适配器出具的缺陷事实快照引用（§7.3）。 */
  factsSnapshotRef: { ref: string; issuedAt: string; expiresAt: string; source: 'U1_TRUSTED_FACTS_ADAPTER' };
  /** 可信基线引用（§7.3）；**调用方不得指定**。 */
  baselineRef: string;
}

export interface U2CandidateDecision {
  outcome:
    | 'CANDIDATE_INSERTED'
    | 'CANDIDATE_REUSED'
    | 'CANDIDATE_INVALIDATED'    // 逻辑失效：实时判定，未修改数据库状态
    | 'REJECTED';
  reason: string;                // 稳定、可断言、可审计
  candidateId: string | null;
  candidateDedupeKey: string | null;
  candidateDigest: string | null; // 纯函数摘要，不落库（§7.2）
  identityVersionMatched: boolean;
  checks: readonly { id: string; ok: boolean }[];
  executionAuthorized: false;     // 显式：不是执行授权，不产生队列/执行副作用
}
```

**身份解析规则（fail-closed）**：按
`organizationId + platform + externalAccountId + identityVersion`
在既有唯一约束下解析；**任一**情形 ⇒ `REJECTED`：
① 身份未解析（无匹配 `PlatformAccount`）；② `identityVersion` 缺失/非字符串；
③ 同一键命中多条；④ 账户状态不是既有可用取值（取值以现有单源为准，实施时枚举）；
⑤ 调用方试图直接提供 `identityVersion` 或 `baselineRef`。

**确定性键规则（沿用既有约定，不发明第二套）**

- Incident `incident:<signalKey>`、Task `task:<signalKey>`（`rsi-task-generator.ts`）；
- Candidate `candidate:<signalKey>#<identityVersion>#<baselineRef>`；
  ID 由 `stableId('cand', candidateDedupeKey)`（sha256 前缀）派生 ⇒ 跨重启稳定；
- 唯一性由既有 `AutonomyCandidate.@@unique([dedupeKey])` 保证。

---

## 3. 调用关系（不新增任何运行时组件）

```
[既有] fault-incident-intake → AutonomyIncident(kind=INTERNAL_FAULT, status=DIAGNOSED)
        │
[既有] fault-triage-sweep ──► FaultTriageDecision（仅分类，不含执行）
        │
[既有] PlatformAccount 身份解析（Prisma 读）  ← 服务端可信路径
        │
[U2 新增·服务层] candidate-record-service（只读 Incident/Task/Identity + U1 事实）
        │   缺失 Task ⇒ REJECTED（**不新建 Task**）
        └─► 只 INSERT AutonomyCandidate；**不调用** admit() / claim() / settle()
```

1. U2 只落**服务层**，**不**接入 `rsi-run.ts` / `rsi-controller-continuation.ts` / `server.ts` 装配；
2. U2 **不调用** `admit()` / `claim()` / `settle()`；候选生成与进入执行保持**设计断路**；
3. `INTERNAL_FAULT` 与 `CUSTOMER_GOAL_QUEUE` 的结构隔离不变（执行器只信任 `CUSTOMER_GOAL_QUEUE`）。

---

## 4. 数据与权限矩阵（CHANGE 3 修订）

| 数据 | 读 | 写 | 说明 |
| --- | --- | --- | --- |
| `AutonomyIncident` | ✅ | ❌ | 仅消费 `kind=INTERNAL_FAULT`、`status=DIAGNOSED` |
| `AutonomyTask` | ✅ | ❌ | **只读关联**；**不得改写 `incidentId`**，**不新建 Task**；缺失 ⇒ `REJECTED` |
| `AutonomyCandidate` | ✅ | ✅ **仅 INSERT** | 新候选行；**不 UPDATE、不 DELETE**（含不写 `status`） |
| `AutonomyLease` | ❌ | ❌ | 属执行面，U2 恒不触碰 |
| `PlatformAccount` | ✅ | ❌ | 身份解析只读 |
| 客户租户业务表 / 凭据 / token | ❌ | ❌ | U2 不读取客户数据 |

---

## 5. 四项显式声明（CHANGE 3 措辞统一）

| 维度 | U2 声明 |
| --- | --- |
| 新增**持久化** | **是**：复用既有 `AutonomyCandidate`（平台级表，已含 `@@unique([dedupeKey])`）；**不新增表、不新增容器** |
| 数据库**写入** | **是（仅 INSERT 候选行）**：不 UPDATE 任何模型（**含不写 `AutonomyCandidate.status`**）、不 DELETE、不改迁移文件 |
| **Runtime 接线** | **否**：不接入 `rsi-run` / `rsi-controller` / `server.ts` |
| **模型调用** | **否**：不调用任何模型/Provider；事实来自 U1 只读适配器 |

**依赖前置**：既有 RSI 平台级 schema 批次**尚未 `migrate deploy`**（HOLD）。
U2 若要落库，须**先在隔离库**确认该批次可得并给出 `pg_dump --schema-only` 摘要证据；
**不新增 schema/migration**，生产迁移仍 HOLD。

---

## 6. 失效契约：逻辑失效（CHANGE 2 修订）

1. 候选 `dedupeKey` **包含** `identityVersion` 与 `baselineRef`；
2. **重用或消费前**必须重新解析当前身份（§2）并比对版本与基线；
3. 不匹配 ⇒ 返回 **`CANDIDATE_INVALIDATED`**，且**不修改任何既有记录**（旧候选原样保留）；
4. 明确措辞：这是一次**实时有效性判定**，**不宣称**数据库中旧候选的 `status` 已被更新；
5. 若将来确需**持久化失效事件**，必须**另行设计并审批存储结构**，不得在 U2 隐式引入；
6. 任何「授权在执行窗口内变化」的情形仍由既有 claim 授权重解析 + fenced settle 兜住；
   U2 **不得**把 `autoRecoverAuthorized` / 事实快照当作执行许可。

---

## 7. 验收矩阵 / 契约细节 / 负向对照 / 证据归档

### 7.1 确定性用例（CHANGE 4 修订，含 U2-7~U2-10）

| 用例 | 矩阵条目 | 断言（确定性） |
| --- | --- | --- |
| U2-1 同因重复 | A10 | 同 `signalKey` 两次 ⇒ 第二次 `CANDIDATE_REUSED`，候选行数不增加 |
| U2-2 身份版本变化 | A4 | 旧候选返回 `CANDIDATE_INVALIDATED`，**且旧行前后快照一致（未被修改）**；新键产生新候选 |
| U2-3 快照过期 | A5 | `factsSnapshotRef` 过期 ⇒ `REJECTED`，不写候选 |
| U2-4 关联完整性 | A3 | `Candidate.taskId → Task.incidentId → Incident.id` 链可枚举；`candidateDigest` 可复算 |
| U2-5 跨事务 | A9 | 跨事务/外部副作用 ⇒ `BLOCK`（`NOT_AUTHORIZED`），无候选产生 |
| U2-6 重启重放 | A6/A10 | 重启后同因不重复建候选；计数与去重键一致 |
| **U2-7 并发同键** | A10 | 两个并发事务写同一 `dedupeKey`：恰好 1 行 INSERT，另一事务经唯一冲突**校验后复用**（`CANDIDATE_REUSED`），无重复行 |
| **U2-8 同键不同关联** | A10/A4 | 同 `dedupeKey` 但 Task / `baselineRef` / `identityVersion` 不同 ⇒ **`REJECTED`**（拒绝而非复用） |
| **U2-9 事务回滚** | A3 | 注入写入失败 ⇒ 事务回滚后**无半成品关联**（候选计数与关联计数前后一致） |
| **U2-10 身份版本竞争** | A4 | 身份版本切换与候选创建并发 ⇒ 仅一个版本成功，另一个 `CANDIDATE_INVALIDATED` 或 `REJECTED`（fail-closed），无跨版本复用 |

### 7.2 `candidateDigest` 契约（CHANGE 3 修订）

`candidateDigest = sha256( canon({ signalKey, incidentId, taskId, baselineRef, identityVersion, factsSnapshotRef.ref, faultClass, faultDetectedAt }) )`

—— `canon` 为**确定性字段序 + 稳定序列化**（键序固定、无空白差异、时间用 ISO-8601 UTC）。
它是**证据摘要**，**不落库、不新增字段**；仅用于跨轮比对与证据行。

### 7.3 `factsSnapshotRef` 与 `baselineRef` 可信性（CHANGE 4 修订）

- `factsSnapshotRef`：**只能**由 U1 只读适配器签发（`source='U1_TRUSTED_FACTS_ADAPTER'`），
  必须带 `issuedAt` / `expiresAt`；超期或来源不符 ⇒ `REJECTED`；
- `baselineRef`：**只能**由可信基线解析得到（既有基线/封板锚点解析），**调用方不得指定**；
  解析失败 ⇒ `REJECTED`。

### 7.4 失败关闭 / 负向对照 / 证据归档

**失败关闭**：身份未解析/版本缺失/冲突/状态不可用、Incident 非 `DIAGNOSED`、Task 缺失、
快照过期或来源不符、基线不可解析、`dedupeKey` 被其他 kind 占用 ⇒ 一律 `REJECTED`/`BLOCK`。
**负向对照**：① 从 `dedupeKey` 移除 `identityVersion` 的对照实现下 **U2-2 与 U2-10 必须失败**；
② 把「唯一冲突后校验复用」改为「直接 INSERT」的对照实现下 **U2-7 必须失败**。
**证据归档**：`U2_EVIDENCE {...}` 行 + 原始 vitest/tsc 输出 + 候选/关联行前后快照 +
`pg_dump --schema-only` 摘要，落盘 `tools/verification/self-repair/phase3a-u2-*`。

---

## 8. 隔离与审批边界

- 候选补丁只在**受控候选分支**产生，**永不直接落地**；
- 测试只在**隔离 PostgreSQL**执行，不接生产；
- 白名单外路径（迁移、门禁、支付、外写、密钥）一律拒绝；
- 任何 U2 实施授权必须**单独送审**；U2 设计通过后**仅**授权其最小安全实施单元，
  **不得**据此自动启动 U3–U5。

---

## 9. 回滚方案（CHANGE 3 修订）

1. **停用 U2 服务入口**（该入口本就不在运行时装配内）；
2. **保留全部历史记录**（候选、关联、证据一律不删）；
3. **禁止批量删除**候选行——候选可能已被评估/推广/回滚记录引用（外键 `onDelete: Restrict`）；
4. 如确需清理，只能走**单独审批**的运维流程，不在 U2 范围内。

---

## 10. 未实施声明

本文件为**纯设计 R2**：未新增产品代码、未新增表、未执行迁移、未接线运行时、未调用模型、
未生成任何候选或队列记录。`EXTERNAL_WRITE=HOLD`、`REAL_PROVIDER_EXECUTION=NOT_AUTHORIZED`、
`AUTO_MERGE=FORBIDDEN`、`AUTO_DEPLOY=FORBIDDEN`、`PRODUCTION_READY=NO`。
U1 封板锚点 `9ee36837` 保持不变。
