# PHASE 3-A · U2 设计 R21（候选记录与 Incident↔Candidate↔Task 关联）—— **仅设计，未实施**

> 授权来源：`MSG-20261009-25 = PASS / U1_FINAL_CLOSURE=YES` →
> `MSG-20261009-43 = REVISE` → `MSG-20261009-44 = REVISE` → `MSG-20261009-45 = REVISE`
> → `NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_R21_READ_ONLY_CHANGES_83_TO_85`。
> 本文件是 **U2 设计 R21** 送审材料（MSG-20261009-46），**不含任何产品代码改动**。
> **R21 的修订集中在 §29**（提交窗口的**失败模型**与排他证明的可执行判据 /
> **恢复强制范围**与多实例自动化写入的**显式不授权声明** / `U2-51b` 的数据库结果验收断言 /
> 按审计方要求**收敛到两个可执行问题**），含本仓库范围内的只读证据核验；
> §1–§28 保留历史；凡冲突者以 §29 为准（**R13–R21 优先于 §20.4.1**）。

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
| U2 设计 R8 | `7a5d8058` |
| U2 设计 R9 | `d9172daa` |
| U2 设计 R10 | `35a50c63` |
| U2 设计 R11 | `b02a92de` |
| U2 设计 R12 | `c9b167c7` |
| U2 设计 R13 | `8c42cfc2` |
| U2 设计 R14 | `b57e5cb8` |
| U2 设计 R15 | `52308673` |
| U2 设计 R16 | `97dee91e` |
| U2 设计 R17 | `c9ec3eca` |
| U2 设计 R18 | `c391245e` |
| U2 设计 R19 | `824ac886` |
| U2 设计 R20 | `b396dc99` |
| U2 设计 R21 | 本提交（同一个仓库路径 `docs/releases/SI-RSI-INTERNAL-CODE-REPAIR-V1-PHASE3A-U2-DESIGN.md`） |
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

---

## 17. R9 修订（对应 MSG-20261009-33 的 CHANGE 26–31）

### 17.1 CHANGE 26（P0）—— 隔离证明的**可信链**

**承认**：R8 的 `ISOLATION_ATTESTED` 只是一组自述字段，**不能**证明隔离真实存在。

**R9 定义**

1. **来源**：隔离证明**只能**由可信运行环境（部署编排/受限运行账户的既有运维步骤）生成，
   U2 **只从受信配置或受信通道**获取；**普通业务输入不得**提供该证明（若入参出现任何证明字段 ⇒
   `EXTRA_FIELD_KEY_OR_UNKNOWN`）。
2. **服务端强制上限**：`issuedAt` 有效期受**服务端常量**约束 `ATTESTATION_MAX_AGE_MS_CAP`；
   调用方配置的 `maxAgeMs` 只能**收紧**、不能放宽（超出上限即按上限处理）。
3. **字段扩展（绑定真实保护范围）**：
   ```ts
   interface IsolationAttestation {
     attestationVersion: 'u2-iso:v1';
     canonicalWorktreePath: string;   // realpath 解析后的绝对路径
     gitDirRealPath: string;          // .git 实际指向目录（worktree 场景为 gitdir）
     protectedRefsDigest: string;     // sha256(canon(git for-each-ref 排序输出 + packed-refs 原始字节))
     ownerAccount: string;
     aclEvidenceRef: string;          // 只读 ACL/所有权检查输出的引用
     aclEvidenceDigest: string;       // 上述输出字节的 sha256
     writeDeniedProbeRef: string;     // 「非属主写入被拒绝」探针证据引用
     writeDeniedProbeDigest: string;
     issuedAt: string;                // UTC 毫秒
     maxAgeMs: number;                // ≤ ATTESTATION_MAX_AGE_MS_CAP
   }
   ```
4. **运行期复核（非一次性）**：在 T0 与检查③ 各重新计算
   `realpath(canonicalWorktreePath)`、`gitDirRealPath`、`protectedRefsDigest`，
   与证明中的值**逐项比对**；不一致 ⇒ `ATTESTATION_STALE`（新 reason），零写入。
   因此**不得**把一次历史 ACL 检查当作运行期持续不可变的证明。
5. **信任边界（如实列出）**：本设计**不**声称能防御
   ①同一 UID 下的其他进程；②特权账户（root/管理员）；③证明签发**之后**被外部修改的 ACL。
   这三类必须由运行环境通过**专用账户 + 权限边界**排除；U2 只做证据一致性判定。
6. **两个验收层级必须区分**：
   - `ATTESTATION_VALID` —— U2 在运行期可以判定的结论（证据在位、一致、在有效期内）；
   - `WRITE_ISOLATION_ENFORCED` —— **只能**由实施阶段的 `U2-20A` 探针在**该环境**上实测得出，
     U2 运行期**从不**自行宣告该结论（设计如实声明，不越权宣称）。

### 17.2 CHANGE 27（P0）—— U2-20 拆分（修正自相矛盾的断言）

| 用例 | 必须断言 |
| --- | --- |
| **U2-20A** 外部非授权写入被拒绝 | Git HEAD/工作树**不变**；**合法候选可以提交**（提交成功）；**没有**越权写入发生（受保护路径对非属主不可写）⇒ 该环境据此可记录 `WRITE_ISOLATION_ENFORCED`（实施阶段） |
| **U2-20B** 真实检测到基线变化 | 回滚；**候选零新增**；**不泄露** candidate ID（仅结构化 reason `BASELINE_CHANGED_DURING_WRITE`） |
| **U2-20C** 隔离证明缺失/无效/过期 | **拒绝进入写入流程**；候选零新增（reason `EXCLUSIVE_WINDOW_UNAVAILABLE` 或 `ATTESTATION_STALE`） |

### 17.3 CHANGE 28（P0）—— 唯一键冲突与并发复用闭环

1. **约束核实（实施前置）**：确认既有 `AutonomyCandidate.@@unique([dedupeKey])` **确实覆盖** R9 的候选去重键
   （v2 键，§12.2）；**不新增**约束、**不改 schema**。
2. **写入语义**：`INSERT ... ON CONFLICT ("dedupeKey") DO NOTHING`（或以保存点包裹并捕获**唯一约束冲突**
   这一**特定**错误码）。
3. **冲突后的恢复/重试路径（明确设计）**：
   ① 回滚到保存点（或结束本事务）→ ② 在**新事务**中按 `dedupeKey` **重读**既有候选行 →
   ③ 重新构造权威身份并**逐项比对**（`dedupeKey`、`taskId`、`Task.incidentId`、`baselineRef`、`builderRef`、`candidateDigest`）
   → ④ **完全一致**才 `CANDIDATE_REUSED`（返回该 `candidateId`）；**任一不一致** ⇒ `INPUT_KEY_MISMATCH` 且 `candidateId=null`。
4. **不得**把**所有**数据库异常都当作去重冲突：非唯一约束类错误 ⇒ 稳定错误码 `CANDIDATE_WRITE_FAILED`（§17.6）。
5. **新增真实 PostgreSQL 双连接竞争测试**（**U2-28 / U2-29**）：
   - U2-28：两连接强制交错（两者查询均未命中 → A 提交 → B 撞唯一键）⇒ 断言**恰好 1 行**、
     B 走 §17.3 的恢复路径并返回 `CANDIDATE_REUSED`（身份完全一致时）；
   - U2-29：同上交错但 B 的权威身份与既有行**不一致**（构造恶意冲突）⇒ `INPUT_KEY_MISMATCH`、`candidateId=null`、**零新增**。

### 17.4 CHANGE 29（P1）—— 权威读取与事务边界

1. **关键权威读取入事务**：`Incident` / `Task`（真实外键链）/ 故障上下文 的读取与
   权威身份构造**移入候选写入事务**（或在新事务内做**同等强度**的重新验证）；
   证据行记录 `authoritativeReadInsideTx=true`。
2. **并发失效防护**：证明「`Incident` 状态变化 / `Task` 关联变化 与候选 `INSERT` 并发」时
   **不提交已失效候选**（测试 U2-30）。
3. **`COMMIT` 结果未知（不得谎称回滚）**：若 `COMMIT` 抛错且**结果未知**（连接中断等）：
   - **不重试**（避免重复副作用）；
   - 执行**只读对账**：按 `dedupeKey` 查询候选行；
     - 存在且权威身份一致 ⇒ 返回 `COMMIT_CONFIRMED_BY_RECONCILE`（`commitState='COMMITTED'`）；
     - 不存在 ⇒ 返回 `COMMIT_NOT_CONFIRMED`（`commitState='NOT_COMMITTED'`）；
     - 查询本身失败 ⇒ `commitState='UNKNOWN'`；
   - 三种情况都**不得**被表述为「已回滚且零写入」。

### 17.5 CHANGE 30（P1）—— 锁释放的原子性与失败语义

1. **稳定验证 + 原子释放**：释放**不得**采用「先读 `ownerToken`、再按路径删除」的两步法，改为：
   - 持锁期间保留**打开的文件描述符**；
   - 释放时先 `fstat` 取得 `(dev, inode)` 并从**同一 fd** 读回 `ownerToken`；
   - 通过**原子 `rename`** 将锁改名为 `<lock>.released.<ownerToken>`（目标已存在则视为异常）；
     随后校验改名后文件内容仍为本属主 ⇒ 再 `unlink`；任何不一致 ⇒ **不删除**并告警（fail-closed）；
   这样可以避免删除「后来者」的锁。
2. **创建后写入/同步失败**：尽力释放（按第 1 条）并返回 `EXCLUSIVE_WINDOW_UNAVAILABLE`，零写入。
3. **释放失败（含正常路径）**：告警，且**下次调用**在锁存在时按 §16.2 直接拒绝；不自动接管。
4. **提交成功但释放失败**：**不得**报告为「零写入」；结果按 §17.6 的副作用契约如实返回
   （`commitState='COMMITTED'`、`lockReleaseFailed=true`）。
5. **人工解除陈旧锁**：须有文档化流程（操作者身份、存活检查证据、时间戳）并落入既有审计工件；
   U2 自身永不自动清理归属不明的锁。

### 17.6 CHANGE 31（P1）—— 拒绝码与最终副作用状态一致

**新的统一副作用契约**（所有返回都必须携带，且与 reason 一致）：

```ts
interface U2SideEffectReport {
  candidateRowsWritten: 0 | 1;
  commitState: 'COMMITTED' | 'NOT_COMMITTED' | 'UNKNOWN';
  lockReleaseFailed: boolean;
  authoritativeReadInsideTx: boolean;
}
```

**确定性判定补充**

1. `null` 与缺失的优先级：**缺失或 `undefined`** ⇒ `MISSING_INCIDENT_ID` / `MISSING_REQUEST_REF`；
   **存在但为 `null`** ⇒ `EMPTY_STRING_FIELD`；**存在且非 `null` 但类型非 `string`** ⇒ `INVALID_FIELD_TYPE`；
   **存在且为空字符串** ⇒ `EMPTY_STRING_FIELD`。（顺序：缺失 → 类型 → 空值）
2. 非普通对象 / `Proxy`：仅接受**数据属性**；检测到 symbol 键、访问器属性，或属性访问抛出 ⇒ `TOP_LEVEL_INPUT_INVALID`，
   零写入（并重申：进程内无法穷尽防御恶意 Proxy，主要控制是内部调用来源约束）。
3. **`BASELINE_CHECK_FAILED`（新）** 与 `BASELINE_CHANGED_DURING_WRITE` 必须区分：
   Git 命令执行失败/元数据不可读 ⇒ 前者；三次检查结果**确实不同** ⇒ 后者。
4. `INSERT` 期间的**普通数据库错误** ⇒ `CANDIDATE_WRITE_FAILED`（稳定契约），不得映射为去重复用。
5. **原则**：**不得**因为最终返回 `REJECTED` 就声称数据库一定没有发生提交；
   反之，任何 `CANDIDATE_INSERTED` / `CANDIDATE_REUSED` 都必须与 `candidateRowsWritten`/`commitState` 自洽。

### 17.7 R9 未变部分

§12 候选键 v2 与 digest、§13.1 接口结构（`U2PlatformCandidateInput{incidentId,requestRef}` /
`U2CandidateDecision`，本节点增补副作用报告）、§13.2 矩阵（U2-1…U2-21 状态不变，另加
U2-28/29/30）、§16.1 的 `CONTROLLED_FIXED_WORKTREE` 唯一模式与协作锁降级、
`builderRef` 固定常量、仅 INSERT、无 UPDATE/DELETE、不新增 schema/migration、不接 Runtime/Queue、
不调用模型/Provider、ACCOUNT 保持 `NOT_AUTHORIZED`、U1 封板 `9ee36837` 不变、
`SCHEMA_MIGRATION=HOLD`、`EXTERNAL_WRITE=HOLD`、`AUTO_MERGE/AUTO_DEPLOY=FORBIDDEN`、`PRODUCTION_READY=NO`。
本文件仍为**纯设计 R9**：未新增产品代码、未建表、未执行迁移、未接线运行时、未调用模型。

---

## 18. R10 修订（对应 MSG-20261009-34 的 CHANGE 32–35，并收口 CHANGE 26/28 的遗留规范）

### 18.1 CHANGE 32（P0）—— 锁释放的**可证明原子性**

**承认**：`fstat(fd)` + 读 `ownerToken` + `rename` + `unlink` 仍有两处竞态：
① 普通 `rename()` 可能**覆盖**已存在的目标；② **源路径**可能被其他进程替换（校验旧 fd 的 inode
不等于随后按路径 `rename` 的对象）。

**R10 规则**

1. **不可覆盖改名**：Linux 上使用 `renameat2(..., RENAME_NOREPLACE)`（或等效的不可覆盖原语）；
   平台不提供该原语 ⇒ **不释放**并告警（fail-closed）。
2. **父目录纳入隔离保护**：锁目录（锁文件的父目录）必须属于 §17.1 受保护范围——
   归属专用运行账户、非属主**不可写/不可改名**；否则非受信主体可替换锁路径。
   **`RENAME_NOREPLACE` 只解决目标覆盖，不解决源路径替换⇒目录权限约束为必要条件。**
3. **释放前后校验**：释放前从**同一 fd** 取 `(dev,inode)` 与 `ownerToken`；
   改名后再对**新路径**（通过 `O_NOFOLLOW` 打开）校验 `(dev,inode)` 与内容一致；
   任一不一致 ⇒ **不执行 `unlink`**、保留现场并告警。
4. **失败留证**：`rename` 后源路径异常、目标冲突、校验失败 ⇒ 将现场
   （路径、`(dev,inode)`、`ownerToken`、时间戳）写入既有证据工件，供人工调查；
   **不**自动重试、**不**自动清理。
5. **新增 U2-31**：真实并发场景下（①另一进程替换锁路径；②目标名冲突；③持锁进程被中断）
   断言：候选零新增或如实上报、锁不被误删、现场证据存在。

### 18.2 CHANGE 33（P0）—— PostgreSQL 并发失效防护

**承认**：事务内读取**不等于**状态稳定（A 读 `DIAGNOSED` → B 改为不合格并提交 → A 仍提交候选）。

**R10 规则**

1. **对权威行加行锁**：在事务内以
   `SELECT ... FROM "AutonomyIncident" WHERE id=$1 FOR UPDATE`（关联 `AutonomyTask` 同样加锁）读取，
   再据此判定资格。该行锁会**阻止**其他事务在同一行上执行 `UPDATE` 直到本事务结束，
   从而消除「读后被他方改状态再提交」的交错。
2. **锁顺序固定以防死锁**：统一按 `Incident` → `Task`（按 `id` 升序）顺序取锁；禁止反向顺序。
3. **超时与失败处置**：设置**锁等待超时**；捕获
   `40001`（序列化失败）/`40P01`（死锁）⇒ 视为**可安全重试**（前提：本事务**未产生任何副作用**，
   且重试后必须**重新**执行基线校验与权威资格判定）；重试上限固定（默认 1 次），超限 ⇒
   `REJECTED`，reason=`CONCURRENT_CONFLICT`。
4. **不可重试的情形**：已发出 `COMMIT`（结果可能未知）⇒ 走 §18.3 的对账路径，**不得重试插入**。
5. **提交时刻语义（如实声明）**：候选在其提交时刻对**当时**的 `Incident` 状态是合法的；
   此后 `Incident`/`Task` 状态若变化，由既有**逻辑失效**规则（§6/§12.4 语义）在**重用/消费前**
   重新校验处置——**不**追认历史候选无效。
6. **新增 U2-30（真实 PostgreSQL 双连接、可控交错）**：B 在 A 持锁期间尝试改 `Incident` 状态 ⇒
   断言 B 被阻塞至 A 结束；断言最终**已提交状态与候选资格一致**（A 提交时资格成立），
   且后续 B 的状态变更会被重用前重验捕获。

### 18.3 CHANGE 34（P0）—— 未知 `COMMIT` 的对账语义（修正推论）

**承认**：**查不到记录 ≠ 已回滚**（结果未定、数据库切换、副本延迟都可能造成「查不到」）。

**R10 规则**

1. **权威数据源**：对账**只**使用与写入同一连接字符串的**主库**（`DATABASE_URL`），
   以 `READ COMMITTED` 读取；**不**使用只读副本；对账使用**新连接**。
2. **结果确定性前提**：仅当满足「该事务已结束且结果可由主库判定」时，对账结论方可作为提交证据；
   否则一律 `UNKNOWN`。
3. **三分类（取代 R9 的二分类）**：
   - 查到**完全匹配**的可见记录 ⇒ `COMMIT_CONFIRMED_BY_RECONCILE`，`commitState='COMMITTED'`；
   - 未查到 ⇒ `COMMIT_NOT_CONFIRMED`，`commitState='UNKNOWN'`（**不得**判为 `NOT_COMMITTED`）；
   - 对账查询失败 ⇒ `commitState='UNKNOWN'`。
4. **唯一允许 `NOT_COMMITTED` 的情形**：本地驱动可**证明** `COMMIT` **未被发出**
   （例如连接在发出 `COMMIT` 之前失败）⇒ `commitState='NOT_COMMITTED'`；此为「明确的未提交证据」。
5. **禁止**在对账期间盲目重复 `INSERT`（避免重复副作用）。

### 18.4 CHANGE 35（P1）—— 副作用报告的完整语义 + 收口 CHANGE 26/28 遗留规范

**修订后的副作用报告**

```ts
interface U2SideEffectReport {
  insertAttempted: boolean;          // 是否已尝试 INSERT
  insertSucceededInTx: boolean;      // 事务内 INSERT 是否成功
  newRowsCommitted: 0 | 1 | 'UNKNOWN'; // 最终已提交的**新**行数；无法判定时为 'UNKNOWN'
  commitState: 'COMMITTED' | 'NOT_COMMITTED' | 'UNKNOWN';
  lockReleaseFailed: boolean;
  authoritativeReadInsideTx: boolean;
  reconciled: boolean;               // 是否通过对账得出结论
}
```

**完整状态表（取代 R9 的简化表）**

| 场景 | outcome | reason | commitState | candidateId | newRowsCommitted |
| --- | --- | --- | --- | --- | --- |
| 新候选确认提交 | `CANDIDATE_INSERTED` | — | `COMMITTED` | 新候选 ID | 1 |
| 合法既有候选复用 | `CANDIDATE_REUSED` | — | `NOT_COMMITTED`（本次无新提交） | 既有 ID | 0 |
| 输入校验拒绝 | `REJECTED` | 输入类 reason | `NOT_COMMITTED` | `null` | 0 |
| 插入失败且事务确认回滚 | `REJECTED` | `CANDIDATE_WRITE_FAILED` | `NOT_COMMITTED` | `null` | 0 |
| `COMMIT` 结果未知且对账无定论 | `REJECTED` | `COMMIT_NOT_CONFIRMED` | `UNKNOWN` | `null` | `'UNKNOWN'` |
| 对账确认已提交 | `CANDIDATE_INSERTED` | `COMMIT_CONFIRMED_BY_RECONCILE` | `COMMITTED` | 已确认 ID | 1 |
| 提交成功但锁释放失败 | `CANDIDATE_INSERTED` | `LOCK_RELEASE_FAILED` | `COMMITTED` | 已确认 ID | 1 |

> `NOT_COMMITTED` 的语义严格限定为「**本次调用没有提交新候选写入**」，**不**否认既有候选已持久化。
> `COMMIT_CONFIRMED_BY_RECONCILE` / `LOCK_RELEASE_FAILED` 是 **reason**（不是 outcome），
> `outcome` 枚举仍为 `{ CANDIDATE_INSERTED | CANDIDATE_REUSED | REJECTED }`，避免与 §13.1 冲突。

**CHANGE 26 遗留收口 —— `protectedRefsDigest` 的字节级规范**

```text
输入 = for-each-ref 输出 与 packed-refs 原始字节 的确定性拼接
  ① git for-each-ref --format='%(refname)%1F%(objectname)%1F%(objecttype)' | 按 refname 码点升序排序
  ② 每行以 0x0A 结尾；字段以 0x1F 分隔；空值以零长度表示（不加占位符）
  ③ 追加 packed-refs 文件**原始字节**（若不存在则追加零长度）
protectedRefsDigest = sha256( utf8("u2refs:v1" + "\n" + 上述字节) )
范围 = git rev-parse --git-common-dir 与 worktree 专属 gitdir **同时**覆盖（worktree 场景两者都校验）
```

**证明签发者的认证机制（如实要求）**：隔离证明**只能**通过受信通道送达 ——
① 由编排器在**进程启动时注入**的环境变量/挂载（运行期**不得**从工作树内可篡改文件读取），
或 ② 经认证的控制面调用；若环境中**只有**本地可篡改配置文件作为来源 ⇒ 视为 `NOT_ATTESTED`，
U2 **拒绝**（`EXCLUSIVE_WINDOW_UNAVAILABLE`）。**R10 不引入密钥材料、不新增表**。

**CHANGE 28 遗留收口**：`ON CONFLICT ... DO NOTHING` 返回**零行**时**不得**视为插入成功，
必须进入 §17.3 的重读+逐项比对路径；重开事务后必须**重复**基线校验与权威资格判定。

### 18.5 R10 未变部分

§12 候选键 v2 与 digest、§13.1 接口（本节点增补副作用字段）、§13.2 矩阵（另加 U2-31）、
§16.1 `CONTROLLED_FIXED_WORKTREE` 唯一模式、§17.1 隔离证明框架、§17.2 U2-20A/B/C、
§17.3 冲突复用路径、`builderRef` 固定常量、仅 INSERT、无 UPDATE/DELETE、不新增 schema/migration、
不接 Runtime/Queue、不调用模型/Provider、ACCOUNT 保持 `NOT_AUTHORIZED`、U1 封板 `9ee36837` 不变、
`SCHEMA_MIGRATION=HOLD`、`EXTERNAL_WRITE=HOLD`、`AUTO_MERGE/AUTO_DEPLOY=FORBIDDEN`、`PRODUCTION_READY=NO`。
本文件仍为**纯设计 R10**：未新增产品代码、未建表、未执行迁移、未接线运行时、未调用模型。

---

## 19. R11 修订（对应 MSG-20261009-35 的 CHANGE 36–39）

### 19.1 CHANGE 36（P0）—— 同 UID 并发下的锁安全

**承认审计方的判断**：`RENAME_NOREPLACE` 只防**目标覆盖**，`O_NOFOLLOW` 只防最终路径的符号链接，
目录属主权限只挡**其他用户**；**同一运行账户的第二个进程**仍可能在「A 检查与改名之间」替换**源目录项**。
纯用户态文件锁**无法**排除同 UID 同权限进程——R11 不再宣称能排除，而是把它变成**可验证的前提**。

**R11 规则**

1. **锁目录安全假设（显式声明）**：`<lockDir>` 属专用运行账户、权限 `0700`，
   **且该账户下不得同时运行两个 U2 实例**。后一条是**运维前提**，必须由外部保序机制提供（见第 2 条）。
2. **单实例保序前提 `SUPERVISOR_SINGLE_INSTANCE`（技术可验证）**：运行环境必须提供**外部单实例保证**，
   在 §17.1 的隔离证明中新增字段：
   `singleInstanceGuaranteeRef`（证据引用，例如 systemd 服务单元的 `RuntimeDirectory` +
   单元级 `flock`/单实例配置的实际配置输出）与 `singleInstanceGuaranteeDigest`。
   **缺失/无法验证** ⇒ `EXCLUSIVE_WINDOW_UNAVAILABLE`，**不进入任何写入流程**。
   > 说明：R11 **不**新增自研 Runtime/Scheduler/Controller，只要求复用**既有**的操作系统/服务管理能力。
3. **路径互斥仍必须可验证**：即使有单实例保证，释放流程仍按 §18.1 的
   `RENAME_NOREPLACE` + `O_NOFOLLOW` + `(dev,inode)` + `ownerToken` 全链校验；
   **任何异常一律 fail-closed**，且**不得删除**无法证明属于本次持锁者的锁对象。
4. **生命周期关系（明确写出）**：
   `T0 校验隔离证明与单实例证据` → `T1 取得协作锁` → `T2 候选事务（Git①②③ + 行锁 + INSERT + COMMIT）`
   → `T3 释放锁（§18.1 全链校验）`。锁在 `T1`~`T3` 全程持有；`T2` 结果未知时**锁保持**直到对账完成。
5. **U2-31（扩展）**：①同 UID 双进程竞争同一锁；②**释放验证后、删除前**由同 UID 进程替换源目录项；
   ③目标名冲突；④持锁进程被中断。断言：**不删除非本次持锁者的锁对象**、无法证明所有权时**保留现场**、
   候选行数按如实上报、异常路径 fail-closed。

### 19.2 CHANGE 37（P0）—— COMMIT 对账的**事务归因**

**承认**：**查到完全匹配记录 ≠ 本次 INSERT 已提交**（同 `dedupeKey` 候选可能**先前已存在**）。

**R11 规则**

1. **两类事实分离**：`RECORD_EXISTS`（库中存在匹配记录）与 `THIS_INSERT_COMMITTED`（**本次**事务写入被提交）。
2. **归因判定（在既有 schema 内）** —— 只有同时满足以下三条才判定 `THIS_INSERT_COMMITTED`：
   ① 事务内插入前读取（§18.2 第 1 步行锁读取）**未发现**该 `dedupeKey` 的既有行；
   ② `insertSucceededInTx === true`；
   ③ 对账在**主库**上查到**恰好一行**匹配记录，且其 `createdAt` 落在**本次事务窗口**内；
   否则一律 `RECORD_EXISTS only` ⇒ `candidateInsertCommitState='UNKNOWN'`、`newRowsCommitted='UNKNOWN'`。
3. **不虚构归因凭据**：R11 **不**新增列/表；如未来需要「写入令牌」式的强归因，**必须单独送审**
   （本设计不越权假设）。**在无法排除既有记录或竞争事务影响时，一律 `UNKNOWN`**。
4. **路径严格分开**：`ON CONFLICT ... DO NOTHING` 的**零行路径**（§17.3 重读+逐项比对 ⇒ `CANDIDATE_REUSED`
   或 `INPUT_KEY_MISMATCH`）与**未知 `COMMIT` 的对账路径**（§19.2）**不得混用**。
5. **新增对抗用例 U2-32**：预先存在完全匹配候选 + 本次 `COMMIT` 返回未知 ⇒
   断言**禁止**输出 `CANDIDATE_INSERTED`、`newRowsCommitted` 必须为 `'UNKNOWN'`、`candidateId=null`。

### 19.3 CHANGE 38（P1）—— 事务状态与新增行数的统一语义

**字段改名与语义**

