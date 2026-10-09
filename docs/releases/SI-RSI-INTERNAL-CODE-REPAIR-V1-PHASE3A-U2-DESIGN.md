# PHASE 3-A · U2 设计 R8（候选记录与 Incident↔Candidate↔Task 关联）—— **仅设计，未实施**

> 授权来源：`MSG-20261009-25 = PASS / U1_FINAL_CLOSURE=YES` →
> `MSG-20261009-30 = PASS WITH REVISE` → `MSG-20261009-31 = REVISE` → `MSG-20261009-32 = REVISE`
> → `NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_R8_READ_ONLY_CHANGES_22_TO_25`。
> 本文件是 **U2 设计 R8** 送审材料（MSG-20261009-33），**不含任何产品代码改动**。
> **R8 的修订集中在 §16（OS 级写入隔离 / 锁生命周期 / 拒绝顺序 / 唯一运行模式）；
> §1–§15 保留历史；凡冲突者以 §16 为准。**

| 锚点 | 值 |
| --- | --- |
| U1 关闭锚点（封板代码，未被改动） | `9ee36837` |
| U2 设计 R1 | `065f950e` |
| U2 设计 R2 | `5ae09e37` |
| U2 设计 R3 | `ac94ef8e` |
| U2 设计 R4 | `378bfb2a` |
| U2 设计 R5 | `f115f881` |
| U2 设计 R6 | `a12a9f36` |
| U2 设计 R7 | `f6c6d677` |
| U2 设计 R8 | 本提交（同一个仓库路径 `docs/releases/SI-RSI-INTERNAL-CODE-REPAIR-V1-PHASE3A-U2-DESIGN.md`） |
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

---

## 11. R3 修订（对应 MSG-20261009-27 的 CHANGE 5–8）

> 本节是 R3 的正式修订内容。§1–§10 保留 R2 原文以维持历史；**凡与本节冲突的，一律以本节为准。**

### 11.1 R2 → R3 修订记录

| 变更 | R2 遗留问题 | R3 处置 |
| --- | --- | --- |
| **CHANGE 5（P0）** | `@@unique([organizationId, platform, externalAccountId, identityVersion])` **允许 v1/v2 并存**，R2 未定义「哪个版本当前有效」 | §11.2：禁止调用方传入、禁止 U2 自行挑选；只接受既有可信身份验证产物并按完整四元组解析；**歧义即拒绝**；版本解析与 INSERT 同事务；U2-10 断言切换后旧版本**不会被重新确认为有效** |
| **CHANGE 6（P0）** | `factsSnapshotRef.source` 只是声明，可伪造 | §11.3：U2 **自行调用 U1 只读适配器**取得事实，调用方 ref 视为不可信标签；校验 Incident/Task/作用域绑定、有效期、防重放；三类伪造负向验收；**不改 U1 契约、不引入新存储/密钥** |
| **CHANGE 7（P0）** | 候选键未证明租户隔离，`Incident→Candidate→Task` 是间接关系 | §11.4：新增显式 `scope`（PLATFORM / ACCOUNT）；候选键显式携带作用域；作用域不符 ⇒ `SCOPE_MISMATCH` **拒绝且不返回既有 candidateId**；复用前校验关联链；明确「signalKey 全局唯一 ≠ 租户隔离」 |
| **CHANGE 8（P1）** | U2-5 与 U2-7 冲突；U2-8 定义含混；digest 未规范化 | §11.5：U2-5 拆为三类（允许 U2 自身原子事务 / 禁止跨 U1 只读事务写 / 禁止未授权外部副作用）；U2-8 重定义为 `INPUT_KEY_MISMATCH`；`candidateDigest` 固定序列化/精度/NFC/测试向量；新增 U2-11..U2-13 |

### 11.2 CHANGE 5 —— 「当前有效身份版本」的可信选择规则（P0）

**已核实事实**：schema 中 `PlatformAccount` 的唯一键为
`@@unique([organizationId, platform, externalAccountId, identityVersion])`，
因此**同一账户可同时存在 v1 与 v2 两行**，该约束**不能**证明「哪个版本当前有效」。

R3 规则：

1. **不接受调用方版本**：`identityVersion` **不得**来自请求参数、消息体或模型输出；
2. **不自行挑选**：U2 **禁止**以「最新 `createdAt`」「最大版本号」等启发式选择当前版本；
3. **唯一可信来源**：只接受既有可信通道产物 —— `PlatformIdentityVerification`
   （`apps/api/src/services/connectors/platform-identity-verifier.ts`，
   `source ∈ { PROVIDER_OAUTH, PROVIDER_API, ADAPTER_MOCK }`，含 `evidenceRef` / `verifiedAt` / `identity.identityVersion`；
   `ADAPTER_MOCK` 仅限 dev/test），并按 **完整四元组** 解析 `PlatformAccount`；
4. **歧义即拒绝**：若同一 `(organizationId, platform, externalAccountId)` 存在 ≥2 行（不同版本）
   且无唯一可信裁决 ⇒ `REJECTED`，`reason='IDENTITY_VERSION_AMBIGUOUS'`；**不得任选一行**；
5. **并发一致性边界**：**身份解析与候选 INSERT 必须在同一 U2 数据库事务内**完成；
   INSERT 前在**同一事务内重新读取**身份行确认版本未变；版本在窗口内变化 ⇒ 回滚并 `REJECTED`；
6. **切换后不复归**：U2-10 必须断言「身份切换完成后，旧版本候选在**重用路径**上返回
   `CANDIDATE_INVALIDATED`」——即旧版本**不会被重新确认为有效**，而不仅是"两个候选不重复"。

### 11.3 CHANGE 6 —— 可信事实引用的不可伪造性（P0）

R2 的 `factsSnapshotRef`（含 `source='U1_TRUSTED_FACTS_ADAPTER'` 字符串）**只是来源声明**，任何调用者都能构造同结构 ⇒ R3 改为：

1. **U2 自行取得事实**：U2 服务在**服务端直接调用 U1 只读适配器**（依赖注入的 adapter 实例）取回事实；
   调用方传入的任何 ref 结构一律视为**不可信标签**，仅用于审计标注；
2. **绑定校验**：取回事实必须与本次输入一致 —— `incidentId`、`taskId`、作用域
   （PLATFORM 时无租户字段；ACCOUNT 时 `organizationId`/`platform`/`externalAccountId`）；不一致 ⇒ `REJECTED`；
3. **有效期**：以适配器返回的 `issuedAt` 与 U2 配置的 `maxAgeMs` 判定；超期 ⇒ `REJECTED`（**不做 TTL 延长**）；
4. **防重放**：同一 `(factsSnapshotRef, candidateDedupeKey)` 组合在**同一事务内**最多推进一次候选写入；
   重复消费不产生第二行（唯一约束 + 事务校验）；
5. **负向验收**（三类各自 `REJECTED`）：① 伪造 `source`；② 跨租户 / 跨 Incident 引用；③ 已过期引用；
6. **不改 U1 契约**：U1 封板文件与本设计**均不改动**；若将来需要「签名式引用」，
   **必须单独设计并审批**；R3 **不引入新存储、不引入密钥材料、不新增 Runtime/Scheduler/Controller**。

### 11.4 CHANGE 7 —— 作用域（租户隔离）与关联完整性（P0）

**R3 新增的仓库证据**：

- `RsiSignal.dedupeKey` 由 `apps/api/src/services/autonomy/rsi-observer.ts` 生成，
  形如 `CI_FAIL:<head>:<runId>`、`TYPECHECK_FAILURE:<summary>`、`TEST_FAILURE:<summary>`、`BACKLOG_STALL:<headNow>`
  ⇒ **纯平台级，不含租户/账户作用域**；
