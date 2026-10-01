# AUTOPILOT 持久自治规则（.autopilot/RULES.md）

> 来源：**HOST DIRECTIVE 2026-10-01「冻结底座 + 加速交付」**（宿主直接指令，长期有效）。
> 本文件是**持久自治规则**：对后续每一轮 tick、会话重启、runner 重启同样生效，不依赖任何单轮聊天上下文。
> 机器可读镜像：`.autopilot/rules.json`；runner 每轮读取并写入 HEARTBEAT；CI 由
> `tools/autopilot/check-autopilot-rules.mjs` 校验。策略全文：`docs/releases/DELIVERY-ACCELERATION-POLICY.md`。

## R1 冻结已 PASS 底座（默认不再重新设计 / 重构 / 重复审计）

已审计 PASS 且**本轮未变化**的基础能力一律冻结，不得重新设计、重构或重复送审：
Tenant / Organization 隔离 · Case / Recovery 主状态机 · Approval / HITL · Action Guard · Audit Log ·
Transaction / CAS / Row Lock · 幂等与并发控制 · Recovery / Reconcile · 权限重验与审批消费机制 ·
R43 Manual Recovery Persistence（S1–S6，MSG-20261001-39 = PASS — R43 CLOSED）·
Platform Write Attempt Ledger（PG1–PG10，MSG-20261001-21 = PASS）。

## R2 只有 8 类边界才触发「架构级审计」

1. Schema 发生实质变化
2. 租户隔离边界变化
3. 权限模型变化
4. 审批 / HITL 边界变化
5. 真实外部写操作变化
6. 资金 / 结算 / 扣费相关变化
7. 幂等 / 事务 / 并发一致性边界变化
8. 安全边界变化

普通业务功能、UI、Rule Pack、Adapter、Connector、映射规则、解析规则**不再默认升级为架构级审计**。

## R3 审计口径 = 增量风险审计

每轮只提交**本轮新增/变化**的边界、风险与测试证据；已 PASS 且未变化的基础设施不重复送审。

## R4 `ARCH_REVIEW_REQUIRED = NO` 时不得停止执行

- `ARCH_REVIEW_REQUIRED = NO` ⇒ **直接进入下一执行单元**；不得以「无新 ChatGPT 裁决」为由停止、空转或等待宿主。
- 唯一的合法停止条件是：`READY_FOR_REVIEW`（完整可审计批次送审）、`HOST_ACTION_REQUIRED`、架构方 `BLOCK`、以及无法 SELF_RESOLVE 的真实技术阻塞。
- 该项由 runner 每轮写入 HEARTBEAT（`arch_review_policy.continue_when_no_new_risk=true`、`no_verdict_is_not_stop=true`），重启后仍生效。

## R5 队列规则：不重新规划、不回退

按 `.autopilot/TASKS.md` 的未完成队列顺序执行（历史序列 S1 → S2 → S3 → S4 → S5 已按序完成并关闭；等价约定为：**不重排、不重做、不回退**）。
若某执行单元涉及 R2 的 8 类边界，则先实现 + targeted tests + commit + CI，再提交**增量**裁决；其余情况直接推进下一单元。

## R6 复用优先

新模块编码前依次检查：仓库现有实现 → 旧 `zhuihuiweikuan-saas`（只读迁移候选）→ 成熟 MIT / Apache-2.0 组件 → 现有库。
禁止重复造轮子；但不得为使用开源组件破坏已 PASS 的事务、权限、审计与租户边界。

## R7 编排工具边界

n8n / Activepieces 仅限外围（定时、通知、数据同步、非关键搬运、webhook 编排）；索赔提交、审批消费、资金结算、关键状态迁移**不得**放进低代码工作流。

## R8 每轮状态必须给出三项

```
FOUNDATION_REUSED    = 本轮复用了哪些已有底座
NEW_RISK_BOUNDARY    = YES / NO（+ 说明）
ARCH_REVIEW_REQUIRED = YES / NO（+ 原因；YES 时必须点名 R2 的触发项）
```

送审记录（STATE 中的 `*_submission`）必须包含 `risk_classification` 三项，否则 CI 失败。

## R9 仍然 HOLD

Production Enablement · 真实外部写 · 真实资金 · 客户真实提交 · 生产凭据 ·
AMAZON WRITE · REAL WRITE ADAPTER · TRANSPORT=false · SETTLEMENT/BILLING LINKAGE。

## R10 开源优先复用 + 商用许可证统一机制（HOST DIRECTIVE 2026-10-01 补充）

**统一机制**：每个新模块开工前先做「复用分类 + 许可证判定」，二者是同一次判断，不拆成两套流程。

### R10.1 复用分类（五档，写入 OPEN_SOURCE_REUSE_MATRIX）

