# SI-RSI V2-09 — V2 验收矩阵（V2-01 → V2-08）

> 授权：HOST DIRECTIVE 2026-10-10「V2-AUTONOMOUS-20261010-01」§五。
> 分支：`feat/customs-opportunity-unlock-v2`；基准 `V2_BASE_HEAD=21e49891`；本矩阵锚点 `V2_FINAL_HEAD=f47ba314`。

## 0. 证据快照（本机真实执行，可复现）

```powershell
# 提交
git -C D:/crossclaim-ai rev-parse HEAD
# → f47ba3146e690c2a2d7d75db5d35624114afcbce

# 单元回归（apps/api）
cd D:/crossclaim-ai/apps/api
npx vitest run src/__tests__/customs-paid-api-gate.test.ts src/__tests__/customs-paid-provider-composition.test.ts `
  src/__tests__/customs-opportunity-unlock-state.test.ts src/__tests__/customs-profit-gate.test.ts `
  src/__tests__/customs-unlock-payment.test.ts src/__tests__/customs-execution-chain.test.ts `
  src/__tests__/customs-unlock-si-pack.test.ts src/__tests__/customs-success-fee-collection.test.ts `
  src/__tests__/customs-success-fee-guard.test.ts
# → Test Files  9 passed (9)      Tests  165 passed (165)

# 类型检查
npx tsc --noEmit          # apps/api → 0 error
cd ../web; npx tsc --noEmit   # apps/web → 0 error
```

各套件明细：paid-api-gate 33 · unlock-payment 23 · success-fee-guard 18 · opportunity-unlock-state 19 ·
execution-chain 19 · profit-gate 21 · paid-provider-composition 10 · success-fee-collection 15 · unlock-si-pack 7。

## 1. 验收矩阵

| # | 验收项 | 状态 | 证据 | 级别 |
| --- | --- | --- | --- | --- |
| 1 | 免费发现与六态投影 | **PASS** | `customs-opportunity-unlock-state.ts` + 19 单测（六态顺序、跨租户不泄露） | 代码通过 |
| 2 | 真实金额缺失时付费入口不可见 | **PASS**（代码）/ **NOT_VERIFIED**（浏览器） | 投影 `unlockEntryVisible` 仅 `READY_TO_UNLOCK`；页面仅在后端给出金额时渲染付费面板 | 代码通过 / 模拟未做 |
| 3 | 五语言文案一致性 | **PASS**（类型级） | `CUSTOMS_UNLOCK_COPY: Record<Locale, …>`，缺任一语言编译失败；`apps/web tsc --noEmit` 0 error | 代码通过 |
| 4 | 报价、付款、权益与授权状态 | **PASS** | `customs-unlock-payment.ts` + 23 单测（报价有效期、四要素、HMAC 验签、幂等、生命周期） | 代码通过 |
| 5 | 账户隔离与越权访问 | **PASS**（应用层）/ **NOT_RUN**（DB 层） | Gate `OPPORTUNITY_NOT_OWNED`；投影 `CROSS_TENANT_REJECTED`；pack 缺租户绑定即 BLOCK；DB 级租户隔离套件需 PostgreSQL | 代码通过 / DB 未跑 |
| 6 | Profit Gate 正确阻断 | **PASS** | `customs-profit-gate.ts` + 21 单测（缺报价/超预算/政策失效/毛利下限/概率越界） | 代码通过 |
| 7 | ONE SI Runtime 唯一路径 | **PASS**（未新增运行时）/ **NOT_WIRED**（pack 未注册） | `customs-unlock-si-pack.ts` 实现既有 `RsiDomainCapabilityPack`；`createsRuntime=false`、`createsScheduler=false`；未消费保留命名空间 | 设计+代码通过 |
| 8 | 任务幂等、并发领取与重复执行保护 | **部分 PASS** | 幂等已证：支付事件 `eventId`、成功费 `settlementId`、执行链 `billedSettlementIds`；保留命名空间互斥。**真实并发领取（租约 CAS）未验证** | 代码通过 / 并发未跑 |
| 9 | Provider 失败、超时、重试及对账 | **部分 PASS** | 执行链在 Provider 不可用 / 缺报价 / 超时 / Kill Switch 时停在明确 HOLD；真实 Provider 失败重试与对账未验证 | 代码通过 / 真实未跑 |
| 10 | 证据可信性和结算事实验证 | **PASS**（判定层）/ **NOT_VERIFIED**（真实证据） | 未证实结算 → 成功费 `NONE`；`verifiedActualRecovery` 为唯一计费前提 | 代码通过 / 真实未跑 |
| 11 | 15% 成功费准确性与重复计费保护 | **PASS** | `customs-success-fee-collection.ts` 15 单测 + 既有 `customs-success-fee-guard` 18 单测；分批 2000/3000/5000 → 300/450/750；重复结算抑制 | 代码通过 |
| 12 | Kill Switch、审批门禁及外写 HOLD | **PASS** | Gate/执行链/pack/成功费四处 Kill Switch 分支；外写需 Action Guard 审批 + 外写授权双门禁 | 代码通过 |
| 13 | 前后端集成与主要浏览器断点 | **BLOCKED** | 无 PostgreSQL（`127.0.0.1:5432` 不可达、Docker 未运行），前后端链路未起；未做多断点截图 | 未验证 |
| 14 | 数据迁移兼容性与回滚准备 | **NOT_APPLICABLE** | `git diff --name-only c6e03c51..HEAD` 中 `prisma`/`migration` 命中数 = **0**：本阶段未新增任何 schema 变更，因此无迁移/回滚对象 | 不适用 |