- 该批 RSI 表按 `schema.prisma` 注释为 **PLATFORM_LEVEL**（无 `organizationId`/`tenantId`/`customerId`）；
- `AutonomyCandidate.taskId → AutonomyTask.incidentId → AutonomyIncident.id` 为**间接关系**。

R3 规则：

1. **显式作用域**：`U2CandidateInput.scope` 改为判别联合
   `{ kind: 'PLATFORM' } | { kind: 'ACCOUNT'; identity: ResolvedPlatformAccountIdentity }`；
   `INTERNAL_FAULT` 的 RSI 信号一律 `PLATFORM`；**禁止**把 PLATFORM 候选当作租户作用域对象使用；
2. **候选键显式携带作用域**：
   `candidate:<scopeKind>:<scopeRef>#<identityVersion|NONE>#<baselineRef>`，
   PLATFORM ⇒ `scopeRef='platform'`、`identityVersion='NONE'`；ACCOUNT ⇒ `scopeRef=<organizationId>/<platform>/<externalAccountId>`；
3. **跨作用域冲突 = 拒绝**：同 `dedupeKey` 但作用域不同 ⇒ `REJECTED`，`reason='SCOPE_MISMATCH'`，
   **绝不返回既有 `candidateId`**；
4. **复用前校验关联链**：复用必须同时校验 `taskId`、`baselineRef`、（ACCOUNT 时）解析身份与 `Incident.kind`；
   任一不符 ⇒ `REJECTED`；
5. **明文声明**：**「signalKey 全局唯一」不等于租户隔离**；本设计的隔离性来自
   "平台级 / 账户级" 的**显式作用域区分**与第 3、4 条的拒绝规则。

### 11.5 CHANGE 8 —— 验收矩阵消歧与摘要规范化（P1）

**U2-5 重新定义（消除与 U2-7 的冲突）** —— 必须区分三类：

| 类别 | 允许性 | 断言 |
| --- | --- | --- |
| (a) U2 **自身**的独立原子数据库事务（单次 INSERT + 唯一冲突后校验复用） | **允许** | 正常路径成功 |
| (b) 跨越 **U1 只读事务边界**执行写入 | **禁止** | 断言 ⇒ `BLOCK` / `NOT_AUTHORIZED` |
| (c) 任何**未授权外部副作用** | **禁止** | 断言 ⇒ `BLOCK` / `NOT_AUTHORIZED` |

**U2-8 重新定义**：键内已含 `baselineRef`/`identityVersion`/`scopeRef`，故「同键但字段不同」不再是普通去重冲突，
应定义为 **`INPUT_KEY_MISMATCH`**（输入键与可信解析字段不一致，或恶意构造冲突）⇒ `REJECTED`，
并断言**未写入任何行**。

**`candidateDigest` 规范化（跨环境可独立复算）**：

```text
candidateDigest = sha256( "u2cd:v1\n" + canonicalJson(fields) )

fields（固定顺序）:
  scopeKind, scopeRef, identityVersion, baselineRef,
  incidentDedupeKey, taskDedupeKey, faultClass, faultDetectedAtUtc, factsDigest

canonicalJson:
  · 键序固定为上述顺序；无多余空白；NFC 规范化；UTF-8
  · 时间统一 UTC、毫秒精度、ISO-8601 形如 2026-10-09T05:00:00.000Z（输入精度高于毫秒时截断到毫秒）
  · 前缀 u2cd:v1 用于未来演进
```

**固定测试向量（R3 写入，实施时以单测锁定）**：

```text
scopeKind=PLATFORM
scopeRef=platform
identityVersion=NONE
baselineRef=refs/heads/main@<SEAL_COMMIT>
incidentDedupeKey=incident:CI_FAIL:h:1
taskDedupeKey=task:CI_FAIL:h:1
faultClass=DATABASE_TRANSACTION_ERROR
faultDetectedAtUtc=2026-10-09T05:00:00.000Z
factsDigest=<由 U2 自行取回的事实按同一规范化计算>
⇒ candidateDigest = <确定性常量，实施时填入并锁定>
```

**新增验收用例**：**U2-11**（U2-5 三类区分：(a) 通过 / (b)(c) `BLOCK`）、
**U2-12**（U2-8 `INPUT_KEY_MISMATCH` + 零写入）、
**U2-13**（digest 跨环境复算：同输入 ⇒ 同 digest；字段顺序/空白/时间精度变化 ⇒ 不同 digest）。

### 11.6 R3 未变部分

§1 功能与非目标、§3 调用关系（不新增 Runtime/Scheduler/Controller/Queue、不触发执行）、
§5 四项声明（持久化=复用既有 `AutonomyCandidate`；写入=**仅 INSERT**；Runtime 接线=否；模型调用=否）、
§8 隔离与审批边界、§9 回滚（停用入口 + 保留历史 + 禁止批量删除）、§10 未实施声明 —— **全部保持**；
U1 封板锚点 `9ee36837` 不变。

---

## 12. R4 修订（对应 MSG-20261009-28 的 CHANGE 9–12）

> 本节是 R4 的正式修订内容。§1–§11 保留以维持历史；**凡与本节冲突的，一律以本节为准。**

### 12.1 R3 → R4 修订记录

| 变更 | R3 遗留问题 | R4 处置 |
| --- | --- | --- |
| **CHANGE 9（P0）** | 候选键不含故障身份，两个不同 Incident 在同 scope/baseline 下碰撞 | §12.2：候选键升级为 **v2**，纳入由**已验证 Incident 行**派生的 `signalKey`，所有可变长字段用 **base64url** 无歧义编码；新增 U2-14 / U2-15 |
| **CHANGE 10（P0）** | 要求 U1 事实绑定 PLATFORM 故障，与 U1 实际契约不匹配 | §12.3：给出 U1 真实契约与**逐字段兼容性矩阵**；**解除 PLATFORM 路径的 U1 事实依赖**；携带 U1 字段 ⇒ `TRUSTED_FACTS_CONTRACT_UNSUPPORTED`；如需扩展 U1 契约须单独送审 |
| **CHANGE 11（P0）** | 身份版本「当前性」无可信裁决、`READ COMMITTED` 下二次读不足 | §12.4：**采用审计方允许的路径 —— ACCOUNT 作用域标记 `NOT_AUTHORIZED`，R4 只保留 PLATFORM 设计**；不新增身份管理表/迁移、不改 U1 契约；并写明未来解除条件 |
| **CHANGE 12（P1）** | 测试向量为占位符；U2-13 断言与规范化语义相反；`factsDigest` 规范缺失 | §12.5：给出**已由两种独立实现交叉复算**的固定向量；更正 U2-13 为规范化**等价性**断言；`factsDigest` 随 U1 依赖解除而移除 |

### 12.2 CHANGE 9 —— 候选键 v2（含故障身份 + 无歧义编码）

```text
candidate:v2:<scopeKind>:<b64url(scopeRef)>:<b64url(signalKey)>:<identityVersion|NONE>:<b64url(baselineRef)>
```

- `b64url` = RFC 4648 §5 base64url（字母表 `A-Za-z0-9-_`，**省略** `=` 填充）。
  该字母表**不含** `:`、`#`、`/`，因此字段间**不存在分隔符碰撞**；所有可变长字段一律经此编码（等价于无歧义编码/长度前缀）。
- `signalKey` **必须**取自**已读取并验证的 `AutonomyIncident` 行**：由该行 `dedupeKey` 去掉既有前缀得到
  （`incident:<signalKey>` → `<signalKey>`）。**不得**信任调用方自行提供的字符串；
  输入与 Incident 行不一致 ⇒ `REJECTED`，`reason='INPUT_KEY_MISMATCH'`。
