# PRODUCTION CANDIDATE READINESS CHECKPOINT（TRACK A · READ-ONLY / DOCS-ONLY）

授权：MSG-20261002-80（A/X4 = NOT NEXT；下一单元 = TRACK A PRODUCTION CANDIDATE READINESS SWEEP，READ-ONLY / DOCS-ONLY；secret.rotate = HOST_ACTION_REQUIRED）。
对账基线：`docs/releases/TRACK-A-MAINLINE-RECONCILE.md`（HEAD `0792e38`）；REQUEST `docs/releases/TRACK-A-NEXT-UNIT-AUTHORIZATION-REQUEST.md`（HEAD `e0293c0`）。
本轮**未**改代码、**未**改 Schema、**未**加 migration、**未**加测试、**未**接真实 transport、**未**写 Payment、**未**新增 feature implementation。
证据来源（只读）：`.github/workflows/{ci,audit-bridge}.yml`、`apps/web/app/**`、`apps/api/src/services/**`、`apps/api/prisma/migrations/**`、`tools/**`、`docs/releases/**`、`docs/platform-approval/**`、`AI-ARCHITECT-INBOX.md`、各 Checkpoint 与 CI run 记录。
边界：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。

## 0. 分类口径（强制四选一，禁止 TODO / later / maybe）

| 分类 | 含义 |
|---|---|
| `INTERNAL_READY` | 在内部可控 / 可测范围内已实现并有证据（迁移 + DB/HTTP 验收 + CI） |
| `BLOCKER_INTERNAL` | 仍是 Production Candidate 前置，且**可**在内部完成（无需外部凭据 / 审批 / 真实数据） |
| `BLOCKER_EXTERNAL` | Production Candidate 前置，但需要 provider approval / 真实凭据 / 真实数据 / legal / payment provider |
| `HOST_ACTION_REQUIRED` | 只有宿主能完成或授权（付费服务、生产部署、Secret 轮换、真实外写放行等） |
| `POST_LAUNCH` | 有价值但不是 Production Candidate blocker（V1.1 / 规模化 / 智能化增强） |

## 1. 两份完成度（口径显式）

- **INTERNAL PRODUCT COMPLETION = `INTERNAL_READY / (INTERNAL_READY + BLOCKER_INTERNAL)` = 59 / 78 ≈ 76%**
  （只回答「内部可测范围内的产品闭环是否做完」，不含任何外部依赖项）
- **PRODUCTION ENABLEMENT COMPLETION = `INTERNAL_READY / (INTERNAL_READY + BLOCKER_INTERNAL + BLOCKER_EXTERNAL + HOST_ACTION_REQUIRED)` = 59 / 90 ≈ 66%**
  （把真实 provider API / 凭据 / 支付 / legal / production ops 纳入分母；`POST_LAUNCH` 不计入）

| 计数 | 值 |
|---|---|
| `INTERNAL_READY` | **59** |
| `BLOCKER_INTERNAL` | **19** |
| `BLOCKER_EXTERNAL` | **10** |
| `HOST_ACTION_REQUIRED` | **2**（`secret.rotate`、success-fee collection / payment activation） |
| `POST_LAUNCH` | **4**（X4 Entity Resolution v1、Growth P3、Carrier V1、Customs V1） |

> 口径说明：百分比只统计已登记能力项，不代表工时；`INTERNAL PRODUCT COMPLETION` 与 `PRODUCTION ENABLEMENT COMPLETION` 的差值主要来自真实 provider / 支付 / legal。

## 2. GAP REGISTER（单一真相源）

### P1 · Core Recovery Workflow（14/14 `INTERNAL_READY`）

