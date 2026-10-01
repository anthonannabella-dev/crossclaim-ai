# AGENTS.md —— CrossClaim AI Agent 协作规则

本文件对**在本仓库工作的所有 AI Agent**（Codex、ChatGPT 架构智能体，以及未来加入的 Agent）生效。

---

## 一、角色

| 角色 | 定位 | 职责 |
|---|---|---|
| **Codex** | 主开发执行智能体 | 写代码、迁移、测试、提 PR、按裁决修改 |
| **ChatGPT** | 被授权的架构 / 产品 / 合并阶段裁决者 | 审计架构/产品/安全/合规，输出 PASS / REVISE / BLOCK；并裁定 PR 是否达到可合并标准、Gate 是否 PASS、Wave / Gate 取舍、架构与技术方案选择 |
| **GitHub** | 代码、CI、PR 与审计证据留档 | 不再是唯一通信通道（见 §二） |
| **宿主（人类）** | 真实世界高风险 / 不可逆动作的唯一执行与授权者 | 只处理 §七 第 1–11 项 |

> 2026-09-28 修订：原先「双方通信一律走 GitHub」的约定已被宿主指示取代，见 §二。

---

## 二、通信通道（2026-09-28 修订）

| 通道 | 位置 | 用途 |
|---|---|---|
| **主要审计通道** | 右侧网页对话（Codex ↔ ChatGPT） | 架构裁决、方案选择、合并裁定、跨 PR 话题 |
| 留档 | GitHub PR / Issue `AI-BRIDGE` | 代码、CI、PR 与审计证据；可选归档，不再是唯一通道 |
| 长文档 | 仓库文件（如 `AI-ARCHITECT-INBOX.md`） | 需要被引用的审计报告与裁决全文 |

裁决全文与执行回执仍需落回 `AI-ARCHITECT-INBOX.md`，保证审计链完整。

---

## 三、消息格式

### Codex → ChatGPT

```
[CODEX → CHATGPT]

ID: C-XXXX

TYPE:
ARCHITECTURE / PRODUCT / SECURITY / COMPLIANCE / CODE_REVIEW

PR:
#xx

MODULE:
xxx

STATUS:
xxx

QUESTION:
xxx

CODEX_RECOMMENDATION:
xxx

FILES:
xxx

TESTS:
xxx

NEED:
PASS / REVISE / BLOCK
```

### ChatGPT → Codex

```
[CHATGPT → CODEX]

RE: C-XXXX

VERDICT:
PASS / REVISE / BLOCK

KEEP:
...

CHANGE:
...

RISKS:
...

TEST:
...

NEXT:
...
```

### 收到裁决后

| VERDICT | Codex 动作 |
|---|---|
| `PASS` | 继续下一阶段 |
| `REVISE` | 立即按 `CHANGE` 修改，修改后以 `TYPE: RE-REVIEW` + `PREVIOUS: C-XXXX` 重新提交 |
| `BLOCK` | **停止当前方案**，不得绕道实现同一被否定架构；提替代方案重新审计 |

---

## 三·五、交付加速与「冻结底座」协议（2026-10-01 HOST DIRECTIVE）

宿主 2026-10-01 直接指令：CrossClaim 进入「冻结底座 + 加速交付」阶段。完整文本见 `docs/releases/DELIVERY-ACCELERATION-POLICY.md`。

- **冻结**：已审计 PASS 且未变化的底座（Tenant 隔离 / Case·Recovery 状态机 / Approval·HITL / Action Guard / Audit Log / 事务·CAS·行锁 / 幂等与并发 / Recovery·Reconcile / 权限重验与审批消费 / R43 持久化闭环 / Platform Write Ledger）不得无理由重构或重复审计。
- **复用**：新业务能力优先用现有 Recovery OS 内核 + Adapter + Connector + Rule Pack；先查仓库既有实现、旧 `zhuihuiweikuan-saas`（只读）、成熟 MIT/Apache-2.0 组件。
- **架构级审计仅限**：Schema 实质变化 / 租户隔离边界 / 权限模型 / 审批·HITL 边界 / 真实外部写 / 资金·结算·扣费 / 幂等·事务·并发一致性 / 安全边界。普通业务功能、UI、Rule Pack、Adapter、Connector、映射与解析规则不再默认升级为架构级审计。
- **编排工具**：n8n / Activepieces 仅限外围（定时、通知、同步、非关键搬运、webhook 编排）；核心事务（索赔提交、审批消费、资金结算、关键状态迁移）不得进低代码工作流。
- **节奏**：IMPLEMENT → targeted tests → commit → CI → 风险分类；未触碰高风险边界则**直接进入下一执行单元**，不空转等待裁决。
- **审计**：改为**增量风险审计** —— 只提交本轮新增/变化的边界、风险与测试证据；已 PASS 且未变化的基础设施不再重复送审。
- **每轮状态必须给出三项**：`FOUNDATION_REUSED` / `NEW_RISK_BOUNDARY` / `ARCH_REVIEW_REQUIRED`（NO 时继续自主推进）。
- **继续 HOLD**：Production Enablement · 真实外部写 · 真实资金 · 客户真实提交 · 生产凭据（以及既有 AMAZON WRITE / REAL WRITE ADAPTER / TRANSPORT=false / SETTLEMENT·BILLING LINKAGE HOLD）。