- PLATFORM 时 `identityVersion` 固定为字面量 `NONE`（随 §12.4 的 ACCOUNT 不授权一并简化）。
- **新增验收**：**U2-14**（同一平台、同一 `baselineRef` 下两个**不同** Incident ⇒ 两个**不同**候选键、两行候选）；
  **U2-15**（同一 Incident 重放 ⇒ 仅一行候选，且复用前校验链通过）。

### 12.3 CHANGE 10 —— U1 真实契约与兼容性矩阵（并解除 PLATFORM 的 U1 依赖）

**R4 只读取证（`apps/api/src/services/self-repair/trusted-facts-adapter.ts`）**：

| U1 契约要素 | 实际值 |
| --- | --- |
| 调用方白名单 | `TRUSTED_FACTS_CALLERS = ['SERVER_REQUEST_GATE', 'RUNTIME_MEMBER']` |
| 作用域维度 | `TRUSTED_FACTS_SCOPE_DIMENSIONS = ['provider','platformAccountId','domain','jurisdiction']` |
| 动作策略 `internal.repair.propose` | required = `['platformAccountId','provider']`；optional = `['domain','jurisdiction']` |
| 返回 | `TrustedFactsResolution` / `TrustedFactsProvenance`（面向**客户动作授权**） |

**结论**：U1 事实面向**客户动作授权**（组织/账户/资源作用域），与**平台内部故障**
（`CI_FAIL:<head>:<runId>`、`TYPECHECK_FAILURE:<summary>`、`BACKLOG_STALL:<headNow>`，无租户/账户维度）
**不存在对应的 action type** ⇒ **不能**把组织授权事实解释为平台故障事实。

**逐字段兼容性矩阵（R4）**

| U1 输入/输出字段 | PLATFORM 内部故障 | ACCOUNT |
| --- | --- | --- |
| `caller`（白名单） | NOT_APPLICABLE（R4 解除依赖） | NOT_AUTHORIZED |
| `platformAccountId` / `provider` | NOT_APPLICABLE | NOT_AUTHORIZED |
| `domain` / `jurisdiction`（optional） | NOT_APPLICABLE | NOT_AUTHORIZED |
| `TrustedFactsResolution` / `TrustedFactsProvenance` | NOT_APPLICABLE | NOT_AUTHORIZED |
| `factsSnapshotRef` / `factsDigest` / `issuedAt` | **已移除**（R4 起 PLATFORM 不再要求） | NOT_AUTHORIZED |

**R4 处置**：

1. **解除 PLATFORM 路径的 U1 事实依赖**。PLATFORM 候选的可信输入仅限：
   (a) 已验证的 `AutonomyIncident` 行（`kind='INTERNAL_FAULT'`、`status='DIAGNOSED'`）；
   (b) 关联的 `AutonomyTask` 行；(c) `baselineRef`（来自可信基线解析）；(d) 用于校验的当前 `HEAD`；
2. 调用方若传入任何 U1 事实字段（`factsSnapshotRef`/`factsDigest`/`issuedAt`/组织身份）⇒
   `REJECTED`，`reason='TRUSTED_FACTS_CONTRACT_UNSUPPORTED'`（**不使用、不解释、不补齐**）；
3. **不**绕过 U1 的调用方白名单与作用域策略（本设计根本不再调用 U1）；
4. 若将来要为平台内部故障引入独立可信事实来源或扩展 U1 契约，**必须单独送审**；
   不得在 U2 实施中隐式修改封板代码。

### 12.4 CHANGE 11 —— 身份版本当前性：ACCOUNT 作用域标记 NOT_AUTHORIZED

**R4 只读取证（`apps/api/src/services/connectors/platform-identity-verifier.ts`）**：
`PlatformIdentityVerification` = `{ source; evidenceRef; verifiedAt; identity }`，且
`VerifiedPlatformIdentity.identityVersion` 为**可选**。该结构只证明**一次验证结果**，并不证明：
① 哪个版本当前有效；② 旧版本是否已撤销；③ 两次验证谁优先；④ 是否发生版本回退。
此外在 PostgreSQL `READ COMMITTED` 下，同一事务内**二次读取**并不能阻止另一事务在第二次读取**之后**提交版本变更。

**R4 决定（采用审计方明确允许的路径）**：

1. **ACCOUNT 作用域候选自 R4 起标记 `NOT_AUTHORIZED`**，U2 **只保留 PLATFORM 设计**；
   任何 ACCOUNT 输入 ⇒ `REJECTED`，`reason='SCOPE_NOT_AUTHORIZED'`；
2. **不新增**身份管理表、**不新增**迁移、**不改** U1 契约；
3. **未来解除条件（须单独送审）**：存在可信的「当前版本」裁决来源（含优先级与冲突拒绝规则），
   且具备「版本切换操作」与「候选 INSERT」共享的锁或串行化机制，并能给出覆盖
   「第二次读取之后、INSERT 提交之前」竞争窗口的并发时序证明；在具备该机制之前，ACCOUNT 保持 NOT_AUTHORIZED；
4. 该决定是**承认现有系统不具备该能力**，而不是假定其存在（与审计方要求一致）。

### 12.5 CHANGE 12 —— digest 契约与固定测试向量（两种独立实现交叉复算）

**字段集（R4，PLATFORM）**：`scopeKind, scopeRef, signalKey, baselineRef, faultClass, faultDetectedAtUtc`
（移除 `identityVersion` 与 `factsDigest`：前者随 ACCOUNT 一同不授权，后者随 U1 依赖解除而移除）。

```text
candidateDigest = sha256( utf8( "u2cd:v2" + "\n" + canonicalJson(fields) ) )

canonicalJson: 固定键序为上述字段顺序；紧凑输出（无多余空白）；NFC 规范化；UTF-8；
               字符串按 JSON 转义；时间统一 UTC 毫秒 ISO-8601（YYYY-MM-DDTHH:MM:SS.sssZ）
```

**规范化等价性断言（更正 R3 U2-13 的反向表述）**：

1. 输入对象**键序**变化 ⇒ 规范化后 **相同** digest；
2. 无意义**空白**差异 ⇒ **相同** digest；
3. 同一时刻的**等价时间表示**（如 `+00:00` 与 `Z`、或更高精度按规范截断到毫秒）⇒ **相同** digest；
4. **只有规范化后的语义字段发生变化** ⇒ 不同 digest。

**固定测试向量（已由两种独立实现交叉复算，结果一致）**：

```text
canon = {"scopeKind":"PLATFORM","scopeRef":"platform","signalKey":"CI_FAIL:abc:100","baselineRef":"refs/heads/main@9ee36837","faultClass":"DATABASE_TRANSACTION_ERROR","faultDetectedAtUtc":"2026-10-09T05:00:00.000Z"}
input = "u2cd:v2\n" + canon          （UTF-8，215 字节）
sha256 = fa8ed0617c3db797a9e4e8d85b7403c697b0352291ad846e4a6a79ac010db0b8

复算实现 ① Node.js : crypto.createHash('sha256').update(Buffer.from(input,'utf8')).digest('hex')
                    ⇒ fa8ed0617c3db797a9e4e8d85b7403c697b0352291ad846e4a6a79ac010db0b8
复算实现 ② .NET    : PowerShell Get-FileHash -Algorithm SHA256（对同一字节序列）
                    ⇒ fa8ed0617c3db797a9e4e8d85b7403c697b0352291ad846e4a6a79ac010db0b8
两种独立实现一致 ⇒ 该向量可作为独立复算基准
```