```ts
interface U2SideEffectReport {
  insertAttempted: boolean;
  insertSucceededInTx: boolean;
  /** 仅描述**本次候选 INSERT** 的提交状态（不描述"是否复用了既有候选"） */
  candidateInsertCommitState: 'COMMITTED' | 'NOT_COMMITTED' | 'UNKNOWN';
  /** 本次调用**新插入并确认持久化**的行数；无法判定为 'UNKNOWN' */
  newRowsCommitted: 0 | 1 | 'UNKNOWN';
  lockReleaseFailed: boolean;
  authoritativeReadInsideTx: boolean;
  reconciled: boolean;
}
```

**组合约束（每种结果都必须一致）**

| 场景 | insertAttempted | insertSucceededInTx | candidateInsertCommitState | newRowsCommitted | reconciled | lockReleaseFailed |
| --- | --- | --- | --- | --- | --- | --- |
| 新候选确认提交 | true | true | `COMMITTED` | 1 | false | false |
| 提交成功但释放失败 | true | true | `COMMITTED` | 1 | false | **true** |
| 合法既有候选复用（未尝试 INSERT） | **false** | false | `NOT_COMMITTED` | 0 | false | false |
| 输入校验拒绝 | false | false | `NOT_COMMITTED` | 0 | false | false |
| 插入失败且事务确认回滚 | true | false | `NOT_COMMITTED` | 0 | false | false |
| 结果未知且对账无定论 | true | true | `UNKNOWN` | **'UNKNOWN'** | true | 任意 |
| 对账确认已提交 | true | true | `COMMITTED` | 1 | **true** | 任意 |

**优先级规则**：当 `candidateInsertCommitState='UNKNOWN'` 时，
**`lockReleaseFailed=true` 不得改变或掩盖该状态**（报告同时携带两个字段，调用方须以提交状态为准）。
`outcome` 枚举保持 `{ CANDIDATE_INSERTED | CANDIDATE_REUSED | REJECTED }` 不变，
`COMMIT_CONFIRMED_BY_RECONCILE` / `LOCK_RELEASE_FAILED` 仍为 **reason**。

### 19.4 CHANGE 39（P1）—— 证明与 refs digest 的精确定义

1. **Digest 用纯字节拼接（不得字符串/字节混用）**：
   ```text
   B = Buffer.concat([
     Buffer.from('u2refs:v2\n', 'utf8'),
     Buffer.from('common-git-dir\u0000', 'utf8'), commonGitDirBytes,
     Buffer.from('\u0000worktree-gitdir\u0000', 'utf8'), worktreeGitdirBytes,
     Buffer.from('\u0000forEachRef\u0000', 'utf8'), forEachRefBytes,
     Buffer.from('\u0000packedRefs\u0000', 'utf8'), packedRefsRawBytes   // 不存在则零长度
   ])
   protectedRefsDigest = sha256(B)
   ```
   - `commonGitDirBytes` / `worktreeGitdirBytes`：`git rev-parse --git-common-dir` 与 `--git-dir` 的
     **相对路径解析后**的 UTF-8 字节（相对路径以工作树根为基准做 `realpath` 归一，随后编码）；
     **两者各自独立成段**并**带域分隔标签**，避免不同文件组合产生同一拼接结果；
   - `forEachRefBytes`：`git for-each-ref --format='%(refname)%1F%(objectname)%1F%(objecttype)'`
     按 `refname` **码点升序**排序；每行以 `0x0A` 结尾、字段以 `0x1F` 分隔、空值零长度；
   - `packedRefsRawBytes`：`packed-refs` 文件**原始字节**（**绝不**做字符串转换）。
2. **通道 ≠ 签发者认证**：隔离证明的**传输通道**（环境变量 / 启动挂载 / 控制面）**不等于**签发者可信。
   R11 要求证明中额外携带 `signerIdentity` 与其**认证引用** `signerAuthRef`
   （例如服务管理单元的单元身份/主机的机器身份证据），并区分验证：
   - `CHANNEL_TRUSTED`：证明确实经受信通道送达；
   - `SIGNER_AUTHENTICATED`：签发者身份已由环境认证。
   二者**都成立**才视为 `ATTESTATION_VALID`；**任一不成立** ⇒ `NOT_ATTESTED` ⇒
   `EXCLUSIVE_WINDOW_UNAVAILABLE`，拒绝写入。
3. **不新增密钥管理系统**：R11 不引入密钥材料、不新增表；无法满足可信前提时**直接拒绝**。

### 19.5 R11 未变部分

§12 候选键 v2 与 digest、§13.1 接口、§13.2 矩阵（另加 U2-32，U2-31 扩展）、
§16.1 `CONTROLLED_FIXED_WORKTREE`、§17.1 隔离证明框架（本节点扩展字段）、§17.2 U2-20A/B/C、
§17.3 冲突复用路径、§18.1 释放全链校验、§18.2 行锁与重试边界、§18.3 对账三分类（本节点增补归因）、
`builderRef` 固定常量、仅 INSERT、无 UPDATE/DELETE、不新增 schema/migration、不接 Runtime/Queue、
不调用模型/Provider、ACCOUNT 保持 `NOT_AUTHORIZED`、U1 封板 `9ee36837` 不变、
`SCHEMA_MIGRATION=HOLD`、`EXTERNAL_WRITE=HOLD`、`AUTO_MERGE/AUTO_DEPLOY=FORBIDDEN`、`PRODUCTION_READY=NO`。
本文件仍为**纯设计 R11**：未新增产品代码、未建表、未执行迁移、未接线运行时、未调用模型。

---

## 20. R12 修订（对应 MSG-20261009-36 的 CHANGE 40–43）

### 20.1 CHANGE 40（P0）—— **活体**排他性（不再把配置当作证明）

**承认审计方判断**：`singleInstanceGuaranteeRef + Digest` 只证明**某份配置/证据存在**，
不证明**运行中的进程持有排他权**；`RuntimeDirectory` ≠ 单实例锁；systemd 单元单实例
**不代表**同 UID 用户不能直接启动第二个进程；`flock` 只有被**所有**相关实例遵守才有协作互斥意义。

**R12 规则**

1. **唯一受控入口**：仅**既有**服务管理单元（systemd 单元，`Reuse=false`/单实例语义）被记录为
   U2 的受控入口；**同 U2 不新增任何 Runtime/Scheduler/Controller**。
   但**明确声明**：受控入口只约束**协作**主体，**不**约束不合作进程（见第 3 条）——不得再以「单元单实例」充当证据。
2. **两级证据必须分开**：
   - `CONFIG_VERIFIED`：配置/单元文件与实际运行实例一致（只证明**配置**）；
   - `LIVE_EXCLUSIVITY_VERIFIED`：由**U2 之外的探针进程**在同一运行账户下**尝试获取同一排他锁并断言失败**，
     探针输出（含时间戳与结果）作为证据引用。**只有后者满足排他门禁**；
     缺 `LIVE_EXCLUSIVITY_VERIFIED` ⇒ `EXCLUSIVE_WINDOW_UNAVAILABLE`，零写入。
3. **同 UID 文件系统隔离是「可信运行账户安全假设」**（如实标注，不再宣称用户态锁能阻止不合作进程）：
   `SAME_UID_FS_ISOLATION = TRUSTED_ASSUMPTION`，必须由**可信启动边界**（专用账户 + 仅该账户可登录/可写工作树与锁目录 + 无旁路启动路径）
   保证，并由运行侧提供 `sameUidIsolationRef`。**未提供或无法满足 ⇒ 拒绝写入**。
4. **`flock` 语义（若采用）**：锁文件位于工作树之外、`O_CREAT|O_RDWR`、`0600`；
   **FD 在整个进程生命周期持有**（覆盖 T1–T3 **完整事务窗口**，不得只覆盖事务而提前释放）；
   进程终止 ⇒ 内核自动释放（因此**无需**时间戳抢占规则）；**残余锁文件本身不是锁**，
   不得据此判定「有活动持锁者」，也不得**仅凭时间戳**删除或抢占。
5. **生命周期**：T0（校验隔离证明 + `LIVE_EXCLUSIVITY_VERIFIED` + `sameUidIsolationRef`）→ T1 取锁 →
   T2 候选事务 → T3 释放；T2 结果未知时锁**保持到对账完成**。
6. **U2-31（扩展）**：①**同 UID 绕过正常入口直接启动**第二个进程 ⇒ 断言其取锁失败或被 §20.1.3 的前提声明排除；
   ②释放锁期间路径对象被替换 ⇒ 断言**不删除**非本次持锁者对象且保留现场；
   ③目标名冲突；④持锁进程被中断后重启 ⇒ 断言新实例可正常取锁（内核已释放）且**不依赖任何时间戳规则**。

### 20.2 CHANGE 41（P0）—— 精确事务归因（`RETURNING` 真实返回 ID）

**承认**：`READ COMMITTED` 下「读时未发现 key」**不排除**其他事务随后插入同一 key；
行锁锁不住**不存在**的行；`createdAt` 是**时间**而非**事务身份** ⇒ R11 三条件**不足以**证明 `THIS_INSERT_COMMITTED`。

**R12 规则（不新增 schema）**

1. 写入语义改为 **`INSERT ... ON CONFLICT ("dedupeKey") DO NOTHING RETURNING "id"`**：
   - **返回一行** ⇒ 该 `id` 是**本次事务实际插入的主键**，在 `COMMIT` **之前**记录为
     `returnedCandidateId`（事务内事实）；
   - **返回零行** ⇒ 走 §17.3 零行冲突路径（重读 + 逐项比对 ⇒ `CANDIDATE_REUSED` 或 `INPUT_KEY_MISMATCH`），
     与未知 `COMMIT` 路径**严格分开**。
2. **未知 `COMMIT` 的对账**：在**权威主库**上按 `id = returnedCandidateId` 读取，并同时校验
   `dedupeKey` 与**必要不变字段**（`taskId`、`baselineRef`、`builderRef`）。
   三条同时命中 ⇒ `THIS_INSERT_COMMITTED`（`candidateInsertCommitState='COMMITTED'`、`newRowsCommitted=1`）。
3. **归因前提（必须成立，否则只能 `UNKNOWN`）**：
   ① `AutonomyCandidate.id` 为**主键**（Prisma `@id`）且由数据库生成，**不可复用**；
   ② U2 路径**不存在** UPDATE/DELETE 候选行（本设计仅 INSERT），因此记录不会被替换；
   ③ 既有唯一约束 `@@unique([dedupeKey])` 的实际行为已核实（实施前置）。
   若任一前提无法证明（例如驱动未取得 `RETURNING` 结果）⇒ `candidateInsertCommitState='UNKNOWN'`、
   `newRowsCommitted='UNKNOWN'`、`candidateId=null`，**不得**宣称已确认本次提交。
4. **`createdAt` 降级**：仅作辅助诊断字段，**不得**作为归因凭据。
5. **U2-32（扩展）**：加入**两个事务交错写入同一 `dedupeKey`**：一方 `RETURNING` 得行并提交；
   另一方 `DO NOTHING` 得零行 ⇒ 走零行冲突路径；并断言未知 `COMMIT` 场景下**不得**误报 `CANDIDATE_INSERTED`。

### 20.3 CHANGE 42（P1）—— 状态报告语义收口

1. **零行冲突复用**（执行了 `ON CONFLICT DO NOTHING` 且返回零行后复用）必须记
   **`insertAttempted=true`**（不是 `false`）；只有「INSERT 前即发现既有候选并直接复用」才是 `false`。
2. **`reconciled` 语义收紧**：严格表示「**已执行过对账**」；**结论**一律以
   `candidateInsertCommitState` + `newRowsCommitted` 表达（不再用 `reconciled` 表示「有结论」）。
3. **优先级**：当 `candidateInsertCommitState='UNKNOWN'` 与 `lockReleaseFailed=true` 并存时，
   `outcome='REJECTED'`、`reason='COMMIT_NOT_CONFIRMED'`（**提交不确定性优先**），
   `lockReleaseFailed=true` 仅作为附加事实，不得改变 outcome/reason。

### 20.4 CHANGE 43（P1）—— digest 规范与**规范测试向量**

1. **编码规范（v3，长度前缀，消除分隔符歧义）**：
   ```text
   protectedRefsDigest = sha256( concat(
       ascii("u2refs:v3\n"),
       f(commonGitDirBytes), f(worktreeGitdirBytes), f(forEachRefBytes), f(packedRefsRawBytes)
   ) )
   f(x) = 4-byte big-endian length prefix ++ raw bytes
   其中 "\n" 与长度前缀均为**实际字节**（0x0A / 4×0x00..），不是文本反斜杠序列
   ```
   - `commonGitDirBytes` / `worktreeGitdirBytes`：`git rev-parse --git-common-dir` 与 `--git-dir` 的原始输出，
     **以工作树根为基准做相对路径解析**；**不做符号链接跟随**（保留 as-is，工作树根之外不做 realpath），
     **统一去除尾部分隔符**，UTF-8 编码；规则固定后可重复计算；
   - `forEachRefBytes`：`git for-each-ref --format='%(refname)%1F%(objectname)%1F%(objecttype)'`
     按 `refname` 码点升序，每行 `0x0A`，字段 `0x1F`，空值零长度；
   - `packedRefsRawBytes`：`packed-refs` **原始字节**（不存在 ⇒ 零长度；**绝不**字符串转换）。
2. **规范测试向量（已两种独立实现交叉复算，结果一致）**：
   ```text
   输入：commonGitDir=".git"、worktreeGitdir=".git"、forEachRef=空、packedRefs=空
   拼接总字节 = 34
   hex = 7532726566733a76330a000000042e676974000000042e6769740000000000000000
   sha256 = 3e1a6ea723f3c6ebbe1753152f4fe51272d486c8dda1d9378b04888198da0f46
   复算① Node.js crypto.createHash('sha256')；复算② PowerShell Get-FileHash -Algorithm SHA256（.NET）
   两者一致 ⇒ 该向量可作为实现基准
   ```
3. **其他规定用例（实施时须补）**：空 `packed-refs`、**linked worktree**（`--git-dir` 与 `--git-common-dir` 不同）、
   含空格/非 ASCII 的路径、缺失 refs、异常输入（命令失败 ⇒ `BASELINE_*` 类拒绝，不产生 digest）。
4. **`signerAuthRef` 绑定**：须同时绑定 **签发者身份 + 运行实例标识 + 证明内容摘要**
   （即 `signerAuthRef` 的完整性覆盖 `{signerIdentity, instanceId, attestationDigest}`），
   防止**合法证明被复制**到其他执行环境复用。

### 20.5 R12 未变部分

§12 候选键 v2 与 digest 概念、§13.1 接口（本节点收紧语义）、§13.2 矩阵（另加 U2-32 扩展）、
§16.1 `CONTROLLED_FIXED_WORKTREE`、§17.1 隔离证明框架、§17.2 U2-20A/B/C、§17.3 零行冲突复用路径、
§18.1 释放全链校验、§18.2 行锁与重试边界、§19.4 通道/签发者分离、
`builderRef` 固定常量、仅 INSERT、无 UPDATE/DELETE、不新增 schema/migration、不接 Runtime/Queue、
不调用模型/Provider、ACCOUNT 保持 `NOT_AUTHORIZED`、U1 封板 `9ee36837` 不变、
`SCHEMA_MIGRATION=HOLD`、`EXTERNAL_WRITE=HOLD`、`AUTO_MERGE/AUTO_DEPLOY=FORBIDDEN`、`PRODUCTION_READY=NO`。
本文件仍为**纯设计 R12**：未新增产品代码、未建表、未执行迁移、未接线运行时、未调用模型。

---

## 21. R13 修订（对应 MSG-20261009-37 的 CHANGE 44–46）

> 授权来源：`MSG-20261009-37 = REVISE` ⇒ `NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_R13_READ_ONLY_CHANGES_44_TO_46`。
> 本轮**只改设计文本与审计归档**：不新增产品代码、不建表、不执行迁移、不接 Runtime/Queue、不调用模型/Provider；
> `U2_IMPLEMENTATION_AUTHORIZED=NO` 保持不变。R12 中已 PASS 的 §20.3（CHANGE 42）语义**原样保留**，本轮**不改动**。

| CHANGE | R12 位置 | R13 修订位置 | 变更性质 |
| --- | --- | --- | --- |
| **CHANGE 44（P0）** | §20.1 第 5 条（`T0 → T1 → T2 → T3`） | **§21.1** | 时序重构 + **锁所有权证明**（新增 `T1A`） |
| **CHANGE 45（P0）** | §20.2.3 前提②（「U2 路径无 UPDATE/DELETE」） | **§21.2** | 局部论证 → **全局不可变性**前置 |
| **CHANGE 46（P1）** | §20.4.1 / §20.4.2 / §20.4.4 | **§21.3** | 字节与排序规范、统一 fail-closed、`signerAuthRef` 生命周期 |
| 验收矩阵 | §13.2 / §20.1.6 / §20.2.5 | **§21.4** | 新增 **U2-33 ~ U2-40** 正反例 |

### 21.1 CHANGE 44（P0）—— 活体排他的**时序**与**锁所有权证明**

**承认审计方的判断**：R12 §20.1 的 `T0（校验活体排他）→ T1（取锁）` **时序自相矛盾**。
`T0` 的外部探针失败只能证明**探测时刻存在持锁者**，**不能**证明 **U2 在 `T1` 持锁**；
若锁在 `T0` 时已由 U2 自己持有，则 `T1` 是否**复用同一已持锁 FD**、如何证明该 FD 属于**当前执行实例**，R12 均未定义。

**R13 规则（严格按序执行；任一步失败 ⇒ 立即 fail-closed，零写入）**

1. **阶段定义（重排后）**

| 阶段 | 必须完成的事 | 失败语义（拒绝码） |
| --- | --- | --- |
| **`T0`** | 校验**受控启动身份**（专用运行账户 + 既有服务管理单元）、**隔离前提** `SAME_UID_FS_ISOLATION` + `sameUidIsolationRef`、**配置证明** `CONFIG_VERIFIED`；并完成 §21.3.4 的 `signerAuthRef` **首次验证** | `EXCLUSIVE_WINDOW_UNAVAILABLE` |
| **`T1`** | **当前 U2 实例**取得锁，并记录：①**持锁 FD 号** ②**实例身份**（`instanceId` + 启动凭证） ③**锁对象标识** `(st_dev, st_ino)` 与 `ownerToken` | `LOCK_ACQUIRE_FAILED` |
| **`T1A`** | **独立探针进程**用**独立打开的 FD**对**同一锁对象**做**非阻塞**获取并**断言失败**；探针必须同时验证 **(a)** 锁对象身份一致（`(dev,inode)` 与 `T1` 记录相同）与 **(b)** 「当前 U2 实例**确实持锁**」这一事实成立 | `LOCK_OWNERSHIP_UNPROVEN` / `PROBE_OBJECT_MISMATCH` |
| **`T2`** | **仅当 `T1` 与 `T1A` 均成功且证明仍有效**（未过期、未被释放、锁对象未被替换、`signerAuthRef` 复验通过）才进入数据库事务；进入前须**最后一次**复检锁对象 `(dev,inode)`、FD 有效性与「持有者仍是本实例」 | `LOCK_RELEASED_EARLY` / `LOCK_OBJECT_REPLACED` / `SIGNER_AUTH_INVALID` |
| **`T3`** | 事务 + 必要对账 + 释放（§18.1 全链校验）。**释放失败必须保留异常事实** `lockReleaseFailed=true`，**不得**声称正常释放（优先级见 §20.3.3） | `LOCK_RELEASE_FAILED` |

2. **`T1A` 探针的独立性要求**：探针必须是**与 U2 不同的进程**（独立 `fork`+`exec` 或独立可执行文件），**独立打开**锁文件，
   **不得**通过 FD 继承 / `SCM_RIGHTS` / `dup` 复用 U2 的 FD；探针须输出结构化结果（时间戳、`(dev,inode)`、尝试结果、探针自身实例标识），
   该输出作为 `LIVE_EXCLUSIVITY_VERIFIED` 的**证据引用**。
3. **锁对象身份必须以 `(st_dev, st_ino)` 比对**，**不得只比对路径字符串**（路径可被替换/重绑）；`T1` 与 `T1A` 的对象标识不一致 ⇒ 不得进入 `T2`。
4. **`flock` 的 FD 语义（必须显式实现）**：`flock` 锁绑定在**打开文件描述（open file description）**上，**不是**绑定在 FD 号上：
   - `dup`/`fork` **共享**同一描述 ⇒ 父进程退出**不会**释放锁（只要仍有副本存在）；
   - `exec` 派生的子进程若未设置 close-on-exec 会**继承**该描述 ⇒ **锁意外持续**（探针将一直失败，实例形同「幽灵持锁」）；
   - **规定**：锁 FD **一律** `O_CLOEXEC`（`FD_CLOEXEC`）；**禁止** `dup` 该 FD；派生任何子进程前必须确认该 FD 不在继承集合内；
   - **释放手段**：`flock(LOCK_UN)` **与** `close(fd)` **同时**执行，且以 **`close()`** 为最终释放依据（仅 `LOCK_UN` 不能解决副本问题）；
   - 持锁进程被 `SIGKILL` ⇒ 内核释放全部副本 ⇒ **不依赖任何时间戳抢占规则**（§20.1.4 保留）。
5. **证明有效性窗口**：`T1`/`T1A` 的证明与 `T2` 的事务之间不得存在可被其他实例利用的窗口；
   `T2` 前的复检（第 1 条 `T2` 行）是**必需**步骤，**不得省略**，也**不得**仅以 `T0` 的结论代替。
6. **负例（必须纳入 §21.4 矩阵）**：
   - 探针**取得**锁（即 U2 **实际未持锁**）⇒ 拒绝；
   - 探针与 U2 锁定**不同 inode** ⇒ 拒绝；
   - 证明通过后锁被**提前释放**（同 UID 进程 `LOCK_UN`/`close`，或锁对象被替换）⇒ 拒绝。

### 21.2 CHANGE 45（P0）—— COMMIT 归因前提升级为**全局不可变性**

**承认审计方的判断**：§20.2.3 前提②以「**U2** 路径不存在 UPDATE/DELETE」论证「记录不会被替换」，这是**局部**论证。
U2 自身不改记录，**不等于**其他模块、管理员或数据库作业不改；
因此「未知 `COMMIT` 后按 `id` 在主库重读到匹配行」仍缺少**全局不可变性**保证。

**R13 规则（不新增 schema）**

1. **全局写入者清单（必须建立并逐项核实，不得只限 U2 模块）**：至少覆盖
   ①U2 候选记录器自身 ②**任何既有服务/后台作业** ③**迁移与运维脚本** ④**人工/管理员访问**（含 DBA 与 Prisma Studio 类工具）
   ⑤**数据库级对象**（触发器 / 规则 / 级联）。
   每一项须给出**来源证据**（仓库内引用 + 生产库对象查询结果），并标注**是否可能 UPDATE/DELETE 候选行**；
   **清单不完整 ⇒ 视为不可证明**。
2. **`AutonomyCandidate.id` 生成与不复用机制的核对**：必须对照**实际 Schema**（Prisma `@id`）、**数据库约束**（主键 / 唯一索引 / 默认值与生成方式）
   与**写入路径**逐项核实：
   - `uuid`/`cuid` 一类生成器在**不重放先前值**的前提下可判定为不复用；
   - **序列/自增**类须考虑**回绕与重置**（`ALTER SEQUENCE RESTART`、恢复/克隆库）⇒ 默认**不**判定为不复用；
   - 上述任一项**无法核实** ⇒ 归因前提**不成立**。
3. **`returnedCandidateId` 的保存时机（关键）**：事务内取到 `RETURNING` 的 `id` 后，必须在 **`COMMIT` 之前**把它写入**事务外的执行上下文**
   （可持久化载体：结构化日志 / 对账日志；写入失败即视为**未保存**）。
   必须明确：该值**本身不等于已提交证明**——它只证明「本事务**执行过**插入并取得主键」，提交与否仍须按下条对账。
4. **未知 `COMMIT` 对账的严格前提**：只有在 ①全局写入者清单完成且**不可变性**在**整个观察窗口**内成立、
   ②`id` 不复用机制已核实、③`returnedCandidateId` 已按第 3 条保存 之后，
   才允许在**权威主库**上执行 §20.2.2 的重读校验，并据此得出 `candidateInsertCommitState='COMMITTED'`、`newRowsCommitted=1`。
5. **无法证明全局不可变性 ⇒ 只允许 `UNKNOWN`**：`candidateInsertCommitState='UNKNOWN'`、`newRowsCommitted='UNKNOWN'`、`candidateId=null`；
   **不得**认定 `THIS_INSERT_COMMITTED`，也**不得**据此推进任何自动化动作（`outcome='REJECTED'`、`reason='COMMIT_NOT_CONFIRMED'`）。
6. **必须覆盖「`RETURNING` 得一行、随后事务显式 `ROLLBACK`」**：由于第 3 条已在事务外保存 `returnedCandidateId`，
   对账在**主库**读不到该 `id`（或读到但**必要不变字段** `taskId`/`baselineRef`/`builderRef` 不匹配）⇒
   结论必须是 `NOT_COMMITTED`（或 `UNKNOWN`），**禁止**把「执行过 INSERT」解释为「已提交」。

### 21.3 CHANGE 46（P1）—— refs 摘要的**字节规范**收口

1. **`git rev-parse` 原始输出的处理**：**只去除命令自身产生的行尾换行**（末尾 `0x0A`；若为 `0x0D 0x0A` 则一并去除），
   **不得**做 `trim()`、空白折叠、路径规范化或大小写处理——**不得损伤路径名中的有效字符**（含空格、`\t`、非 ASCII 与结尾空白）。
   若输出被 Git 以 **C 风格引号包裹**（首/末为 `"`，`core.quotePath` 场景）⇒ 视为**路径解析失败** ⇒ `BASELINE_*` 拒绝，**不得**自行解码猜测。
2. **排序算法固定（消除 locale 依赖）**：非 ASCII `refname` 的「**码点排序**」与「**原始字节排序**」**可能不同**，故固定为
   **`refname` 原始字节（UTF-8）的无符号字节升序**（逐字节 `memcmp` 语义，短者在前）；
   **禁止**使用任何 locale 相关比较（`strcoll` / `localeCompare`）或大小写折叠。
   **区域设置不得影响输出**：读取前固定 `LC_ALL=C`（等价做法：完全不调用 locale 相关比较），并**显式**传 `--sort=refname`、**不依赖**默认排序；
   证据中须记录所用排序为「UTF-8 原始字节序」。同一 `refname` 出现两次 ⇒ 视为异常输入（见第 3 条）。
3. **统一 fail-closed（无部分结果）**：下列情形一律产生 `BASELINE_*` 类拒绝（如 `BASELINE_UNREADABLE` / `BASELINE_PARSE_FAILED`），
   **不产生 digest**，且**不得**以「部分输出 + 空值」替代：
   ①`git for-each-ref` / `git rev-parse` **非零退出码**；
   ②输出**解析失败**（字段数 ≠ 3、含 NUL、`refname` 为空、`refname` 重复）；
   ③**路径解析失败**（第 1 条）；
   ④`packed-refs` **存在但不可读**（只有**确认不存在**才允许零长度）。
4. **`signerAuthRef` 的验证时机 / 有效期 / 防重放**：
   - **验证时机**：`T0` 验证一次；进入 `T2` 事务前**再次验证**；两次之间失效 ⇒ 拒绝（`SIGNER_AUTH_INVALID`）；
   - **有效期**：必须携带**签发时刻与明确有效期**，**不得无限期**，且窗口**不得长于**单次 U2 执行窗口；过期 ⇒ 拒绝；
   - **防重放**：必须绑定**一次性 `nonce`**（或等价一次性挑战）并纳入签名/摘要覆盖范围；**同一 `signerAuthRef` 不得被两次执行复用**
     （第二次使用 ⇒ 拒绝并保留证据）；
   - 仍绑定 `{signerIdentity, instanceId, attestationDigest}`（§20.4.4 保留）。