| 能力 | 证据 | 分类 |
|---|---|---|
| ingest（connection-gated，unbound 拒绝） | `account-lineage-gate-db` 6/6；Track B BATCH 1 | `INTERNAL_READY` |
| canonical fact（account-scoped，禁止新 NULL） | `canonical-fact-db`、`account-lineage-downstream-db` 16/16 | `INTERNAL_READY` |
| detection / rule engine（含 audit 投影） | `detection-db`、`rule-engine-audit-db` | `INTERNAL_READY` |
| opportunity（fail-closed 归因） | `account-lineage-downstream-db`、`workflow-*` | `INTERNAL_READY` |
| case（建案 + 状态机） | `workflow-case-db`、`c2-*` | `INTERNAL_READY` |
| evidence（strict account-lineage） | C2 CLOSED（55921f3）、`c2-dual-context-resolver-db` | `INTERNAL_READY` |
| claim prepare（草稿） | `action-guard-claim-prepare-http-db` 21/21（MSG-20261001-10 PASS） | `INTERNAL_READY` |
| claim submit（人工闸门，`NEEDS_MANUAL`） | `action-guard-claim-submit-http-db` 22/22（MSG-20261001-07 PASS） | `INTERNAL_READY` |
| appeal submit（快照 + 审批绑定） | `action-guard-appeal-submit-http-db` 13/13（MSG-20261001-16 PASS） | `INTERNAL_READY` |
| manual recovery（package / submission / reference） | R43 S1–S6 CLOSED；`recovery-manual-*` 系列 | `INTERNAL_READY` |
| recovery outcome（HITL + 审批指纹） | R38/R44 批次 CLOSED | `INTERNAL_READY` |
| settlement（可信到账 → 事实） | R46 S1–S3 CLOSED；`settlement-record-db` 15/15 | `INTERNAL_READY` |
| fee calculation / adjustment | R46 S4 CLOSED；`fee-*` 系列 | `INTERNAL_READY` |
| billing draft / invoice issue | R46 S5 CLOSED；`billing.draft`、`invoice-issue-db` 10/10 | `INTERNAL_READY` |

### P2 · Provider / Platform Integration

| 平台 | 现状 | 分类 |
|---|---|---|
| Amazon（READ-ONLY adapter + fixture runner） | R39/R40/R41 CLOSED；adapter 只读、注入式 transport、`submitClaim() → NEEDS_MANUAL` | `INTERNAL_READY`（只读形态） |
| Amazon 真实 API / write scope | 未接通；`docs/platform-approval/AMAZON_SCOPE_MATRIX.md` 为申请材料 | `BLOCKER_EXTERNAL` |
| TikTok Shop | 仅 scope 矩阵 / 计划 | `BLOCKER_EXTERNAL` |
| Walmart | 仅 scope 矩阵 / 计划 | `BLOCKER_EXTERNAL` |
| Carrier / logistics（UPS/FedEx/DHL…） | 仅契约与规则草案；UPS Compliance Gate HOLD | `BLOCKER_EXTERNAL` |
| Customs / broker（BrokerConnector 契约） | 仅契约（`CUSTOMS-BROKER-CONNECTOR-CONTRACT.md`） | `BLOCKER_EXTERNAL` |

> 明确禁止的过强表述：**「已有 adapter contract」≠「平台已接通」**；上述真实平台全部为 `BLOCKER_EXTERNAL`。

### P3 · Customer Onboarding

| 能力 | 现状 | 分类 |
|---|---|---|
| 注册 / signup | `apps/web` 只有 `login`；无注册页、无自助 Organization 创建入口 | `BLOCKER_INTERNAL` |
| Organization / membership bootstrap | `admin/members` + 服务层已具备 | `INTERNAL_READY` |
| connection creation | `apps/web/app/connections/page.tsx` + `POST /connections` | `INTERNAL_READY` |
| bind PlatformAccount | Track B BATCH 3（`BIND_EXISTING` + `POST /connections`） | `INTERNAL_READY` |
| OAuth / API authorization flow | 未实现（`PlatformIdentityVerifier` 仅 contract + mock） | `BLOCKER_EXTERNAL` |
| file upload fallback | `apps/web/app/upload/page.tsx` + ingest 链路 | `INTERNAL_READY` |
| multi-account | TRACK C2 CLOSED（PlatformAccount / account-scoped facts） | `INTERNAL_READY` |
| connection state（bound / unbound / canIngest） | ONBOARDING TRANSPORT CLOSURE T4 | `INTERNAL_READY` |
| legacy unbound rebind | `POST /connections/:id/rebind`（T3） | `INTERNAL_READY` |

### P4 · Claim Execution

| 能力 | 现状 | 分类 |
|---|---|---|
| claim package ready | R43 CLOSED（package + versioned basis） | `INTERNAL_READY` |
| 人工提交登记（submission fact / `claim.submitted_by_human`） | `services/claims/tracking-service.ts` + R44/R44-A/R44-B CLOSED | `INTERNAL_READY` |
| external transport abstraction（`submitClaimThroughAdapter()`） | 恒返回 `NEEDS_MANUAL`；注册表拒绝写入面 adapter | `INTERNAL_READY` |
| 真实 provider write / 真实 Claim 提交 | HOLD（`TRANSPORT=false`） | `BLOCKER_EXTERNAL` |