**验收用例调整**：**U2-13** 更正为 §12.5 的四条等价性断言；新增 **U2-14 / U2-15**（§12.2）；
**U2-16**（PLATFORM 输入携带 U1 事实字段 ⇒ `TRUSTED_FACTS_CONTRACT_UNSUPPORTED` 且**零写入**）；
**U2-17**（ACCOUNT 输入 ⇒ `SCOPE_NOT_AUTHORIZED` 且**零写入**）。

### 12.6 R4 未变部分与边界

未变：§1 范围与非目标、§3 调用关系（不新增 Runtime/Scheduler/Controller/Queue、不触发执行）、
§5 四项声明（**仅 INSERT**、无 UPDATE/DELETE、无 Runtime 接线、无模型调用）、§8 隔离与审批边界、
§9 回滚（停用入口 + 保留历史 + 禁止批量删除）、§10 未实施声明；
`SCHEMA_MIGRATION=HOLD`；U1 封板锚点 `9ee36837` **不变**。
本文件仍为**纯设计 R4**：未新增产品代码、未新增表、未执行迁移、未接线运行时、未调用模型。

---

## 13. R5 修订（对应 MSG-20261009-29 的 `REQUIRED_CHANGES = CHANGE 13–15`）

> 本节是 R5 的正式修订，也是**实施前的最终契约**。§1–§12 保留历史；**凡与本节冲突者以本节为准。**

### 13.1 最终输入输出契约（CHANGE 13，P1）

R5 起 **唯一有效**的接口只有下面两个（§2 的 `U2CandidateInput` / `U2CandidateDecision` 自本节点起**作废**，
仅作历史留存；不得据其实现）：

```ts
/** PLATFORM-only：U2 只处理平台级内部故障候选。 */
export interface U2PlatformCandidateInput {
  /** 由服务端从数据库读取的 Incident 主键；不得由调用方构造。 */
  incidentId: string;
  /** 请求标识：仅用于审计与幂等，不参与候选键。 */
  requestRef: string;
}

export interface U2CandidateDecision {
  outcome:
    | 'CANDIDATE_INSERTED'
    | 'CANDIDATE_REUSED'
    | 'REJECTED';
  /** 稳定、可断言、可审计的原因码（见 13.1.3 拒绝优先级）。 */
  reason: string;
  /** 仅在本调用写入或复用成功时非空；失败时恒为 null（不暴露其他候选/作用域信息）。 */
  candidateId: string | null;
  /** 证据摘要（§12.5 的 candidateDigest）；失败时为 null。 */
  candidateDigest: string | null;
  /** 恒为 false：本调用不是执行授权。 */
  executionAuthorized: false;
  checks: readonly { id: string; ok: boolean }[];
}
```

**13.1.1 权威读取路径（调用方不得提供这些字段）**

| 字段 | 权威来源 | 说明 |
| --- | --- | --- |
| `signalKey` | `AutonomyIncident` 行（按 `incidentId` 读取）的 `dedupeKey` 去掉 `incident:` 前缀 | 与输入不一致 ⇒ `INPUT_KEY_MISMATCH` |
| `taskDedupeKey` / 关联 | `AutonomyTask.incidentId === incidentId` 的真实外键链 | 缺失或不一致 ⇒ `TASK_LINK_INVALID` |
| `faultClass` | `AutonomyIncident.riskClass` 之外的故障类别取自既有 intake 落库字段（kind/`sourceRefs` 既有约定） | 读取失败 ⇒ `FAULT_CONTEXT_UNAVAILABLE` |
| `faultDetectedAtUtc` | `AutonomyIncident.detectedAt`（UTC，毫秒） | — |
| `scopeKind` / `scopeRef` | **服务端常量**：`PLATFORM` / `platform` | 任何 ACCOUNT 输入 ⇒ `SCOPE_NOT_AUTHORIZED` |
| `baselineRef` | 服务端可信解析（§13.3） | 解析失败 ⇒ `BASELINE_UNRESOLVABLE` |
| `builderRef` | **服务端常量字面量** `self-repair-u2-candidate-recorder@v1` | **不得**由调用方或模型填写；`AutonomyCandidate.builderRef` 为必填，INSERT 时必须写入该常量 |

**13.1.2 `AutonomyCandidate` INSERT 必填字段（由服务端填充）**

`taskId`（= 关联 `AutonomyTask.id`）、`dedupeKey`（§12.2 的 v2 键）、`baselineRef`（§13.3）、
`builderRef`（上述固定字面量）；其余列沿用 schema 默认值。**不写 `status`**（保持默认，不做 UPDATE）。

**13.1.3 拒绝优先级（自上而下，命中即返回，不继续后续检查）**

```text
1. SCOPE_NOT_AUTHORIZED            —— 出现 ACCOUNT 身份或任何非 PLATFORM 作用域输入
2. TRUSTED_FACTS_CONTRACT_UNSUPPORTED —— 出现 U1 事实字段（factsSnapshotRef/factsDigest/issuedAt/组织身份）
3. INPUT_KEY_MISMATCH              —— 调用方提供的 signalKey 等与 Incident 行不一致
4. INCIDENT_NOT_ELIGIBLE           —— Incident 不存在 / kind≠INTERNAL_FAULT / status≠DIAGNOSED
5. TASK_LINK_INVALID               —— 无关联 Task 或外键链不一致
6. FAULT_CONTEXT_UNAVAILABLE       —— 既有故障上下文字段读取失败
7. BASELINE_UNRESOLVABLE           —— baselineRef 无法可信解析
8. BASELINE_INVALID                —— 解析结果与当前 HEAD 不一致（§13.3）
```

**13.1.4 失败语义**：任何拒绝 ⇒ `candidateId=null`、`candidateDigest=null`、`executionAuthorized=false`，
**不返回**其他候选、其他作用域或数据库内部信息；`reason` 取上述稳定码。

### 13.2 最终验收矩阵（CHANGE 14，P1）

`ACTIVE` = R5 有效；`SUPERSEDED` = 语义已并入其他用例或前提消失；`NOT_AUTHORIZED` = 属未授权能力，不测。

| 用例 | 状态 | 说明 / 断言要点 |
| --- | --- | --- |
| U2-1 同因重复 | ACTIVE | 同 signalKey 第二次 ⇒ `CANDIDATE_REUSED`，行数不增 |
| U2-2 身份版本变化 | SUPERSEDED | 属 ACCOUNT 语义；改由 U2-18 的基线失效覆盖 |
| U2-3 快照过期 | SUPERSEDED | U1 事实依赖已解除（§12.3） |
| U2-4 关联完整性 | ACTIVE | 断言 `Candidate.taskId → Task.incidentId → Incident.id` **真实外键链**可枚举（不是字符串比较） |
| U2-5 三类区分 | ACTIVE | (a) U2 自身原子事务允许；(b) 跨 U1 只读事务写 ⇒ `BLOCK`；(c) 未授权外部副作用 ⇒ `BLOCK` |
| U2-6 重启重放 | ACTIVE | 同因不重复建候选 |
| U2-7 并发同键 | ACTIVE | 恰好 1 行 INSERT，另一事务唯一冲突后**完整验证**再复用 |
| U2-8 同键不同关联 | ACTIVE | ⇒ `INPUT_KEY_MISMATCH`（恶意冲突），**零写入** |
| U2-9 事务回滚 | ACTIVE | 注入失败 ⇒ 无半成品关联 |
| U2-10 身份版本竞争 | NOT_AUTHORIZED | ACCOUNT 不授权 |
| U2-11 三类区分（细化） | ACTIVE | 与 U2-5 合并断言 |
| U2-12 `INPUT_KEY_MISMATCH` | ACTIVE | 零写入 |
| U2-13 digest 等价性 | ACTIVE | 键序/空白/等价时间表示 ⇒ 同 digest；语义变化 ⇒ 不同 digest |
| U2-14 不同 Incident 不碰撞 | ACTIVE | 同平台同 baseline 两个不同 Incident ⇒ 两个不同键、两行 |
| U2-15 同 Incident 重放 | ACTIVE | 仅一行，复用前完整校验 |
| U2-16 U1 事实字段 | ACTIVE | ⇒ `TRUSTED_FACTS_CONTRACT_UNSUPPORTED`，零写入 |
| U2-17 ACCOUNT 输入 | ACTIVE | ⇒ `SCOPE_NOT_AUTHORIZED`，零写入 |
| **U2-18 基线失效（新）** | ACTIVE | `baselineRef` 与当前 HEAD 不一致 / 无法解析 ⇒ `BASELINE_INVALID` / `BASELINE_UNRESOLVABLE`，**不得降级接受旧候选**，零写入 |