5. **哈希证据口径（维持诚实表述）**：34 字节规范向量**保留为基准**；文档 SHA-256 与该向量的双实现复算**仍属送审方报告**，
   **不得**记为本轮**独立**哈希验证通过（一律 `*_VERIFICATION=NOT_INDEPENDENTLY_VERIFIED`）。
   本轮**未改变**编码规则（§20.4.1 的 v3 长度前缀编码原样保留）⇒ 现有向量**仍然适用**，无需重算。

### 21.4 R13 正反例验收矩阵（新增 U2-33 ~ U2-40）

| 编号 | 场景（正例/反例） | 期望断言（fail-closed） |
| --- | --- | --- |
| **U2-33** | 反例：`T1A` 探针**成功**取得锁（说明当前实例**未真正持锁**） | 拒绝，`LOCK_OWNERSHIP_UNPROVEN`，**零写入** |
| **U2-34** | 反例：探针锁定的对象与 `T1` 记录 **inode 不同**（路径被替换/重绑） | 拒绝，`PROBE_OBJECT_MISMATCH`，**零写入** |
| **U2-35** | 反例：`T1A` 通过后、`T2` 之前锁被**提前释放**（同 UID `LOCK_UN`/`close`，或对象被替换） | `T2` 前复检必须发现 ⇒ 拒绝，`LOCK_RELEASED_EARLY`，**零写入** |
| **U2-36** | 反例：**子进程继承锁 FD**（父进程退出后探针仍取锁失败） | 断言实现**不允许**该状态（`O_CLOEXEC`）；被观测到 ⇒ 记为缺陷 `LOCK_FD_LEAKED`；释放以 `close()` 为准 |
| **U2-37** | 正/反例：`RETURNING` 得一行后事务**显式 `ROLLBACK`** | `candidateInsertCommitState ∈ {NOT_COMMITTED, UNKNOWN}`，**禁止** `THIS_INSERT_COMMITTED` |
| **U2-38** | 反例：对账窗口内**非 U2 写入者**修改/删除候选行（模拟管理员/作业） | 结论 `UNKNOWN`/`NOT_COMMITTED`，**禁止** `THIS_INSERT_COMMITTED`，并保留对账证据 |
| **U2-39** | 反例：`git for-each-ref` 失败 / `refname` 重复 / 路径被引号包裹 | `BASELINE_*` 拒绝、**不产生 digest**、**无部分结果** |
| **U2-40** | 反例：`signerAuthRef` **过期**、或在 `T0`/`T2` 之间失效、或**被重放**（同一 ref 第二次执行使用） | 拒绝，`SIGNER_AUTH_INVALID`；且非 ASCII `refname` 在 `LC_ALL=C` 与 `LC_ALL=ja_JP.UTF-8` 下 digest **必须相同** |

### 21.5 R13 未变部分

§12 候选键 v2 与 digest 概念、§13.1 接口（本节点收紧语义）、§13.2 矩阵（另加 **U2-33 ~ U2-40**）、
§16.1 `CONTROLLED_FIXED_WORKTREE`、§17.1 隔离证明框架、§17.2 U2-20A/B/C、§17.3 零行冲突复用路径、
§18.1 释放全链校验、§18.2 行锁与重试边界、§19.4 通道/签发者分离、
**§20.3（CHANGE 42）已 PASS 的状态语义原样保留**、**§20.4.1 编码规则（v3 长度前缀）本轮未改**（向量仍适用）、
`builderRef` 固定常量、仅 INSERT、无 UPDATE/DELETE、不新增 schema/migration、不接 Runtime/Queue、
不调用模型/Provider、ACCOUNT 保持 `NOT_AUTHORIZED`、U1 封板 `9ee36837` 不变、
`SCHEMA_MIGRATION=HOLD`、`EXTERNAL_WRITE=HOLD`、`AUTO_MERGE/AUTO_DEPLOY=FORBIDDEN`、`PRODUCTION_READY=NO`。
本文件仍为**纯设计 R13**：未新增产品代码、未建表、未执行迁移、未接线运行时、未调用模型。

---

## 22. R14 修订（对应 MSG-20261009-38 的 CHANGE 47–53）

> 授权来源：`MSG-20261009-38 = REVISE` ⇒ `NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_R14_READ_ONLY_CHANGES_47_TO_53`。
> 本轮**只做**：①设计文本修订；②**本仓库范围内的只读证据核验**（仓库/迁移只读查询，不写产品代码）；
> ③审计归档。`U2_IMPLEMENTATION_AUTHORIZED=NO`、`U2_PLATFORM_ONLY_INSERT_SUBSET=NOT AUTHORIZED` **保持不变**。
> §21.3.4 的「验证时机/有效期」保留，其「一次性 nonce」表述由 §22.7 **收紧为原子消费**。

| CHANGE | R13 位置 | R14 修订位置 | 变更性质 |
| --- | --- | --- | --- |
| **CHANGE 47（P0）** | §21.1.1 的 `T1`/`T1A`/`T2` | **§22.1** | 锁**所有权证据链**（E1+E2）与 `T2` 前**持续持锁**验证 |
| **CHANGE 48（P0）** | §21.1.4（`close()` 为最终释放依据） | **§22.2** | **撤回并修正** flock 释放/继承语义；未受控复制 FD 检测 |
| **CHANGE 49（P1）** | §21.4 的 U2-33 ~ U2-36 | **§22.3** | 真实 **Linux 多进程**测试用例 |
| **CHANGE 50（P1）** | §21.2.2 / §21.2.3 / §21.2.4 | **§22.4** | 归因证据有效性（不复用四条件 / ROLLBACK / 持久化载体） |
| **CHANGE 51（P1）** | §21.2.1 / §21.2.2 | **§22.5** | 清单完整性升级为**准入条件** + 只读核验结果 |
| **CHANGE 52（P1）** | §21.3.1 / §21.3.2 | **§22.6** | 字节级输入契约**统一**（R13/R14 优先于 §20.4.1） |
| **CHANGE 53（P0）** | §21.3.4 | **§22.7** | `signerAuthRef` **原子消费**语义 |
| 验收矩阵 | §21.4 | **§22.3 / §22.8** | 新增 U2-33a ~ U2-36b、U2-40a/b、U2-41a/b |

### 22.1 CHANGE 47（P0）—— 锁**所有权证据链**（内核事实 + 独立互斥 + 持续持锁）

**承认审计方的判断**：独立探针**取锁失败**最多证明**该锁对象当前存在冲突锁**，
**不能**证明持锁者**就是当前实例**；`ownerToken` / `instanceId` / `(st_dev, st_ino)` 只是**身份关联**，
**不是**内核层面的锁所有权证明。R13 把「证明持锁者身份」的负担放在 `T1A` 上，是**归因错误**。

**R14 规则（三段证据，缺一不可）**

1. **`E1`（内核事实·必须由当前实例产生）**：`T1` 由**当前实例**在**指定 FD** 上执行
   `flock(fd, LOCK_EX | LOCK_NB)`，并**保留系统调用结果**（返回值与 `errno`）：
   - 返回 `0` ⇒ **内核**保证「**本实例的这个打开文件描述（OFD）**持有该锁对象的排他锁」——这是锁**所有权**的**最强证据**；
   - 返回 `EWOULDBLOCK`/`EINTR`/其他 ⇒ **拒绝**（`LOCK_ACQUIRE_FAILED`），零写入。
   `E1` 记录：**FD 号**、调用时刻、返回值/`errno`、`fstat(fd)` 的 `(st_dev, st_ino)`、
   进程 **PID + 启动时刻**（`/proc/<pid>/stat` 的第 22 字段，用于排除 **PID 复用**造成的身份误判）。
2. **`E2`（独立互斥·由独立进程观测）**：`T1A` 在**独立打开的文件描述**上执行
   `flock(fd2, LOCK_EX | LOCK_NB)` 并**断言失败**（`EWOULDBLOCK`）。
   `E2` 提供**第三方视角的互斥事实**，用于交叉验证 `E1` 未被误读（例如实现缺陷、错误 FD、错误锁对象）。
3. **证据链语义（明确写下）**：**`E1` 与 `E2` 组合**才构成锁所有权证据链——
   `E1` 证明「**本实例**持有」，`E2` 证明「**此刻该锁对象确实被持有**」；
   **禁止**让 `T1A` **单独**承担「证明持锁者是当前实例」的职责（这正是本轮被判 REVISE 的原因）。
   若 `E1` 与 `E2` 的 `(st_dev, st_ino)` 不一致 ⇒ `PROBE_OBJECT_MISMATCH`；若 `E1` 未成功而 `E2` 失败 ⇒
   `LOCK_OWNERSHIP_UNPROVEN`（持锁者是**别人**），两种情况均**拒绝**。

**`E3`（`T2` 前必须完成：打开文件描述**仍持续持有**排他锁）**

4. **明确不足**：仅做 `fstat(fd)` 与路径一致性检查**不足以**证明「该 OFD **此刻仍**持有排他锁」——
   这些只是元数据读取，既不能观测锁状态，也不能排除「同一 OFD 的复制 FD 上已执行 `LOCK_UN`」（见 §22.2）。
5. **可信 FD 生命周期控制（必需）**：
   ① 锁 FD 由**单一线程/单次调用**创建并持有，**禁止** `dup`/`dup2`/`dup3` 该 FD；
   ② **禁止**通过 `SCM_RIGHTS` 传递该 FD；
   ③ 派生任何子进程**之前**必须保证该 FD 不在继承集合（`O_CLOEXEC` + 显式 `closefrom`/`close_range`，或先派生后取锁）；
   ④ 锁文件**只**在本进程内以该 FD 打开，路径本身不得被用作「再次打开」的入口。
6. **检测式复核（detective control，如实标注其性质）**：`T0`（取锁**前**）与 `T2`（进入事务**前**）各执行一次
   **同 UID 全进程 FD 扫描**：枚举 `/proc/*/fd/*`，以 `readlink` 取目标并比对 `(st_dev, st_ino)`：
   - **期望恰为 1 个命中**（本实例的锁 FD）；**任何额外命中** ⇒ `LOCK_FD_LEAKED`，**拒绝**并保留扫描快照证据；
   - 该扫描**不是**原子保证，须与 §20.1.3 的 `SAME_UID_FS_ISOLATION = TRUSTED_ASSUMPTION` **共同**成立，
     并在证据中如实标注为「检测式控制」；
   - 平台**无法**提供 `/proc` 或无权限枚举 ⇒ **`EXCLUSIVE_WINDOW_UNAVAILABLE`**（不进入 `T2`）。
7. **`T2` 门禁**：`E1` 成功 **且** `E2` 成功 **且** 第 6 条扫描通过 **且** `signerAuthRef` 复验通过（§22.7.2）
   ⇒ 才允许进入数据库事务；任一不满足 ⇒ **拒绝**（不得以「反复读取元数据」代替）。
8. **降级路径（必须显式声明）**：若目标平台**无法**提供上述 FD 生命周期控制或检测式复核，
   U2 **不得**假设锁安全，必须返回 `EXCLUSIVE_WINDOW_UNAVAILABLE` 并零写入；
   **不得**以「更频繁地 `fstat`」作为补偿。

### 22.2 CHANGE 48（P0）—— **撤回并修正** flock 的释放与继承语义

**承认审计方的判断**：R13 §21.1.4 的「以 `close()` 为**最终释放依据**」**不准确**。
Linux 上 `flock` 锁关联的是 **open file description（OFD）**：

- **显式 `LOCK_UN` 可以解除该锁**，**即使**仍存在引用同一描述的**复制 FD**（锁状态属于该描述，`LOCK_UN` 清除它）；
- 反之，**只关闭其中一个 FD 并不保证解锁**（仍有副本 ⇒ 描述仍存在 ⇒ 锁仍然有效）。

**R14 规则（取代 §21.1.4 中与该结论冲突的表述）**

1. **锁的归属单位是 OFD，不是 FD 号**：`dup` / `fork` / `SCM_RIGHTS` 产生的**复制 FD 共享同一把锁**。
2. **释放必须同时满足并留下证据**：①`flock(fd, LOCK_UN)` **且** ②`close(fd)`；
   并须用**独立观测**确认「已释放」——**`T1A` 式独立探针能够成功取锁（随后立即 `LOCK_UN`/`close`）**；
   任一步失败、或探针**仍失败** ⇒ `lockReleaseFailed=true`，**保留状态与证据**（fd、`errno`、扫描结果、探针结果）。
3. **不得**声明「`close(fd)` 一定是最终释放依据」（**撤回** R13 表述）；释放结论必须来自第 2 条的独立观测。
4. **必须验证不存在未受控的复制 FD**：按 §22.1.6 的 `/proc` 扫描；发现额外副本 ⇒ `LOCK_FD_LEAKED`，**拒绝**并保留快照。
5. **`O_CLOEXEC` 的边界（必须写明）**：它**防止 FD 跨 `exec` 继承**，**不阻止 `fork` 时继承**
   ⇒ `fork` 前必须确保锁 FD 不在子进程继承集合（或子进程**立即** `close`），并在每次派生后**复查**（§22.1.6）。
6. **`SIGKILL` 的边界**：结束**持锁进程**并**不**代表其他仍持有同一 OFD 副本的进程也结束——
   **锁可能继续存在** ⇒ **不得**把「持锁进程已死」当作「锁已释放」。
7. **释放异常一律保留状态与证据**，**不得以时间戳推断锁已释放**（延续 §20.1.4；`residual lock file` 仍**不是**锁）。

### 22.3 CHANGE 49（P1）—— 真实 **Linux 多进程**测试（U2-33 ~ U2-36 扩展）

| 编号 | 场景（反例） | 期望断言 |
| --- | --- | --- |
| **U2-33a** | **U2 未持锁、其他进程持锁**（探针失败，但持锁者不是本实例） | 断言**不产生**「本实例持锁」结论：`E1` 未成功 ⇒ `LOCK_OWNERSHIP_UNPROVEN`，**零写入** |
| **U2-34a** | **同一 OFD 的复制 FD 上执行 `LOCK_UN`** | 断言**能检出**排他锁已丧失（`E3`/探针复检失败）⇒ **不得**进入或继续 `T2` |
| **U2-35a** | **`fork` 子进程继承锁 FD、父进程退出** | 断言**不误判**「锁已释放」（子进程仍持 OFD ⇒ 探针仍失败）；且实现须已按 §22.2 阻止/消除该副本（否则 `LOCK_FD_LEAKED`） |
| **U2-36a** | **证明完成 → 提交期间**锁被释放或路径/对象被替换 | 断言拒绝或安全中止（`LOCK_RELEASED_EARLY` / `LOCK_OBJECT_REPLACED`），**无写入** |
| **U2-36b** | 同 UID 扫描检出**额外 FD** 副本 | 断言 `LOCK_FD_LEAKED`，拒绝，并保留 `/proc` 扫描快照 |

**执行环境（必须如实标注）**：以上用例要求**真实 Linux 多进程**环境（真实 `flock`、真实 `/proc`）。
本开发机为 **Windows**，**无法**执行 ⇒ `U2_LINUX_MULTIPROCESS_TESTS=NOT_VERIFIED`、`LINUX_SYSTEMD=NOT_VERIFIED`。
**实施时必须**在 Linux 实机（或等价容器）上运行并留存原始输出作为证据。

### 22.4 CHANGE 50（P1）—— COMMIT 归因的**证据有效性**收紧

1. **低碰撞概率 ≠ 形式化绝对不复用**：不得仅凭 `id` 类型断言「全局不可复用」。设计须限定
   **数据库实例、恢复历史、ID 写入权限、观察窗口**四个条件（见第 2 条）。
2. **不复用的四条件（全部必需；任一无法核实 ⇒ 只能 `UNKNOWN`）**：
   ①**数据实例**：对账与写入针对**同一主库实例**（克隆/恢复出的历史库不得并发写入）；
   ②**恢复历史**：不存在 PITR/还原把旧行「重放」进观察窗口；
   ③**ID 写入权限**：只有受控写入者可 `INSERT`，且**不得**写入重复的 `id` 文本；
   ④**观察窗口**：窗口内不发生上述任一变更。
3. **显式 `ROLLBACK` 的判定**：只有在**可靠确认回滚完成**时，才可判定本次 INSERT **未提交**
   （例如驱动/连接层明确返回事务已回滚；或对账在**同一主库**观察到「该 `id` 不存在」且
   「同一 `dedupeKey` 的现存行具有不同的不可变字段」）；
   **连接异常、事务终态未知且查询未命中** ⇒ 仍为 `UNKNOWN`（**不得**推断为未提交，也不得推断为已提交）。
4. **跨进程恢复对账的证据载体**：只有**稳定、可持久化、可重新读取**的事务外记录（落盘日志/对账表）才能用于对账；
   **进程内变量**或**未确认落盘的日志**不构成持久化证据 ⇒ 等价于「`returnedCandidateId` 未保存」（§21.2.3 收紧）。

### 22.5 CHANGE 51（P1）—— 清单完整性是**准入条件**（含本仓库只读核验结果）

**R14 规则**：§21.2.1 的「全局写入者清单」由「未来须核对」**升级为写入前置门禁**。

1. **门禁项（全部必需；任一缺失 ⇒ `GLOBAL_IMMUTABILITY_UNPROVEN` / `EXCLUSIVE_WINDOW_UNAVAILABLE`，零写入）**：
   ①全部写入者已列举并附来源证据；②数据库**权限与触发器**已核验；
   ③**全观察窗口**不存在未记录的 `UPDATE`/`DELETE`；④`id` 不复用前提在**实际运行环境**成立。
2. **只读核验结果（本仓库范围；以下均为可复核的事实引用）**：
   - **候选表没有 append-only 触发器**：迁移仅对 `AutonomyMetricResult`、`AutonomyPromotionDecision`、
     `AutonomyRollbackRecord` 创建 `cc_append_only__*` 触发器
     （`apps/api/prisma/migrations/20261005000000_rsi_autonomy_state_persistence/migration.sql:297-310`）
     ⇒ `AutonomyCandidate` 行在**数据库层面可被 `UPDATE`/`DELETE`**（仅当存在子行时由 FK
     `ON DELETE RESTRICT` 阻止删除：同文件 `:179-191`）。
   - **表结构明确预期候选行会被更新**：`status` 有 10 态检查约束（同文件 `:233-235`），
     schema 含 `updatedAt @updatedAt`（`apps/api/prisma/schema.prisma:3311,3318`；迁移列为
     `"updatedAt" TIMESTAMP(3) NOT NULL`）⇒ 这与「U2 路径不 `UPDATE`/`DELETE`」不冲突，
     但**恰好证伪**「记录不会被替换」的**全局**说法。
   - **`id` 由客户端生成，数据库无默认值**：`id String @id @default(uuid())`
     （`schema.prisma:3309`）而迁移列为 `"id" TEXT NOT NULL`（**无 `DEFAULT`、无序列**，同文件 `:39`）
     ⇒ 「不复用」是**写入者行为属性**，**不是**数据库强制的不变量。
   - **当前 `apps/api/src` 中不存在候选写入/更新路径**（`prisma.autonomyCandidate.create` 仅出现在
     `apps/api/src/__tests__/` 下：`rsi-persistence-db.test.ts:51`、`rsi-reboot-reconcile-db.test.ts:107,152,277,304`）
     ⇒ 现时风险来自**未来/外部写入者与运维通道**，而非现存服务代码。
   - **迁移中未发现任何 `GRANT`/`REVOKE`/角色定义** ⇒ 数据库权限核验**在本仓库范围内无证据**。
3. **结论（如实标注）**：门禁项 ①②③④ **当前均未达成**（①部分、②④无证据、③无证据）
   ⇒ `DB_PRIVILEGE_VERIFICATION=NOT_VERIFIED`、`GLOBAL_IMMUTABILITY_PROOF=NOT_VERIFIED`；
   R14 **不得**据此授权任何写入；实施前必须补齐并在审计中给出**证据引用**（含目标库的权限/触发器查询输出）。

### 22.6 CHANGE 52（P1）—— 字节级输入契约**统一**（R13/R14 优先于 §20.4.1）

1. **优先级（明确）**：**§21.3.1、§22.6 优先于 §20.4.1**；§20.4.1 中「路径解析」「统一去除尾部分隔符」
   等与本章冲突的表述**作废**（避免同一文档出现两种可能产生不同 digest 的规定）。
2. **唯一路径字节来源（固定）**：`commonGitDirBytes` / `worktreeGitdirBytes` 取
   `git -C <worktreeRoot> rev-parse --path-format=absolute --git-common-dir`（及 `--git-dir`）
   **stdout 的原始字节**，**仅**去除命令产生的行尾换行（末尾 `0x0A`；CRLF 一并去除）；
   **不做**其他任何转换（**不**相对化、**不**去尾部分隔符、**不** `realpath`、**不**做字符串规范化、**不**改大小写）。
   `--path-format=absolute` 用以消除「相对 vs 绝对」的二义性；若 Git 不支持该选项、命令非零退出、
   或输出被 **C 风格引号包裹** ⇒ `BASELINE_*` 拒绝（**不**自行解码猜测）。
3. **完整调用参数与环境（必须固定并记录）**：`LC_ALL=C`、`GIT_OPTIONAL_LOCKS=0`、`-c core.quotePath=false`；
   两条 `rev-parse` 如上；`for-each-ref` 使用显式 `--sort=refname` 与
   `--format='%(refname)%1F%(objectname)%1F%(objecttype)'`（字段 `0x1F`、行 `0x0A`）；
   证据须记录实际 `git --version`、平台与 shell 环境。
4. **排序**：实现**必须**在读取后按**原始字节**重新排序（`memcmp` 语义，短者在前）；
   **不得**依赖区域设置，**不得**以 Git 输出顺序**未经校验**地替代规范排序
   （若选择信任 Git 顺序，则须增加一次「与字节排序结果一致」的校验，不一致即 `BASELINE_PARSE_FAILED`）。
5. **拒绝不能无损表示的输入**：`refname`/路径含 `NUL`、Git 以 C 风格引号包裹、或字节序列无法无损解析
   ⇒ `BASELINE_PARSE_FAILED`（**不产生 digest**、**无部分结果**）。
6. **编码版本与向量口径（本轮不改编码）**：编码仍为 **v3（长度前缀）**；
   现存的 **34 字节向量**保留为**编码器基准向量**，其输入为**合成字符串**（`.git` / `.git` / 空 / 空），
   **不代表**生产路径字节；
   **另须新增**一个「**绝对路径 + 非 ASCII**」向量（实施时补），并以**两种独立实现**复算；
   所有哈希结论在本轮**仍属送审方报告**（`NOT_INDEPENDENTLY_VERIFIED`）。

### 22.7 CHANGE 53（P0）—— `signerAuthRef` 防重放：**原子消费语义**

**承认审计方的判断**：一次性 `nonce` **仅被签名/摘要覆盖**，**不能**阻止两个实例**并发**使用同一 `nonce`
（签名只证明「该 `nonce` 曾由签发者签发」，**不**证明「只被消费一次」）。

**R14 规则**

1. **消费状态载体**：必须是**权威、跨进程可见、带唯一约束**的存储（例如以 `nonce` 为主键/唯一索引的一行，
   或既有等价受控面）；**禁止**以实现进程内的内存标记充当消费状态。
2. **`T0` 原子占用（一次性、仅一个获胜者）**：以**原子原语**占用该 `nonce`，例如
   `INSERT ... ON CONFLICT ("nonce") DO NOTHING RETURNING "id"`：
   - **返回一行** ⇒ **本次执行**取得该 `nonce` 的消费权；
   - **返回零行** ⇒ 已被占用 ⇒ **拒绝**（`SIGNER_AUTH_REPLAY`），**不得**继续。
3. **`T2` 复验（只读复核，不再消费）**：进入事务前仅**只读复核**「该 `nonce` 的占用者 **=** 本次执行的执行标识」
   且授权**仍在有效期**内；不满足 ⇒ `SIGNER_AUTH_INVALID`。
4. **崩溃后不得重生**：占用记录**不得**因进程崩溃而自动回到「未占用」
   （**禁止**用「进程存活 + TTL 抢占」把旧 `nonce` 变回可用）；若授权本身已过期，则**另行签发新 `nonce`**，
   **不得**复用旧 `nonce`。
5. **实例不匹配 / 过期** ⇒ 拒绝；**并发双实例**使用同一 `signerAuthRef` ⇒ **恰好一个**成功（由原子原语保证），
   另一个必须失败。
6. **能力缺失的处理（fail-closed）**：若现有可信控制面**不支持**原子占用（无唯一约束、只能「读-改-写」）
   ⇒ **保持 `EXCLUSIVE_WINDOW_UNAVAILABLE`**，默认拒绝；**不得**以「先读后写」模拟原子性。

### 22.8 R14 验收矩阵增补（除 §22.3 的 Linux 多进程用例外）

| 编号 | 场景 | 期望断言 |
| --- | --- | --- |
| **U2-40a** | 两个执行实例**并发**使用同一 `signerAuthRef`/`nonce` | **恰好一个**成功占用，另一个 **拒绝**（`SIGNER_AUTH_REPLAY`），且失败方零写入 |
| **U2-40b** | 占用后**进程崩溃并重启** | 旧 `nonce` **不可**再次使用（不得因崩溃/TTL 回退为可用）；须重新签发 |
| **U2-40c** | 控制面**无唯一约束**（只能读-改-写） | 保持 `EXCLUSIVE_WINDOW_UNAVAILABLE`，默认拒绝 |
| **U2-41a** | 非 ASCII `refname` + **绝对路径**输入，在 `LC_ALL=C` 与 `LC_ALL=ja_JP.UTF-8` 下分别计算 | 两次 digest **必须相同**（排序与编码不依赖区域设置） |
| **U2-41b** | 路径被 C 风格引号包裹 / 含 `NUL` / 非零退出码 | `BASELINE_*` 拒绝、**不产生 digest**、**无部分结果** |

### 22.9 R14 未变部分与未验证项

§12 候选键 v2 与 digest 概念、§13.1 接口、§13.2 矩阵（另加 **U2-33a ~ U2-41b**）、
§16.1 `CONTROLLED_FIXED_WORKTREE`、§17.1 隔离证明框架、§17.2 U2-20A/B/C、§17.3 零行冲突复用路径、
§18.1 释放全链校验、§18.2 行锁与重试边界、§19.4 通道/签发者分离、
§20.3（CHANGE 42）已 PASS 的状态语义、**§21.2（CHANGE 45）方向（本轮加严而非推翻）**、
§21.3.4 的验证时机与有效期、`builderRef` 固定常量、仅 INSERT（U2 路径）、无 `UPDATE`/`DELETE`（U2 路径）、
不新增 schema/migration、不接 Runtime/Queue、不调用模型/Provider、ACCOUNT 保持 `NOT_AUTHORIZED`、
U1 封板 `9ee36837` 不变、`SCHEMA_MIGRATION=HOLD`、`EXTERNAL_WRITE=HOLD`、
`AUTO_MERGE/AUTO_DEPLOY=FORBIDDEN`、`PRODUCTION_READY=NO`。

```text
R14_NOT_VERIFIED = U2_LINUX_MULTIPROCESS_TESTS ; DB_PRIVILEGE_VERIFICATION ;
                   GLOBAL_IMMUTABILITY_PROOF ; POSTGRESQL_INTEGRATION_TEST ; VITEST ; TSC ;
                   LINUX_SYSTEMD ; CI ; PRODUCTION ; U2_DESIGN_DOC_SHA256（送审方报告）
```

本文件仍为**纯设计 R14**：未新增产品代码、未建表、未执行迁移、未接线运行时、未调用模型。
本轮只读核验**仅**读取 `apps/api/prisma/schema.prisma` 与既有迁移文件，**未**连接任何数据库、**未**执行任何写入。

---

## 23. R15 修订（对应 MSG-20261009-39 的 CHANGE 54–60）

