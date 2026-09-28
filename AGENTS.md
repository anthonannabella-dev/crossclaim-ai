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

## 四、必须发起审计的场景

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
