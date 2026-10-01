# ENGINEERING REGRESSION POLICY —— 跨模块回归与 Golden Path E2E（长期约束）

> 来源：**HOST PRODUCT DIRECTION 2026-10-01**（宿主明示的长期工程约束，非一次性任务）
> 适用范围：本策略对所有后续批次持续有效；不改变当前 Gate 7 / ② 的执行顺序。

## 0. 目标

防止「修复一个局部问题，却破坏其他模块或整条 Recovery 链路」——即防止「单模块全绿但主链路断裂」。

## 1. 触发条件（命中任一项即必须执行跨模块回归）

任何涉及以下任一项的改动：**核心领域模型、Schema / Migration、状态机、Action Guard、Claim / Appeal、
Settlement、RecoveryLedger、Billing、platform.write、Adapter、Import / Canonical Fact**。

除该批次专项测试外，**必须**执行跨模块回归，不得仅以专项绿作为收口依据。

## 2. Golden Path E2E（长期保留并逐步完善）

主链路（必须端到端可跑）：

```text
Source Data → Canonical Fact → RecoveryOpportunity → Case → Evidence
  → Claim Prepare → Claim Submit → 模拟外部处理结果 → Settlement
  → RecoveryLedger → FeeCalculation → Billing
```

### 2.1 硬性要求（10 条）

1. 主链路 E2E **必须使用真实 PostgreSQL**，不得只用 mock。
2. 每个关键对象必须验证关联连续正确：`id` / `organizationId` / `caseId` / `claimId` / `settlementId` 等逐跳对齐。
3. 必须验证金额、币种、状态、版本快照、审计事件、审批消费在整条链路中保持一致。
4. 任一阶段失败**不得**造成后续非法推进或部分写入（事务/回滚语义必须被断言）。
5. Schema Migration 必须验证旧数据与既有链路不被破坏（含 fresh deploy 与两阶段升级路径）。
6. 状态机修改必须跑**全局 state-machine regression**。
7. 权限 / Action Guard 修改必须跑 **authorization regression**。
8. 模块接口变更必须跑 **contract regression**。
9. S4/S5 或重大 Checkpoint 必须执行**全量回归 + Golden Path E2E + CI**。
10. Golden Path 一旦建立，**不得**为了让新代码通过而删除、弱化、`skip` 或改写核心断言；
    如果产品规则确实变化，必须**先经架构方审计**再更新测试。

## 3. 与现有批次流程的关系

- 不改变当前 Gate 7 / ② 的批次顺序与送审节奏；
- 回归要求叠加在既有「专项测试 + tsc + prisma validate + CI」之上；
- Golden Path E2E 将在合适的回归阶段纳入长期 CI（见 `.autopilot/TASKS.md` 的 `GOLDEN-PATH-E2E` 条目）。

## 4. 回归清单（每批次收口时逐项确认）

| # | 项 | 触发 |
| --- | --- | --- |
| R1 | 批次专项测试 | 每批次 |
| R2 | 跨模块回归（受影响模块 + 主链路相邻模块） | 命中 §1 任一项 |
| R3 | 全局 state-machine regression | 状态机改动 |
| R4 | authorization regression（Action Guard / 权限） | 权限或守卫改动 |
| R5 | contract regression（模块接口变更） | 接口签名/契约变更 |
| R6 | Migration 兼容性（fresh deploy + 两阶段升级） | Schema / Migration |
| R7 | Golden Path E2E（真实 PostgreSQL） | S4/S5 或重大 Checkpoint（建立后每批次） |
| R8 | 全量回归 + CI | S4/S5 或重大 Checkpoint |

## 5. 证据留档

每次执行回归须在 `.autopilot/RUN_LOG.md` 记录：触发项、执行命令、文件/用例数、结论、CI run 编号。
