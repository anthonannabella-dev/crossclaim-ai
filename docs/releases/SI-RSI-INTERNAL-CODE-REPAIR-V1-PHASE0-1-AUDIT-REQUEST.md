# SI/RSI INTERNAL AUTONOMOUS CODE REPAIR V1 —— PHASE 0 + PHASE 1 独立审计请求

> 审计编号（请在回复标题中沿用）：**MSG-20261009-07**
> `REVIEWED_HEAD` = `6a1bf54e`（分支 `feat/si-rsi-internal-code-repair-v1`；基线 `7c8bdc77`）
> durable 记录：`docs/releases/SI-RSI-INTERNAL-CODE-REPAIR-V1.md`（§1 能力审计、§1.3 PHASE 1 实施与验收）
> 通道：右侧 ChatGPT 会话（本文件为 durable 记录；会话只作投递）

## 一、本轮送审范围（只审这两段）

- **A. PHASE 0** —— 现有能力审计（指令列出的 14 类能力逐项核实）。
- **B. PHASE 1** —— 内部故障诊断中心（确定性分类 → 可信 Incident）。

\*\*不审范围\*\*：PHASE 2–7 尚未开始（PHASE 2 故障分流 / PHASE 3 隔离修复代理 / PHASE 4 独立 Judge /
PHASE 5 受控发布准备 / PHASE 6 故障与恢复学习 / PHASE 7 端到端 A–P）。

## 二、PHASE 0 结论（实测，非推断）

- 指令列出的 **14 类能力：13 项真实存在**（ONE SI Runtime、Controller/EventLoop、Task Generator、
  Recovery SI Pack、Model Gateway/Router、Judge/Verifier、Action Guard/Policy、Autonomy 三表含 retry 迁移、
  Experience Memory、Meta Learning、Controlled Config、Sandbox/Canary、测试执行器与 CI、
  以及 `tools/dev/si-rsi-continuous-check.mjs`）。
- `tools/dev/si-rsi-continuous-check.mjs` **只是开发期检查器**（不调用模型、不写代码），不得据此宣布「修复代理已存在」。
- 全仓 `rg` 实测：**无 `code-repair/` 目录、无 `CODE_REPAIR_CANDIDATE` 引用**
  ⇒ `INTERNAL_CODE_REPAIR_AGENT = NOT_IMPLEMENTED`（本任务主体待建）。

## 三、PHASE 1 实现（**纯新增 4 文件**，未修改任何既有文件）

### 3.1 `apps/api/src/services/self-repair/fault-classification.ts` —— 确定性分类（纯函数，零 IO、零模型调用）

- **12 类**：API_TIMEOUT / API_RATE_LIMIT / TOKEN_EXPIRED / PROVIDER_SCHEMA_CHANGED / PARSER_FAILURE /
  WORKFLOW_PLANNING_ERROR / DATA_CONFLICT / DATABASE_TRANSACTION_ERROR / RUNTIME_EXCEPTION /
  INTEGRATION_CONTRACT_MISMATCH / REGRESSION_FAILURE / UNKNOWN_ERROR。
- **规则表顺序即优先级**；同一证据必然同一结论（含去重键 `dedupeKey`）。
- **不猜**：HTTP 403 等无确定证据 ⇒ `UNKNOWN_ERROR` + `HUMAN_REVIEW`（**不冒充** TOKEN_EXPIRED）。
- **模型只有辅助归因权**：`annotateUntrustedModelHint()` 只记录「模型声称什么」，`authority='NONE'`，
  不参与分类 / 风险 / 重试 / 权限；即使「猜对」也不构成授权。
- **单向升级**：`securityAffecting` / `privilegeAffecting` ⇒ 只允许更保守（HIGH + HUMAN_REVIEW + 禁自动重试）。
- **AUTO_RECOVER 仅限确定性可重试类别**（API_TIMEOUT / API_RATE_LIMIT / DATABASE_TRANSACTION_ERROR）。
- `TOKEN_EXPIRED` ⇒ `ownerGatedAction='PRODUCTION_CREDENTIALS'`（既有 `requiresOwnerApproval()` 为真 ⇒ RSI 不能自我授权）。
- **脱敏**：Token / Bearer / JWT / API key / 邮箱 / 长数字 / 绝对路径一律打码；
  组织 / Provider 只落**不可逆引用** `org-<sha16>` / `provider-<sha16>`。