| 分类 | 含义 |
| --- | --- |
| `EXISTING` | 当前 CrossClaim 仓库已有能力 → 直接复用 |
| `LEGACY_REUSE` | 旧 `zhuihuiweikuan-saas`（只读）有可迁移能力 |
| `OSS_NOW` | 当前阶段应立即接入的成熟开源组件 |
| `OSS_LATER` | 当前只保留接口，后续再接 |
| `REJECT` | 许可证 / 架构 / 维护性 / 安全性不适合，不引入 |

**不得在已有成熟方案的情况下重复自研通用基础能力。**

### R10.2 许可证等级（与 `tools/license-gate/allowlist.json` 的 allow/review/deny 同源）

- **LEVEL A（默认可进入候选）**：MIT / Apache-2.0 / BSD-2 / BSD-3 / ISC / 其他明确允许商用且无强传播要求的宽松许可。
- **LEVEL B（必须人工审查）**：GPL / LGPL / AGPL / MPL / EPL / BSL / SSPL / Sustainable Use License / Elastic License / 自定义 Community License / Source Available / 带商业限制的模型许可证。
- **LEVEL C（默认禁止进入生产）**：无 LICENSE / 许可不明确 / 商用不明确 / 模型来源不明 / 禁止商用 / 要求公开整个 CrossClaim 源码且未获批准 / 与商业 SaaS 明显冲突。
  **不得因为 GitHub 仓库公开就默认「可以商用」。**

### R10.3 依赖登记（OSS_NOW / OSS_LATER 必须登记才可进代码）

登记落盘在 `tools/license-gate/oss-registry.json`，每条至少包含：
`dependency_name / version / source_repository / license / license_category / commercial_use_allowed /
redistribution_requirement / attribution_requirement / copyleft_risk / saas_network_restriction /
model_weight_license / decision(ACCEPT|REVIEW|REJECT) / reason`，外加复用分类 `class`。
校验器：`node tools/license-gate/check-oss-registry.mjs --root .`（挂在既有 `license-gate` CI job 上，**不新建第二套许可证系统**）。

### R10.4 模型权重与代码许可证分离

任何会下载/加载模型权重的框架（如 Docling、PaddleOCR）必须**分别**判定：框架代码许可证 vs **每个模型权重**许可证。
权重登记沿用 `MODEL_LICENSES.md`（model name / source / license / commercial_use_allowed / redistribution_allowed / restrictions）。
**许可证不明确的模型不得进入生产**（LEVEL C）。

### R10.5 AI / Agent 层边界

优先复用：**FastAPI**（AI service interface）、**Pydantic**（structured output）、**LangGraph**（agent orchestration）、**Docling**（文档解析）。
链路：Recovery OS → AI service interface → FastAPI → Pydantic structured output → LangGraph → 模型（DeepSeek/Claude/其他）。

**以下永远不得交给 LLM 决定**（继续由确定性代码 / SQL / Rule Engine 控制）：
金额 · Fee / Success Fee · Deadline · Ledger · Settlement · Billing · 状态推进 · 权限判断 · 审批消费。

### R10.6 Connector / Adapter 边界

优先顺序：**官方 API / SDK → 成熟客户端库 → 薄 Adapter 自研**。
平台 SDK、认证、分页、限流、字段命名**不得**写进 Recovery OS 核心；结构固定为：
`Platform SDK/HTTP → Adapter → Canonical ingest → CanonicalFact → Rule Engine → RecoveryOpportunity → Recovery OS`。

### R10.7 外围自动化边界

只能承担：通知 · 定时任务 · Webhook · 非关键数据同步 · 非关键数据搬运 · 内部运营自动化。
禁止承担：Claim/Appeal 提交核心事务 · approval consumption · Settlement · RecoveryLedger · Billing · Success Fee · Payment · 核心状态迁移 · 权限决定。
**n8n**：不按普通 MIT/Apache 依赖处理（Sustainable Use License）；只能作为「受限外围工具」评估，不得嵌入客户产品、不得默认托管客户工作流/凭据；Embed/Enterprise 商业许可需单独立项。
**Activepieces**：Community/Core 与企业版必须分开检查；MIT 部分可进入候选，`packages/ee` 不得当作 MIT 使用。

### R10.8 禁止「大换底座」

引入开源组件的原则是「**插入现有架构**」，不是「为使用某个开源项目推倒现有架构重做」。
任何开源组件不得绕过：Tenant Isolation · RBAC · Approval/HITL · Audit · Idempotency · Transaction · Ledger invariants · Action Guard · Kill Switch。

### R10.9 本规则不阻塞当前队列

规则落盘后，当前执行队列继续推进；只有真正进入**新模块**时才执行对应的 OSS / License 判定。
进入新大模块时，本轮回报在上述三项之外增加：`LEGACY_REUSED / OSS_CANDIDATE / OSS_DECISION / LICENSE / COMMERCIAL_USE / LICENSE_RISK`。