**补充断言（CHANGE 14 明确要求）**：① Task 与 Incident 必须**真实外键链**一致；② 读取到不一致的
Task/Incident/候选关联 ⇒ 拒绝，且**不返回其他作用域的候选 ID**；③ 同键唯一冲突**只能在完整验证既有行后复用**，
**不得**把任何数据库异常解释为成功重放。

### 13.3 PLATFORM 基线可信性（CHANGE 15，P1）

**13.3.1 `baselineRef` 的可信解析接口与来源**

- 形态：`refs/heads/<branch>@<commit40>`（例如 `refs/heads/main@9ee36837…`）。
- **唯一可信来源**：服务端 git 只读解析（既有仓库只读能力），**不接受**调用方传入；
  解析产物 = `{ branchRef, commit, resolvedAt }`，其中 `commit` 必须由本地仓库对象数据库实际解析得到。
- **固定审核基线**：U1 封板锚点 `9ee36837`（PENDING 时改为任务记录中登记的基线 commit）；
  解析结果必须与登记的固定基线 **一致**。

**13.3.2 与当前 HEAD 的比较规则**

1. `baselineRef` 解析出的 `commit` 必须等于**登记的固定审核基线**；
2. 该基线必须等于**候选写入时刻仓库的当前 HEAD**（同一只读解析调用内取得，避免 TOCTOU）；
3. 比较失败 ⇒ 拒绝，`reason='BASELINE_INVALID'`；解析失败 ⇒ `reason='BASELINE_UNRESOLVABLE'`；
4. **不允许**在基线检查失败时降级为「继续复用旧候选」或「沿用上一次解析结果」；
5. 基线失效不影响既有历史行（只读保留，不做 UPDATE/DELETE）。

**13.3.3 负向验收**：HEAD 不一致、`refs/heads/<branch>` 不存在、commit 无法解析、
解析期间 HEAD 变化四类，各自断言拒绝且**零写入**，并在证据行中记录
`{ reason, baselineCommitResolved, headAtResolve, resolvedAt }`（不含任何凭据或敏感数据）。

### 13.4 R5 未变部分与边界（重申）

仅 INSERT；无 UPDATE/DELETE；不新增 schema/migration；不接入 Runtime/Queue；不调用模型/Provider；
不新增第二套 Runtime/Scheduler/Controller；回滚＝停用入口 + 保留历史；
`SCHEMA_MIGRATION=HOLD`；U1 封板 `9ee36837` 不变；`ACCOUNT` 保持 `NOT_AUTHORIZED`；
`EXTERNAL_WRITE=HOLD`、`AUTO_MERGE/AUTO_DEPLOY=FORBIDDEN`、`PRODUCTION_READY=NO`。
本文件仍为**纯设计 R5**：未新增产品代码、未建表、未执行迁移、未接线运行时、未调用模型。

---

## 14. R6 修订（对应 MSG-20261009-30 的 CHANGE 16–18）

> 本节覆盖 §13.1（输入契约）与 §13.3（基线可信性）中与本节冲突的表述。

### 14.1 CHANGE 16（P0）—— 审计锚点 vs 运行基线（消除 §13.3 的自相矛盾）

**问题（审计方指出，R6 承认）**：§13.3 同时要求「固定基线 = `9ee36837`」与「基线 = 候选写入时刻的当前 HEAD」，
但本分支 HEAD 为 `f115f881` ⇒ 按字面实现**所有候选都会被 `BASELINE_INVALID` 拒绝**，正常 INSERT 路径不可用。

**R6 定义（两个概念彻底分离，不得混用）**

| 概念 | 定义 | 是否参与门禁 |
| --- | --- | --- |
| **审计锚点** `auditAnchor` | U1 封板提交 `9ee36837` | **否**。仅作为溯源标签写入证据行（`u1SealRef`），**不**参与候选写入的通过/拒绝判定 |
| **运行基线** `baselineRef` | `refs/heads/<branch>@<commit40>`，其中 `commit40` **必须等于**运行时刻 `git rev-parse HEAD`，且 `git status --porcelain` 必须为空 | **是**。候选写入的门禁对象 |

**两种运行模式（仅此两种）**

1. **`SELF_CONSISTENT_HEAD`（默认，无需额外授权）**：`baselineRef` 的分支与 commit 必须与
   运行时刻的 HEAD **自洽**（`refs/heads/<currentBranch>@<currentHead>`），且工作树干净。
   `auditAnchor` 与 `baselineRef` **允许不同**（这正是当前分支的实际情况）。
2. **`AUTHORIZED_FIXED_BASELINE`（需单独审批）**：由操作方配置一个**冻结基线**常量；
   此时要求 `HEAD == 冻结基线`，否则 `BASELINE_INVALID`。该模式**不因本设计而自动开启**。

**其他规则**

- **不得**以历史候选的 `baselineRef`、上一次成功解析结果或任意旧 commit 代替当前基线；
- `PENDING` 之类的动态表述**不得**被解释为已开放新的基线选择权限（R6 明确：`AUTHORIZED_FIXED_BASELINE`
  的启用需要**独立审批**，不在本次授权内）；
- 无可靠基线（HEAD 不可解析、工作树不干净、分支不可解析）⇒ 一律 `BASELINE_UNRESOLVABLE` / `BASELINE_INVALID`，
  **零写入**。

### 14.2 CHANGE 17（P1）—— 运行时严格白名单（不只依赖 TypeScript 静态类型）

**输入契约（运行时判定，§13.1 的接口形状不变）**

1. 入参必须是对象，且**键集合严格等于** `{ incidentId, requestRef }`；
2. 出现**任何**额外键（含 `signalKey`、`identity`、`platformAccountId`、`factsSnapshotRef`、
   `factsDigest`、`issuedAt`、`scope`、`baselineRef`，以及任何未知键）⇒ **拒绝**，
   **禁止静默忽略后继续 INSERT**；
3. 类型与取值校验：`incidentId`、`requestRef` 必须为非空字符串；
4. `incidentId` 的可信来源：U2 仅由**内部服务端组合**调用（隔离测试装配或服务端请求门），
   **不对外暴露 API**；调用方不得自行编造 `incidentId`（无法在库中解析 ⇒ 拒绝）；
5. **确定性失败行为**：非法字段类型 ⇒ `INVALID_FIELD_TYPE`；缺失 `requestRef` ⇒ `MISSING_REQUEST_REF`；
   `incidentId` 不存在/不可解析 ⇒ `INCIDENT_NOT_ELIGIBLE`；以上均 `candidateId=null`、零写入。

**R6 拒绝优先级（取代 §13.1.4 的列表）**

