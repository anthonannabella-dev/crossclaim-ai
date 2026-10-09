# PHASE 3-A · U2 设计 R4（候选记录与 Incident↔Candidate↔Task 关联）—— **仅设计，未实施**

> 授权来源：`MSG-20261009-25 = PASS / U1_FINAL_CLOSURE=YES` →
> `MSG-20261009-26 = REVISE` → `MSG-20261009-27 = REVISE` → `MSG-20261009-28 = REVISE` →
> `NEXT_AUTHORIZED = PHASE3_A_U2_DESIGN_R4_READ_ONLY_CHANGES_9_TO_12`。
> 本文件是 **U2 设计 R4** 送审材料（MSG-20261009-29），**不含任何产品代码改动**。
> **R4 的修订集中在 §12；§1–§10 为 R2 原文、§11 为 R3 修订（保留历史）；凡冲突者以 §12 为准。**

| 锚点 | 值 |
| --- | --- |
| U1 关闭锚点（封板代码，未被改动） | `9ee36837` |
| U2 设计 R1 | `065f950e` |
| U2 设计 R2 | `5ae09e37` |
| U2 设计 R3 | `ac94ef8e` |
| U2 设计 R4 | 本提交（同一个仓库路径 `docs/releases/SI-RSI-INTERNAL-CODE-REPAIR-V1-PHASE3A-U2-DESIGN.md`） |
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