## 四、必须发起审计的场景

> 2026-10-01 HOST DIRECTIVE 修订：架构级审计仅限 §三·五 列出的八类边界；其余增量只做「增量风险审计」，不重复送审已 PASS 且未变化的基础设施。


以下情况**必须**写进 `AI-BRIDGE` Issue 或当前 PR 评论，不得自行决定：

- 架构问题、核心领域模型变化
- 业务规则不确定、金额模型问题
- Settlement / Billing 问题、数据隔离问题
- 合规问题、安全问题、外部 API 权限问题
- 多方案选择
- 准备删除核心组件
- CI 持续失败
- 准备进入下一重大 Gate

**不要只写在本地终端。** 需要审计的内容必须落到 GitHub。

---

## 五、Git 工作规则

- **禁止直接在 `main` 开发。** 每个 Gate 使用独立分支（`gate/N-<name>`）。
- 所有重大阶段必须进入 PR。
- PR 必须包含（缺失项要明确写"无"）：

```
TASK
PRODUCT SPEC
ARCHITECTURE
DOMAIN MODEL CHANGES
DATABASE CHANGES
RULE CHANGES
SECURITY
COMPLIANCE
LICENSES
TESTS
CI RESULT
KNOWN RISKS
QUESTIONS FOR CHATGPT
```

---

## 六、不可违反的领域规则（摘要）

完整版见 `ARCHITECTURE_CONTRACT.md`。以下为硬约束：

1. `RecoveryOpportunity` 是系统核心业务实体。
2. `SourceTransaction` 与 `RecoveryLedger` **严格分离**。
3. 原始账单、订单、Invoice **不允许**直接变成 `RecoveryLedger`。
4. `Settlement` 只表示客户**实际收到**的退款 / Credit / 补偿 / 到账。
5. CrossClaim 向客户收费属于 `Billing`；**Billing 与 Settlement 必须分开**。
6. `FileAsset` **不等于** `Evidence`。
7. 一份证据必须能服务**多个** Case。
8. 第一版图结构用 PostgreSQL Node + Edge 表；**不引入 Neo4j**。
9. 金额、佣金、Deadline、账本结果**不得由 LLM 决定**。
10. 外部平台必须通过 **Adapter** 接入；平台规则**不得硬编码**在业务逻辑中。
11. `RuleVersion` 至少包含 `source / version / effective_from / effective_to / last_verified`。
12. 规则优先级：客户合同 > Rate Card > 官方 Carrier Tariff > 日期对应政策 > 默认规则。

---

## 七、必须叫宿主的事（`HOST APPROVAL REQUIRED`）

以下动作**必须停止并明确列出**，等待宿主批准：

1. 付费、购买服务
2. 生产环境部署
3. DNS / 域名
4. 删除真实数据
5. Secret 轮换
6. API 正式申请
7. 第三方真实账号授权
8. 真实客户数据操作
9. 法律 / 牌照高风险动作
10. 修改仓库公开 / 私有状态
11. 任何不可逆的外部操作

**关于合并（2026-09-28 修订）**：宿主已把「项目内拍板」委托给 ChatGPT，
含 PR 是否达到可合并标准、Gate 是否 PASS、Wave / Gate 取舍、架构与技术方案选择。
merge 决策因此由 ChatGPT 作出，**但不得绕过 GitHub 自身的技术性保护**：
若分支保护要求人类账号审批，只报告 `MERGE TECHNICALLY BLOCKED BY GITHUB PROTECTION`，
禁止 force push 或修改保护规则。
无论授权来自谁，**上面第 1–11 项仍必须由宿主本人执行或明确授权**。

其余工程问题由 Codex + ChatGPT 自主完成。

---

## 八、禁止伪造完成

存在下列任一情况，必须明确标注 **`NOT COMPLETE`（尚未完成）**，
**不得宣布"项目完成"**：

CI 红 · 测试未跑 · API 未验证 · 模型许可证未知 · migration 不可用 ·
部署未验证 · 页面只是占位 · 金额逻辑是假数据 · 核心流程依赖 TODO ·
只写了接口没有实现

---

## 九、安全底线

