# 交付加速与「冻结底座」协议（DELIVERY-ACCELERATION-POLICY）

> 来源：**HOST DIRECTIVE 2026-10-01「冻结底座 + 加速交付」**（宿主直接指令，长期有效）。
> 目标：**优先减少重复审计时间，而不是减少测试质量**。已经过 ChatGPT 审计并 PASS 的底座视为稳定基础设施。

---

## 1. 冻结底座（默认不再重新设计 / 重构 / 重复审计）

已审计 PASS 且**未发生变化**的基础能力默认冻结：

- Tenant / Organization 隔离
- Case / Recovery 主状态机
- Approval / HITL
- Action Guard
- Audit Log
- Transaction / CAS / Row Lock
- 幂等与并发控制
- Recovery / Reconcile
- 权限重验与审批消费机制
- R43 Manual Recovery Persistence（S1–S6，MSG-20261001-39 = PASS — R43 CLOSED）
- Platform Write Attempt Ledger（S1–S5 / PG1–PG10，MSG-20261001-21 = PASS）

禁止：无理由重新设计、重构、重复审计、重复要求架构方复核已 PASS 且未变化的设施。

## 2. 新业务能力优先复用

新增业务能力优先使用 **现有 Recovery OS 内核 + Adapter + Connector + Rule Pack**。
不得为 Amazon、TikTok Shop、Walmart、物流 SLA、Chargeback、关税/归类等业务**另造一套工作流**。

## 3. 只有以下情况才允许触发「架构级审计」

1. Schema 发生实质变化
2. 租户隔离边界变化
3. 权限模型变化
4. 审批 / HITL 边界变化
5. 真实外部写操作变化
6. 资金、结算、扣费相关变化
7. 幂等、事务、并发一致性边界变化
8. 安全边界变化

普通业务功能、UI、Rule Pack、Adapter、Connector、映射规则、解析规则**不再默认升级为架构级审计**。

## 4. 复用优先（开源与既有能力）

每个新模块编码前先检查：

1. 仓库现有实现是否可复用
2. 旧 `zhuihuiweikuan-saas`（只读）是否有可迁移能力
3. 成熟 MIT / Apache-2.0 开源组件是否可直接使用
4. 是否可通过现有库解决

禁止重复造通用轮子；但**不得**为了使用开源组件破坏已 PASS 的核心事务、权限、审计与租户边界。

## 5. 编排工具边界（n8n / Activepieces 等）

只允许用于**外围自动化**：

- 定时任务
- 通知
- 数据同步
- 非关键数据搬运
- webhook 编排

**不得**把索赔提交、审批消费、资金结算、关键状态迁移等核心事务放进低代码工作流。

## 6. 开发节奏（每轮固定）

```
IMPLEMENT → targeted tests → commit → CI → 风险分类
```

若未触碰新的高风险边界（见 §3）→ **直接进入下一执行单元，不为等待新裁决而空转**。

## 7. ChatGPT 审计 = 增量风险审计

只提交本轮**新增/变化**的边界、风险与测试证据。
不要重复要求审查已 PASS 且未变化的基础设施。

## 8. 当前执行序列

- R43（Manual Recovery Persistence S1–S6）：**CLOSED**（MSG-20261001-39）。
- 下一批：**R44 — Manual Recovery HTTP/API Boundary**（仅入口边界；authn → tenant/role → action guard → 服务端 package/basis 解析 → 复用既有 S3/S4 service → 响应语义）。
- 之后：R45 Outcome / Reimbursement Reconciliation、R46 Settlement / Billing Linkage（各自独立设计与审计）。

历史清单（Prisma ledger port / T1–T3 / R1 / approval_consumed 同事务 / T2 事务外投递 / PG1–PG10 / reconcile 策略测试）均属 **platform-write ledger 批次，已 PASS 关闭**（MSG-20261001-21），无需重复审计。

## 9. 每轮状态回复必须包含三项

```
FOUNDATION_REUSED      = 本轮复用了哪些已有底座
NEW_RISK_BOUNDARY      = 本轮是否引入新的高风险边界（YES/NO + 说明）
ARCH_REVIEW_REQUIRED   = YES / NO（说明原因）
```

若 `ARCH_REVIEW_REQUIRED = NO`：继续自主推进下一执行单元，不等待宿主，不空转。

## 10. 仍然 HOLD（直到正式上线 Gate 明确放行）

Production Enablement · 真实外部写操作 · 真实资金操作 · 客户真实提交 · 生产凭据

其余既有 HOLD：AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · SETTLEMENT/BILLING LINKAGE HOLD。