## 2. 五个层级必须分开读（防止"设计通过"被当成"生产可用"）

| 层级 | 本阶段结论 |
| --- | --- |
| 设计通过 | V2-01…V2-08 设计均已实现为可测代码并留档（8 份 release 文档） |
| 代码通过 | **是**：165 单测 + 双端 tsc 0 error（本机真实执行） |
| 模拟环境通过 | **否（未做）**：未搭本地/隔离环境跑端到端；浏览器断言为 BLOCKED |
| 真实 Provider 验证通过 | **否**：Provider 未接线（`HOLD_EXTERNAL`），无沙箱凭据 |
| 生产授权通过 | **否**：`PRODUCTION_READY=NO`、`PRODUCTION_PAYMENT_ENABLED=NO`、`AUTO_COLLECTION=HOLD` |

## 3. 本轮**未**完成的 V2-06 遗留项（如实列出，不报 PASS）

| 项 | 状态 | 原因 |
| --- | --- | --- |
| `ENTITLEMENT_AWARE_CTA` | 未实现 | 需要权益读取端点；当前 API 未暴露该读取面，页面以 `alreadyCovered=false` 渲染并已在代码注释中标注 |
| `CHECKOUT_REDIRECT` | NOT_IMPLEMENTED | 未接收银台；购买按钮保持禁用（Payment HOLD） |
| `BROWSER_E2E` | BLOCKED | 无 DB / 未起链路 |
| `MULTI_DEVICE_VISUAL` | BLOCKED | 同上；未实际执行故不标记 PASS |

## 4. HOST_ACTION_REQUIRED

```text
1. PostgreSQL 16 实例（或启动 Docker）→ 才能跑 DB 级租户隔离、并发领取、收费台账持久化验收
2. 支付服务商测试商户 + Webhook 签名密钥 → 才能验证真实验签链路（当前仅本机 HMAC 向量）
3. Customs Provider 沙箱凭据 + 价目表（含 RATE_LOOKUP 是否计费）→ 才能验证真实外部执行
4. 批准 customs-unlock-si pack 注册进生产 composition（注册即激活该域任务的运行时消费）
```

## 5. 边界自证

未新增 Runtime / 调度器 / 第二套 Policy Engine；未触碰 `main` / `release/rc-20261008-linux-deploy-v1` / U1 封板；
未重开 U2 Design R21；未连接生产数据库；未执行真实扣款、真实 Provider 写、生产迁移或部署。