> 授权来源：`MSG-20261009-39 = REVISE` ⇒ `NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_R15_READ_ONLY_CHANGES_54_TO_60`。
> 本轮只做：①设计文本修订；②只读证据收集（仓库文本）；③审计归档。
> `U2_IMPLEMENTATION_AUTHORIZED=NO`、`U2_DESIGN_R14_ACCEPTED=NO`、`U2_PLATFORM_ONLY_INSERT_SUBSET=NOT_AUTHORIZED` **不变**。

| CHANGE | R14 位置 | R15 修订位置 | 变更性质 |
| --- | --- | --- | --- |
| **CHANGE 54（P0）** | §22.1.6（`T0` 也要求「恰好 1 个命中」） | **§23.1** | **撤回**该要求；改为 `T0`/`T1`/`T2` **分阶段**检查对象与合法 FD 集合 |
| **CHANGE 55（P0）** | §22.1.7（`T2` 门禁仅四条件） | **§23.2** | `T2` 加入**新的独立探针 `P2`** + 生命周期保证边界 |
| **CHANGE 56（P1）** | §22.1.6 / §22.5（扫描语义） | **§23.3** | 明确「**检测**」与「**保证**」的职责边界 |
| **CHANGE 57（P1）** | §22.4.3 | **§23.4** | COMMIT 归因**四类场景**与允许结论 |
| **CHANGE 58（P1）** | §22.5.2/§22.5.3 | **§23.5** | 证据范围**标注纪律**（不得越界为运行库证明） |
| **CHANGE 59（P1）** | §22.6.4/§22.6.5 | **§23.6** | 字节编码与 Git 命令边界**三项断言** |
| **CHANGE 60（P0）** | §22.7（原子占用） | **§23.7** | 消费记录的**持久化边界**与实施范围边界 |
| 验收矩阵 | §22.8 | **§23.2.4 / §23.7.7** | 新增 `U2-42a` ~ `U2-42d` |

### 23.0 送审范围口径（更正后的固定写法）

`MSG-20261009-39` 指出送审材料把「R14 设计提交自身的范围」误当作「R13→R14 审计范围」。
该更正已记录于 `docs/releases/SI-RSI-INTERNAL-CODE-REPAIR-V1.md` 的 `§2.43.0`（含实测依据）。
**此后每轮送审固定给出两个口径**（模板）：

```text
AUDIT_SCOPE      = <上一轮评审头>..<本轮 HEAD>   = <N> commits / <M> files（含裁决归档提交）
SINGLE_COMMIT    = <本轮设计提交父>..<本轮设计提交> = 1 commit / 1 file（本次仅设计文档）
PRODUCT_CODE     = 0（git diff <本轮 HEAD> -- apps/api 无输出）
```

### 23.1 CHANGE 54（P0）—— `T0` / `T1` / `T2` **分阶段**验收条件（消除时序矛盾）

**承认审计方的判断**：R14 §22.1.6 要求 `T0`（**尚未取锁**）与 `T2` 都出现「**恰好一个命中**＝当前实例的锁 FD」，
这在 `T0` 是**自相矛盾**的——`T0` 时本实例**尚未**取得锁，不可能存在「本实例的持锁 FD」。R14 表述**撤回**。

**R15 规则（分阶段定义检查对象 / 合法 FD 集合 / 失败码 / 证据局限）**

| 阶段 | 检查对象 | 合法集合（期望） | 失败码 | 证据局限（必须随证据记录） |
| --- | --- | --- | --- | --- |
| **`T0`**（取锁前） | 锁对象是否已被**本实例之外**的主体持有/打开 | **他方命中 = 0**；**不要求**本实例持锁（本实例命中应为 0） | `LOCK_OBJECT_FOREIGN_HOLDER` ⇒ `EXCLUSIVE_WINDOW_UNAVAILABLE` | 检测式；有竞态；`(dev,inode)` **不能**区分 OFD |
| **`T1`**（取锁） | 本实例**新创建**的锁 FD + `flock(LOCK_EX\|LOCK_NB)` 返回值（`E1`） | **恰好 1 个**本实例锁 FD；`E1` 返回 `0` | `LOCK_ACQUIRE_FAILED` | `E1` 是**历史事实**，不证明之后仍持锁 |
| **`T2`**（事务前） | 该 FD 所属 **OFD 是否仍持锁**（`P2` 探针，见 §23.2）+ FD 合法集合 + 授权复验 | 仍为**恰好 1 个**本实例锁 FD；`P2` 断言失败（`EWOULDBLOCK`） | `LOCK_RELEASED_EARLY` / `LOCK_FD_LEAKED` / `SIGNER_AUTH_INVALID` | `P2` 是**时点**证明，不是永久保证 |

1. **「同一 inode 的其他 FD」vs「同一 OFD 的复制 FD」（必须写明的判定边界）**：
   仅凭 `(st_dev, st_ino)` **相同**只能说明「指向同一**文件**」，**不能**判定两个 FD 是否引用**同一个打开文件描述**；
   区分二者需要更强的内核手段（例如 `kcmp(..., KCMP_FILE, ...)`，受权限限制）或由**受控执行环境**保证复制来源不存在。
   因此设计**不得**声称扫描具有该区分能力；**无法区分时按最坏情形处理**：任何他方 FD 命中 ⇒ 拒绝（fail-closed）。
2. **合法 FD 集合的定义**：`L0 = ∅`（`T0`，本实例尚未取锁）、`L1 = {本实例锁 FD}`（`T1` 后至 `T3` 释放前）。
   任何集合外命中 ⇒ 拒绝；本实例锁 FD 的**唯一性**由 §23.3 的结构性约束保证，扫描只作异常发现。
3. **检测证据的局限必须随证据保存**（含时间戳、扫描到的 PID/FD 清单、`(dev,inode)`、以及与 `L0`/`L1` 的差异）。

### 23.2 CHANGE 55（P0）—— `T2` 门禁加入**新的独立探针** `P2` + 生命周期保证

**承认审计方的判断**：`E1`/`E2` 是**历史观察**；FD 扫描**不能**证明锁仍有效。反例（评审方给出）：
`T1` 取锁 → 程序错误执行 `LOCK_UN` → **FD 仍打开、inode 未变** → `T2` 扫描**可能仍然通过** —— 此时「FD 存在」被错误等同于「锁仍被持有」。

**R15 规则**

1. **`T2` 门禁五项（全部必需）**：
   ① `E1` 事实记录存在且属于**本次执行**；
   ② **`P2`（新增）**：以**独立打开的文件描述**对同一锁对象执行 `flock(LOCK_EX|LOCK_NB)` 并**断言失败**（`EWOULDBLOCK`），
      记录结果与时间戳；**`P2` 必须在 `T2` 门禁处现场执行**（不得复用 `T1A` 的旧结果）；
   ③ FD 合法集合检查通过（`= L1`，见 §23.1.2）；
   ④ 授权复验通过（§23.7 / §21.3.4）；
   ⑤ **生命周期保证**成立（第 3 条）。
2. **`P2` 是时点证明，不是永久保证**（必须逐字写入报告）：`P2` 只说明「**该时刻**锁对象被持有」。
3. **从 `P2` 到 `COMMIT` 的锁状态由可信生命周期控制维持**（结构性保证，必需）：
   ① 锁 FD **唯一持有者**（本进程内无其他可达引用）；② **无 `dup`/`fork`/`SCM_RIGHTS` 复制来源**；
   ③ **`T3` 之前不存在任何执行 `LOCK_UN` 的代码路径**（含错误处理路径）；
   ④ 上述三条须以**结构与代码约束**（单持有者、无解锁路径）保证，**不得**以「重复探测」替代。
4. **无法证明该控制边界 ⇒ 拒绝写入**（`EXCLUSIVE_WINDOW_UNAVAILABLE` 或 `LOCK_LIFECYCLE_UNPROVEN`）。
5. **反例必须可被捕获**：对 §23.2 开头的反例（取锁后误 `LOCK_UN`），`P2` **必然成功取锁** ⇒ 断言 `LOCK_RELEASED_EARLY`、**零写入**。
6. **验收矩阵增补**：`T2`/生命周期相关新增用例列于 **§23.9**（`U2-43a` ~ `U2-43d`）；
   `nonce` 消费相关新增用例列于 **§23.7.7**（`U2-42a` ~ `U2-42d`）。

### 23.3 CHANGE 56（P1）—— 「**检测**」与「**保证**」的职责边界

| 机制 | 类型 | **能**证明 | **不能**证明 |
| --- | --- | --- | --- |
| 受控执行环境 + FD 操作约束（§23.2.3） | **保证**（结构性） | OFD 唯一持有与 `T3` 前锁状态维持 | 需要实现与平台支持；无法证明时 fail-closed |
| `E1`（`flock` 返回 `0`） | 历史事实 | 本实例 OFD **曾**取得排他锁 | 之后是否仍持锁 |
| `P2`（独立探针） | **时点**事实 | **该时刻**锁对象被持有（他方取不到） | 永久性；不区分 OFD |
| `/proc` FD 扫描 | **检测式** | 发现**异常**（他方持有、额外 FD） | 完整性保证：有竞态；inode 相同 ≠ OFD 相同 |

1. **职责划分（明确）**：锁生命周期由**受控执行环境与 FD 操作约束**负责；
   `/proc` 扫描**只负责发现异常**，**不承担**完整性证明。
2. **已知竞态与假设（如实列出）**：同 UID 进程可能在两次扫描之间打开/关闭 FD；
   `fork` 后子进程**关闭复制 FD** 也会改变文件描述生命周期，从而使「扫描通过」不再代表稳定状态。
3. **不可控派生的处理**：对无法受控的进程派生，**继续执行既有 fail-closed 规则**（§22.1.5、§22.2.5）。

### 23.4 CHANGE 57（P1）—— COMMIT 归因的**四类场景**与允许结论

| 类别 | 观察 | **允许**的结论 |
| --- | --- | --- |
| **1** | 数据库**确认完成显式 `ROLLBACK`** | **`NOT_COMMITTED`**（**唯一**可直接推出的类别） |
| **2** | `COMMIT` 请求失败、**事务终态未知** | **`UNKNOWN`**（除非满足 §22.4 全部前提，才可按第 5 条路径升级） |
| **3** | 对账查询主库**无匹配记录** | **`UNKNOWN`**（**不得**直接判 `NOT_COMMITTED`） |
| **4** | 对账查询存在**其他写入者创建的同键行** | **`UNKNOWN`**（**不得**判本次已提交；须按 §22.4 前提核对不可变字段与观察窗口） |

1. **升级为 `COMMITTED` 的唯一路径**：§22.4 四条件 + §22.5 全部门禁 + `id` 不复用 + `returnedCandidateId` 持久保存
   **全部成立**，且在**权威主库**重读到**匹配且必要不变字段一致**的行。
2. 任何一类**不得**以「记录存在」「键相同」「时间接近」等弱证据升级结论；**保持 `UNKNOWN`** 是默认（fail-closed）。

### 23.5 CHANGE 58（P1）—— 证据范围**标注纪律**（不得越界）

1. 本仓库只读核验的结论**只能**标注为 `REPOSITORY_SCHEMA_EVIDENCE_PARTIALLY_VERIFIED`
   （范围：`apps/api/prisma/**` 的**文本**）。
2. **禁止**由迁移文本推出运行库事实。以下项目一律 `NOT_VERIFIED`，直到有**目标库**查询输出：
   `DB_RUNTIME_PRIVILEGES`、`DB_TRIGGERS_ACTUAL`、`DB_ROLES`、`DB_WRITER_SET_ACTUAL`、`OBSERVATION_WINDOW_IMMUTABILITY`。
3. **固定结论句模板**（送审时逐字使用）：
   `REPOSITORY_SCHEMA_EVIDENCE_PARTIALLY_VERIFIED=YES（范围：apps/api/prisma/** 文本）`；
   `RUNTIME_DB_*=NOT_VERIFIED（无目标库证据）`。

### 23.6 CHANGE 59（P1）—— 字节编码与 Git 命令边界（三项断言）

1. **断言 A（字节级无歧义）**：`for-each-ref` 的**记录分隔**固定 `0x0A`、**字段分隔**固定 `0x1F`；
   **禁止**把 Git 输出当作一般字符串表格解析（不得按空白/引号/Unicode 规则切分）。
   `refname` / `objectname` / `objecttype` 中**不会**出现 `0x1F`/`0x0A`（前者受 Git ref 名校验、中者为十六进制、后者为固定枚举）；
   若**实际出现** ⇒ `BASELINE_PARSE_FAILED`（不产生 digest）。
2. **断言 B（排序基于原始字节）**：排序键为 `refname` 的**原始字节**；
   **禁止**「先解码为字符串再重新编码」（该往返还可能改变非 ASCII 字节），**禁止**大小写折叠与任何 locale 相关比较。
3. **断言 C（同一字节序列贯穿全程）**：`f(x) = 4 字节大端长度前缀 ++ x` 中的 `x` 必须与
   「读取到的原始字节」「用于排序的字节」**完全同一序列**；长度前缀按**字节长度**计算；
   **禁止**一处用解码后字符串、另一处用原始字节。
4. **失败语义**：任何解析/表示异常 ⇒ `BASELINE_PARSE_FAILED`，**不产生部分 digest**，**不得**「尽力解析」。

### 23.7 CHANGE 60（P0）—— `signerAuthRef` 消费的**持久化边界**与实施范围

1. **消费记录必须是权威存储中的一行**，且**唯一约束由数据库强制**（`INSERT ... ON CONFLICT DO NOTHING RETURNING` 语义）。
2. **持久确认的判定**：`T0` 占用后必须以**已提交**（durably committed）的方式确认该消费记录存在。
   **未确认落盘/未确认提交**时：
   - **不得**宣称该 `nonce` **已消费**（否则等于放弃一次性）；
   - 同时**也不得**继续执行（无法保证一次性）⇒ **终止本次执行**（fail-closed）；
   - 后续只能**重新签发授权**（新 `nonce`），**不得**抢占或复用旧 `nonce`。
3. **失败不回退**：`T0` 占用成功后，无论 `T1`/`T2`/`T3` 结果如何，该 `nonce` **永久保持已消费**
   （不得因失败、超时、崩溃而恢复为可用；**禁止** TTL 抢占）。
4. **必须区分两个对象（状态报告须分列）**：
   ①**已成功消费的授权状态**（authorization consumption，**控制面**）；
   ②**尚未发生的候选业务写入**（candidate INSERT，**数据面**）。
   两者**不同存储、不同语义**，**不得**互相推断或替代。
5. **与实施范围的关系（明确回答评审方的问题）**：写 `nonce` 消费记录**不属于**「U2 仅 INSERT 候选记录」的范围。因此在 `SCHEMA_MIGRATION=HOLD` 之下：
   - 若能复用**既有**权威存储，且其**唯一约束与事务边界**已核验 ⇒ 仅可在**另行明确授权**的范围内使用；
   - 若**不存在**满足条件的既有存储 ⇒ **保持 `EXCLUSIVE_WINDOW_UNAVAILABLE`**；**不得**新建表、
     **不得**以内存储/普通文件近似原子性。
6. **只读核验（本仓库文本范围；结论按 §23.5 限定）**：仓库中**已存在**同型「一次性消费/幂等」设计模式，可作**模式先例**（**不代表**可直接复用）：
   - `ControlledConfigExecutionReservation`（`apps/api/prisma/schema.prisma:3505-3527`）：
     `reservationKey @unique`、`idempotencyKey @unique`、`authorizationVerdictDigest @unique`、`authorizationTicketDigest @unique`，
     且对「同 key 不同载荷」显式 **FAIL CLOSED（禁止 silent overwrite）**（同文件 `:3526` 注释）；
   - `ControlledConfigExecutionDelivery`（`schema.prisma:3621-3635`）：**append-only 消费者交付账本**，
     `deliveryKey @unique` + `@@unique([outboxId, consumerRef])` + `consumedAt`，
     即「同一事件对同一消费者**至多一次**」的既有范式。
   **如实声明**：本轮**未**核验上述任一表可用于 U2 的 `nonce` 消费（语义归属、所有权、写入权限、与既有消费者语义冲突均未验证）
   ⇒ `U2_NONCE_CONSUMPTION_STORE = NOT_VERIFIED`。
7. **验收矩阵增补**：

| 编号 | 场景 | 期望断言 |
| --- | --- | --- |
| **U2-42a** | 消费记录**未确认提交** | **终止执行**；**不得**宣称已消费；只能重新签发 |
| **U2-42b** | 占用成功后 `T1`/`T2` 失败或进程崩溃 | `nonce` **永久已消费**（不得恢复可用）；后续只能重签 |
| **U2-42c** | 控制面无唯一约束（只能读-改-写） | `EXCLUSIVE_WINDOW_UNAVAILABLE`（默认拒绝） |
| **U2-42d** | 状态报告 | 必须**分别**给出「授权消费状态」与「候选写入状态」，二者不得互相推断 |

### 23.8 R15 未变部分

§12 候选键 v2 与 digest 概念、§13.1 接口、§13.2 矩阵（另加 U2-42a ~ U2-42d）、§16.1 `CONTROLLED_FIXED_WORKTREE`、
§17.1 隔离证明框架、§17.2 U2-20A/B/C、§17.3 零行冲突复用路径、§18.1 释放全链校验、§18.2 行锁与重试边界、
§19.4 通道/签发者分离、§20.3（CHANGE 42）状态语义、§21.2（CHANGE 45）方向、§21.3.4 验证时机与有效期、
§22.2（`flock` 释放/继承修正）、§22.4（四条件）、§22.6（字节级契约，本章 §23.6 追加三项断言）、
§22.7（原子占用，本章 §23.7 追加持久化边界）、`builderRef` 固定常量、**U2 路径仅 INSERT**、
U2 路径无 `UPDATE`/`DELETE`、不新增 schema/migration、不接 Runtime/Queue、不调用模型/Provider、
ACCOUNT 保持 `NOT_AUTHORIZED`、U1 封板 `9ee36837` 不变、`SCHEMA_MIGRATION=HOLD`、`EXTERNAL_WRITE=HOLD`、
`AUTO_MERGE/AUTO_DEPLOY=FORBIDDEN`、`PRODUCTION_READY=NO`。

### 23.9 R15 验收矩阵增补（T2/生命周期）

| 编号 | 场景 | 期望断言 |
| --- | --- | --- |
| **U2-43a** | `T1` 取锁后**误执行 `LOCK_UN`**（FD 仍开、inode 未变） | `P2` 必然成功取锁 ⇒ `LOCK_RELEASED_EARLY`，**零写入** |
| **U2-43b** | `T2` 时复用 `T1A` 的**旧探针结果** | 视为违规（`P2` 必须现场执行）；报告须含 `P2` 时间戳与结果 |
| **U2-43c** | `T0` 存在**他方持有**锁对象 | `LOCK_OBJECT_FOREIGN_HOLDER` ⇒ `EXCLUSIVE_WINDOW_UNAVAILABLE`（**不得**要求本实例已持锁） |
| **U2-43d** | 无法证明「`T3` 前无解锁路径 / 无复制来源」 | `LOCK_LIFECYCLE_UNPROVEN` ⇒ 拒绝写入（不得以重复探测替代） |

```text
R15_NOT_VERIFIED = U2_LINUX_MULTIPROCESS_TESTS ; DB_PRIVILEGE_VERIFICATION ; GLOBAL_IMMUTABILITY_PROOF ;
                   DB_RUNTIME_PRIVILEGES ; DB_TRIGGERS_ACTUAL ; DB_ROLES ; DB_WRITER_SET_ACTUAL ;
                   OBSERVATION_WINDOW_IMMUTABILITY ; U2_NONCE_CONSUMPTION_STORE ;
                   POSTGRESQL_INTEGRATION_TEST ; VITEST ; TSC ; LINUX_SYSTEMD ; CI ; PRODUCTION ;
                   U2_DESIGN_DOC_SHA256（送审方报告）
```

本文件仍为**纯设计 R15**：未新增产品代码、未建表、未执行迁移、未接线运行时、未调用模型。
本轮只读核验**仅**读取 `apps/api/prisma/schema.prisma` 与既有迁移文件，**未**连接任何数据库、**未**执行任何写入。

---

## 24. R16 修订（对应 MSG-20261009-40 的 CHANGE 61–63）

> 授权来源：`MSG-20261009-40 = REVISE` ⇒ `NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_R16_READ_ONLY_CHANGES_61_TO_63`。
> 本轮只处理三项实质问题（**不重复**已在 R15 闭合的 CHANGE 54/56/58/59）。
> `U2_DESIGN_R15_ACCEPTED=NO`、`U2_IMPLEMENTATION_AUTHORIZED=NO`、`U2_PLATFORM_ONLY_INSERT_SUBSET=NOT_AUTHORIZED` **不变**。

| CHANGE | R15 位置 | R16 修订位置 | 变更性质 |
| --- | --- | --- | --- |
| **CHANGE 61（P0）** | §23.2.1 / §23.2.5（把 `P2` 当所有权证据） | **§24.1** | `P2` 降为**必要非充分**；所有权改由**结构性保证 + 持锁状态证据**承担；异常分类与意外取锁处理 |
| **CHANGE 62（P1）** | §23.4（升级路径） | **§24.2** | 区分 `CANDIDATE_EXISTS` 与 `THIS_EXECUTION_COMMITTED`；**执行身份**归因 |
| **CHANGE 63（P1）** | §23.7.2（持久确认二分） | **§24.3** | `nonce` 消费引入 **`CONSUMPTION_UNKNOWN`** 三分支 |
| 验收矩阵 | §23.9 / §23.7.7 | **§24.4** | 新增 U2-44a ~ U2-44f、U2-45a ~ U2-45c、U2-46a ~ U2-46d |

### 24.1 CHANGE 61（P0）—— `P2` 只是**必要非充分**证据；所有权归因重构

**承认审计方的判断（并撤回 R15 的无条件表述）**：`P2` 收到 `EWOULDBLOCK` **只证明「该锁对象此刻存在冲突锁」**，
**不证明该锁由本实例持有**。审计方给出的反例成立：

```text
1) 本实例 T1 取得锁
2) 本实例误释放锁（LOCK_UN），但未关闭 FD
3) 另一进程取得同一锁对象的排他锁
4) 本实例执行 P2 → 得到 EWOULDBLOCK（看起来"正常"）
5) FD 扫描未及时发现另一进程
⇒ P2 通过，但本实例已失去锁所有权
```

因此 R15 §23.2.5「误释放后 `P2` **必然**成功取锁」**撤回**；该断言**仅在**「已确认不存在其他冲突持有者」时才成立。

**R16 规则**

1. **`P2` 的定位（明确写入规格）**：`P2_EWOULDBLOCK` 是锁所有权的**必要非充分证据**；
   它只能作**丧失检测器（loss detector）**：`P2` **成功取锁** ⇒ 排他**确定已丧失**（可据此拒绝）；
   `P2` **取锁失败** ⇒ **不能**推出「本实例仍持有」。
2. **所有权的证据来源（改为三要素，`P2` 不在其中承担归属证明）**：
   - **`O1`（内核事实）**：`T1` 在**本实例的 OFD** 上 `flock(LOCK_EX\|LOCK_NB)` 返回 `0`（`E1`），即**该时刻**内核保证**本实例该 OFD**持有排他锁；
   - **`O2`（结构性保证·必需）**：自 `E1` 成功起至 `T3` 释放前，**不存在**任何能解除该 OFD 锁的路径，且**不存在**该 OFD 的复制来源 —— 见第 3 条；
   - **`O3`（可查询的持锁状态·条件性）**：若目标平台提供**内核可查询**的持锁状态证据，则在 `T2` **查询并要求「仍持有」**；见第 4 条。
   **`O3` 不可得时，`O1 + O2` 必须足以成立；否则 `EXCLUSIVE_WINDOW_UNAVAILABLE`（第 5 条）。**
3. **`O2` 的可执行内容（结构性保证，必须逐条实现并可审计）**：
   ① 锁 FD **唯一持有者**：进程内除锁管理模块外**无可达引用**；**禁止** `dup/dup2/dup3`；
   ② **禁止** `SCM_RIGHTS` 传递；派生任何子进程前保证该 FD **不在继承集合**（`O_CLOEXEC` + 显式 `closefrom`/`close_range`，或**先派生后取锁**）；
   ③ **`T3` 之前不存在任何执行 `LOCK_UN`（或 `close` 锁 FD）的代码路径**，包括错误处理与超时路径；
   实现须以**单一释放点**表达（`T3` 唯一调用点），并在代码审查与测试中证明；
   ④ 运行期**辅助不变量**：维护 `releaseCounter`（仅 `T3` 递增）与 `dupCounter`（任何复制尝试即计数）；
   `T2` 门禁要求 `releaseCounter == 0 && dupCounter == 0`。
   **如实标注**：④ 是**实现不变量**，用于**发现缺陷**，**不是**内核权威状态；不得据此宣称「内核保证仍持锁」。
4. **`O3`（条件性可查询机制）—— 候选机制与未验证声明**：若目标内核提供**用户态可读**的持锁状态，
   实现**可以**在 `T2` 直接查询「本实例该 OFD 是否仍持有排他锁」，从而把「持续持锁」从**推断**变为**查询**。候选机制：
   - **候选 A（OFD 记录锁）**：以 `F_OFD_SETLK`/`F_OFD_GETLK` 族（OFD 记录锁）替代或叠加 `flock`，
     并读取 `/proc/self/fdinfo/<fd>` 中的锁条目进行**本进程**校验；OFD 记录锁的**归属单位为 OFD**，语义与 §22.2 的结论一致；
   - **候选 B（flock + 结构化保证 + `P2` 作丧失检测）**：`flock` 本身**没有**等价的「查询本 OFD 是否持锁」用户态接口，
     故只能依赖 `O2` 的结构保证＋`P2` 作为**丧失检测器**（无法检测「已丧失且他方持有」的反例，见上文）。
   **必须如实声明（重要）**：本轮**没有**在任何 Linux 主机上验证候选 A 的可用性（内核版本相关）、
   `/proc/self/fdinfo` 字段语义、或 `flock` 的可观测性 ⇒ `O3_MECHANISM_VERIFIED = NOT_VERIFIED`。
   实施前必须在**目标内核**上以**可复现实验**确认：查询接口存在、返回值可区分「持有/未持有」、且**不引入**新的语义陷阱
   （例如「关闭该文件的其他 FD 会释放全部锁」这类 POSIX 记录锁陷阱 —— 候选 A 若采用 OFD 变体可避免，但**须实测确认**）。
5. **fail-closed 判据**：若 ①`O2` 无法实现（存在复制来源或存在 `T3` 前解锁路径且无法消除），或
   ②`O3` 不可得**且**实现无法证明 `O2` 成立 ⇒ **`EXCLUSIVE_WINDOW_UNAVAILABLE`，零写入**；
   **禁止**以「重复执行 `P2`」「依赖 FD 存在」「依赖时间戳」替代所有权证明。
6. **`P2` 的错误分类（必须区分，不得一律当作「正常冲突」）**：

| `P2` 结果 | 语义 | 处理 |
| --- | --- | --- |
| `EWOULDBLOCK` | 存在冲突锁（**必要非充分**） | 继续，但**不**据此宣称本实例持锁（须由 `O1+O2(+O3)` 承担） |
| **返回 0（意外取得锁）** | **排他确定已丧失** | 立即对**探针 FD** 执行 `LOCK_UN` + `close()`（**安全释放**并记录）；**拒绝本次业务写入**；`LOCK_OWNERSHIP_UNPROVEN` |
| `EACCES` / `EPERM` | 无权限对锁文件加锁（无法推理排他） | **拒绝**（`EXCLUSIVE_WINDOW_UNAVAILABLE`） |
| `EBADF` | 探针 FD 无效 ⇒ 实现缺陷 | **拒绝**（`LOCK_PROBE_INVALID_FD`），并记为缺陷 |
| `EINTR` | 被信号中断 | 有界重试；仍失败 ⇒ **拒绝** |
| 其他 `errno` | 未分类错误 | **拒绝**（fail-closed），并保留原始输出 |

