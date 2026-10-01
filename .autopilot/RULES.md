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
