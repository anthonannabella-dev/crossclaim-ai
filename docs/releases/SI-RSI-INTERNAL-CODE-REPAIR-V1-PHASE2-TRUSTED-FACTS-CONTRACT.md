# SI/RSI INTERNAL CODE REPAIR V1 · PHASE 2 —— 可信事实来源契约（TRUSTED FACTS CONTRACT）

> 授权依据：MSG-20261009-09（PHASE 2 FINAL-R2 / CHANGE 3：固定可信事实来源契约）。
> 适用范围：PHASE 2 故障分流的**服务端可信事实**输入。本文件是契约正文；可执行断言见
> `apps/api/src/__tests__/internal-code-repair-phase2-trusted-facts-contract.test.ts`（11 用例）。

## 1. 三个可信事实的允许来源

分流只接受三个可信事实；**每个事实只有一个允许来源**：

| 可信事实 | 允许来源（唯一） | 语义 |
| --- | --- | --- |
| `organizationIdResolved` | `TRUSTED_PERSISTED_IDENTITY` | 该 Incident 的租户身份是否已由**可信持久化身份关系**解析（不是请求里的 organizationId） |
| `authorizationActive` | `SERVER_AUTHORIZATION_STATE` | 该组织当前是否存在未撤销、未过期的授权 —— 由**服务端当前授权状态**重新解析得出 |
| `operationRecheck` | `TRUSTED_EXECUTION_CONTEXT` | 对「只读 / 确认未生效 + 可信幂等 / 未确认」的**再次确认**，来自可信执行上下文 |

**禁止来源（一律视为不可信）**：`REQUEST_PARAM`、`CLIENT_INPUT`、`MODEL_OUTPUT`、`UNKNOWN`（未声明即不可信）。

## 2. 可执行的契约（不是纸面约定）

1. `assertTrustedFactSources(declaration)` —— 校验来源声明；返回违规字段清单
   （`FORBIDDEN_TRUSTED_FACT_SOURCE` / `SOURCE_MISMATCH`），未声明的事实同样 fail-closed。
2. `defineTrustedFactsResolver(declaration, resolver)` —— **唯一推荐的可信事实解析器构造方式**；
   声明违规时在**创建期**抛 `TrustedFactSourceContractError`。
3. `createPrismaFaultTriageSweep({ trustedFactSources })` —— 接线时再次校验声明；违规即抛错。
   （生产适配器**必须**提供声明；未提供声明的调用只保留给测试与被明确标记的实验路径。）
4. 缺省（无解析器）⇒ 全部事实按 `FAIL_CLOSED` 处理：任何 A 路径候选都会在
   `TENANT_CONTEXT_NOT_TRUSTED` / `AUTHORIZATION_NOT_ACTIVE` / `RUNTIME_RECHECK_NOT_CONFIRMED` 处被拦下。

## 3. 快照语义（与运行时授权的关系）

- 分流结论只是**某一时刻的快照**：`autoRecoverAuthorized = true`
  **不是**任务提交/执行授权，`runtimeHandoffAuthorized = true` 也只是「可交回既有运行时再校验」的资格。
- 已登记的分流结论采用 **first-write-wins**：可信事实若在「计算 → 写入」之间变化，已登记内容**不被改写**；
  因此运行时**不得**把该快照当作授权凭证，必须自行复核（服务端可信事实、幂等状态、租约 fencing、授权时效、外写门禁）。
- 未来若需要重新评估并更新登记，必须另行设计**版本化机制**并单独送审（本轮不实现）。

## 4. 未来适配器（接线）必须满足

1. 必须经 `defineTrustedFactsResolver` 声明三个事实的来源，并**证明**该来源（例如：组织身份来自可信身份关系表 /
   会话上下文，授权状态来自服务端授权存储，操作复核来自执行上下文的再次确认）。
2. **不得**把请求参数、客户端字段、模型输出直接映射为可信事实；不得让调用方自报「授权有效」。
3. 不得新增第二套 Runtime / Scheduler / Controller；A 路径的消费必须由既有 ONE SI Runtime 承担。
4. 任何 schema / migration 变更须先提交独立 Schema Delta 审计。

## 5. 验收证据（本轮实测）

| 项目 | 结论 |
| --- | --- |
| 契约常量与值域 | `TRUSTED_FACT_SOURCE_REQUIREMENTS` / `FORBIDDEN_TRUSTED_FACT_SOURCES` / `TRIAGE_TRUSTED_FACT_CONTRACT` 逐项断言 |
| 负向矩阵 | 三个事实分别被声明为 `REQUEST_PARAM` / `CLIENT_INPUT` / `MODEL_OUTPUT` / `UNKNOWN` ⇒ 违规并被点名 |
| 配对错位 / 未声明 | 合法种类但用错事实、以及未声明 ⇒ 一律违规（fail-closed） |
| 构造期校验 | `defineTrustedFactsResolver` 违规声明抛 `TrustedFactSourceContractError`；合法声明可正常解析 |
| 源码级边界 | 分流/扫描源码不出现 `req.body|query|params`、`request.body|query|params`、`modelOutput`，且零日志输出 |
| 回归 | PHASE 2 四套件 **56/56 PASS**（含真实 PostgreSQL 17 用例）；`apps/api tsc --noEmit` **0 error** |

## 6. 强制条款（MSG-20261009-10 · CHANGE 5 / CHANGE 6）

### 6.1 声明不是运行时授权（CHANGE 5）

> **来源声明只约束解析器配置。** PHASE 3 必须通过**受信服务端适配器**取得可信事实，并在**执行前重新读取与校验**；
> 禁止以声明对象、登记快照或模型输出代替授权。

- 注册到代码中的常量：`TRIAGE_TRUSTED_FACT_CONTRACT.declarationIsNotAuthorization = true`。
- `triageDecision = AUTO_RECOVER_VIA_RUNTIME` 只是**历史时点的候选判断**；执行前必须重新验证组织身份、授权有效性、
  操作上下文与当前故障状态（审计 MSG-20261009-10 原文约束）。

### 6.2 来源伪装负向断言与已登记前置条件（CHANGE 6）

- 契约测试断言：来源种类的**形态变体**（大小写、首尾空白、前后缀伪装）一律判为违规，不可能仅靠字符串相似通过校验。
- **如实登记的限制**：字符串级声明校验**不能证明来源真实性** —— 若未来适配器把客户端值包装成合法声明，
  本层无法阻止信任提升。因此本层**没有**可验证的运行时来源隔离：

  ```
  PHASE3_IMPLEMENTATION_PREREQUISITE = TRUSTED_ADAPTER_SOURCE_PROVENANCE_EXECUTION_TIME_RECHECK
  TRIAGE_TRUSTED_FACT_CONTRACT.runtimeSourceIsolationImplemented = false
  ```

  该前置条件必须在 PHASE 3 实现阶段关闭（受信适配器来源证明 + 执行时重新读取与校验），
  在此之前**不得**据此批准任何自动执行能力。