> `CLAIM READY` ≠ `CLAIM ACTUALLY SUBMITTED`：当前系统只能产出 package + 人工提交事实，**没有**任何真实提交能力。

### P5 · Money / Monetization

| 能力 | 现状 | 分类 |
|---|---|---|
| recoverable amount / expected basis | R45 CLOSED | `INTERNAL_READY` |
| settlement（确认到账事实） | R46 S1–S3 CLOSED | `INTERNAL_READY` |
| fee calculation / adjustment | R46 S4 CLOSED | `INTERNAL_READY` |
| billing invoice（DRAFT / ISSUED） | R46 S5 CLOSED | `INTERNAL_READY` |
| entitlement（Customer / Package 权益模型） | 未实现（Growth/Customs 契约里已登记） | `BLOCKER_INTERNAL` |
| checkout / package unlock | 未实现 | `BLOCKER_INTERNAL` |
| payment provider 接入（真实扣款） | 未接通（`PAYMENT_ACTIVATION_GATE = HOLD`） | `BLOCKER_EXTERNAL` |
| success fee collection（自动收取） | 需宿主书面放行 | `HOST_ACTION_REQUIRED` |

> `INTERNAL_LEDGER_READY` ≠ `REAL MONEY FLOW ENABLED`：`Payment = 0` / `collection = OFF` 是正式登记状态。

### P6 · Customer-Facing Product（`apps/web`）

| 能力 | 现状 | 分类 |
|---|---|---|
| login | `app/login` | `INTERNAL_READY` |
| register / signup | 缺失 | `BLOCKER_INTERNAL` |
| onboarding wizard（connect → bind → scan） | 缺失（分散在 `/connections`、`/upload`） | `BLOCKER_INTERNAL` |
| opportunity list | 缺失（只有 `components/opportunity-actions.tsx`） | `BLOCKER_INTERNAL` |
| case view / status tracking | `app/cases`、`app/cases/[id]` | `INTERNAL_READY` |
| claim package view（客户可读） | 缺失（package 只存在于服务层/测试） | `BLOCKER_INTERNAL` |
| recovered money visibility | 缺失 | `BLOCKER_INTERNAL` |
| billing / invoice view | `app/billing` | `INTERNAL_READY` |
| account management（profile / members / connections） | 部分（`/connections` + `admin/members`，缺自助账户页） | `BLOCKER_INTERNAL` |
| error / recovery states（断连、失败重试、需人工处理） | 缺失 | `BLOCKER_INTERNAL` |

> 结论：**当前无法通过界面独立完成从注册到追回的全流程**（注册、机会列表、package、回款可见性、错误恢复均为缺口）。

### P7 · Admin / Operations（`apps/web/app/admin/**`）

| 能力 | 现状 | 分类 |
|---|---|---|
| tenant admin / overview | `admin/tenant-overview` | `INTERNAL_READY` |
| audit | `admin/audit` + `tools/audit-coverage` | `INTERNAL_READY` |
| recovery review | `admin/recovery-review` | `INTERNAL_READY` |
| kill switch | `admin/kill-switch` + 控制面（MSG-20260930-16 PASS） | `INTERNAL_READY` |
| import diagnostics | `admin/imports` | `INTERNAL_READY` |
| system health | `admin/system-health` | `INTERNAL_READY` |
| manual intervention | 恢复/申诉/账单人工路径已具备 | `INTERNAL_READY` |
| failed job recovery（通用死信/重放运维面） | 仅有 payment `retry-due` 与 platform-write `DEAD_LETTER` 语义；无统一运维入口 | `BLOCKER_INTERNAL` |

### P8 · Security / Compliance