7. **探针资源纪律**：`P2`（以及 `T1A`）的探针 FD **必须在探针结束前关闭**；
   探针**意外取得锁**时，须在**同一次探针流程内**完成 `LOCK_UN` + `close()`，
   且**不得**把探针获得的锁用于推进事务；探针留下的任何状态都要记录。
8. **跨进程 FD 扫描的定位（收敛）**：扫描**只能**在**明确支持并可验证的 Linux 隔离环境**内作为**辅助检测**；
   **不得**作为锁所有权的**权威来源**（其竞态与「inode 相同 ≠ OFD 相同」的局限已在 §23.3 承认）。
9. **错误码（采用审计方建议）**：`LOCK_OWNERSHIP_UNPROVEN`、`LOCK_PROBE_INVALID_FD`，以及既有 `EXCLUSIVE_WINDOW_UNAVAILABLE`。

### 24.2 CHANGE 62（P1）—— COMMIT 归因必须区分**存在**与**本次执行提交**

**承认审计方的判断**：「相同主键 + 相同候选内容 + 相同时间窗口」**不必然**等于**同一次执行**提交。

**R16 规则**

1. **两个结论必须分列（不得合并）**：
   - **`CANDIDATE_EXISTS`**：主库存在一条「`dedupeKey` 相同且必要不变字段一致」的行 —— 这只说明**候选记录已存在**
     （可能由**本实例**插入，也可能由**其他写入者**插入）；
   - **`THIS_EXECUTION_COMMITTED`**：主库中的该行**由本次执行的事务提交**产生 —— 需要**执行身份**证据，见第 2 条。
2. **执行身份（`executionIdentity`）—— 定义与要求**：`THIS_EXECUTION_COMMITTED` 必须绑定一个
   **本次执行生成、不可被其他写入者预测或伪造、且可跨进程重新读取**的标识：
   ①**来源**：由执行上下文在 `T1` 之前生成（例如随机 128 位标识 `executionRef`），与 `returnedCandidateId` 一并记录；
   ②**不可伪造性**：`executionRef` **不得**出现在任何**其他写入者可写**的位置，且**不得**由 `dedupeKey`/`scopeRef` 等**可推导**字段派生
   （否则其他写入者可用相同算法构造出相同值 ⇒ 归因失效）；
   ③**绑定关系**：必须记录 `{executionRef, returnedCandidateId, dedupeKey, attemptNo}` 的**同一事务外持久记录**（§21.2.3 已要求持久载体）。
3. **schema 边界（只读核验结论，必须如实标注）**：`AutonomyCandidate` 现有列为
   `id / taskId / status / builderRef / baselineRef / codeCommitRef / promptVersion / dedupeKey / createdAt / updatedAt`
   （`apps/api/prisma/schema.prisma:3308-3328`）——**没有**承载 `executionRef`/执行身份的列；
   在 `SCHEMA_MIGRATION=HOLD` 之下**不得**新增列。
   ⇒ **`THIS_EXECUTION_COMMITTED` 不能仅由候选行本身推出**；只能由「**事务外持久记录**（第 2 条）」
   ＋「**权威主库按 `returnedCandidateId` 重读并校验必要不变字段**」共同支持。
   若该持久记录**缺失/不可读/其内容与重读结果不一致** ⇒ **只能 `UNKNOWN`**（不得升级为 `COMMITTED`）。
4. **`id` 的可伪造性边界**：`id` 是客户端生成的 `TEXT`（`schema.prisma:3309`；迁移列 `"id" TEXT NOT NULL`，无数据库默认值，`migration.sql:39`）。
   因此「主库中存在 `id = returnedCandidateId` 的行」在**原则上**也可由**知道该值**的其他写入者造成 ⇒
   这正是必须叠加**执行身份**与**四条件**（§22.4）的原因；**禁止**仅凭 `id` 命中宣称 `THIS_EXECUTION_COMMITTED`。
5. **状态报告字段（新增/明确）**：
   `candidateExists ∈ {YES, NO, UNKNOWN}`、`thisExecutionCommitted ∈ {YES, NO, UNKNOWN}`、
   `executionIdentityRef`（可空）、`executionIdentitySource`（生成点与持久载体引用）。
   **禁止**由 `candidateExists=YES` 推出 `thisExecutionCommitted=YES`。
6. **与既有语义的关系**：§21.2 的 `candidateInsertCommitState` 语义不变；
   `COMMITTED` 的判定条件**收紧为**：§22.4 四条件 + §22.5 全部门禁 + `id` 不复用 + `returnedCandidateId` **持久**保存
   + **`executionIdentity` 成立**（第 2 条）+ 权威主库重读一致。

### 24.3 CHANGE 63（P1）—— `nonce` 消费状态必须有 **`CONSUMPTION_UNKNOWN`** 分支

**承认审计方的判断**：R15 §23.7.2 的二分（「已持久确认」/「未确认」）不足以表达**消费事务终态不可知**的情形，
会导致**状态误报**（把未知说成未消费）。

**R16 规则（三分支）**

| 分支 | 触发条件 | 允许的报告 | 后续动作 |
| --- | --- | --- | --- |
| **`CONSUMED`** | 消费事务**已提交并确认**（含「事后确认已提交」） | 报 `CONSUMED` | 继续/终止按业务结果；**旧 `nonce` 永不释放** |
| **`UNCONSUMED`** | 数据库**明确确认消费事务已回滚**（且仅此一种情形） | 报 `UNCONSUMED` | 终止本次执行；**只能重新签发**新 `nonce`（不得复用旧值） |
| **`CONSUMPTION_UNKNOWN`** | 消费事务**提交结果不可知**（提交请求失败、连接中断、超时、崩溃等） | **必须**报 `CONSUMPTION_UNKNOWN` | **终止本次执行**；**旧 `nonce` 不可重试**；**只能重新签发授权** |

1. **禁止的误报（逐条写死）**：①**不得**把 `CONSUMPTION_UNKNOWN` 报成 `UNCONSUMED`（状态误报）；
   ②**不得**把 `CONSUMPTION_UNKNOWN` 报成 `CONSUMED`（把不确定当确定）；
   ③**不得**因「候选业务记录尚未写入」而释放或复位旧 `nonce`。
2. **安全默认**：`CONSUMPTION_UNKNOWN` 之下，**按「已消费」执行安全策略**（不复用、不重试），
   但在**报告**上必须如实标注为**未知**——**安全策略**与**事实陈述**分开表达。
3. **与候选写入状态分离**：`authorizationConsumptionState ∈ {CONSUMED, UNCONSUMED, CONSUMPTION_UNKNOWN}` 与
   `candidateInsertCommitState ∈ {COMMITTED, NOT_COMMITTED, UNKNOWN}` **互相独立**；
   报告须**分列**，**不得**由一者推断另一者（与 §23.7.4 的两个对象一致）。
4. **消费记录不得被清理**：任何清理/GC/重试路径**不得**删除或复位消费记录；
   `CONSUMPTION_UNKNOWN` 的处置是**人工/控制面签发新授权**，不是自动回滚。

### 24.4 R16 验收矩阵增补

| 编号 | 场景 | 期望断言 |
| --- | --- | --- |
| **U2-44a** | **本实例提前释放 + 第三方随后取锁**（审计方反例，**真实 Linux 多进程**） | `P2` 得 `EWOULDBLOCK` **但不得**据此判定本实例持锁；`O2` 不变量（`releaseCounter`）必须暴露违规；**零候选写入**（`LOCK_OWNERSHIP_UNPROVEN`/`EXCLUSIVE_WINDOW_UNAVAILABLE`） |
| **U2-44b** | `P2` **意外取得锁** | 探针 FD 立即 `LOCK_UN` + `close()`（安全释放并记录）；**拒绝业务写入**；报告含探针释放证据 |
| **U2-44c** | `P2` 返回 `EACCES`/`EPERM` | **拒绝**（`EXCLUSIVE_WINDOW_UNAVAILABLE`），不得当作「正常冲突」 |
| **U2-44d** | `P2` 返回 `EBADF` | **拒绝**（`LOCK_PROBE_INVALID_FD`）并记为缺陷 |
| **U2-44e** | `T3` 前出现任何 `LOCK_UN` 路径或 `dup` 尝试 | 门禁拦截（不变量计数 ≠ 0）⇒ 拒绝写入 |
| **U2-44f** | `O3` 机制不可得且 `O2` 无法证明 | `EXCLUSIVE_WINDOW_UNAVAILABLE`（fail-closed），不得以重复 `P2` 替代 |
| **U2-45a** | 其他写入者插入**同 `dedupeKey`** 的行 | 只能报 `candidateExists=YES`；`thisExecutionCommitted` 必须为 `NO/UNKNOWN` |
| **U2-45b** | 事务外持久记录缺失/不可读 | `thisExecutionCommitted=UNKNOWN`（不得升级 `COMMITTED`） |
| **U2-45c** | `executionRef` 可由可推导字段生成 | 视为**设计缺陷**（归因失效）；须改为不可预测、不可推导的随机标识 |
| **U2-46a** | 消费事务提交结果不可知（超时/断连） | 报 `CONSUMPTION_UNKNOWN`；终止执行；旧 `nonce` 不可重试 |
| **U2-46b** | 数据库明确确认消费事务回滚 | 报 `UNCONSUMED`（唯此情形）；仍需**重新签发**新 `nonce` |
| **U2-46c** | 消费已提交但业务候选未写入 | 报 `CONSUMED`；**不得**释放/复位旧 `nonce` |
| **U2-46d** | 报告组装 | 必须**分列** `authorizationConsumptionState` 与 `candidateInsertCommitState`，不得互相推断 |

### 24.5 R16 未变部分

§12 候选键 v2 与 digest 概念、§13.1 接口、§13.2 矩阵（另加 U2-44a ~ U2-46d）、§16.1 `CONTROLLED_FIXED_WORKTREE`、
§17.1 隔离证明框架、§17.2 U2-20A/B/C、§17.3 零行冲突复用路径、§18.1 释放全链校验、§18.2 行锁与重试边界、
§19.4 通道/签发者分离、§20.3（CHANGE 42）状态语义、§21.2（CHANGE 45）方向、§21.3.4 验证时机与有效期、
§22.2 `flock` 释放/继承修正、§22.4 四条件、§22.6 字节级契约、§22.7 原子占用、
§23.1 T0/T1/T2 分阶段条件、§23.3 检测 vs 保证、§23.4 归因四类（本章 §24.2 追加执行身份）、
§23.5 证据范围纪律、§23.6 字节编码三断言、§23.7 消费持久化（本章 §24.3 追加三分支）、
`builderRef` 固定常量、**U2 路径仅 INSERT**、U2 路径无 `UPDATE`/`DELETE`、不新增 schema/migration、
不接 Runtime/Queue、不调用模型/Provider、ACCOUNT 保持 `NOT_AUTHORIZED`、U1 封板 `9ee36837` 不变、
`SCHEMA_MIGRATION=HOLD`、`EXTERNAL_WRITE=HOLD`、`AUTO_MERGE/AUTO_DEPLOY=FORBIDDEN`、`PRODUCTION_READY=NO`。

```text
R16_NOT_VERIFIED = O3_MECHANISM_VERIFIED（候选 A / fdinfo 语义未在目标内核实测） ;
                   U2_LINUX_MULTIPROCESS_TESTS ; DB_PRIVILEGE_VERIFICATION ; GLOBAL_IMMUTABILITY_PROOF ;
                   DB_RUNTIME_PRIVILEGES ; DB_TRIGGERS_ACTUAL ; DB_ROLES ; DB_WRITER_SET_ACTUAL ;
                   OBSERVATION_WINDOW_IMMUTABILITY ; U2_NONCE_CONSUMPTION_STORE ;
                   POSTGRESQL_INTEGRATION_TEST ; VITEST ; TSC ; LINUX_SYSTEMD ; CI ; PRODUCTION ;
                   U2_DESIGN_DOC_SHA256（送审方报告）
```

本文件仍为**纯设计 R16**：未新增产品代码、未建表、未执行迁移、未接线运行时、未调用模型。
本轮只读核验**仅**读取 `apps/api/prisma/schema.prisma` 与既有迁移文件，**未**连接任何数据库、**未**执行任何写入。

---

## 25. R17 修订（对应 MSG-20261009-41 的 CHANGE 64–66）

> 授权来源：`MSG-20261009-41 = REVISE` ⇒ `NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_R17_READ_ONLY_CHANGES_64_TO_66`。
> 本轮只处理三项（**不重复**已通过的 CHANGE 54/56/58/59，也**不重做**已接受的 `P2` 必要非充分与错误分类设计）。
> `U2_DESIGN_R16_ACCEPTED=NO`、`U2_IMPLEMENTATION_AUTHORIZED=NO`、`U2_PLATFORM_ONLY_INSERT_SUBSET=NOT_AUTHORIZED` **不变**。

| CHANGE | R16 位置 | R17 修订位置 | 变更性质 |
| --- | --- | --- | --- |
| **CHANGE 64（P0）** | §24.1.4（`O3` 候选机制 A） | **§25.1** | `O3` 改为**证据等级制**并给出**校验清单**；`F_OFD_GETLK` 不得作自身持锁的肯定证明 |
| **CHANGE 65（P1）** | §24.1.3（`O2` 不变量） | **§25.2** | `O2` 升级为**统一锁 FD 边界** + **全窗口覆盖**；计数器降为辅助 |
| **CHANGE 66（P0）** | §24.2（执行身份） | **§25.3** | `COMMITTED` 需**可信因果绑定**；给出现行 schema 下不新增列的候选机制 |
| 验收矩阵 | §24.4 | **§25.4** | 新增 U2-47a/U2-47b 的落地断言，另加 U2-48a ~ U2-48e、U2-49a ~ U2-49c |

### 25.1 CHANGE 64（P0）—— `O3` 改为**证据等级制**；`F_OFD_GETLK` 不得作自身持锁的肯定证明

**承认审计方的判断**：`F_OFD_GETLK` 是**冲突查询**接口（回答「若现在请求该锁，会不会冲突」），
**不是**「查询**本 OFD** 是否持锁」的接口；`/proc/self/fdinfo` 的锁条目能否稳定完成 **OFD 归属**关联，
取决于内核行为与解析方式。R16 把候选 A 表述为「查询并要求仍持有」**过于乐观**，现予**收窄**。

**R17 规则**

1. **`O3` 证据等级（三值，必须显式给出）**：

| 等级 | 含义 | 对 `T2` 门禁的作用 |
| --- | --- | --- |
| **`O3-PROVEN`** | 有**本 OFD 归属**的**肯定**证据（锁类型 + 目标对象 + 锁范围 + OFD 归属**四要素齐备**，见第 2 条） | 可作为「仍持有」的**正向**证据（但仍不替代 `O1`+`O2`） |
| **`O3-CONTRADICTED`** | 有**否定**证据（例如本实例自查显示该 OFD **未**持有目标锁） | **拒绝**（`LOCK_RELEASED_EARLY`），零写入 |
| **`O3-INCONCLUSIVE`** | 查询**只能**证明「存在冲突锁」或无法完成 OFD 归属判定（含 `F_OFD_GETLK` 单用、`fdinfo` 条目不完整、内核行为未验证） | **不提供任何正向证据**；必须**完全依赖 `O2`**（§25.2）成立；否则 `EXCLUSIVE_WINDOW_UNAVAILABLE` |

2. **`fdinfo` 校验清单（必须四项全查，缺一即 `O3-INCONCLUSIVE`）**：
   ①**锁类型**：确认条目属于**本实现实际使用的锁族**（OFD 记录锁 / 其他），不得把**同 inode 上其他进程的锁条目**当作本 OFD 的证据；
   ②**目标对象**：锁条目对应的对象与 `T1` 记录的 `(st_dev, st_ino)` 一致；
   ③**锁范围**：为**整个目标文件**（或与设计声明的范围完全一致），不接受部分范围冒充全文件锁；
   ④**OFD 归属**：该条目必须可归因到**本实例自 `T1` 起持有且从未复制**的那个 OFD
   （依据 §25.2 的唯一持有者边界）；**无法完成归属判定 ⇒ `O3-INCONCLUSIVE`**。
3. **`F_OFD_GETLK` 的定位（写死）**：**不得**被单独视为「自身持锁」的肯定证明；
   它最多可产生 `O3-CONTRADICTED`（冲突查询显示存在冲突且非本 OFD）或 `O3-INCONCLUSIVE`。
4. **机制可用性的前置条件（未验证则不得使用）**：使用任何 `O3` 机制前，必须在**目标内核**上以**可复现实验**确认：
   接口存在、语义与本文一致、且能区分「本 OFD 持有 / 本 OFD 未持有 / 他方持有」三种情形。
   未完成验证 ⇒ `O3` 一律按 **`INCONCLUSIVE`** 处理（等价于 `O3` 不可用）。
   **如实声明**：本轮**未**在任何 Linux 主机上验证任何 `O3` 机制 ⇒ `O3_MECHANISM_VERIFIED = NOT_VERIFIED`（延续 §24.1.4）。
5. **失败组合的处理（与 §24.1.5 一致）**：`O3` 不可用（`INCONCLUSIVE`）时，
   **仅当** `O2` 的持续持锁结构保证**确实成立**（§25.2）才可继续；否则 **拒绝写入**。
6. **禁止事项**：`O3` 绝**不得**用于「重新获取锁」或「掩盖已丧失」（例如在 `T2` 通过再取锁把状态"修好"）；
   任何 `O3` 查询**不得**改变锁状态（只读）。

### 25.2 CHANGE 65（P1）—— `O2` 升级为**统一锁 FD 边界**与**全窗口覆盖**

**承认审计方的判断**：`releaseCounter == 0` **不能替代**真实的结构保证——
若某个**未经过锁管理模块**的原生调用执行了 `close(fd)`，计数器**可能仍为零**，而锁已经丢失。

**R17 规则**

1. **统一锁 FD 边界（`LockFdBoundary`，唯一持有与唯一释放点）**：
   ① **唯一创建**：锁 FD 只能由该边界模块创建（`open` + `O_CLOEXEC`）；
   ② **不导出**：**禁止**把原始 FD 号或任何可对其调用 `close`/`dup` 的句柄**导出**到边界之外
   （对外只提供「已持有」的**不透明能力对象**）；
   ③ **唯一释放**：`close` 与任何 `LOCK_UN` **只能**出现在该模块的 `T3` 释放函数内（**单一释放点**）；
   ④ **唯一查询**：`fstat`/`flock`/`fdinfo` 等访问**只能**经该模块（保证与 §25.1 的 `O3` 校验同源）。
2. **必须纳入的运行环境边界（逐条声明并测试）**：
  ① **native addon / FFI**：U2 执行路径内**禁止**引入可执行 `close`/`dup`/`flock` 的原生扩展或 FFI 调用；
     如无法排除 ⇒ 该路径**不得**进入排他写入窗口；
  ② **子进程派生**：派生前后按 §22.2 处理（`O_CLOEXEC` + 显式排除继承集合），并**禁止**以任何形式的 FD 传递（含 `SCM_RIGHTS`）；
  ③ **异常退出/信号**：进程被 `SIGKILL` 等终止时，因**不存在副本**（第 1 条 ②），内核释放**全部**引用 ⇒ 不依赖时间戳；
     但**必须**在重启路径上重新走 `T0~T2` 全流程，不得假设「上次的锁还在」；
  ④ **运行时/语言层**：明确禁止使用可绕过该边界的接口（例如直接调用底层 fd 操作、`process.binding`、第三方库的 `close` on raw fd）。
3. **静态约束（可审计）**：
  ① 代码检查规则：在 `LockFdBoundary` 模块**之外**出现 `dup`/`close`/`flock`/`SCM_RIGHTS`/原生 fd 操作 ⇒ **构建失败**；
  ② 依赖策略：U2 执行路径的依赖清单中**不得**出现原生扩展（或必须提供「无 fd 操作」的证明）。
4. **运行期辅助（降级为辅助，不构成保证）**：`releaseCounter` / `dupCounter` **保留**，
   但其语义**明确**为「**发现缺陷**」而不是「证明保持」；**不得**以计数器为 0 宣称结构保证成立。
5. **全窗口覆盖（关键）**：持锁证明必须覆盖**整个实际写入窗口** ——
   自 `T2` 门禁通过起，经**事务执行**、**`COMMIT` 尝试**、**结果未知的对账**，直到 `T3` 释放为止；
   **不得**只在 `T2` 瞬间成立。若在窗口内任何时点可能失去锁（存在未受控释放路径）⇒ 排他窗口**不成立**，**拒绝写入**。
6. **fail-closed**：无法满足第 1~3 条（或无法证明其成立）⇒ `LOCK_LIFECYCLE_UNPROVEN` / `EXCLUSIVE_WINDOW_UNAVAILABLE`，零写入。

### 25.3 CHANGE 66（P0）—— `COMMITTED` 需**可信因果绑定**（在执行身份与数据库提交事件之间）

**承认审计方的判断**：R16 的随机 `executionRef` 能证明「**执行记录**的身份」，
**不能**自动证明「**数据库行的创建者**」。审计方反例（E1 提交结果未知 + 有写入权限的 E2 以相同候选 ID 插入内容一致的行 + E1 外部记录仍存在）成立。

**R17 规则**

1. **归因要求**：`THIS_EXECUTION_COMMITTED` 必须建立在**执行身份**与**数据库提交事件**之间的**可信因果绑定**之上；
   仅「外部记录与候选行内容一致」**不构成**因果绑定。
2. **候选因果绑定机制（设计候选；必须至少实现一种并给出目标环境证据）**：
   - **M1（首选，不新增 schema）同事务事务标识 + 行系统列比对**：在**同一事务内**读取**当前事务标识**（PostgreSQL：`pg_current_xact_id()`，返回 64 位 xid8），
     并在 `COMMIT` 前将其与 `returnedCandidateId` 一并写入**事务外持久记录**；对账时在**权威主库**读取该行的**插入事务标识**
     （PostgreSQL 行系统列 `xmin`，32 位），与本实例捕获的事务标识**在防回绕窗口内**比对 ⇒ 一致方可支持 `THIS_EXECUTION_COMMITTED`。
     **优势**：行系统列**由数据库维护**，**其他写入者无法伪造**；且该行若被**他方更新/删除重插**，`xmin` 会变化 ⇒ **自动检测外来修改**（与 CHANGE 57/62 的保守性一致）。
   - **M2 同事务数据库审计记录**：由**同一事务**写入一条审计记录，关联 `{executionRef, candidateId}`；
     需要既有可写对象或新表（后者属 schema 变更，当前 `HOLD`）⇒ 若只能新建表 ⇒ **本轮不可用**。
   - **M3 写入凭证隔离**：证明**只有本次事务**能使用该特定写入凭证（例如每次执行专属的、受控签发的数据库会话/凭证），
     并从同一事务内可验证地取得该凭证标识 ⇒ 需要基础设施支持。
   - **M4 受信边界的事务回执**：由**受信数据库写入边界**提供可**持久验证**的事务回执（等价于 M1 的托管形态）。
3. **M1 的必须注意事项（如实列出；未验证项不得当作已成立）**：
   ① `xmin` 为 **32 位**，xid8 为 **64 位** ⇒ 比对必须在**防回绕窗口**内进行（捕获与对账之间不得跨过 xid 回绕），
      跨窗或无法确定 ⇒ **`UNKNOWN`**；
   ② 读取行系统列需要**原始 SQL**（Prisma 需用 `$queryRaw` 等）；若目标驱动/权限**不允许**读取系统列 ⇒ 机制**不可用** ⇒ `UNKNOWN`；
   ③ 行被**更新**（含 HOT 更新）或**删除后重插** ⇒ `xmin` 变化 ⇒ 比对失败 ⇒ 结论退回 `UNKNOWN`（保守）；
   ④ 该机制**不新增 schema**，但**必须**在目标 PostgreSQL 版本上实测确认（函数名/返回值/权限/系统列可读性）。
4. **只读核验（本仓库范围）**：仓库**已具备**原始 SQL 通道的先例 —— `$queryRaw` / `$executeRaw` 在
   `apps/api/src` 多处使用（包含 `apps/api/src/services/autonomy/si-budget-concurrency.ts`、`si-budget-policy-store.ts` 各 1 处）
   ⇒ 机制 M1 的**调用通道**在本仓库范围内存在；
   但仓库中**未发现**任何 `pg_current_xact_id` / `txid_current` / `xmin` 的既有先例
   ⇒ M1 的**语义与可用性未验证**：`XID_BINDING_MECHANISM_VERIFIED = NOT_VERIFIED`。
5. **状态规则（明确允许的保守结论）**：在 `SCHEMA_MIGRATION=HOLD` 且**缺少可信因果绑定**（M1~M4 均不可用或未验证）时：
   **必须允许** `candidateExists=YES` 与 `thisExecutionCommitted=UNKNOWN` **并存**，
   **不得**因「外部记录与候选行一致」强行升级为 `YES`。
6. **反向约束**：`thisExecutionCommitted=YES` **仅在**下列全部成立时给出：
   §22.4 四条件 + §22.5 全部门禁 + `id` 不复用 + `returnedCandidateId` 持久保存 + **因果绑定成立**（M1~M4 之一，含第 3 条注意事项）+ 权威主库重读一致。
7. **M1 与既有语义的关系**：M1 **不改变**「U2 路径仅 INSERT」；它**只读**系统列与函数，**不写入**新表。
   若为读取系统列需要**额外数据库权限**，该权限**必须**显式声明并审计；未获授权 ⇒ 机制不可用 ⇒ `UNKNOWN`。

### 25.4 R17 验收矩阵增补

| 编号 | 场景 | 期望断言 |
| --- | --- | --- |
| **U2-47a** | **本实例释放锁、另一进程接管**（审计方要求） | `O3` **不得**报告本实例仍持有；允许的结论仅为 `O3-CONTRADICTED` 或 `O3-INCONCLUSIVE`；若为后者则**必须**由 `O2` 支撑，否则**拒绝写入** |
| **U2-47b** | E1 提交结果未知 + E2 以相同候选 ID 插入内容一致的行 + E1 外部记录仍存在 | 必须**拒绝**把该行归因于 E1：`candidateExists=YES` 与 `thisExecutionCommitted=UNKNOWN` 并存；**不得**升级为 `YES` |
| **U2-48a** | `O3` 四项校验缺任意一项 | `O3-INCONCLUSIVE`；不得当作正向证据 |
| **U2-48b** | 仅使用 `F_OFD_GETLK` 作为「自身持锁」证据 | 视为**设计违规**；只允许 `O3-CONTRADICTED`/`O3-INCONCLUSIVE` |
| **U2-48c** | `T2` 之外（事务中/提交后对账中）出现未受控 `close(fd)`（模拟原生调用绕过） | 全窗口覆盖断言必须暴露：`releaseCounter` 可能仍为 0，但**静态约束/统一边界**必须阻止该调用；若无法阻止 ⇒ 拒绝写入 |
| **U2-48d** | `LockFdBoundary` 之外出现 `dup`/`close`/`flock`/原生 fd 操作 | **构建失败**（静态规则），不得进入运行时 |
| **U2-48e** | 子进程派生后继承锁 FD | 断言派生前后继承集合被显式排除；出现继承副本 ⇒ `LOCK_FD_LEAKED` 并拒绝 |
| **U2-49a** | 主库可读 `xmin` 且与本事务捕获的事务标识一致 | 允许 `thisExecutionCommitted=YES`（需同时满足全部前提） |
| **U2-49b** | 期间发生 xid 回绕 / 无法确定回绕窗口 | 必须退回 `UNKNOWN`（不得判 `YES`） |
| **U2-49c** | 候选行被他方 UPDATE 或删除重插（`xmin` 变化） | 比对失败 ⇒ `thisExecutionCommitted=UNKNOWN`（保守），且 `candidateExists` 可仍为 `YES` |