```text
1. EXTRA_FIELD_SCOPE              —— 出现 ACCOUNT 作用域字段（scope/identity/platformAccountId）
2. EXTRA_FIELD_TRUSTED_FACTS      —— 出现 U1 事实字段（factsSnapshotRef/factsDigest/issuedAt）
3. EXTRA_FIELD_KEY_OR_UNKNOWN     —— 出现 signalKey/baselineRef 或任何未知键
4. INVALID_FIELD_TYPE / MISSING_REQUEST_REF —— 类型或必填校验失败
5. INPUT_KEY_MISMATCH             —— 调用方与 Incident 行不一致（保留）
6. INCIDENT_NOT_ELIGIBLE          —— Incident 不存在 / kind≠INTERNAL_FAULT / status≠DIAGNOSED
7. TASK_LINK_INVALID              —— 无关联 Task 或外键链不一致
8. FAULT_CONTEXT_UNAVAILABLE      —— 既有故障上下文字段读取失败
9. BASELINE_UNRESOLVABLE          —— 基线不可解析
10. BASELINE_INVALID              —— 基线与 HEAD 不自洽（或 AUTHORIZED 模式下与冻结基线不符）
```

**测试**：**U2-19** 多种违规字段同时出现 ⇒ 只返回**最高优先级**的单一 reason，且**零写入**。

### 14.3 CHANGE 18（P1）—— Git 基线读取与数据库写入的时序边界（TOCTOU）

**承认**：同一次只读解析**不足以**保证「Git 检查结束 → 数据库事务提交」之间 HEAD 不变。

**R6 执行顺序（强制）**

```text
(1) Git 解析①：ref → commit；git rev-parse HEAD；git status --porcelain（须为空）
(2) 开启 U2 数据库事务
(3) Git 解析②（事务内）：再次读取 HEAD 与工作树状态
(4) 读取 Incident / Task 并完成 §14.2 的校验
(5) INSERT 候选行（唯一冲突 ⇒ 完整验证后复用）
(6) Git 解析③：**提交前**最后一次读取 HEAD 与工作树状态
(7) 若 (1)(3)(6) 任一不一致，或工作树在任一步不为空 ⇒ ROLLBACK，
    reason='BASELINE_CHANGED_DURING_WRITE'，**零候选写入**
(8) 一致 ⇒ COMMIT
```

**边界声明（不得含糊）**

- U2 **无法**在 Git 与数据库之间建立跨系统事务；因此采用**三次检查 + 提交前复核**，
  并在**任何**不一致时 fail-closed；若运行环境本身无法保证写入窗口内的仓库稳定
  （例如存在并发写入者），则**必须拒绝写入**，不得把一次历史读取视为持续有效的授权；
- **不得**通过新增第二套 Runtime / Scheduler / Controller 解决本问题（本设计不引入任何此类组件）；
- 允许的**部署前置**（属运维约定，不是新组件）：U2 隔离测试/运行窗口内**无并发 Git 写入**。

**测试**：**U2-18(c)** 增加「Git 验证完成后、数据库写入前 HEAD 变化」负向用例 ⇒
`BASELINE_CHANGED_DURING_WRITE` 且**零写入**（配合 U2-18(a) HEAD 不一致、(b) 分支/commit 不可解析）。

### 14.4 R6 未变部分

§12（候选键 v2 / digest）、§13.1 的接口形状（`U2PlatformCandidateInput{incidentId,requestRef}` /
`U2CandidateDecision`）、§13.2 的矩阵（U2-1…U2-18 状态不变，另加 U2-19）、
`builderRef` 固定常量、仅 INSERT、无 UPDATE/DELETE、不新增 schema/migration、不接 Runtime/Queue、
不调用模型/Provider、不新增第二套 Runtime/Scheduler/Controller、ACCOUNT 保持 `NOT_AUTHORIZED`、
U1 封板 `9ee36837` 不变、`SCHEMA_MIGRATION=HOLD`、`EXTERNAL_WRITE=HOLD`、
`AUTO_MERGE/AUTO_DEPLOY=FORBIDDEN`、`PRODUCTION_READY=NO`。
本文件仍为**纯设计 R6**：未新增产品代码、未建表、未执行迁移、未接线运行时、未调用模型。

---

## 15. R7 修订（对应 MSG-20261009-31 的 CHANGE 19–21）

### 15.1 CHANGE 19（P0）—— Git 写入窗口的**技术性**排他保证

**承认审计方的判断**：三次 Git 检查**只在「排他成立」时才是有效防线**；检查③到 `COMMIT` 之间的窗口
必须由**技术门禁**覆盖，而不能只写「存在并发写入者就必须拒绝」这种运维约定。

**R7 的唯一运行模式：`CONTROLLED_FIXED_WORKTREE`（受控、固定提交的隔离工作树）**

1. **运行位置**：U2 只在**受控、固定提交的隔离工作树**（`git worktree`/独立 clone 的固定 commit）内运行；
   **禁止**自动跟随可变远程分支（运行期不执行 `git fetch` / `git pull` / `git checkout`）。
2. **排他锁（技术门禁，非新组件）**：进入流程的**第一步**（**早于**首次 Git 校验）尝试对工作树内
   锁文件 `.u2-exclusive.lock` 取得**独占创建**（`O_CREAT|O_EXCL`），写入 `{ownerToken, pid, acquiredAt, ttlMs}`：
   - 取锁失败（已存在且未过期 / 归属他人）⇒ `REJECTED`，`reason='EXCLUSIVE_WINDOW_UNAVAILABLE'`，**零写入**；
   - 锁**全程持有**：自首次 Git 校验**之前**开始，直到**数据库提交完成后**（或回滚完成后）释放；
   - 锁文件位于隔离工作树内，**不参与 schema、不建表**（属运行期文件，不随候选写入）。
3. **三次 Git 检查（保留，但只作为完整性复核）**：①取锁后、②事务内、③`COMMIT` 前；
   每次记录 `{check, head, branchRef, worktreeClean, refsDigest, at}`，其中 `refsDigest = sha256(canon(git for-each-ref 的排序输出))`；
   任一次与首次不一致，或 `worktreeClean=false` ⇒ 回滚，`BASELINE_CHANGED_DURING_WRITE`，**零写入**。
4. **若无法建立排他**（例如无法创建锁文件、工作树不可控、存在外部写入者）⇒ **直接拒绝**，零写入。
5. **不得**为此新增第二套 Runtime / Scheduler / Controller：锁与检查都在 U2 服务调用内部完成。

**U2-20（负向）**：在检查③之后、`COMMIT` 之前由**对抗进程**尝试修改 `HEAD`（或写入工作树）：
断言**候选行数为 0** 且返回稳定拒绝码（`EXCLUSIVE_WINDOW_UNAVAILABLE` 或 `BASELINE_CHANGED_DURING_WRITE`）——
即排他锁使对抗写入无法取得同一窗口，或事务在发现不一致时拒绝。

### 15.2 CHANGE 20（P1）—— 拒绝原因码与校验顺序（唯一、确定）

**每一级只对应一个 reason；自上而下命中即返回，绝不并列。**

