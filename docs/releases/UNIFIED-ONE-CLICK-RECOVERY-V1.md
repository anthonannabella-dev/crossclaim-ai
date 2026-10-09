# UNIFIED ONE-CLICK AUTONOMOUS RECOVERY V1 —— 实施记录

> 分支：`feat/unified-one-click-recovery-v1`（从已完成 PHASE 1–3 独立审计的 SI/RSI 线 `7c8bdc77` 创建）
> 指令来源：HOST 粘贴的《CODEX → CROSSCLAIM AI · UNIFIED ONE-CLICK AUTONOMOUS RECOVERY · FINAL DIRECTIVE》

## 0. 边界（全程遵守）

- **不修改**封板 `release/rc-20261008-linux-deploy-v1`（`ceb65ab7`）与 `main`（`444a246c`）；封板部署锚点 `04a93666` 不变。
- **不新增**第二套 SI/RSI Runtime / Scheduler / Controller；复用 ONE SI Runtime 与既有业务服务。
- 不执行生产部署 / 生产迁移；不写真实密钥；真实外写 / 报关 / 支付 / 扣佣 / 生产开闸 **HOLD**。
- 不伪造测试结果或审计裁决；不把"代码存在"或"单测通过"当作"已接入生产"。

## 1. PHASE 0 —— 现有能力审计（本轮实测）

### 1.1 指令列出的模块存在性：**16 / 16 全部存在**

| 模块 | 路径 | 存在 |
| --- | --- | --- |
| 统一目标入口 | `apps/api/src/services/agent-goal/`（compiler / validator / capability-resolver / task-planner / admission / prisma-task-queue-port） | ✅ |
| 目标控制台 | `apps/web/app/components/ui/goal-console.tsx` | ✅ |
| 授权复用 | `services/standing-authorization/`、`customs/customs-one-click-authorization.ts`、`customs-one-click-start.ts`、`customs-authorization-route.ts` | ✅ |
| 业务自动执行 | `runtime/rsi-run.ts`、`runtime/recovery-si-pack.ts`、`runtime/recovery-si-production-composition.ts` | ✅ |
| 物流↔关税数据联动 | `carriers/carrier-tracking-read.ts`、`carrier-invoice-pod-read.ts`、`carrier-evidence-bundle.ts`、`carrier-recovery-estimate.ts`、`customs/customs-return-matching.ts`、`customs-return-fact-store.ts`、`customs-return-claim-evidence.ts`、`customs/drawback/` | ✅ |

### 1.2 已复现的真实缺口（PHASE 1 的目标）

探针（只读、不写库）：`work/probe-goal-domains.mjs` → `compileAgentGoal({text})`

| 输入 | 修复前 | 修复后 |
| --- | --- | --- |
| 帮我检查所有可以追回的钱 | ❌ `GOAL_UNSUPPORTED_INTENT` | ✅ `DISCOVER_AND_RECOVER` / 四域 |
| 帮我找回所有能追回的钱 | ❌ `GOAL_UNSUPPORTED_INTENT` | ✅ 四域 |
| 自动找回我过去三年的资金损失 | ❌ `GOAL_UNSUPPORTED_INTENT` | ✅ 四域 |
| 帮我扫描所有已连接账户 | ❌ `GOAL_UNSUPPORTED_INTENT` | ✅ 四域 |
| Find all recoverable money | ❌ `GOAL_UNSUPPORTED_INTENT` | ✅ 四域 |
| Audit all my connected accounts | ❌ `GOAL_UNSUPPORTED_INTENT` | ✅ 四域 |
| 检查所有可追回的关税、物流、平台费用 | ⚠️ 三域（无 INDEPENDENT_SITE） | ✅ 三域（**显式枚举优先，不扩展**） |
| 检查物流 | ✅ `AUDIT_DOMAIN` / LOGISTICS | ✅ 不变 |
| 检查亚马逊平台费用 | ✅ `AUDIT_DOMAIN` / PLATFORM | ✅ 不变 |

**根因**：`goal-compiler.ts` 的 `DOMAIN_SIGNALS` 是**关键词**匹配，缺少"全域意图"信号；无任何域命中时 `domains.length === 0` 直接落到 `GOAL_UNSUPPORTED_INTENT`（fail-safe，但无法形成四域候选计划）。指令中"立即验证此问题"**已确认为真实缺口**。

### 1.3 分类口径与进度（如实）

- **存在性**：已核实（上表）。
- **接入状态分类**（`ALREADY_IMPLEMENTED` / `PARTIALLY_CONNECTED` / `MISSING_WIRING` / `TEST_ONLY` / `PRODUCTION_HOLD`）：**尚未逐项判定**，下一单元按真实调用路径逐模块给出，**本轮不据此宣布 PASS**。
- 已知事实（与《SI/RSI INTERNAL AUTONOMOUS CODE REPAIR V1》PHASE 0 的提示一致）：`tools/dev/si-rsi-continuous-check.mjs` 只是**开发任务检查器**，不是内部代码修复代理。

## 2. PHASE 1 —— 全域意图最小修复（已完成）