| 能力 | 现状 | 分类 |
|---|---|---|
| tenant isolation | 应用层 organizationId + DB trigger（`cc_tenant_*`） | `INTERNAL_READY` |
| account isolation | C2 + Track B（含 `ACCOUNT_BINDING_IMMUTABLE`） | `INTERNAL_READY` |
| credential storage | 仅 `credentialRef` 引用；无 secret 落库 | `INTERNAL_READY` |
| audit secret-leakage guard | `looksLikeSecret` + 载荷脱敏 + 验收用例 | `INTERNAL_READY` |
| approval boundaries（HITL / Action Guard） | Gate 7 ①/② 各批 PASS | `INTERNAL_READY` |
| external write kill switch | 控制面 + `TRANSPORT=false` | `INTERNAL_READY` |
| payment guards | 账单/资金红线 + `Payment=0` | `INTERNAL_READY` |
| webhook verification（支付/平台回调验签） | 未实现（无真实通道） | `BLOCKER_EXTERNAL` |
| secret rotation（`secret.rotate`） | SECRET_ACCESS → 仅宿主 | `HOST_ACTION_REQUIRED` |

### P9 · Reliability / Production Operations

| 能力 | 现状 | 分类 |
|---|---|---|
| migrations | 46+ migrations + checksum 门禁（`tools/migration-checksum`） | `INTERNAL_READY` |
| backups | `tools/backup-verify` + CI job `backup-verify` | `INTERNAL_READY` |
| restore verification | CI `Backup restore verify · synthetic dataset` | `INTERNAL_READY` |
| CI | 5 jobs：license-gate / backup-verify / deploy-smoke / api / web | `INTERNAL_READY` |
| deploy smoke（fresh install + migration upgrade） | CI `Deploy smoke` | `INTERNAL_READY` |
| two-stage upgrade | `tools/upgrade-verify` | `INTERNAL_READY` |
| idempotency | 幂等键 / deterministic audit id / `SUCCEEDED` partial unique | `INTERNAL_READY` |
| retries / backoff | platform-write state machine（RETRYABLE→DEAD_LETTER，上限 3） | `INTERNAL_READY` |
| failed task / dead-letter 统一恢复 | 无统一运维面 | `BLOCKER_INTERNAL` |
| monitoring（指标 / 告警 / 追踪） | 仅有 `metrics` 单测与 health 端点，无生产监控配置 | `BLOCKER_INTERNAL` |
| rate limit | 未见对外统一限流层 | `BLOCKER_INTERNAL` |
| concurrency（锁序 / CAS / exactly-once） | R45/R46/Action Guard 各批验收 | `INTERNAL_READY` |

### P10 · Commercial / Launch Requirements（只登记，不实现）

| 项 | 现状 | 分类 |
|---|---|---|
| pricing（success fee / customs 定价） | `SUCCESS-FEE-BILLING-REDLINE.md`、`CUSTOMS-SELF-SERVICE-PRICING-CONTRACT.md` | `INTERNAL_READY`（文档口径） |
| free audit / scan | onboarding 契约要求「免费扫描，不强制绑卡」；能力侧可支持 | `INTERNAL_READY` |
| package unlock（付费解锁） | 未实现 | `BLOCKER_INTERNAL` |
| provider terms（平台条款证据） | `docs/platform-approval/**` 为申请材料 | `BLOCKER_EXTERNAL` |
| legal / compliance notices | 未实现 | `BLOCKER_INTERNAL` |
| customer consent / claims authorization | 未实现（POA / 授权链） | `BLOCKER_INTERNAL` |
| privacy / data retention | `PRIVACY_DATA_LIFECYCLE.md` | `INTERNAL_READY`（文档口径） |
| customer support / manual exception flow | 未实现 | `BLOCKER_INTERNAL` |

## 3. X4 classification（按 MSG-80 ③ 重判）

| 项 | 判定 | 依据 |
|---|---|---|
| Cross-Provider Entity Resolution v1 | **`POST_LAUNCH`** | 无 X4 时当前 V1 仍可完成单平台 recovery：`PlatformAccount` + `CanonicalFact` + `RecoveryOpportunity` + `Case` + `Claim` + `Settlement` 链路均可闭合；X4 提供的是跨平台/跨域**增强**（发现单平台看不到的资金损耗），不是当前 V1 无法正确完成 recovery 的原因。若未来出现「必须跨 provider 归并才能正确识别 recovery」的真实用例，可重新升级为 `BLOCKER_INTERNAL`。 |

同批：Growth P3、Carrier V1、Customs V1 = `POST_LAUNCH`（均进入 POST_LAUNCH / GROWTH TRACK，除非被证明是 Production Candidate blocker）。

## 4. 唯一优先级队列（PC-01 …）

排序原则（MSG-80 ⑥）：Production Candidate blocker → 内部可完成 → 产品闭环 → customer-visible 能力 → 依赖更少。