- 绝不把密钥、令牌、`.env` 写入仓库或任何产出文件
- 审计/报告类文档**不复述凭据取值**（文档自身不得成为新的泄露源）
- 凭据只以"引用名"形式出现在配置里，实际值放密钥管理
- 引入依赖前必须过许可证闸门；模型权重单独登记在 `MODEL_LICENSES.md`


---

## 八、产品总方向（长期冻结）与自治循环协议

### 8.1 产品总方向（2026-10-01 HOST PRODUCT DIRECTION，长期有效）

- CrossClaim AI = **跨境资金损耗 Recovery OS**：Platform / Logistics / Customs-Trade / Independent-site-Payment 四类 Recovery 共享**统一 Recovery Engine**
  （`Source Data → Canonical Fact → RecoveryOpportunity → Case → Evidence → Claim/Appeal/Dispute → Settlement → RecoveryLedger → Billing`）。
- **每个 Gate / Wave / Schema / Adapter / Claim / Appeal / Evidence / Settlement / Billing 设计都必须自检**：是否仍满足统一跨渠道 Recovery Engine；不得收缩为 Amazon/FBA 单点工具，也不得为单渠道另建孤立子系统。
- 长期定位与 backlog 登记见 `PRODUCT_SPEC.md` §十一；设计稿见 `docs/releases/PRODUCT-SCOPE-04-INDEPENDENT-SITE-CHARGEBACK-RECOVERY-DESIGN.md`。
- PRODUCT-SCOPE-04 当前仅**登记 + 设计排队**，未实施；其 Schema/规则/资金链路实施需架构方裁决。

### 8.2 自治循环 STEP 0 · reconcile（每轮必须执行）

每轮开始按以下**固定顺序**重建事实，禁止只读本地 STATE 直接续跑：

1. **GitHub Issue #2 最新正式 ARCHITECT VERDICT**（正式总线）
2. `AI-ARCHITECT-INBOX.md` 最新 `### [MSG-…]`
3. `.autopilot/STATE.json`
4. `.autopilot/TASKS.md`

优先级：**GitHub 正式裁决 > AI-ARCHITECT-INBOX > STATE.json > TASKS.md**。
发生冲突时以更高优先级为准并自动修正低优先级记录（含 `head` / `current_head` / `last_chatgpt_message` / `architect_decision_pending` / `reviewed_head`），
修正后继续执行当前任务，**不因 reconcile 本身而停下**。

### 8.3 自治循环裁决语义（5 分钟 tick，保持 ACTIVE）

| 裁决 | 自动动作 |
| --- | --- |
| `PASS` | 登记该批次 PASS → 立即进入下一小批次（NEXT） |
| `REVISE` | 立即按 `CHANGE` 实施 → 专项/回归/tsc/prisma → commit/push/CI → 重新送审 |
| `BLOCK` | 停止被否定方案，不得绕道；提交替代方案重新审计 |

只有本文件 §七 `HOST APPROVAL REQUIRED` 的 1–11 项才允许打断自治循环请求宿主。
Production Enablement / 真实平台外写 / 真实资金 / 客户提交 / 生产凭据：**继续 HOLD**。

## 长期工程约束：跨模块回归 + Golden Path E2E（HOST PRODUCT DIRECTION 2026-10-01）

**这是一条长期约束，不是一次性任务；不改变 Gate 7 / ② 的批次顺序。**

任何涉及**核心领域模型 / Schema / 状态机 / Action Guard / Claim / Appeal / Settlement / RecoveryLedger /
Billing / platform.write / Adapter / Import / Canonical Fact** 的改动，除批次专项测试外，
**必须执行跨模块回归**，防止「单模块全绿但主链路断裂」。

长期保留并逐步完善 **Golden Path E2E**（真实 PostgreSQL）：

`Source Data → Canonical Fact → RecoveryOpportunity → Case → Evidence → Claim Prepare → Claim Submit
 → 模拟外部处理结果 → Settlement → RecoveryLedger → FeeCalculation → Billing`

硬性要求（摘要，全文见 `docs/releases/ENGINEERING-REGRESSION-POLICY.md`）：

1. 主链路 E2E 必须用真实 PostgreSQL（不得只用 mock）；
2. 每跳验证 `id / organizationId / caseId / claimId / settlementId` 关联连续；
3. 验证金额、币种、状态、版本快照、审计事件、审批消费一致；
4. 任一阶段失败不得造成后续非法推进或部分写入；
5. Schema Migration 必须验证旧数据与既有链路不被破坏；
6. 状态机修改 → 全局 state-machine regression；
7. 权限 / Action Guard 修改 → authorization regression；
8. 模块接口变更 → contract regression；
9. S4/S5 或重大 Checkpoint → 全量回归 + Golden Path E2E + CI；
10. Golden Path 建立后不得为让新代码通过而删除 / 弱化 / skip / 改写核心断言；规则变化须先经架构方审计。