| 级别 | reason | 触发定义（精确定义） |
| --- | --- | --- |
| L1 | `TOP_LEVEL_INPUT_INVALID` | 顶层不是普通对象（`null`/`undefined`/数组/原始值/类实例） |
| L2 | `EXTRA_FIELD_SCOPE` | 出现作用域类额外键（`scope`/`identity`/`platformAccountId`） |
| L3 | `EXTRA_FIELD_TRUSTED_FACTS` | 出现 U1 事实类额外键（`factsSnapshotRef`/`factsDigest`/`issuedAt`） |
| L4 | `EXTRA_FIELD_KEY_OR_UNKNOWN` | 出现 `signalKey`/`baselineRef` 或任何未知键 |
| L5 | `MISSING_INCIDENT_ID` | `incidentId` 缺失（键不存在或为 `undefined`） |
| L6 | `MISSING_REQUEST_REF` | `requestRef` 缺失（键不存在或为 `undefined`）——**优先于类型/空串检查** |
| L7 | `INVALID_FIELD_TYPE` | 字段存在且非 `null`，但类型不是 `string` |
| L8 | `EMPTY_STRING_FIELD` | 字段为 `null` 或空字符串 |
| L9 | `EXCLUSIVE_WINDOW_UNAVAILABLE` | 无法取得 §15.1 的排他锁 |
| L10 | `INPUT_KEY_MISMATCH` | **数据库中已存在的候选**与本次**重新计算的权威身份**（候选键、关联 `Task`/`Incident`、`baselineRef`、`builderRef`、摘要）不一致 |
| L11 | `INCIDENT_NOT_ELIGIBLE` | Incident 不存在 / `kind≠INTERNAL_FAULT` / `status≠DIAGNOSED` |
| L12 | `TASK_LINK_INVALID` | 无关联 Task 或外键链不一致 |
| L13 | `FAULT_CONTEXT_UNAVAILABLE` | 既有故障上下文字段读取失败 |
| L14 | `BASELINE_UNRESOLVABLE` | 基线不可解析 |
| L15 | `BASELINE_INVALID` | 基线与 HEAD 不自洽（或 `AUTHORIZED_FIXED_BASELINE` 模式下与冻结基线不符） |
| L16 | `BASELINE_CHANGED_DURING_WRITE` | 三次检查之间 / 提交前发现 HEAD 或 refsDigest 变化 |

**补充规则**

- 非法顶层输入**不得**抛运行时异常，也**不得**产生任何写入（L1 返回结构化拒绝）；
- 多违规并存 ⇒ 只返回**最高优先级**的单一 reason（U2-19）；
- **复用契约**：唯一冲突命中既有行时，必须逐项校验 `dedupeKey`（重算）、`taskId`、`Task.incidentId`、
  `baselineRef`、`builderRef` 与权威值一致；**任何不匹配 ⇒ L10 `INPUT_KEY_MISMATCH`，且不得返回既有 `candidateId`**；
- `INPUT_KEY_MISMATCH` 语义按审计方要求更正（调用方已无法合法提供 `signalKey`）；
- 保留 §13.1 的接口结构，不新增字段。

### 15.3 CHANGE 21（P1）—— 提交证据与变更声明更正

1. **变更记录更正**：`f115f881 → a12a9f36` 实为**两个提交、三个文件**（设计文档、checkpoint、
   `AI-ARCHITECT-INBOX.md`）。本设计今后**不再**用「只改一个文件」这类不精确表述；
   声明统一写作：「产品代码零变更」+「本轮变更文件清单以 `git diff --name-only` 为准」。
   R7 的变更文件清单亦按此口径在送审正文中逐条列出（由 `git diff --name-only` 生成）。
2. **`u1SealRef` 写入位置（不新增 schema）**：仅写入**既有合法证据位置** ——
   与 U1 同构的机器可读证据行 `U2_EVIDENCE {...}`（操作输出）以及既有证据目录
   `tools/verification/self-repair/phase3a-u2-*` 的文本/JSON 工件；**不建表、不加列、不改迁移**。
3. **三次 Git 检查的最小审计记录**：
   `{check: 1|2|3, head, branchRef, worktreeClean, refsDigest, at}`；不一致时追加
   `{reason, rollback: true, candidateRowsWritten: 0}`。
4. **指纹口径分离**：
   - 文档 **SHA-256**（对设计文档字节）：在审计方完成独立字节复算前，**始终**标记
     `U2_DESIGN_DOC_SHA256_VERIFICATION = NOT_INDEPENDENTLY_VERIFIED`；
   - **Git blob SHA**（`git rev-parse <commit>:<path>`）：与文档 SHA-256 **分别记录**，**不得混用**。

### 15.4 R7 未变部分

§12 候选键 v2 与 digest、§13.1 接口结构、§13.2 矩阵（U2-1…U2-19 状态不变，另加 U2-20）、
§14.1 的 `auditAnchor` / `baselineRef` 分离与两种运行模式、`builderRef` 固定常量、
仅 INSERT、无 UPDATE/DELETE、不新增 schema/migration、不接 Runtime/Queue、不调用模型/Provider、
ACCOUNT 保持 `NOT_AUTHORIZED`、U1 封板 `9ee36837` 不变、`SCHEMA_MIGRATION=HOLD`、
`EXTERNAL_WRITE=HOLD`、`AUTO_MERGE/AUTO_DEPLOY=FORBIDDEN`、`PRODUCTION_READY=NO`。
本文件仍为**纯设计 R7**：未新增产品代码、未建表、未执行迁移、未接线运行时、未调用模型。

---

## 16. R8 修订（对应 MSG-20261009-32 的 CHANGE 22–25）

### 16.1 CHANGE 22（P0）—— 从「协作锁」升级为「操作系统级写入隔离」

**承认审计方判断**：`O_CREAT|O_EXCL` 锁只提供**协作式互斥**，对**不遵守该协议的进程**毫无约束力；
它**不能**作为「受保护 Git 基线不被外部修改」的证明。

**R8 设计：隔离前置条件（attested precondition）+ 协作锁降级为辅助**

1. **唯一执行环境**：`CONTROLLED_FIXED_WORKTREE` = 由**独立受限权限**的隔离工作树承担：
   - 目录与 `.git`（含 `refs/`）归属**专用运行账户**，**其他主体无写权限**（以文件系统 ACL/所有权实现，
     使用**既有**基础设施，**不新增 Runtime / Scheduler / Controller**）；
   - 运行期禁止 `git fetch` / `git pull` / `git checkout`，不跟随可变远程分支。
2. **隔离证明（必须由运行环境提供，U2 不自我宣称）**：U2 进程**无法自证** OS 隔离，因此引入
   **隔离前置条件** `ISOLATION_ATTESTED`，由运行侧编排（既有运维脚本/CI 步骤）产出并随调用传入：
   ```ts
   interface IsolationAttestation {
     worktreePath: string;          // 受控工作树绝对路径
     ownerAccount: string;          // 专用运行账户
     aclEvidenceRef: string;        // ACL/所有权检查证据引用（只读命令输出）
     writeDeniedProbeRef: string;   // 「非属主写入被拒绝」探针证据引用
     issuedAt: string;              // 时间戳（UTC 毫秒）
     maxAgeMs: number;              // 证据有效期上限（由调用方配置，U2 只做判定）
   }
   ```
   判定规则：**缺失 / 过期 / `worktreePath` 与当前运行路径不一致** ⇒ `EXCLUSIVE_WINDOW_UNAVAILABLE`，
   **零写入**（不进入后续任何检查）。
3. **`.u2-exclusive.lock` 保留但降级**：仅用于**协作式**互斥（同一运行账户下的多进程防重入），
   **文档明确标注「非安全关键」**；安全性由第 1、2 条承担。
4. **U2-20（改写）**：在检查③之后、`COMMIT` 之前由**不遵守锁协议的**对抗进程尝试
   `git reset` / 修改 `refs` / 写入工作树：
   - 断言 ①对抗写入**被操作系统权限拒绝**（或对受保护路径不可写）；②**候选行零新增**；
     ③**无 candidate ID 泄露**（返回体只有结构化 reason）；
   - **不得**以「对抗进程主动遵守 `.u2-exclusive.lock`」充当证明。

### 16.2 CHANGE 23（P0）—— 锁文件生命周期 vs 工作树洁净性

**承认冲突**：锁文件若位于工作树内且未被跟踪，`git status --porcelain` 立即变脏 ⇒ 正常 INSERT 会被全部拒绝。