| 序 | 单元 | 分类 | 为什么在此位置 |
|---|---|---|---|
| **PC-01** | **Customer Onboarding Entry：注册 / signup + 自助 Organization bootstrap** | `BLOCKER_INTERNAL` | 最前置的 customer-visible 缺口：没有注册与组织引导，真实客户无法从 0 开始；完全内部可完成、无外部依赖 |
| PC-02 | Opportunity list（机会列表 UI + 筛选/状态） | `BLOCKER_INTERNAL` | 产品主循环的客户可见入口，直接暴露已有 opportunity 能力 |
| PC-03 | Claim package view（客户可读的 package / basis / 提交状态） | `BLOCKER_INTERNAL` | `CLAIM READY` 价值无法被客户看见；纯展示 + 只读边界 |
| PC-04 | Error / recovery states（断连、失败重试、需人工处理） | `BLOCKER_INTERNAL` | 客户自助闭环的必要条件；避免静默失败 |
| PC-05 | Recovered money visibility（到账/结算/费用可视化） | `BLOCKER_INTERNAL` | 让 `Settlement`/`Fee`/`Invoice` 事实对客户可见（只读投影） |
| PC-06 | Account management（profile / members / 连接自助管理） | `BLOCKER_INTERNAL` | 自助运营基础；复用既有 members/connections 能力 |
| PC-07 | Entitlement + package unlock（权益模型，不含真实扣款） | `BLOCKER_INTERNAL` | 变现前置；只做权益与解锁，不触发 payment |
| PC-08 | Ops readiness：monitoring + rate limit + unified failed-job recovery | `BLOCKER_INTERNAL` | Production Candidate 的运行前置（无外部依赖） |
| PC-09 | Commercial/legal 内容层：notices + consent + claims authorization + support flow | `BLOCKER_INTERNAL`（法律复核由宿主） | 上线合规前置；内容与流程可内部实现，法务判断留给宿主 |
| PC-10 | Webhook verification 设计 + 实现（支付/平台回调） | `BLOCKER_EXTERNAL`（激活需真实通道） | 只有在支付/平台通道获批后才有意义 |
| PC-11 | Real provider OAuth/API integration（Amazon → TikTok → Walmart → Carrier） | `BLOCKER_EXTERNAL` | 需 provider approval + 真实凭据 |
| PC-12 | Payment activation（真实扣款 / success fee collection） | `HOST_ACTION_REQUIRED` | 需宿主书面放行 + 生产支付凭据 |
| PC-13 | `secret.rotate` 运维路径 | `HOST_ACTION_REQUIRED` | SECRET_ACCESS 仅宿主 |
| POST_LAUNCH | X4 Entity Resolution v1 / Growth P3 / Carrier V1 / Customs V1 | `POST_LAUNCH` | 增强而非 blocker |

**FIRST EXECUTABLE INTERNAL BLOCKER = PC-01（注册 / signup + 自助 Organization bootstrap）** → 可直接进入实现（含 UI + 服务 + 测试 + CI），无需外部资源。

## 5. HOST_ACTION_REQUIRED 清单（不自动推进）

| 项 | 原因 |
|---|---|
| `secret.rotate`（生产 Secret 轮换 / SECRET_ACCESS） | 只有宿主能完成或授权；禁止自动取得真实 secret / 自动轮换生产凭据 |
| Payment activation / success-fee collection | 需宿主书面放行 + 生产支付凭据（R13 / `PAYMENT_ACTIVATION_GATE = HOLD`） |
| 真实 provider 申请与凭据（Amazon / TikTok / Walmart / Carrier） | 平台审批 + 真实账号授权 |
| 域名 / DNS / 生产部署 / 付费服务开通 | 不可逆外部操作，需宿主授权 |

## 6. 本轮边界与后续

- 本轮 `READ-ONLY / DOCS-ONLY`：未写 X4 coding、未写 Growth Schema、未写 Carrier rules、未写 Customs checkout；未回开 Track B、未回开 R44/R45/R46；未触发 payment activation；未做 external write；未使用生产凭据。
- 完成后按 MSG-20261002-80：NEXT EXECUTION UNIT = **PC-01**（若 PC-01 被判定为 EXTERNAL/HOST，则继续扫描 PC-02… 找第一个可内部推进的 blocker，不停机）。