### 3.2 `apps/api/src/services/self-repair/fault-incident-intake.ts` —— 复用既有 `AutonomyIncident`（kind=`INTERNAL_FAULT`）

- **不新增表**；同因聚合到**同一行**（`sourceRefs.occurrenceCount` 原子累加：单语句 UPDATE + 隐式行锁）。
- 同 `dedupeKey` 已被**别的 kind**（客户执行面 `CUSTOMER_GOAL_QUEUE`）占用 ⇒ **拒绝写入**（`KIND_MISMATCH`），绝不劫持。
- 已 `CLOSED`/`REJECTED` ⇒ **不静默复活**（`INCIDENT_NOT_OPEN`）。
- 状态跃迁复用既有 `rsi-lifecycle` 合法跃迁表（`OPEN`→`DIAGNOSED`）。
- **不建任务、不建租约、不执行任何客户业务动作**（权限隔离是结构性的：既有 `claim()` 只信任 `CUSTOMER_GOAL_QUEUE`）。

### 3.3 测试（同样为新增文件）

- `apps/api/src/__tests__/internal-code-repair-phase1-classification.test.ts`（纯函数，29 用例）
- `apps/api/src/__tests__/internal-code-repair-phase1-incident-db.test.ts`（真实 PostgreSQL，6 用例）

## 四、本机验收证据（可复现）

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 纯函数分类 | `vitest run src/__tests__/internal-code-repair-phase1-classification.test.ts` | **29/29 PASS** |
| 真实 PostgreSQL | 隔离库 `crossclaim_p3r2_iso`（本任务自建，未触碰共享库） | **6/6 PASS** |
| 定向回归 | 新增 2 文件 + `rsi-schema-contract` + `si-rsi-phase1-authorization` + `si-rsi-phase1-durable-queue` | **5 文件 / 58 tests 全绿** |
| 类型检查 | `apps/api tsc --noEmit` | **0 error** |

真实 PG 用例覆盖：同因聚合（2 次 ⇒ 1 行、计数 2）／**6 路并发仍 1 行且计数=6**／
容器隔离（`CUSTOMER_GOAL_QUEUE` 占位时拒写且不改动）／终态不复活（CLOSED 后计数不涨）／
**修复平面 Incident 下任务无法被客户执行面领取**（持久化 BLOCKED、零租约）／落库脱敏（原始组织 id 与密钥形状文本不可见）。

**如实声明的 NOT VERIFIED**：未跑全量回归；Linux/systemd、真实浏览器验收、真实 Provider 均未验证；
`REAL_MODEL_INTEGRATION = HOLD`。

## 五、边界声明（未做清单）

未修改封板 `release/rc-20261008-linux-deploy-v1` 与 `main`；**未新增第二套 runtime / scheduler / controller**；
未改 Prisma schema / migration；未做真实 Provider 调用 / 外部写 / 支付 / 报关 / 运输；
未写真实密钥；未执行生产部署或生产迁移。

## 六、请求裁决项

请逐项判 `PASS | REVISE | FAIL`：

1. `PHASE0_CAPABILITY_AUDIT`
2. `PHASE1_DETERMINISTIC_CLASSIFICATION`
3. `PHASE1_MODEL_AUTHORITY_BOUNDARY`
4. `PHASE1_SANITIZATION`
5. `PHASE1_INCIDENT_CONTAINER_ISOLATION`
6. `PHASE1_VERIFICATION_EVIDENCE`
7. `SCOPE_HONESTY`（NOT VERIFIED 是否如实登记）

并给出：

```text
FINAL VERDICT: PASS | PASS WITH REVISE | REVISE | BLOCK
REVIEWED_HEAD: <sha>
CHANGES: <必须执行的修订>
RISKS: <剩余风险>
```

请在**本会话**直接回复（不要写入我的仓库，也不要尝试访问外部系统）。若上文不可读，回复「需要重发」。