### 25.5 R17 未变部分

§12 候选键 v2 与 digest 概念、§13.1 接口、§13.2 矩阵（另加 U2-47a ~ U2-49c）、§16.1 `CONTROLLED_FIXED_WORKTREE`、
§17.1 隔离证明框架、§17.2 U2-20A/B/C、§17.3 零行冲突复用路径、§18.1 释放全链校验、§18.2 行锁与重试边界、
§19.4 通道/签发者分离、§20.3（CHANGE 42）状态语义、§21.2（CHANGE 45）方向、§21.3.4 验证时机与有效期、
§22.2 `flock` 释放/继承修正、§22.4 四条件、§22.6 字节级契约、§22.7 原子占用、
§23.1 `T0`/`T1`/`T2` 分阶段条件、§23.3 检测 vs 保证、§23.4 归因四类、§23.5 证据范围纪律、
§23.6 字节编码三断言、§23.7 消费持久化、**§24.1 的 `P2` 必要非充分与错误分类（审计方已接受，不重做）**、
§24.2 的存在性/提交归因区分与状态字段、§24.3 的 `CONSUMPTION_UNKNOWN` 三分支（**CHANGE 63 已 PASS**，不重做）、
`builderRef` 固定常量、**U2 路径仅 INSERT**、U2 路径无 `UPDATE`/`DELETE`、不新增 schema/migration、
不接 Runtime/Queue、不调用模型/Provider、ACCOUNT 保持 `NOT_AUTHORIZED`、U1 封板 `9ee36837` 不变、
`SCHEMA_MIGRATION=HOLD`、`EXTERNAL_WRITE=HOLD`、`AUTO_MERGE/AUTO_DEPLOY=FORBIDDEN`、`PRODUCTION_READY=NO`。

```text
R17_NOT_VERIFIED = O3_MECHANISM_VERIFIED（未在目标内核验证任何 O3 机制） ;
                   XID_BINDING_MECHANISM_VERIFIED（pg_current_xact_id / xmin 语义与权限未验证） ;
                   LOCKFD_BOUNDARY_STATIC_RULES（构建规则尚未实现） ;
                   U2_LINUX_MULTIPROCESS_TESTS ; DB_PRIVILEGE_VERIFICATION ; GLOBAL_IMMUTABILITY_PROOF ;
                   DB_RUNTIME_PRIVILEGES ; DB_TRIGGERS_ACTUAL ; DB_ROLES ; DB_WRITER_SET_ACTUAL ;
                   OBSERVATION_WINDOW_IMMUTABILITY ; U2_NONCE_CONSUMPTION_STORE ;
                   POSTGRESQL_INTEGRATION_TEST ; VITEST ; TSC ; LINUX_SYSTEMD ; CI ; PRODUCTION ;
                   U2_DESIGN_DOC_SHA256（送审方报告）
```

本文件仍为**纯设计 R17**：未新增产品代码、未建表、未执行迁移、未接线运行时、未调用模型。
本轮只读核验**仅**读取 `apps/api/prisma/schema.prisma`、既有迁移文件与 `apps/api/src` 中的只读检索结果，
**未**连接任何数据库、**未**执行任何写入。

---

## 26. R18 修订（对应 MSG-20261009-42 的 CHANGE 67–72）

> 授权来源：`MSG-20261009-42 = REVISE` ⇒ `NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_R18_READ_ONLY_CHANGES_67_TO_72`。
> 本轮只处理这六项；**不重复**已通过的 CHANGE 54/56/58/59，也**不重做**已接受的 `P2` 设计。
> `U2_DESIGN_R17_ACCEPTED=NO`、`U2_PLATFORM_ONLY_INSERT_SUBSET=NOT_AUTHORIZED`、`U1_REOPEN=NO` **不变**。

```text
AUDIT_SCOPE   = <上一轮评审头>..<本轮 HEAD> = 2 commits / 3 files（含上一轮裁决归档提交）
SINGLE_COMMIT = <上一轮归档提交>..<本轮设计提交> = 1 commit / 1 file
PRODUCT_CODE  = 0
```

| CHANGE | R17 位置 | R18 修订位置 | 变更性质 |
| --- | --- | --- | --- |
| **CHANGE 67（P1）** | §25.1.1 / §25.1.3 | **§26.1** | `O3-CONTRADICTED` 的定义收紧；标签与门禁解耦 |
| **CHANGE 68（P0）** | §25.1.4（候选 A 用 OFD 记录锁） | **§26.2** | **选定唯一生产锁协议**；禁止混用锁族；**撤回**候选 A |
| **CHANGE 69（P1）** | §25.2.1–§25.2.3 | **§26.3** | 静态约束扩展至**可执行调用路径**；`O_CLOEXEC` 边界 |
| **CHANGE 70（P0）** | §25.3.1–§25.3.2 | **§26.4** | M1 的**事务归属 vs 提交持久证明**；失败即不 COMMIT；永久未知的处置 |
| **CHANGE 71（P0）** | §25.3.3 | **§26.5** | `xmin` 的 **epoch 与行版本语义**；冻结/重写场景 |
| **CHANGE 72（P1）** | §25.4 | **§26.6** | M1 反例矩阵 **U2-50a ~ U2-50f**（逐字落地） |

### 26.1 CHANGE 67（P1）—— `O3-CONTRADICTED` 的**证据边界**（标签与门禁解耦）

**承认审计方的判断**：R17 §25.1.3 把「冲突查询显示存在冲突且非本 OFD」直接写成可产生 `O3-CONTRADICTED`，
这是**过度概括**。**其他 OFD 持有冲突锁**只能证明**当前请求存在外部冲突**，
**不必然**证明「**本 OFD 曾经持有的锁已经提前释放**」——后者需要**锁族、锁范围、查询身份与锁生命周期**共同支持。

**R18 规则**

1. **`O3-CONTRADICTED` 的严格定义**：只有在**已有充分证据推翻持锁不变量**时才可给出，且必须**同时**满足：
   ①**同一锁族**（与 §26.2 选定的唯一生产协议一致）；
   ②**同一规范化锁对象**（`(st_dev, st_ino)` 与 `T1` 记录一致）；
   ③**兼容锁范围**（§26.2 选定协议为整文件锁 ⇒ 必须是整文件）；
   ④证据形式属于下列**之一**：**(a)** 对**本 OFD** 的查询**肯定地**报告「未持有」（仅在 §26.2.4 的机制已获验证时）；
   **(b)** **本实例**以**同一协议**对同一对象发起排他请求并**成功取得**（即 `P2` 返回 `0`）。
2. **不得**把下列情形判为 `CONTRADICTED`（一律 **`INCONCLUSIVE`**）：
   ①查询只显示「存在冲突锁」而不满足第 1 条 ①②③；②冲突来自**其他锁族**（可能与本族不互斥，见 §26.2）；
   ③锁范围不匹配（部分范围）；④对象身份不匹配（不同 inode）；⑤**无法证明**本 OFD 是否曾持有。
3. **`O3` 标签与写入门禁解耦（写死）**：`O3-PROVEN` **不是**门禁的必要条件；
   `O3-INCONCLUSIVE` **不**自动等于放行；**一旦无法确认排他性，无论标签如何，写入门禁一律 fail-closed**
   （唯一放行组合见 §26.1.4）。
4. **放行组合（唯一）**：`O1` 成立（`T1` 系统调用成功，属本次执行）**且** `O2` 成立（§25.2 的统一边界与全窗口覆盖）**且**
   `O3 ≠ CONTRADICTED` **且** `P2` 现场未取得锁 **且** 授权复验通过 ⇒ 允许进入 `T2`；其余组合一律拒绝。
5. **不满足锁族/锁范围/OFD 身份匹配的查询结果，永远不得升级为 `PROVEN`**（延续 §25.1.3）。

### 26.2 CHANGE 68（P0）—— **唯一生产锁协议**；禁止混用不兼容锁族

**承认审计方的判断**：Linux 上 `flock(2)` 与 `fcntl` **OFD 记录锁**即便都与打开文件描述相关，
在本地文件系统上**通常是相互独立的锁体系**，**不能假定彼此互斥**。R17 把二者并置于同一抽象边界下**不够**。

**R18 规则**

1. **选定唯一生产锁协议：`flock(2)` 整文件排他锁（`LOCK_EX | LOCK_NB`）**。
   依据：其**归属单位为打开文件描述**（§22.2 已按此修正释放与继承语义）、其**释放规则**已在本设计内固定
   （唯一释放点 + `LOCK_UN` 与 `close` 并用 + 独立探针复核）、且其**整文件范围**消除了范围兼容性歧义。
2. **被否决的备选与其后果（明确写下）**：**OFD 记录锁（`F_OFD_SETLK`/`F_OFD_SETLKW`）本轮不作为生产协议**——
   若采用它，则**所有**参与排他写入的进程、**全部探针**（`T1A`/`P2`）与**释放路径**都必须**整体迁移**到该族并重新验证；
   在**未整体迁移**的情况下混用两族，会形成**两个互不互斥的"排他域"**，即**排他窗口事实上不存在**。
   ⇒ 因此 R18 **撤回** R17 §25.1.4 的「候选 A 用 OFD 记录锁 + fdinfo 校验」作为 `O3` 实现路径：
   它与本节选定的生产协议**不同族**，混用即违规。
3. **`O3` 在当前选定协议下的可得性（如实标注）**：`flock` 在本设计内**没有**已验证的用户态「查询本 OFD 是否持锁」接口
   ⇒ **`O3` 默认按 `INCONCLUSIVE` 处理**（延续 §25.1.4 的机制未验证纪律），
   **持续持锁的证明由 `O2`（统一边界 + 全窗口覆盖）承担**；`O2` 不能成立 ⇒ `EXCLUSIVE_WINDOW_UNAVAILABLE`（fail-closed）。
   若未来要在目标内核上启用某一 `O3` 机制，**必须**按第 2 条**整体迁移**并重新验证，**不得**局部启用。
4. **参与者的协议一致性（可审计要求）**：
   ①**协议声明**：`CONFIG_VERIFIED`（§20.1.2）证据**必须**额外包含**所有**参与 U2 排他写入的进程/单元所声明的**锁协议标识**
   （期望值恒为 `flock:whole-file:LOCK_EX`）；任何参与者**未声明**或声明**不一致** ⇒ `EXCLUSIVE_WINDOW_UNAVAILABLE`；
   ②**相同规范化锁对象**：锁对象固定为**单一绝对路径**、`O_NOFOLLOW` 打开（§18.1）、身份以 `(st_dev, st_ino)` 比对，
   **禁止**以不同路径/不同符号链接指向同一文件而视为不同对象；
   ③**兼容锁范围**：因选定协议为**整文件锁**，**禁止**引入任何"部分范围"语义（那是记录锁族的属性）。
5. **混合锁族的负面测试（验收必失败条件）**：测试**必须**包含「进程 A 以 `flock`、进程 B 以 OFD 记录锁
   对**同一锁对象**加锁」的用例，并断言：**出现两个进程同时认为自己持有排他锁 ⇒ 验收失败**。
   如实标注：U2 **无法**在运行时可靠识别他方使用了另一锁族 ⇒ 该风险的**唯一控制手段**是第 4 条的
   **协议声明与一致性门禁**（外加运维隔离前提，§20.1.3）；**不得**声称探测可以发现它。

### 26.3 CHANGE 69（P1）—— 静态约束必须覆盖**可执行调用路径**

**承认审计方的判断**：「模块外出现 `close`/`dup`/`flock` 即构建失败」是**必要**控制，但**文本/语法规则不能证明不存在间接底层调用**。

**R18 规则**

1. **威胁模型（必须逐项纳入）**：
  ①`fcntl` 族解锁（`F_UNLCK`，含 OFD 变体）；②`dup2`/`dup3`/`F_DUPFD`；③**FD 传递**（`SCM_RIGHTS`、`/proc/self/fd/*`、
  作为 `stdio` 数组元素传入的裸 FD 号）；④`fork`/`spawn`/`exec` 的**继承与复制**；⑤**线程/工作线程共享**（同进程内其他线程可访问同一 FD 表）；
  ⑥**运行时原生依赖**（native addon / FFI / 绑定层）；⑦语言运行时内部通道（`process.binding` 类内部 API、第三方库对裸 FD 的封装）。
2. **边界声明（必须写成明确条款）**：显式给出**经 `fork`/`spawn`/`exec`、线程共享或库调用传递 FD 的边界**；
   **任何不能静态证明安全**的依赖 ⇒ 必须提供**目标环境隔离证据**（例如该依赖不在写入窗口内执行、或进程隔离），
   **否则禁止进入写入窗口**。
3. **绕过测试（必须存在）**：在测试进程中**故意绕过 `LockFdBoundary`**（例如直接对该 FD 执行关闭/解锁），
   断言系统**不会继续报告排他条件成立**：`releaseCounter`/`dupCounter` 或等价不变量被触发 ⇒
   `T2` 门禁失败 / 执行中止 / `outcome='REJECTED'`，**零写入**。
   如实标注：该断言证明的是**本实现的检测能力**，**不是**内核层面的普遍保证。
4. **`O_CLOEXEC` 的边界（写死）**：`O_CLOEXEC` **不是**阻止 `fork` 后**短暂继承** FD 的完整机制；
   子进程的**继承与复制必须单独验证**（派生前后继承集合检查 + §22.1.6 的检测式扫描）；
   `fork` 与 `exec` 之间的窗口内，子进程**确实**持有该 OFD 的副本。
5. **静态规则集（构建期）扩展**：除原「模块外 `close`/`dup`/`flock`/`SCM_RIGHTS`/原生 fd 操作 ⇒ 构建失败」外，
   **新增**：模块外出现 `fcntl`、`dup2`/`dup3`/`F_DUPFD`、把裸 FD 传入 `stdio`/句柄、`worker_threads` 中访问该 FD、
   引入原生扩展的依赖声明 ⇒ **构建失败**。

### 26.4 CHANGE 70（P0）—— M1 必须区分「**事务归属**」与「**提交事件的持久证明**」

**承认审计方的判断**：M1 的原理（同事务 XID → 事务外记录 → 行 `xmin` → 对账）在**严格条件**下可建立很强的事务来源证据，
但 R17 未把这些条件写成**判定要求**。

**R18 规则（M1 的判定要求，逐条为必要条件）**

1. **同一真实事务**：捕获事务标识的查询与候选 `INSERT` 必须位于**同一个真实数据库事务、同一事务上下文**
   （同一连接、同一事务边界内执行；**禁止**在事务外或另一连接上捕获后再拼接）。
2. **受信绑定**：事务外记录中的 `{XID, executionRef, returnedCandidateId, dedupeKey, attemptNo}` 必须**建立受信绑定**——
   **单纯可修改的外部 JSON 文件不够**；须采用**防篡改**载体（例如受控写入 + 完整性密钥/摘要绑定，或以不可变方式落盘并由本执行独占）。
3. **COMMIT 前的持久化确认**：事务外记录必须在 `COMMIT` **之前**完成**持久化确认**（`fsync` 级别的落盘确认或等价）；
   **该持久化失败 ⇒ 不得启动 `COMMIT`**（宁可放弃本次写入，也不产生无法归因的已提交行）。
4. **外部记录 ≠ 提交证明**：**不得**因外部记录存在而认定 `COMMIT` 成功；仍须在**权威主库**确认**目标行存在**且**系统列匹配**（§26.5）。
5. **一律 `UNKNOWN` 的清单**：外部记录**丢失/损坏/身份无法认证/事务 ID 不匹配** ⇒ `UNKNOWN`；
   **禁止**凭「内容相似"补全归因。
6. **永久未知的处置（明确写下）**：若数据库 `COMMIT` **已成功**而外部对账记录**不可恢复**，
   系统**可能永久无法确认本次执行** ⇒ 此时选择 **`UNKNOWN` 是正确安全行为**；
   **不得**让**另一执行**重新创建相同候选（那会引入重复/语义漂移），而应将该候选标记为
   `ATTRIBUTION_UNRECOVERABLE` 并**上报控制面/人工处置**。
7. **与状态字段的关系**：`candidateExists` 与 `thisExecutionCommitted` 仍**分列**（§24.2）；
   M1 未成立时只允许 `candidateExists=YES` + `thisExecutionCommitted=UNKNOWN`。

### 26.5 CHANGE 71（P0）—— `xmin` 的**时间与行版本语义**修订

**承认审计方的判断**：`xmin` 表示**当前可见行版本**的插入事务标识，
**不天然代表**逻辑业务记录**一生中唯一的创建事务**；官方亦明确警告**不应长期依赖 32 位事务 ID 的唯一性**。

**R18 规则**

1. **有效时间与生命周期边界**：必须规定「从事务标识捕获到提交结果确认」的**最大有效窗口**，
   并明确该窗口**不得超过**所依赖事务 ID 语义的**生命周期边界**；超出窗口 ⇒ `UNKNOWN`。
2. **epoch 证明（关键）**：**不得**以「`xmin` = xid8 的**低 32 位**」作为**唯一**判断条件；
   必须能证明**二者属于同一 XID epoch**（例如以 64 位事务标识与快照/年龄信息交叉推导，
   **并以在目标 PostgreSQL 版本上的实测**为准）；**无法证明 epoch 连续 ⇒ `UNKNOWN`**。
3. **维护场景（必须逐项处理）**：
  ①**`VACUUM FREEZE`**：被冻结的行版本其插入事务标识会变为**冻结标识**（不再是原事务）⇒ 与捕获值不匹配 ⇒ **`UNKNOWN`**（保守，正确）；
  ②**表重写**（`VACUUM FULL`、`CLUSTER`、`ALTER TABLE ... REWRITE` 等）⇒ 行版本被重写、`xmin` 变化 ⇒ `UNKNOWN`；
  ③**`TRUNCATE`/删除重插** ⇒ 行已非原版本 ⇒ `UNKNOWN`；
  ④恢复/克隆/逻辑重放等会改变实例或版本来源的场景 ⇒ 归入 §22.4 四条件并一律保守。
4. **测试要求**：必须包含「**低 32 位 XID 重复但完整事务身份不同**」的情形（见 §26.6 的 U2-50d/e），
   以及冻结/重写后必须返回 `UNKNOWN` 的断言。
5. **与 §25.3.3 的关系**：R17 的注意事项（回绕、原始 SQL、行被更新 ⇒ `xmin` 变化）**保留**，本节**追加** epoch 与生命周期要求。

### 26.6 CHANGE 72（P1）—— M1 反例验收矩阵（U2-50a ~ U2-50f，逐字落地）

| 编号 | 反例场景 | 必须结果 |
| --- | --- | --- |
| **U2-50a** | 外部记录落盘成功，数据库事务**回滚** | `UNKNOWN` 或明确**未提交**；**不得 YES** |
| **U2-50b** | `COMMIT` 成功，但**外部因果记录不可验证** | `UNKNOWN`（并标记 `ATTRIBUTION_UNRECOVERABLE`，上报控制面） |
| **U2-50c** | **E2 创建内容相同但事务 XID 不同**的行 | **不得归因 E1** |
| **U2-50d** | 行版本经过**冻结、重写**或生命周期无法确认 | `UNKNOWN` |
| **U2-50e** | 同一逻辑 `candidateId` 的行被**删除重插** | 不得根据相同 ID 与 digest 判 YES |
| **U2-50f** | XID 与行版本匹配，但外部记录的 **execution 身份不可认证** | `UNKNOWN` |

**通过上述测试**是 M1 从「合理候选」推进为「可独立验证的因果绑定」的**前置条件**。

### 26.7 R18 未变部分

§12 候选键 v2 与 digest 概念、§13.1 接口、§13.2 矩阵（另加 U2-50a ~ U2-50f）、§16.1 `CONTROLLED_FIXED_WORKTREE`、
§17.1 隔离证明框架、§17.2 U2-20A/B/C、§17.3 零行冲突复用路径、§18.1 释放全链校验、§18.2 行锁与重试边界、
§19.4 通道/签发者分离、§20.3（CHANGE 42）状态语义、§21.2（CHANGE 45）方向、§21.3.4 验证时机与有效期、
§22.2 `flock` 释放/继承修正（**本节选定其为本项目唯一生产锁协议**）、§22.4 四条件、§22.6 字节级契约、§22.7 原子占用、
§23.1 `T0`/`T1`/`T2` 分阶段条件、§23.3 检测 vs 保证、§23.4 归因四类、§23.5 证据范围纪律、§23.6 字节编码三断言、
§23.7 消费持久化、§24.1 的 `P2` 必要非充分与错误分类（审计已接受）、§24.2 存在性/提交归因区分与状态字段、
§24.3 的 `CONSUMPTION_UNKNOWN` 三分支（CHANGE 63 已 PASS）、§25.2 的统一锁 FD 边界与全窗口覆盖、
§25.3 的 M1~M4 候选（本节 §26.4/§26.5 对其 M1 追加判定要求）、
`builderRef` 固定常量、**U2 路径仅 INSERT**、U2 路径无 `UPDATE`/`DELETE`、不新增 schema/migration、
不接 Runtime/Queue、不调用模型/Provider、ACCOUNT 保持 `NOT_AUTHORIZED`、U1 封板 `9ee36837` 不变、
`SCHEMA_MIGRATION=HOLD`、`EXTERNAL_WRITE=HOLD`、`AUTO_MERGE/AUTO_DEPLOY=FORBIDDEN`、`PRODUCTION_READY=NO`。

```text
R18_NOT_VERIFIED = LOCK_PROTOCOL_UNIFORMITY_ATTESTATION（协议声明门禁未在目标环境验证） ;
                   O3_MECHANISM_VERIFIED（选定 flock 协议下无已验证的 O3 机制 ⇒ 默认 INCONCLUSIVE） ;
                   XID_BINDING_MECHANISM_VERIFIED（pg_current_xact_id / xmin / epoch 语义未在目标 PG 验证） ;
                   LOCKFD_BOUNDARY_STATIC_RULES（构建规则尚未实现） ; U2_LINUX_MULTIPROCESS_TESTS ;
                   DB_PRIVILEGE_VERIFICATION ; GLOBAL_IMMUTABILITY_PROOF ; DB_RUNTIME_PRIVILEGES ;
                   DB_TRIGGERS_ACTUAL ; DB_ROLES ; DB_WRITER_SET_ACTUAL ; OBSERVATION_WINDOW_IMMUTABILITY ;
                   U2_NONCE_CONSUMPTION_STORE ; POSTGRESQL_INTEGRATION_TEST ; VITEST ; TSC ; LINUX_SYSTEMD ;
                   CI ; PRODUCTION ; U2_DESIGN_DOC_SHA256（送审方报告）
```

本文件仍为**纯设计 R18**：未新增产品代码、未建表、未执行迁移、未接线运行时、未调用模型。
本轮只读核验**仅**读取 `apps/api/prisma/schema.prisma`、既有迁移文件与 `apps/api/src` 中的只读检索结果，
**未**连接任何数据库、**未**执行任何写入。

---

## 27. R19 修订（对应 MSG-20261009-43 的 CHANGE 73–78）

> 授权来源：`MSG-20261009-43 = REVISE` ⇒ `NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_R19_READ_ONLY_CHANGES_73_TO_78`。
> 本轮只处理这六项；**不重复**已接受的条款，也**不重开** U1。
> `U2_DESIGN_R18_ACCEPTED=NO`、`U2_PLATFORM_ONLY_INSERT_SUBSET=NOT_AUTHORIZED`、`U1_REOPEN=NO` **不变**。

```text
AUDIT_SCOPE   = f7dbce54..<本轮设计提交> = 2 commits / 3 files（含上一轮裁决归档提交）
SINGLE_COMMIT = f7dbce54..<本轮设计提交> = 1 commit / 1 file
PRODUCT_CODE  = 0
```

| CHANGE | R18 位置 | R19 修订位置 | 变更性质 |
| --- | --- | --- | --- |
| **CHANGE 73（P1）** | §25.1 / §24.1.7 | **§27.1** | `P2` 探针**独立性契约**（不得共享 `T1` 的 OFD） |
| **CHANGE 74（P1）** | §26.2.4 | **§27.2** | 部署清单/文件系统前提 + **负面验收 = ADMISSION DENIED** |
| **CHANGE 75（P0）** | §26.3.3 | **§27.3** | **写入保证**（可能失效即禁止提交）+ 提交期覆盖 + **内核语义勘误** |
| **CHANGE 76（P0）** | §26.4 | **§27.4** | M1 **恢复状态机** + **去重权威** |
| **CHANGE 77（P0）** | §26.5 | **§27.5** | **行版本身份**（冻结语义更正）+ **有效期限契约** |
| **CHANGE 78（P1）** | §26.6 | **§27.6** | 新增反例 **U2-50g ~ U2-50j** |

### 27.1 CHANGE 73（P1）—— `P2` 探针**独立性契约**

**承认审计方的判断**：`flock` 锁属于**打开文件描述**；经 `dup()`/`fork()` 共享同一描述得到的 FD
可能操作**同一把锁**，而**不构成独立竞争**。因此 `P2` 必须证明自己是**独立打开**的。

**R19 契约（逐字固定）**

```text
P2_PROBE:
  lock_family      = flock
  file_identity    = T1.(st_dev, st_ino)
  acquisition      = independent_open          # 由 P2 自行 open()，不使用 T1 的 FD
  shares_T1_OFD    = false                     # 不得 dup/fork/SCM_RIGHTS 复用 T1 的打开文件描述
  lock_request     = LOCK_EX | LOCK_NB

P2_ACQUIRED = true  => EXCLUSIVE_WINDOW_CONTRADICTED => T2_DENIED
```

1. **独立性判定（可执行、fail-closed）**：`P2` **自行** `open()` 锁文件（`O_CLOEXEC`，且**不得**经任何 FD 传递方式获得）；
   实现**必须**记录该 FD 的创建路径（`open` 调用点）与号码，并在证据中声明 `shares_T1_OFD=false`。
   **无法证明独立性 ⇒ `O3`/`P2` 一律按 `INCONCLUSIVE` 处理**（不得当作有效互斥证据）。
2. **共享 OFD 的反证（关键）**：若探针**错误地**复用了 `T1` 的 OFD，则其 `flock` 请求**会在同一描述上"成功"**
   ⇒ 结果**恰好**是 `P2_ACQUIRED=true` ⇒ 按上表判为 `EXCLUSIVE_WINDOW_CONTRADICTED` ⇒ **`T2` 被拒**。
   即：**该实现缺陷会以"误报冲突"的方式被 fail-closed 捕获**，而**不会**被误当作"互斥成立"的正面证据。
3. **每个 `T1A`/`P2` 探针**均须遵守本契约（§23.1 的 `T1A` 与 §23.2 的 `P2` 同规则）；
   探针 FD 必须在探针结束前 **`close()`**，若意外取得锁须**同流程内** `LOCK_UN` + `close()`（§24.1.7）。
4. **负面测试（必须存在）**：以 `dup(T1.fd)` 构造**伪独立探针**，断言其**不得**被当作有效 `P2` 证据
   （期望：`P2_ACQUIRED=true` ⇒ `EXCLUSIVE_WINDOW_CONTRADICTED` ⇒ `T2_DENIED`；或实现直接拒绝该探针构造）——见 **U2-51a**。

### 27.2 CHANGE 74（P1）—— 协议边界与**负面验收**