**变更**（`apps/api/src/services/agent-goal/goal-compiler.ts`，最小范围）

- 新增 `ALL_DOMAIN_SIGNAL`（显式全域措辞：所有 / 全部 / 已连接账户 / 资金损失 / all / every / connected accounts …）。
- 新增 `ALL_GOAL_DOMAINS = [PLATFORM, LOGISTICS, CUSTOMS, INDEPENDENT_SITE]`。
- 生效条件**三条同时满足**（避免凭猜测扩大客户授权）：
  1. 文本出现显式全域措辞；
  2. 同时出现追回或查找动作（沿用既有 `RECOVER_SIGNAL` / `FIND_SIGNAL`）；
  3. **未显式点名任何具体领域**（`domains.length === 0`）。
- 命中后写入 `DOMAIN:ALL` 信号，域列表扩为四域，`goalType = DISCOVER_AND_RECOVER`。
- **不扩展**：显式单域（`检查物流`）与显式枚举多域（`关税、物流、平台`）完全保持原行为。

**验收**

| 项 | 结果 |
| --- | --- |
| `api tsc --noEmit` | **0** |
| `agent-goal.test.ts`（新增 2 个全域用例） | **40 / 40 PASS** |
| 定向回归：`agent-goal` + `agent-goal-runtime-wiring` + `historical-scan-boundary` + `historical-scan-runtime-scope` + `si-rsi-phase1-durable-queue` + `si-rsi-phase1-authorization` | **6 文件 / 75 tests 全绿** |

**诚实边界**：本修复只解决**意图 → 候选域**。以下**均未完成**，不得视为已交付：

- 未连接域"保留待接入、不伪造扫描结果"的行为核验；
- PHASE 2 跨域自动转交（物流 → 关税资格检查，无需二次点击）；
- PHASE 3 统一授权中心与授权自动复用（Standing Authorization / Broker POA）；
- PHASE 4 统一客户 UI（"开始检查全部资金"）；
- PHASE 5 E2E-01…E2E-16（真实 PostgreSQL）。

## 3. 后续阶段计划（PHASE 2–5）

1. **PHASE 2（核心）**：物流证据 → 关税候选任务的后台自动转交；只复用 `Carrier Evidence` / `Customs Entry Fact` / `Customs Return Fact` / `Import-Export Matching` / `Eligibility` / `Drawback Candidate Route` / `Evidence Lineage` / `Opportunity` / `Case` / Recovery SI / durable task+lease；**不新增第二套 Customs Truth / Eligibility / Evidence / Recovery Engine**；证据不足只能 `NEEDS_EVIDENCE` / `NEEDS_REVIEW`。
2. **PHASE 3**：统一授权中心视图 + 授权自动复用判定（存在/有效/未撤销/未过期/覆盖范围/主体/Broker/申报类型），缺失时只提示必要授权，不代签。
3. **PHASE 4**：统一入口 UI（"开始检查全部资金"），不暴露 runtime namespace / 内部动作枚举 / 工程错误码；关税页保留为案件详情与法定授权入口。
4. **PHASE 5**：E2E-01…E2E-16 真实 PostgreSQL 验收，并明确区分 `UNIT_PASS` / `POSTGRES_E2E_PASS` / `SANDBOX_PASS` / `REAL_PROVIDER_PASS` / `PRODUCTION_READY`。
5. 每阶段：实现 → 定向测试 → 回归 → commit → push → 右侧 ChatGPT 独立审计 → 修 REVISE 直至 CONFIRMED。

## 4. 状态（截至本文件提交）

```
UNIFIED_GOAL_ENTRY = PARTIAL（全域意图识别已修复；统一 UI 未做）
ALL_DOMAIN_INTENT = PASS（本机单元 + 定向回归；未做真实 PostgreSQL E2E）
SINGLE_CUSTOMER_START = NOT_STARTED
CROSS_DOMAIN_DISCOVERY = NOT_STARTED
LOGISTICS_TO_CUSTOMS_AUTO_TRIGGER = NOT_STARTED
CUSTOMS_EXISTING_ENGINE_REUSED = NOT_VERIFIED（待逐模块分类）
STANDING_AUTHORIZATION_REUSE = NOT_VERIFIED
CUSTOMS_POA_REUSE = NOT_VERIFIED
UNNECESSARY_SECOND_CLICK = NOT_VERIFIED
ONE_SI_RUNTIME = YES（未新增第二套运行时）
DURABLE_TASK = 复用既有（PHASE 1–3 已审计）
NO_DUPLICATE_OPPORTUNITY = NOT_VERIFIED（PHASE 2 验收项）
NO_DUPLICATE_FINANCIAL_RECOVERY = NOT_VERIFIED（PHASE 2 验收项）
POSTGRES_E2E = NOT_STARTED
REAL_PROVIDER_INTEGRATION = HOLD
INDEPENDENT_AUDIT = PENDING（本轮 PHASE 1 修复待送审）
NEW_RELEASE_CANDIDATE = NOT_STARTED
PRODUCTION_READY = NO
```