**R8 设计**

1. **锁文件移出工作树**：`<worktreePath>.u2-lock`（工作树的**同级兄弟路径**，不在仓库目录内）。
   因此 `git status --porcelain` **不受锁影响**，产品代码洁净性检查保持原语义。
2. **禁止**为绕过该问题而忽略整个目录或扩大 `.gitignore` 范围（**不得**掩盖产品文件变更）。
3. **锁语义（无 TTL 自动接管）**：
   - 获取：`O_CREAT|O_EXCL` 创建并写入 `{ownerToken, pid, account, startedAt}`；
   - **TTL 仅作诊断标注，绝不作为删除依据**：即使 `startedAt` 很旧，也**不自动删除**锁；
   - 释放：仅**属主**可释放，释放前必须校验 `ownerToken` 一致；校验不符 ⇒ 不删除（fail-closed）并报
     `EXCLUSIVE_WINDOW_UNAVAILABLE`；
   - 崩溃恢复：进程异常退出后锁**保持存在**；恢复只能由**显式人工/编排步骤**（在确认旧持有者已终止后）
     执行删除；U2 自身**永不**自动清除不明归属的锁；
   - 锁损坏（内容不可解析）、归属不明、旧持有者存活状态不可判定 ⇒ 一律 `EXCLUSIVE_WINDOW_UNAVAILABLE`，零写入。
4. **锁持有/释放状态表**

| 阶段 | 动作 | 失败处置 |
| --- | --- | --- |
| T0 前置 | 校验 `ISOLATION_ATTESTED` | 缺失/过期/路径不符 ⇒ `EXCLUSIVE_WINDOW_UNAVAILABLE` |
| T1 获取锁 | `<worktreePath>.u2-lock` 独占创建 | 已存在/损坏/归属不明 ⇒ `EXCLUSIVE_WINDOW_UNAVAILABLE`（不删除、不接管） |
| T2 持有 | Git①②③ + 事务 + INSERT | 任一步异常 ⇒ 回滚 + 释放（校验 ownerToken） |
| T3 提交后 | 释放锁（校验 ownerToken） | ownerToken 不符 ⇒ 不释放并告警（fail-closed） |
| T4 崩溃恢复 | **人工/编排**确认旧持有者终止后删除 | U2 不自动接管 |

5. **新增 U2-21（负向验收）**：锁不存在时正常路径；锁已存在（活跃/陈旧/损坏/属主不明）四类分别
   `EXCLUSIVE_WINDOW_UNAVAILABLE` 且零写入；TTL 过期**不触发**任何接管；释放时 ownerToken 不符
   **不删除**锁；同时断言 `git status --porcelain` 在锁存在期间仍为**干净**。

### 16.3 CHANGE 24（P1）—— 「执行顺序—reason—数据库副作用」对应表

**执行顺序（与代码顺序一致；每步失败即返回唯一 reason）**

| # | 步骤 | 失败 reason | 数据库副作用 |
| --- | --- | --- | --- |
| 1 | 顶层输入形态判定（普通对象；symbol 键/访问器属性/代理对象 → 拒绝） | `TOP_LEVEL_INPUT_INVALID` | 无 |
| 2 | 严格白名单键集合（作用域类额外键） | `EXTRA_FIELD_SCOPE` | 无 |
| 3 | 严格白名单键集合（U1 事实类额外键） | `EXTRA_FIELD_TRUSTED_FACTS` | 无 |
| 4 | 严格白名单键集合（`signalKey`/`baselineRef`/未知键） | `EXTRA_FIELD_KEY_OR_UNKNOWN` | 无 |
| 5 | `incidentId` 缺失 | `MISSING_INCIDENT_ID` | 无 |
| 6 | `requestRef` 缺失 | `MISSING_REQUEST_REF` | 无 |
| 7 | 字段类型非 `string` | `INVALID_FIELD_TYPE` | 无 |
| 8 | 字段为 `null` / 空字符串 | `EMPTY_STRING_FIELD` | 无 |
| 9 | 隔离前置条件与协作锁 | `EXCLUSIVE_WINDOW_UNAVAILABLE` | 无 |
| 10 | Git 解析①并建立 `baselineRef` | `BASELINE_UNRESOLVABLE` / `BASELINE_INVALID` | 无 |
| 11 | 读 `Incident`（kind/status/linkage） | `INCIDENT_NOT_ELIGIBLE` | 无（只读） |
| 12 | 读关联 `Task` 与真实外键链 | `TASK_LINK_INVALID` | 无（只读） |
| 13 | 读故障上下文（`faultClass` / `detectedAt`） | `FAULT_CONTEXT_UNAVAILABLE` | 无（只读） |
| 14 | 构造**权威身份**（候选键 v2 + `candidateDigest` + 关联四元组） | （构造阶段不产出 reason，失败按 10–13） | 无 |
| 15 | 开启事务；Git 解析②复核 | `BASELINE_CHANGED_DURING_WRITE` | 回滚 |
| 16 | 查询既有候选并**逐项**比对权威身份 | `INPUT_KEY_MISMATCH` | 回滚（不返回既有 `candidateId`） |
| 17 | INSERT（唯一冲突 ⇒ 仅当 16 全部一致时复用） | `INPUT_KEY_MISMATCH`（不一致） | 复用或新增 |
| 18 | Git 解析③（提交前复核） | `BASELINE_CHANGED_DURING_WRITE` | 回滚 |
| 19 | COMMIT | （异常 ⇒ 回滚） | 提交或零写入 |

> **L10 位置更正**：`INPUT_KEY_MISMATCH` 现在位于**权威身份构造之后**（第 16 步），
> 不再出现在身份尚未解析的位置；R7 §15.2 的排序被本节取代。

**非普通输入口径**：以 `Reflect.ownKeys` 检测 **symbol 键**；以属性描述符检测**访问器属性**
（仅接受**数据属性**）；任一步抛出（含 Proxy trap 抛错）⇒ `TOP_LEVEL_INPUT_INVALID`，零写入。
**如实声明**：进程内无法穷尽防御恶意 Proxy；主要控制仍是「只由内部服务端组合调用」这一可信来源约束。

### 16.4 CHANGE 25（P1）—— 唯一运行模式

- **`CONTROLLED_FIXED_WORKTREE` 是唯一允许的 U2 执行环境**（§16.1）。
- §14.1 的 `SELF_CONSISTENT_HEAD` / `AUTHORIZED_FIXED_BASELINE` **不再是运行模式**：
  它们**仅**作为**受控工作树内部**的基线校验策略被保留——即「以当前 HEAD 为基线」是默认策略，
  「冻结基线」只是可选校验策略，**不构成独立运行模式、也不含任何自动授权**。
- `auditAnchor = 9ee36837` 仅用于溯源；**任何冻结基线策略不因 R8 通过而自动启用**（需单独审批）。

### 16.5 R8 未变部分

§12 候选键 v2 与 digest、§13.1 接口结构、§13.2 矩阵（U2-1…U2-20 状态不变，另加 U2-21）、
`builderRef` 固定常量、仅 INSERT、无 UPDATE/DELETE、不新增 schema/migration、不接 Runtime/Queue、
不调用模型/Provider、ACCOUNT 保持 `NOT_AUTHORIZED`、U1 封板 `9ee36837` 不变、
`SCHEMA_MIGRATION=HOLD`、`EXTERNAL_WRITE=HOLD`、`AUTO_MERGE/AUTO_DEPLOY=FORBIDDEN`、`PRODUCTION_READY=NO`。
本文件仍为**纯设计 R8**：未新增产品代码、未建表、未执行迁移、未接线运行时、未调用模型。