**承认审计方的判断**：①协议声明只能证明**已纳入管理的参与者**自称同协议，**不能**证明不存在**未登记进程/旧版本进程/拥有数据库写权限的其他组件**；
②混合锁族测试**不能**以「两个进程都获得锁 ⇒ 测试失败」收尾 —— 那在本地文件系统上是**预期现象**；
真正的验收是：**系统识别该环境或参与者组合不符合自身契约，然后拒绝 U2 写入**。

**R19 规则**

1. **`DEPLOYMENT_INVENTORY`（`CONFIG_VERIFIED` 的证据扩展，必须逐项给出）**：
   ①**真实部署清单**（参与排他写入的进程/单元、其版本或构建标识）；②**数据库写入主体**（应用角色、迁移角色、运维/DBA 访问路径、后台作业）；
   ③**目标 Linux 环境**（发行版/内核版本）；④**文件系统类型与挂载方式**（本地 vs `NFS`/`SMB` 等语义不同的网络文件系统；挂载选项）；
   ⑤**锁文件生命周期**（创建者、路径、权限、是否可被替换/清理）；⑥各参与者声明的**锁协议标识**（期望恒为 `flock:whole-file:LOCK_EX`）。
   **任一缺失或不可核验 ⇒ `U2_ADMISSION=DENIED`（fail-closed）**。
2. **文件系统前提（明确写下）**：Linux 上 `flock` 与 `fcntl` 记录锁在**本地文件系统**通常互不冲突；
   **`NFS`/`SMB` 等网络文件系统语义不同** ⇒ **必须**把「文件系统类型 + 挂载方式」作为**部署前提**固定并核验；
   网络文件系统或无法确认的挂载 ⇒ `U2_ADMISSION=DENIED`（除非另有在该环境上完成的、可复现的互斥验证证据）。
3. **负面验收（改写）**：混合锁族反例的正确验收是 —— 测试**成功重现**「`flock` 与 OFD 记录锁并存」，
   并且系统（依据第 1 条清单中**声明不一致**的参与者，或**注入的未登记写入主体**）
   判定 **`U2_ADMISSION=DENIED`** 并**拒绝 U2 写入**。**仅证明"两把锁可并存"不构成验收**。
4. **三灰区一律 fail-closed**：**未登记的写入主体**、**未经验证的部署拓扑**、**不受控的锁文件替换** ⇒ `U2_ADMISSION=DENIED`。
5. **如实声明的残余风险**：对**完全不声明、也不受清单覆盖**的进程，U2 **无法**在运行时识别其锁族；
   该残余风险**只能**由**部署隔离前提**（§20.1.3 专用账户/无旁路启动）与**数据库侧写入权限隔离**共同压制
   —— 二者当前均 `NOT_VERIFIED`（见 §27.4.4 与 §27.7）。

### 27.3 CHANGE 75（P0）—— FD 边界失效时的**写入保证**（含内核语义勘误）

**承认审计方的判断**：**监测到 FD 被释放 ≠ 能在另一进程取得锁并写入之前阻止危险行为**；
若检测依赖后续扫描、计数器或异步回调，则**检测与数据库写入之间存在 TOCTOU 竞争窗口**。

**R19 规则**

1. **架构层保证：写入进程隔离（首选）**。U2 的排他写入必须运行在**专用写入进程**（"U2 write worker"）内：
   该进程**只**包含 ①`LockFdBoundary` 模块 ②最小数据库客户端 ③本次写入的顺序控制逻辑；
   **不得**加载用户代码/插件、**不得**引入原生扩展或 FFI、**不得**创建 worker 线程、**不得**在写入窗口内派生任何子进程。
   这样「无法证明受统一管理」的路径**根本不进入写入进程**（直接满足 §26.3 的禁止条款）。
2. **失败即停止（fail-stop，不只是记录）**：任何一处检出边界可能失效（不变量被触发、`P2` 现场取锁成功、探针对象/身份不匹配、
   授权复验失败等）⇒ **必须禁止启动或继续 `COMMIT`**：
   - 若尚未发出 `COMMIT` ⇒ **`ROLLBACK`** 并零写入；
   - 若 `COMMIT` 已发出但结果未知 ⇒ 按 §22.4/§26.4 归因；**不得**继续任何后续自动化动作。
3. **提交期覆盖（明确）**：持锁证明必须覆盖**实际数据库提交期间**，而**不只是 `INSERT` 调用期间**：
   `T2` 门禁 → 事务内 `INSERT` → 事务外意图记录持久化（§27.4）→ **`COMMIT` 请求与确认** → 对账 → `T3` 释放。
   其中**紧邻 `COMMIT` 之前**必须再执行一次 `P2`（同一协议、独立打开、§27.1），且**检查与 `COMMIT` 发送之间不得插入任何其他 I/O**。
4. **残余窗口与更强机制（如实说明）**：用户态检查**无法**消除「最终 `P2` 与 `COMMIT` 之间」的微观窗口。
   因此：①**必须**把该窗口压到最小（第 3 条）；②**推荐**引入**数据库端 fencing**——
   即写入语句携带**栅栏令牌**（fence token），由数据库侧判定其**仍然有效**，令牌失效则写入失败
   ——这是唯一能把「锁已失效」与「写入被拒绝」在数据库侧绑定的机制。**fencing 需要的数据库能力（额外表/函数/权限）当前不可用**（`SCHEMA_MIGRATION=HOLD`，权限未核验）⇒ 在获得之前，本设计**只能**声明「残余窗口存在」，并保持**不自动推进后续动作**。
5. **提交后复核（新增强制步骤）**：`COMMIT` 返回后（无论成功或未知），**必须**再执行一次 `P2`；
   若此时 `P2` **成功取锁**（`P2_ACQUIRED=true`）⇒ 说明**写入窗口内曾失去锁** ⇒
   置 `exclusiveWindowViolated=true`、`outcome='REJECTED'`、**禁止任何后续自动化动作**、保留全部证据并**上报控制面**；
   对可能已提交的行按 §27.4/§27.5 归因（不得凭此判 `THIS_EXECUTION_COMMITTED=YES`）。
   见 **U2-51b**。
6. **内核语义勘误（必须更正 R18 的威胁表述）**：**`fcntl(F_UNLCK)` 不能无条件解除一个独立的 `flock` 锁**——
   记录锁（POSIX/OFD）与 `flock` 是不同族；因此威胁列表必须**分列**：
   ①**直接解除本协议锁的路径**：`flock(LOCK_UN)`、关闭该 OFD 的**最后一个**引用；
   ②**其他锁族的干扰路径**：`fcntl` 记录锁的加解锁（可能与本协议**不互斥**，属 §27.2 的协议一致性问题，而非"解除"）。
   R18 §26.3.1 中把 `fcntl` 解锁并列为"解除路径"的表述**作废**，按本条重写。
7. **不可证明时的处置（审计方指定）**：若在所用技术栈中**无法**证明第 2~3 条的保证，
   应选择 **①隔离写入进程（第 1 条）、②缩小可信执行边界、③引入数据库端 fencing**（第 4 条），
   **而不是**继续增加扫描规则；三者均不可行 ⇒ `EXCLUSIVE_WINDOW_UNAVAILABLE`，零写入。

### 27.4 CHANGE 76（P0）—— M1 **恢复状态机**与**去重权威**

**承认审计方的判断**：①「`COMMIT` 前 `fsync` 成功」只证明**意图**记录已持久化，**不能**证明数据库提交与文件系统落盘构成**原子事务**；
②`ATTRIBUTION_UNRECOVERABLE` 若只存于执行进程内部，崩溃后**不能**作为跨实例的阻断依据。

**R19 规则**

1. **意图记录（intent record）契约**：内容 `{executionRef, returnedCandidateId, dedupeKey, attemptNo, capturedXid8, state, hmac}`；
   **原子写入**：写临时文件 → **`fsync` 文件** → `rename` → **`fsync` 父目录**；
   **文件身份绑定**：记录中保存该文件的 `(st_dev, st_ino)` 与大小/摘要，读取时校验（防替换）；
   **密钥可用性**：`hmac` 使用本执行专属密钥；**崩溃后密钥必须可从受信存储取回**，否则**无法验证** ⇒ 按 `UNKNOWN` 处理（不得凭内容相似接受）；
   **`state ∈ {PREPARED, COMMIT_UNKNOWN, COMMITTED, NOT_COMMITTED, ATTRIBUTION_UNRECOVERABLE}`**。
2. **恢复状态机（逐行按表执行）**：

| 恢复状态 | 主库观察 | **允许行为** |
| --- | --- | --- |
| `PREPARED` | 无目标行 | **不得**推断已提交；进入**受控恢复**（重新走对账流程；**不得**直接重放 `INSERT`） |
| `PREPARED` | 目标行匹配且**因果证据有效**（§27.5） | 可以确认**对应提交**（`thisExecutionCommitted=YES`） |
| `COMMIT_UNKNOWN` | 因果证据**不可验证** | `UNKNOWN`；**禁止自动重试 `INSERT`** |
| 任意 | 存在目标行但**执行归因不可恢复** | `ATTRIBUTION_UNRECOVERABLE` ⇒ **人工处置**（见第 3 条） |
| `PREPARED` + 另一执行 | 两个执行竞争**相同 `dedupeKey`** | **只能有一个权威创建结果**（第 3 条） |
3. **去重权威（本仓库已有事实，可直接引用）**：**权威仲裁者是数据库本身** ——
   `AutonomyCandidate` 上有 `@@unique([dedupeKey])`（`apps/api/prisma/schema.prisma:3325`），
   迁移中对应 `CREATE UNIQUE INDEX "AutonomyCandidate_dedupeKey_key"`（`migrations/20261005000000_rsi_autonomy_state_persistence/migration.sql:146`），
   且 schema 注释明确「Incident / Task / Candidate / Promotion 各带 `UNIQUE(dedupeKey)`，reboot 后同因不重复创建」（同文件 `:3257`）。
   ⇒ 「两执行竞争同一 `dedupeKey` 只能有一个创建结果」由**唯一索引 + `INSERT ... ON CONFLICT DO NOTHING`** 结构性保证
   （第二方返回**零行** ⇒ 走 §17.3 零行冲突路径 ⇒ **永不重建**），**不需要新增 schema**。
   **`ATTRIBUTION_UNRECOVERABLE` 的跨实例**呈现仍需一个**所有写入者共同遵守**的持久登记处；
   在不新建表的约束下，本设计**只能**：①以意图记录 + 日志作为**本地**证据；②在**控制面**（人工/工单）登记该状态；
   **并明确**：该状态的**跨实例自动互认**当前 `NOT_VERIFIED`（若未来允许新增表，应以其为唯一登记处）。
4. **主库查询失败的处理**：恢复期的对账查询失败 ⇒ **有界重试**；重试耗尽 ⇒ 保持 `UNKNOWN`（**不得**假定"无行即未提交"，也不得假定"已提交"）。
5. **禁止项（重申）**：任何路径**不得**对已存在的 `dedupeKey` **重新创建**候选；
   任何路径**不得**把 `PREPARED` 记录本身当作提交证明；任何路径**不得**在 `UNKNOWN` 下推进自动化后续动作。

### 27.5 CHANGE 77（P0）—— **行版本身份**与**有效期限**（含冻结语义更正）

**接受审计方对我方事实的更正**（见 `docs/releases/SI-RSI-INTERNAL-CODE-REPAIR-V1.md` §2.47.0）：
现代 PostgreSQL **通常以标记位实现冻结并保留原始 `xmin` 数值**（9.4 以前才可能直接替换可见 `xmin`）
⇒ **冻结后 `xmin` 可能仍等于原值，但这不意味着它仍是可靠的提交归因证据**。
R18 §26.5 第 3 条 ① 的"冻结标识"表述**作废**，按本节重写。

**R19 规则**

1. **不得依赖数值变化检测冻结**：因为冻结可能**保留** `xmin` 数值，所以「观察到的 `xmin` 与捕获值一致」**不能**证明该行版本仍受原事务保护。
2. **因果判断的四要素（必须共同成立）**：①**完整 XID（xid8）**及其 **epoch**；②**目标行版本**的 `xmin`（32 位）；
   ③**受信执行记录**（§27.4.1 的意图记录，含 HMAC 与文件身份）；④**主库**在**权威实例**上的重读结果。
   任一要素缺失或不可验证 ⇒ `UNKNOWN`。
3. **epoch 证明的可执行构造（未在目标库验证）**：在事务内捕获 `xid8 = pg_current_xact_id()`；
   对账时读取该行 `xmin` 并**同时**再次捕获当前 `xid8'`；要求：
   ①`xmin = (xid8 & 0xFFFFFFFF)`；②**`xid8' - xid8 < 2^31`**（即捕获与对账之间**未跨过回绕**）；
   ③**冻结不可能介入**（第 4 条）。①②③ 全部成立**才**可作为"同一 XID epoch"的证据；
   否则（含跨窗、回绕、无法求值）⇒ `UNKNOWN`。**全部为设计构造**：`XID_EPOCH_CONSTRUCTION_VERIFIED = NOT_VERIFIED`。
4. **最大归因窗口与冻结前提（必须写成可运行契约）**：
   ①规定 **`ATTRIBUTION_MAX_WINDOW`**（由运维配置、**有硬上限**），且**要求对账必须在窗口内完成**；超窗 ⇒ `UNKNOWN`（见 U2-50h 的超期测试）；
   ②**必须**取得并记录目标库的冻结相关参数与实际推进情况（至少：`vacuum_freeze_min_age`、`autovacuum_freeze_max_age`、
   以及实例的 XID 消耗速度证据），用于论证「窗口内**不可能**发生冻结」；**取证失败 ⇒ 窗口不成立 ⇒ `UNKNOWN`**；
   ③使用 **`pageinspect` 之外的**手段**不得**被假定可用（读取 `t_infomax` 冻结位需要扩展）⇒ 设计**不**依赖该能力。
5. **一律默认 `UNKNOWN` 的情形**：原始行**被更新**（含 HOT）、**删除后重插**、**被重写**（`VACUUM FULL`/`CLUSTER`/`ALTER TABLE ... REWRITE`）、
   **来源不可信**（恢复/克隆/逻辑重放导致实例或版本来源变化）——**即使 `xmin` 数值匹配**。
6. **目标库实测前置**：所有 SQL 与 XID 语义（`pg_current_xact_id()` 的可用性与权限、`xmin` 可读性、`xid8` 运算、窗口内参数）
   **必须**在**目标 PostgreSQL 版本**上实测；**未实测 ⇒ 不得声明已证明 epoch 归属**（`XID_EPOCH_CONSTRUCTION_VERIFIED=NOT_VERIFIED`）。

### 27.6 CHANGE 78（P1）—— 新增反例 **U2-50g ~ U2-50j**（及两项支撑用例）

| 编号 | 反例场景 | 必须结果 |
| --- | --- | --- |
| **U2-50g** | 外部 `PREPARED` 记录**已 fsync**、`COMMIT` **前**进程崩溃 | **不得**误判 YES；按 §27.4.2 进入**受控恢复**，无目标行时保持非 YES |
| **U2-50h** | **现代 PG 冻结后 `xmin` 数值未改变**，但版本可信性不足（或已超 `ATTRIBUTION_MAX_WINDOW`） | `UNKNOWN` |
| **U2-50i** | E1 归因**不可恢复**，E2 竞争相同 `dedupeKey` | **不得产生第二个候选**（唯一索引 + `ON CONFLICT DO NOTHING` 结构性保证） |
| **U2-50j** | 排他锁**提前释放** → 竞争进程取得锁 → 原进程**随后尝试 `COMMIT`** | **不得产生未受控双写**：提交前 `P2` 必须检出 ⇒ `ROLLBACK`/拒绝（§27.3.2–3） |
| **U2-51a**（支撑） | 以 **`dup(T1.fd)` 构造伪独立探针** | 不得被当作有效 `P2` 证据；`P2_ACQUIRED=true` ⇒ `EXCLUSIVE_WINDOW_CONTRADICTED` ⇒ `T2_DENIED`（§27.1.4） |
| **U2-51b**（支撑） | `COMMIT` 返回后复核 `P2` 时**成功取锁** | `exclusiveWindowViolated=true`、`outcome='REJECTED'`、**禁止后续自动化动作**、上报控制面（§27.3.5） |

### 27.7 R19 未变部分与未验证项

§12 候选键 v2 与 digest 概念、§13.1 接口、§13.2 矩阵（另加 U2-50g~j、U2-51a/b）、§16.1 `CONTROLLED_FIXED_WORKTREE`、
§17.1 隔离证明框架、§17.2 U2-20A/B/C、§17.3 零行冲突复用路径、§18.1 释放全链校验、§18.2 行锁与重试边界、
§19.4 通道/签发者分离、§20.3（CHANGE 42）状态语义、§21.2（CHANGE 45）方向、§21.3.4 验证时机与有效期、
§22.2 `flock` 释放/继承修正、§22.4 四条件、§22.6 字节级契约、§22.7 原子占用、
§23.1 `T0`/`T1`/`T2` 分阶段条件、§23.3 检测 vs 保证、§23.4 归因四类、§23.5 证据范围纪律、§23.6 字节编码三断言、
§23.7 消费持久化、§24.1 `P2` 必要非充分与错误分类、§24.2 存在性/提交归因区分、§24.3 `CONSUMPTION_UNKNOWN`、
§25.2 统一锁 FD 边界与全窗口覆盖、§25.3 M1~M4 候选、
§26.1 `O3-CONTRADICTED` 边界、§26.2 唯一生产锁协议（`flock:whole-file:LOCK_EX`）与撤回 OFD 记录锁候选、
§26.4 M1 的七项判定要求、§26.6 U2-50a~f、`builderRef` 固定常量、**U2 路径仅 INSERT**、
U2 路径无 `UPDATE`/`DELETE`、不新增 schema/migration、不接 Runtime/Queue、不调用模型/Provider、
ACCOUNT 保持 `NOT_AUTHORIZED`、U1 封板 `9ee36837` 不变、`SCHEMA_MIGRATION=HOLD`、`EXTERNAL_WRITE=HOLD`、
`AUTO_MERGE/AUTO_DEPLOY=FORBIDDEN`、`PRODUCTION_READY=NO`。

```text
R19_NOT_VERIFIED = P2_INDEPENDENCE_ENFORCEMENT ; DEPLOYMENT_INVENTORY_EVIDENCE ;
                   FILESYSTEM_AND_MOUNT_PREREQUISITES ; WRITE_PROCESS_ISOLATION ;
                   DB_SIDE_FENCING_CAPABILITY ; M1_RECOVERY_STATE_MACHINE ;
                   ATTRIBUTION_UNRECOVERABLE_CROSS_INSTANCE_REGISTRY ;
                   XID_EPOCH_CONSTRUCTION_VERIFIED（pg_current_xact_id / xmin / 窗口参数未在目标 PG 验证） ;
                   ATTRIBUTION_MAX_WINDOW_EVIDENCE ; LOCKFD_BOUNDARY_STATIC_RULES ;
                   U2_LINUX_MULTIPROCESS_TESTS ; DB_PRIVILEGE_VERIFICATION ; GLOBAL_IMMUTABILITY_PROOF ;
                   DB_RUNTIME_PRIVILEGES ; DB_TRIGGERS_ACTUAL ; DB_ROLES ; DB_WRITER_SET_ACTUAL ;
                   OBSERVATION_WINDOW_IMMUTABILITY ; U2_NONCE_CONSUMPTION_STORE ;
                   POSTGRESQL_INTEGRATION_TEST ; VITEST ; TSC ; LINUX_SYSTEMD ; CI ; PRODUCTION ;
                   U2_DESIGN_DOC_SHA256（送审方报告）
```

本文件仍为**纯设计 R19**：未新增产品代码、未建表、未执行迁移、未接线运行时、未调用模型。
本轮只读核验**仅**读取 `apps/api/prisma/schema.prisma`、既有迁移文件与 `apps/api/src` 中的只读检索结果，
**未**连接任何数据库、**未**执行任何写入。

---

## 28. R20 修订（对应 MSG-20261009-44 的 CHANGE 79–82）

> 授权来源：`MSG-20261009-44 = REVISE` ⇒ `NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_R20_READ_ONLY_CHANGES_79_TO_82`。
> 本轮只处理这四项；`CHANGE 73`（PASS）与 `CHANGE 74`（PASS_SCOPED）**不重开**，其余已接受条款**不重复**。
> `U2_DESIGN_R19_ACCEPTED=NO`、`U2_PLATFORM_ONLY_INSERT_SUBSET=NOT_AUTHORIZED`、`U1_REOPEN=NO` **不变**。

```text
AUDIT_SCOPE   = 4d95e04c..<本轮设计提交> = 2 commits / 3 files（含上一轮裁决归档提交）
SINGLE_COMMIT = 4d95e04c..<本轮设计提交> = 1 commit / 1 file
PRODUCT_CODE  = 0
```

| CHANGE | R19 位置 | R20 修订位置 | 变更性质 |
| --- | --- | --- | --- |
| **CHANGE 79（P0）** | §27.3.3–§27.3.5 | **§28.1** | **撤回**「提交前 `P2` 必然检出」；确立**预防性前提**或 **DB 端 fencing**；禁用「缩窗/事后检查」替代 |
| **CHANGE 80（P0）** | §27.4.3 | **§28.2** | **跨实例恢复阻断权威**（单一协调者 + 人工分支 + 不一致确定性处置） |
| **CHANGE 81（P0）** | §27.5.3 | **§28.3** | `xmin` **降为辅助证据**；明确可证明「存在」与可证明「本执行提交」的界限 |
| **CHANGE 82（P1）** | §27.6 | **§28.4** | `U2-50j` 拆分为两个时序；`U2-51b` **分离安全结论与数据库结论** |

### 28.1 CHANGE 79（P0）—— 最终 `P2` → `COMMIT` 的**排他保证**

**承认审计方的判断**：R19 §27.3 承认用户态存在 TOCTOU，但 §27.6 的 `U2-50j` 又要求「提交前 `P2` 必须检出提前释放」；
**两者只有在释放发生于最终 `P2` 之前时才同时成立**。审计方给出的反例成立：

```text
T1: 最终 P2 检查通过
T1: 原 flock 因边界失效被释放
T2: 成功取得 flock
T2: 提交自己的写入
T1: 发出 COMMIT
T1: COMMIT 成功
T1: 提交后 P2 检出异常        # 只能发现异常，不能撤销 T1 已完成的提交
```

**R20 规则**

1. **撤回**：「提交前 `P2` **必然**检出所有提前释放」的表述**作废**。
   `P2` 的定位**进一步收窄**为：①最终 `P2` **之前**发生的释放，**可被检出**；
   ②最终 `P2` **之后**（含 `COMMIT` 往返期间）发生的释放，**不可被提交前的任何检查检出**。
2. **真正的安全前提（必须逐字写入实施契约）**：

```text
SAFETY_PREMISE(P0) = 在整个提交窗口内，本实例的锁不得被意外释放
   其中 提交窗口 = [最终 P2 完成, COMMIT 返回]
  ⇒ 该性质必须是【预防性】的（结构上不可能发生），
    或由【数据库端可执行的 fencing / 串行化】强制执行；
  ⇒ 不得以「窗口很小」「事后检查」替代。
```

3. **预防性实现（在无 DB 端能力时唯一可接受路径）**：提交窗口内的"不可能释放"必须由**同时满足**下列条件构成：
   ①**专用写入进程**（§27.3.1）内**不存在**任何可达 `flock(LOCK_UN)` / `close(锁 FD)` 的代码路径；
   ②**依赖闭包最小且已审计**：无原生扩展、无 FFI、无动态代码加载（无 `eval`/`vm`/插件/`dlopen` 类机制）；
   ③**释放能力以一次性令牌表达**：`T3` 释放函数只能凭 `T1` 结束时不创建的"释放令牌"调用，
     该令牌**仅在**「提交窗口结束且结果已记录」后由控制流生成 ⇒ **提交窗口内无令牌可用**；
   ④**静态规则集**覆盖 ①②③ 的全部 API 面（§26.3.5 + §27.3.6 勘误版），并在构建期强制。
   **如实标注**：①②③ 是**实现不变量**（由代码结构与静态规则保证），**不是**内核层面的普遍保证；
   它们只能在**受控执行环境**（§20.1.3）与**依赖闭包可审计**的前提下成立。
4. **DB 端 fencing（推荐但当前不可用）**：以**数据库端可执行的栅栏**把「锁已失效」与「写入被拒绝」绑定——
   例：写入语句携带**栅栏令牌**（fence token），由数据库侧判定其**仍然有效**，失效则该写入**失败**。
   该机制要求**额外表/函数/权限**（`SCHEMA_MIGRATION=HOLD`、权限未核验）⇒ 当前 **不可用**；
   在获得之前，本设计**只能**依赖第 3 条的预防性实现，并**必须**保留第 5 条的事后检出作为**检测手段**（非保证）。
5. **事后检出（保留，但仅作检测）**：`COMMIT` 返回后的 `P2` 复核（§27.3.5）**保留**，
   其结论按 §28.4 的**分离语义**记录（`safetyOutcome` / `dbCommitOutcome` / `exclusiveWindowViolated` / `downstreamAutomation`）；
   **禁止**把它描述为「排他权的证明」。
6. **不可证明时的处置（写死）**：若第 3 条的 ①②③④ **不能同时成立**（或无法证明），
   **且**第 4 条的 DB 端 fencing **不可用** ⇒ **`EXCLUSIVE_WINDOW_UNAVAILABLE`，不得写入**。
7. **明确禁止的替代物**：①「缩小微观窗口」；②「提交后检查」；③「更频繁的探针」；④「扫描/计数器」——
   以上**均不得**用于替代第 2 条的互斥安全证明。

### 28.2 CHANGE 80（P0）—— M1 **跨实例恢复阻断权威**

**承认审计方的判断**：数据库唯一索引（`CREATE UNIQUE INDEX "AutonomyCandidate_dedupeKey_key"`）
可防止**两个成功提交的事务**建立相同 `dedupeKey` 的候选记录，但**无法保证两个执行实例共享同一个恢复状态判断**：
在「E1 结果未知、E2 发现唯一键冲突」时，可确认**目标记录存在**，但**不一定能确认哪个执行提交**；
**不得**据唯一键冲突把 E1 标记为成功；**本地文件不能天然成为所有实例共享的阻断权威**。

**R20 规则**

1. **恢复的串行化（在受控范围内实现"单一协调者"）**：**恢复流程必须与写入共用同一把排他锁**——
   即「恢复」也必须在 `T0`→`T1`→`T2` 的**排他窗口内**执行（含 §28.1 的 `SAFETY_PREMISE`）。
   由此在 U2 受控范围内**结构性地**保证：**同一时刻只有一个恢复协调者**可推进任何恢复判定；
   未取得排他窗口 ⇒ **不得**进行任何恢复判定（保持 `UNKNOWN` 并转人工）。
2. **跨实例的持久阻断（如实选择可行分支）**：
   - **分支 A（需新增 schema）**：以**唯一的、所有写入者共同遵守**的持久登记处记录
     `ATTRIBUTION_UNRECOVERABLE` 等状态 ⇒ **当前 `SCHEMA_MIGRATION=HOLD`，不可用**；
   - **分支 B（本轮采用）**：**明确将不可归因状态转入人工/控制面处置**——
     以**意图记录 + 结构化日志 + 控制面工单**作为记录，并**在获得授权前禁止**：
     ①并发恢复 ②自动重试 `INSERT` ③任何自动化后续动作（`downstreamAutomation=BLOCKED`）。
   **如实标注**：分支 B 下「跨实例自动互认」为 `NOT_VERIFIED`（未实现），因此**不得**据此授权并发恢复或自动推进。
3. **本地意图记录与数据库提交不一致时的确定性处置（逐行）**：

| 本地意图 | 主库观察 | 确定性处置 |
| --- | --- | --- |
| `PREPARED` | **无**目标行 | **不得**推断已提交；进入**受控恢复**（须持排他窗口）；**不得**直接重放 `INSERT` |
| `PREPARED` | 目标行存在，且**因果证据有效**（§28.3 的"可证明"级别） | 可确认**对应提交**（`thisExecutionCommitted=YES`，须同时满足全部前提） |
| `PREPARED` | 目标行存在，但因果证据**不可验证** | `UNKNOWN` + `ATTRIBUTION_UNRECOVERABLE` ⇒ **人工处置**，`downstreamAutomation=BLOCKED` |
| **缺失/不可读/HMAC 校验失败** | 目标行存在 | `UNKNOWN` + `ATTRIBUTION_UNRECOVERABLE` ⇒ **人工处置**（**不得**凭内容相似补全归因） |
| **缺失** | 无目标行 | **`UNKNOWN`** ⇒ 转人工（**不得**自动重放） |
| `COMMIT_UNKNOWN` | 任一 | `UNKNOWN`；**禁止**自动重试 `INSERT` |
4. **禁止项（重申并加严）**：①不得以唯一键冲突判定某执行"提交成功"；②不得在未取得排他窗口时做恢复判定；
   ③不得在 `ATTRIBUTION_UNRECOVERABLE` 下推进任何自动化动作；④不得把本地文件的存在当作"已消费/已提交"的证明。

### 28.3 CHANGE 81（P0）—— `XID` / `xmin` 的**证明边界**（降为辅助证据）

**承认审计方的判断**：R19 对冻结语义的更正方向正确，但
`xmin == low32(capturedXid8)` ∧ `currentXid8 − capturedXid8 < 2^31` ∧ `freezing_impossible`
**仍不足以独立证明目标行一定由该执行创建**：①`xmin` 是**行版本**事务标识，**不是业务执行标识**；
②时间窗限制**不能独立证明**该行未被更新、重写或替换；③当前与历史事务 ID 的差距**不能证明行的完整来源**；
④冻结参数与 XID 消耗速度**只能辅助评估风险**。

**R20 规则**

1. **证据分级（本项目据此对外表述，禁止越级）**：

| 结论 | 允许的证据 | 说明 |
| --- | --- | --- |
| **`CANDIDATE_EXISTS`** | 主库存在 `dedupeKey` 相同且必要不变字段一致的行 | **只证明存在**（可能由本执行或其他写入者插入） |
| **`THIS_EXECUTION_COMMITTED`** | 需**执行身份与数据库事务之间的可信绑定**（第 2 条） | **当前配置下不可达成**（第 3 条） |
| **`UNKNOWN`** | 其余全部情形（含 `xmin` 只匹配但不满足第 2 条） | **保守默认** |
2. **可接受的"可信绑定"来源（须同时具备"只能由本执行产生"与"数据库侧可验证"两条性质）**：
   - **(T1) 同事务数据库审计记录**：在本事务内写入一条关联 `{executionRef, candidateId}` 的记录 ⇒ **需新增表/约束**（`HOLD`，当前不可用）；
   - **(T2) 数据库端回执/栅栏**：由数据库侧提供**可持久验证**的事务回执或栅栏令牌 ⇒ **需额外能力/权限**（不可用）；
   - **(T3) 服务端串行化 + 服务端生成令牌**：由数据库侧在事务内生成并返回、且**其他写入者无法预测**的令牌，并与候选行绑定 ⇒ **需 schema/能力**（不可用）。
3. **当前配置下的确定性结论（关键）**：在 `SCHEMA_MIGRATION=HOLD`、无额外数据库能力的条件下，
   **没有任何机制满足第 2 条** ⇒ 本设计**不得**宣称 `THIS_EXECUTION_COMMITTED=YES`；
   `thisExecutionCommitted` 在本配置下**上限为 `UNKNOWN`**（`COMMIT_ATTRIBUTION_PROOF = NOT_AVAILABLE_IN_CURRENT_CONFIGURATION`）。
   这与 §24.2 的字段分列一致：**允许** `candidateExists=YES` 与 `thisExecutionCommitted=UNKNOWN` 并存。
4. **`xmin` 的定位（降级并写明用途）**：`xmin` **仅作辅助证据**，用于：
   ①**辅助排除**（例如与本实例捕获的 `xid8` 不一致时，**支持**"不是本执行"的判断——仍需保守表述）；
   ②**辅助检测外来修改**（行被更新/删除重插/重写时 `xmin` 变化 ⇒ 触发 `UNKNOWN`）；
   **不得**单独用于**肯定**归因。原 §27.5.3 的"epoch 构造"**降级为辅助校验**，其通过**不**提升证明等级。
5. **原行版本连续性的证明要求（未满足即 `UNKNOWN`）**：①同一**主库实例**；②窗口内该行**未被更新/删除重插/重写**
   （以两次读数一致 + `xmin` 一致 + §26.4 的窗口内证据共同支持）；③窗口内**不可能发生冻结**（须有参数与推进证据；取证失败即不成立）；
   ④`(ctid, tableoid)` 等物理定位不得被当作长期稳定标识（仅作**同窗口内**辅助比较）。
6. **提升证明等级的唯一路径**：在**目标 PostgreSQL 版本**上完成实测，并**先取得**第 2 条之一的机制（授权）；
   在此之前，任何"已证明 epoch 归属"的表述**禁止出现**（`XID_EPOCH_CONSTRUCTION_VERIFIED=NOT_VERIFIED`）。

### 28.4 CHANGE 82（P1）—— 修正 `U2-50j` 与 `U2-51b` 的**验收语义**

1. **`U2-50j` 拆分为两个时序**（原单一用例作废）：

| 编号 | 时序 | 必须结果 |
| --- | --- | --- |
| **U2-50j-1** | 释放在**最终 `P2` 之前**（含 `T1` 取锁后、`T2` 门禁前） | **可检出**：`P2`/门禁失败 ⇒ `ROLLBACK`、零写入（`LOCK_RELEASED_EARLY`） |
| **U2-50j-2** | 释放在**最终 `P2` 之后**（`COMMIT` 发出前或往返期间） | **提交前不可检出**；须由 §28.1 的 `SAFETY_PREMISE`（预防性实现或 DB 端 fencing）**阻止**；若**未**满足该前提 ⇒ 该场景**不允许被设计为"可检出"**，只能按 §28.1.6 **拒绝写入**（`EXCLUSIVE_WINDOW_UNAVAILABLE`） |
2. **`U2-51b` 的分离语义（写死）**：`outcome='REJECTED'` 表示**安全验收拒绝**，**不得**直接表达数据库事务已回滚。
   必须**分列**：

```text
safetyOutcome            = REJECTED
dbCommitOutcome          = COMMITTED | NOT_COMMITTED | UNKNOWN
exclusiveWindowViolated  = true
downstreamAutomation     = BLOCKED
```

3. **禁止**：把「安全拒绝」混写为「数据库未提交」；把「提交后检出」当成「排他权证明」；
   把「`U2-50j` 通过」当成 §28.1 安全前提已成立。
4. **保留**：`U2-50g`（`PREPARED` 已 fsync、`COMMIT` 前崩溃 ⇒ 不得误判 YES）、`U2-50h`（冻结后 `xmin` 未变或超窗 ⇒ `UNKNOWN`）、
   `U2-50i`（E1 归因不可恢复、E2 竞争同一 `dedupeKey` ⇒ 不得产生第二个候选）的**负面方向不变**。

### 28.5 R20 未变部分与未验证项

§12 候选键 v2 与 digest 概念、§13.1 接口、§13.2 矩阵（`U2-50j` 拆分、其余保持）、§16.1 `CONTROLLED_FIXED_WORKTREE`、
§17.1 隔离证明框架、§17.2 U2-20A/B/C、§17.3 零行冲突复用路径、§18.1 释放全链校验、§18.2 行锁与重试边界、
§19.4 通道/签发者分离、§20.3（CHANGE 42）状态语义、§21.2（CHANGE 45）方向、§21.3.4 验证时机与有效期、
§22.2 `flock` 释放/继承修正、§22.4 四条件、§22.6 字节级契约、§22.7 原子占用、
§23.1 `T0`/`T1`/`T2` 分阶段条件、§23.3 检测 vs 保证、§23.4 归因四类、§23.5 证据范围纪律、§23.6 字节编码三断言、
§23.7 消费持久化、§24.1 `P2` 必要非充分与错误分类、§24.2 存在性/提交归因区分、§24.3 `CONSUMPTION_UNKNOWN`、
§25.2 统一锁 FD 边界与全窗口覆盖、§25.3 M1~M4 候选、
§26.1 `O3-CONTRADICTED` 边界、§26.2 唯一生产锁协议、§26.3 威胁模型与构建期规则、§26.4 意图记录契约、
§26.6 U2-50a~f、§27.1 `P2` 独立性契约（**CLOSED**）、§27.2 `DEPLOYMENT_INVENTORY` 与负面验收（**CLOSED_SCOPED**）、
§27.3.1–§27.3.2 写入进程隔离与 fail-stop、§27.4.1 意图记录五态、§27.4.5 禁止项、
`builderRef` 固定常量、**U2 路径仅 INSERT**、U2 路径无 `UPDATE`/`DELETE`、不新增 schema/migration、
不接 Runtime/Queue、不调用模型/Provider、ACCOUNT 保持 `NOT_AUTHORIZED`、U1 封板 `9ee36837` 不变、
`SCHEMA_MIGRATION=HOLD`、`EXTERNAL_WRITE=HOLD`、`AUTO_MERGE/AUTO_DEPLOY=FORBIDDEN`、`PRODUCTION_READY=NO`。

```text
R20_NOT_VERIFIED = SAFETY_PREMISE_PREVENTIVE_IMPLEMENTATION（①~④ 未实现/未证明） ;
                   DB_SIDE_FENCING_CAPABILITY（不可用） ; COMMIT_ATTRIBUTION_PROOF（当前配置下不可达成） ;
                   CROSS_INSTANCE_RECOVERY_BLOCKING（分支 B：未实现自动互认） ;
                   XID_EPOCH_CONSTRUCTION_VERIFIED（降级为辅助校验，未在目标 PG 实测） ;
                   P2_INDEPENDENCE_ENFORCEMENT ; DEPLOYMENT_INVENTORY_EVIDENCE ;
                   FILESYSTEM_AND_MOUNT_PREREQUISITES ; WRITE_PROCESS_ISOLATION ;
                   M1_RECOVERY_STATE_MACHINE ; ATTRIBUTION_MAX_WINDOW_EVIDENCE ;
                   LOCKFD_BOUNDARY_STATIC_RULES ; U2_LINUX_MULTIPROCESS_TESTS ;
                   DB_PRIVILEGE_VERIFICATION ; GLOBAL_IMMUTABILITY_PROOF ;
                   DB_RUNTIME_PRIVILEGES ; DB_TRIGGERS_ACTUAL ; DB_ROLES ; DB_WRITER_SET_ACTUAL ;
                   OBSERVATION_WINDOW_IMMUTABILITY ; U2_NONCE_CONSUMPTION_STORE ;
                   POSTGRESQL_INTEGRATION_TEST ; VITEST ; TSC ; LINUX_SYSTEMD ; CI ; PRODUCTION ;
                   U2_DESIGN_DOC_SHA256（送审方报告）
```

本文件仍为**纯设计 R20**：未新增产品代码、未建表、未执行迁移、未接线运行时、未调用模型。
本轮只读核验**仅**读取 `apps/api/prisma/schema.prisma`、既有迁移文件与 `apps/api/src` 中的只读检索结果，
**未**连接任何数据库、**未**执行任何写入。
---

## 29. R21 修订（对应 MSG-20261009-45 的 CHANGE 83–85；并按审计方要求收敛）

> 授权来源：`MSG-20261009-45 = REVISE` ⇒ `NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_R21_READ_ONLY_CHANGES_83_TO_85`。
> 本轮**不扩展** `xmin`/epoch/`P2` 探针方案（遵循审计方收敛要求），只处理**两个可执行问题**与一项验收补强。
> `U2_DESIGN_R20_ACCEPTED=NO`、`U2_PLATFORM_ONLY_INSERT_SUBSET=NOT_AUTHORIZED`、`U1_REOPEN=NO` **不变**。

```text
AUDIT_SCOPE   = b396dc99..6e8366cf = 2 commits / 3 files（含上一轮裁决归档提交 914dcda7 与本轮设计提交）
SINGLE_COMMIT = 914dcda7..<本轮设计提交> = 1 commit / 1 file
PRODUCT_CODE  = 0
```

| CHANGE | R20 位置 | R21 修订位置 | 变更性质 |
| --- | --- | --- | --- |
| **CHANGE 83（P0）** | §28.1.2–§28.1.6 | **§29.1** | **失败模型**（进程终止/在途 `COMMIT`）+ 排他证明的**可执行判据**与**显式不成立结论** |
| **CHANGE 84（P0）** | §28.2.1–§28.2.2 | **§29.2** | 恢复**强制范围**的可执行门禁 + `MULTI_INSTANCE_AUTOMATED_WRITE=NOT_AUTHORIZED` |
| **CHANGE 85（P1）** | §28.4.2 | **§29.3** | `U2-51b` 的**数据库结果验收断言** |
| 收敛声明 | — | **§29.4** | 按审计方要求把结论收敛为**两个可执行问题** |

### 29.1 CHANGE 83（P0）—— 提交窗口的**失败模型**与排他证明的**可执行判据**

**承认审计方的判断**：R20 §28.1 的四项预防性条件只能防止**部分应用代码主动释放**的行为，
**不能证明提交窗口内锁不会意外释放**。审计方反例（「**进程退出，但数据库提交仍可能成功**」）成立：
提交请求送达数据库后，客户端失效与事务最终结果之间存在**不确定区间**；`flock` 由**操作系统**管理，
进程异常终止**可能导致锁释放**；而 PostgreSQL 对**已收到的 `COMMIT`** 是否完成，**不能**凭客户端进程存活状态推断。

**R21 规则**

1. **失败模型（必须逐项纳入，不得省略）**：

| 编号 | 失效 | 锁是否可能被释放 | 是否可能有**成功写入**违反排他 |
| --- | --- | --- | --- |
| `F1` | 应用代码主动 `LOCK_UN`/`close`（缺陷） | 是 | 是（§27.3 已按 fail-stop 处理） |
| `F2` | 进程崩溃（`SIGSEGV`/`abort`）、`SIGKILL`、OOM-Kill | **是**（内核回收该 OFD） | **是**（`COMMIT` 可能已在途） |
| `F3` | 容器/宿主重启、锁持有者整体失效 | 是 | **是** |
| `F4` | 客户端连接中断（`COMMIT` 已发出、结果未知） | 是（会话结束） | **是** |
| `F5` | 数据库在途提交（服务端仍在处理我们已发出的 `COMMIT`） | 与客户端无关 | **是** |
| `F6` | 文件系统/网络文件系统的锁语义差异（`NFS`/`SMB`） | 视环境 | **是** |
2. **可执行判据（唯一放行条件）**：

```text
EXCLUSION_PROOF_STATUS ∈ { PROVEN, NOT_PROVEN }

PROVEN  要求满足下列【之一】，并附目标环境证据：
  (P1) 数据库端强制机制（fence / 行级条件写入 / 服务端串行化）：
       陈旧持有者的写入在【数据库侧】被拒绝 —— 需额外表、函数或权限；
  (P2) 环境级证明：在【目标文件系统 + 挂载方式 + 协议一致性 + 无未登记写入者】下，
       证明从「COMMIT 已发出」到「COMMIT 结果确认」期间【不存在】任何可进入的第二个写入者，
       且该期间的锁状态与提交结果由【非客户端存活】的证据支撑。

NOT_PROVEN = 上述均不成立或无法举证
  ⇒ EXCLUSIVE_WINDOW_UNAVAILABLE = YES
  ⇒ 不得写入（零候选写入）
  ⇒ 【静态规则检查通过】【计数器为 0】【提交后探针通过】均【不得】作为实施许可
```

3. **当前状态的显式结论（不掩饰）**：`(P1)` 需要的能力**当前不可用**（`SCHEMA_MIGRATION=HOLD`、数据库权限未核验）；
   `(P2)` 需要**目标环境证据**（文件系统/挂载/协议一致性/无未登记写入者），**当前全部 `NOT_VERIFIED`**。
   ⇒ 本轮**明确给出**：**`EXCLUSION_PROOF_STATUS = NOT_PROVEN`**、**`SAFETY_PREMISE = NOT_PROVEN`**、
   **`EXCLUSIVE_WINDOW_UNAVAILABLE = YES`**；因此 **U2 候选写入在本配置下不可授权**。
4. **可执行的不变量（供未来实施，非当前许可）**：若未来取得 `(P1)` 能力，须以**数据库侧**判定取代客户端判定，
   即：写入语句**只在栅栏令牌仍有效时**成功；令牌失效 ⇒ 数据库拒绝写入（客户端"以为"仍持锁**不**构成写入成功条件）。
5. **负面验收（必须定义，未来在目标环境执行）**：

| 编号 | 场景 | 期望 |
| --- | --- | --- |
| **U2-52a** | `COMMIT` 已发出后**立即 `SIGKILL`** 写入进程，另一实例同时尝试写入 | 在 `(P1)` 能力下：**陈旧方写入被数据库拒绝**；在无 `(P1)` 时：**记录该风险**并保持 `EXCLUSIVE_WINDOW_UNAVAILABLE`（**不得**以"窗口很小"通过） |
| **U2-52b** | 客户端连接中断（`COMMIT` 结果未知）后另一实例写入 | 同 U2-52a；且**禁止**自动重放同一业务 `INSERT` |
| **U2-52c** | 容器重启/宿主重启期间的写入竞争 | 同 U2-52a |
6. **禁止的替代物（再次写死）**：静态规则、计数器、提交后探针、缩小窗口、更频繁探测——
   **一律不得**用于替代 `EXCLUSION_PROOF_STATUS=PROVEN`。

### 29.2 CHANGE 84（P0）—— 恢复的**强制范围**与**多实例自动化写入的显式不授权**

**承认审计方的判断**：共用同一把锁只解决**受控参与者之间**的部分并发协调，
**不能**得出「所有实例都受同一权威约束」的结论；**日志与工单本身不能构成分布式强制阻断机制**。

**R21 规则（可执行门禁）**

1. **共享前置条件（四项全部必需，逐项需证据）**：
   ①所有参与实例使用**同一个可提供可靠互斥语义的文件系统、锁键（同一绝对路径）与锁协议**（`flock:whole-file:LOCK_EX`）；
   ②不存在**绕过协调者的独立任务或历史服务**（须以 `DEPLOYMENT_INVENTORY` + 数据库写入主体清单举证）；
   ③**人工解除阻断与自动恢复共用同一强制门禁**（不允许"人工绕过"路径）；
   ④存在**跨实例可见且可强制**的阻断状态（否则见第 3 条）。
2. **fail-closed 强制不变量（可直接编码为门禁）**：

```text
R84-INVARIANT（任何实例在任一时刻必须满足）
  若 【无法证明与其他实例共享同一阻断状态】
     或 出现 ATTRIBUTION_UNRECOVERABLE
     或 跨实例阻断状态不确定
  ⇒ 禁止 INSERT（候选写入）
  ⇒ 禁止执行恢复写入
  ⇒ 禁止推进任何下游自动化（downstreamAutomation = BLOCKED）

R84-UNBLOCK
  解除阻断【只能】由受控人工授权触发，且必须重新走验收（不得自动解除、不得超时自动恢复）
```

3. **当前能力的显式声明（关键）**：在**不新增 schema** 的约束下，**不存在**满足第 1 条 ④ 的**跨实例强制阻断**载体
   ⇒ 本设计**明确声明**：

```text
MULTI_INSTANCE_AUTOMATED_WRITE = NOT_AUTHORIZED
SINGLE_INSTANCE_CONTROLLED_EXPERIMENT = 未来独立验收范围（须单独授权；
    且【不得】据此推导跨实例生产安全）
```

4. **分支 B 的定位（收窄并加严）**：R20 §28.2 的分支 B 仍可作为**人工恢复**的处置流程，
   但其证据（意图记录 + 日志 + 工单）**只用于人工决策**，**不构成**分布式强制阻断机制；
   任何实例在无法证明共享阻断状态时，**必须**执行第 2 条的不变量（禁写 + 禁止自动化）。
5. **可执行的不变量（供未来实施）**：若未来取得跨实例共享的可强制阻断载体（新表/外部控制面），
   则 `R84-INVARIANT` 的第一条件由该载体**查询结果**判定；**判定失败即视为"无法证明"**（保守）。

### 29.3 CHANGE 85（P1）—— `U2-51b` 的**数据库结果验收断言**

1. **三条必须写入验收规范的断言**：

```text
A1  若 dbCommitOutcome = COMMITTED 且 safetyOutcome = REJECTED
    ⇒ 报告中【禁止】出现「已回滚」「零持久化写入」等结论；
    ⇒ 该行按【已持久化】对待，归因至多 candidateExists=YES / thisExecutionCommitted=UNKNOWN

A2  若 dbCommitOutcome = UNKNOWN
    ⇒ 【禁止】对同一 dedupeKey 自动重放相同业务 INSERT；
    ⇒ 只能按 §29.2 的 fail-closed 不变量处置（禁写 + 禁止下游自动化 + 人工）

A3  「安全状态恢复正常」（例如重新取得锁）【不得】被记录为
    「提交归因已完成」；两者是【不同维度】，必须分列
```

2. **报告字段语义（固定）**：`safetyOutcome ∈ {ACCEPTED, REJECTED}`（**安全验收**维度）；
   `dbCommitOutcome ∈ {COMMITTED, NOT_COMMITTED, UNKNOWN}`（**数据库事实**维度）；
   `exclusiveWindowViolated ∈ {true,false}`（**排他窗口**维度）；`downstreamAutomation ∈ {ALLOWED, BLOCKED}`。
   四者**互不推导**；`A1`~`A3` 为**验收断言**（未来实施阶段执行），**本轮未运行**。

### 29.4 收敛声明（按审计方要求，把结论压到**两个可执行问题**）

| 问题 | 可执行判据 | 当前状态 |
| --- | --- | --- |
| **Q1 数据库事务提交期间能否证明排他权仍有效？** | `EXCLUSION_PROOF_STATUS ∈ {PROVEN, NOT_PROVEN}`，`PROVEN` 仅当 `(P1)` 数据库端强制 或 `(P2)` 环境级证明成立（含目标环境证据） | **`NOT_PROVEN`** ⇒ `EXCLUSIVE_WINDOW_UNAVAILABLE=YES` ⇒ **不可写入** |
| **Q2 提交归因未知时，所有参与实例能否被强制停止自动化？** | `R84-INVARIANT` 可被所有实例强制执行，且存在**跨实例可强制**的阻断载体；判定失败即视为"无法证明" | **未实现** ⇒ 已声明 **`MULTI_INSTANCE_AUTOMATED_WRITE=NOT_AUTHORIZED`** |

**结论（如实）**：在上述两项**未达成**之前，本设计**不再增加**描述性检查，也不再扩展 `xmin`/epoch/`P2` 方案；
U2 候选写入子集**不可授权**。若后续授权**数据库端能力**（栅栏/串行化/共享阻断载体）或提供**目标环境证据**，
则按 §29.1 的 `(P1)`/`(P2)` 与 §29.2 的第 1 条重新举证，再评估最小实施授权。

### 29.5 R21 未变部分与未验证项

§12 候选键 v2 与 digest 概念、§13.1 接口、§13.2 矩阵（另加 U2-52a~c）、§16.1 `CONTROLLED_FIXED_WORKTREE`、
§17.1 隔离证明框架、§17.2 U2-20A/B/C、§17.3 零行冲突复用路径、§18.1 释放全链校验、§18.2 行锁与重试边界、
§19.4 通道/签发者分离、§20.3（CHANGE 42）状态语义、§21.2（CHANGE 45）方向、§21.3.4 验证时机与有效期、
§22.2 `flock` 释放/继承修正、§22.4 四条件、§22.6 字节级契约、§22.7 原子占用、
§23.1 `T0`/`T1`/`T2` 分阶段条件、§23.3 检测 vs 保证、§23.4 归因四类、§23.5 证据范围纪律、§23.6 字节编码三断言、
§23.7 消费持久化、§24.1 `P2` 必要非充分与错误分类、§24.2 存在性/提交归因区分、§24.3 `CONSUMPTION_UNKNOWN`、
§25.2 统一锁 FD 边界与全窗口覆盖、§25.3 M1~M4 候选、§26.1 `O3-CONTRADICTED` 边界、§26.2 唯一生产锁协议、
§26.3 威胁模型与构建期规则、§26.4 意图记录契约、§26.6 U2-50a~f、§27.1 `P2` 独立性契约（**CLOSED**）、
§27.2 部署清单与负面验收（**CLOSED_SCOPED**）、§27.3.1–§27.3.2 写入进程隔离与 fail-stop、§27.4.1 意图记录五态、
§28.3 证据分级与 `xmin` 降级（**CHANGE 81 = PASS**）、§28.4 `U2-50j` 两时序与 `U2-51b` 分离语义（**CHANGE 82 = PASS_SCOPED**）、
`builderRef` 固定常量、**U2 路径仅 INSERT**、U2 路径无 `UPDATE`/`DELETE`、不新增 schema/migration、
不接 Runtime/Queue、不调用模型/Provider、ACCOUNT 保持 `NOT_AUTHORIZED`、U1 封板 `9ee36837` 不变、
`SCHEMA_MIGRATION=HOLD`、`EXTERNAL_WRITE=HOLD`、`AUTO_MERGE/AUTO_DEPLOY=FORBIDDEN`、`PRODUCTION_READY=NO`。

```text
R21_NOT_VERIFIED = EXCLUSION_PROOF_STATUS=NOT_PROVEN ; SAFETY_PREMISE=NOT_PROVEN ;
                   EXCLUSIVE_WINDOW_UNAVAILABLE=YES ; MULTI_INSTANCE_AUTOMATED_WRITE=NOT_AUTHORIZED ;
                   DB_SIDE_FENCING_CAPABILITY=NOT_AVAILABLE ; TARGET_ENVIRONMENT_EVIDENCE=NOT_VERIFIED ;
                   COMMIT_ATTRIBUTION_PROOF=NOT_AVAILABLE_IN_CURRENT_CONFIGURATION ;
                   CROSS_INSTANCE_RECOVERY_BLOCKING=NOT_VERIFIED ;
                   P2_INDEPENDENCE_ENFORCEMENT ; DEPLOYMENT_INVENTORY_EVIDENCE ;
                   FILESYSTEM_AND_MOUNT_PREREQUISITES ; WRITE_PROCESS_ISOLATION ;
                   M1_RECOVERY_STATE_MACHINE ; ATTRIBUTION_MAX_WINDOW_EVIDENCE ;
                   LOCKFD_BOUNDARY_STATIC_RULES ; U2_LINUX_MULTIPROCESS_TESTS ;
                   DB_PRIVILEGE_VERIFICATION ; GLOBAL_IMMUTABILITY_PROOF ;
                   DB_RUNTIME_PRIVILEGES ; DB_TRIGGERS_ACTUAL ; DB_ROLES ; DB_WRITER_SET_ACTUAL ;
                   OBSERVATION_WINDOW_IMMUTABILITY ; U2_NONCE_CONSUMPTION_STORE ;
                   POSTGRESQL_INTEGRATION_TEST ; VITEST ; TSC ; LINUX_SYSTEMD ; CI ; PRODUCTION ;
                   U2_DESIGN_DOC_SHA256（送审方报告）
```

本文件仍为**纯设计 R21**：未新增产品代码、未建表、未执行迁移、未接线运行时、未调用模型。
本轮只读核验**仅**读取 `apps/api/prisma/schema.prisma`、既有迁移文件与 `apps/api/src` 中的只读检索结果，
**未**连接任何数据库、**未**执行任何写入。
