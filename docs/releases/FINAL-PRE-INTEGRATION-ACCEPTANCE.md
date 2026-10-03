# FINAL PRE-INTEGRATION ACCEPTANCE（HOST DIRECTIVE 2026-10-04）

- 类型：进入 Layer 3（真实 API / Broker / 真实客户数据）之前的**内部工程冻结验收**
- REVIEWED_HEAD（当前仓库 HEAD）：`ea20413`；**FROZEN ACCEPTANCE TREE：`0f7f7ac`**
- 说明：`0f7f7ac..ea20413` 的改动**全部为验收/归档文档与验收工具**（`AI-ARCHITECT-INBOX.md`、`docs/releases/*`、`.autopilot/*`、`tools/autopilot/final-archival.mjs`），**无任何产品代码 / Schema / 测试变更**；故本次未产生新的产品 Acceptance Head。
- 边界：Production Enablement=HOLD · External Write=HOLD · Real Money=HOLD · Customer Submission=HOLD · Production Credentials=HOST_ONLY

---

## A. FINAL ACCEPTANCE BASELINE

| 项 | 独立反查结果 |
|---|---|
| `FINAL_ACCEPTANCE_HEAD = 0f7f7ac` | ✅ 存在且为 `chore(acceptance): record full local DB regression …` |
| CI `37142365134` | ✅ GitHub API 实测 `head_sha=0f7f7ac6f00e39c18782cd403c7108aea343b97a`、`status=completed`、`conclusion=success`（5/5 job success：Deploy smoke / API migration+typecheck+tests / 许可证闸门 / Web typecheck+build / Backup restore verify） |
| `INDEPENDENT FINAL AUDIT = PASS` | ✅ 已归档 `AI-ARCHITECT-INBOX.md ### [MSG-20261003-147]`（`FULL_COPY_OK`） |
| working tree | ✅ clean（`git status --porcelain` 仅静态生成物，按协议 §九 视为 clean） |
| branch divergence | ✅ 无（单分支 `gate/7-commercial-validation`，`0f7f7ac..HEAD` 无产品代码差异） |
| 后续纯文档 commit 是否被当作新 Acceptance Head | ✅ 否（冻结树保持 `0f7f7ac`） |

**BASELINE_INTEGRITY = PASS**

## B. BUILD / SCHEMA / FRESH DATABASE

| 检查 | 结果 |
|---|---|
| `prisma validate` | ✅ schema valid |
| Schema consistency / model count | ✅ architecture-contract 142/142（模型 77：71 core + 6 join） |
| Migration chain | ✅ 66 迁移全部可应用 |
| **Fresh PostgreSQL（空库从 0）** | ✅ 新建空库 → `prisma migrate deploy` 66/66 成功；实测 **78 表 / 173 外键 / 208 唯一索引 / 175 CHECK 约束 / 237 触发器**（含 **31 append-only**、**174 tenant**） |
| append-only invariants | ✅ `cc_append_only__*` 31 枚（含 IOR / PS04 事实层） |
| `tsc` API / WEB | ✅ EXIT=0 / EXIT=0 |
| Production build（web） | ✅ `next build` EXIT=0（含 `/platform-recovery-state`、`/integration-status`、`/money` 等路由） |
| Test discovery | ✅ 277 个 API 测试文件全部被发现（无 quarantine / disabled） |
| `.skip` / `.only` | ✅ 0 处 |
| TEST_ONLY / 生产后门 / auth bypass | ✅ 未发现（`TEST_ONLY` / `SKIP_AUTH` / `BYPASS_*` 均无命中） |
| 安全 / 资金 / 外写相关 FIXME·TODO | ✅ 未发现 |

**BUILD_ACCEPTANCE = PASS · SCHEMA_ACCEPTANCE = PASS · FRESH_DB_ACCEPTANCE = PASS**

## C. 四域 GOLDEN PATH（真实 HTTP + PostgreSQL + 租户隔离）

全量套件（277 文件 / **2725 用例全 PASS**，0 失败 0 跳过，18.8 分钟）中按域统计：

| 域 | 套件规模 | 关键链路证据（HTTP E2E + PG + 租户） |
|---|---|---|
| Platform | 34 文件 | opportunity → qualification（持久化只读投影）→ claim-ready → submission（NEEDS_MANUAL/TRANSPORT=false）→ recovered/fee/billing |
| Logistics / Carrier | 17 文件 / 296 用例 | carrier auth/account → tracking/invoice/POD read → evidence bundle → SLA eligibility → claim package → manual submission → response read model |
| Customs | 26 文件 / 220 用例 | entry fact → duty truth → discrepancy → eligibility → estimate → claim-ready → handoff；只读投影 GET + runtime E2E |
| Independent-site | 6 文件 / 34 用例 | dispute → qualification/evidence/claim-ready（已持久化）→ handoff → response → settlement → recovered → 15% fee → invoice draft |

HTTP/E2E 文件 44 个；PostgreSQL DB 套件 133 个；前端读取均为只读投影（`recomputedOnRead=false`，前端不重算 authoritative facts）。

**PLATFORM_GOLDEN_PATH = PASS · CARRIER_GOLDEN_PATH = PASS · CUSTOMS_GOLDEN_PATH = PASS · INDEPENDENT_SITE_GOLDEN_PATH = PASS**

## D. CUSTOMS 生死线专项

- 自动匹配：`customs-return-matching`（EXACT/PARTIAL/AMBIGUOUS/NO_MATCH）+ `customs-return-fact-store-db` + `customs-return-claim-evidence-db`（含 digit 篡改 → `RECONCILIATION_REQUIRED` 零计入）。
- ambiguity fail-closed：AMBIGUOUS / NO_MATCH → `NOT_READY` 且 confirmed amount = 0，禁止进入 submission-ready。
- 证据来自持久化事实（`CustomsReturnFactRecord` / `CustomsReturnClaimEvidenceRecord`），calculation projection 重算追加历史、latest 由 `computedAt` 推导。
- append-only：UPDATE/DELETE 被 DB 触发器拒绝；跨租户读写被拒绝。
- claim-ready evidence package 可生成；**real filing 继续 HOLD**，Broker/Filing Provider 缺失时输出 `filingSubmitted=false` 而非伪成功（`customs-recovery-chain-http.ts` 四个 HOLD 字段硬编码 false/ABSENT）。

**CUSTOMS_MATCHING_SAFETY = PASS · CUSTOMS_EVIDENCE_CHAIN = PASS · CUSTOMS_FAIL_CLOSED = PASS**

## E. 客户筛选 / DATA SAFETY

- lineage：account / connection / tenant / canonical fact / opportunity / case 全链在 `account-lineage-*`、`canonical-*`、`tenant-isolation`、`claim-tracking-permissions` 等套件中验证。
- Qualification Gate：数据不足 / 完整度低于政策下限 / lineage 不完整 → `INDETERMINATE`，CONDITIONAL 需人工确认，仅 `QUALIFIED` 允许昂贵调用；判定 append-only 持久化（PG 5/5）。
- 高风险输入（unsupported account/jurisdiction/provider、unresolved identity、stale credential、revoked connection）在 connector/credential 生命周期与 action-guard 套件中 fail-closed。

**CUSTOMER_QUALITY_GATE = PASS · DATA_SAFETY_GATE = PASS · TENANT_ISOLATION = PASS · LINEAGE_INTEGRITY = PASS**

## F. HITL / ACTION GUARD / HIGH VALUE（36 文件 / 346 用例）

- approval 绑定 action / actor / organization / basisReference / payload digest；expiry、revoke、consume exactly once、role/membership 重新校验、stale approval、payload 变更后拒绝、replay、并发执行均有断言。
- 高价值（> USD 1000 等值）动作必须 OWNER review；OWNER 降权 / 停用 / Membership 失效 / 审批过期 / 撤销 / payload 改变 → 执行期重新校验并拒绝。

**HITL_ACCEPTANCE = PASS · HIGH_VALUE_REVIEW = PASS · ACTION_GUARD_ACCEPTANCE = PASS**

## G. CONCURRENCY / IDEMPOTENCY / EXACTLY-ONCE（4 文件 / 60 用例专项 + 内嵌断言）

覆盖：双请求同时 `claim.submit`；双连接竞争同 `providerSubmissionId`（root FOR UPDATE → exactly one accepted）；同 idempotencyKey 同/异 immutable payload（后者 → `IDEMPOTENCY_KEY_CONFLICT`）；P2002 收敛；事务回滚；进程重试；网络式重试；stale read；重复 webhook / settlement / payment capture；replay；audit 写入失败；审批消费失败。目标断言全部成立（exactly-one、无第二次外部动作、冲突显式、blind retry 禁止）。

**CONCURRENCY_ACCEPTANCE = PASS · IDEMPOTENCY_ACCEPTANCE = PASS · EXACTLY_ONCE_ACCEPTANCE = PASS**

## H. PAYMENT / RECOVERY MONEY（35 文件 / 335 用例）

recovery money / settlement record / fee visibility / commission basis / payment.capture / invoice 锁定 / 事务边界 / replay / duplicate capture / rollback / audit 失败 / 审批消费失败 / 跨租户 / immutable amount·currency / 舍入与币种分离 —— 全部通过；**REAL_MONEY_EXECUTED = FALSE**。

**MONEY_LEDGER_ACCEPTANCE = PASS · PAYMENT_BOUNDARY_ACCEPTANCE = PASS**

## I. PRODUCTION / EXTERNAL-WRITE GATES（攻击性验证）

- `control-plane.ts`：`PRODUCTION_GATE_DEFAULT = 'NOT_SATISFIED'`；未知 action 或 `globalDisabled=true` → `tenantEnabled/writeEnabled/hostApprovalGranted` 全部 false（fail-closed）。
- 逐条件门控：globalDisabled → productionGate → platformEnabled → tenantFeatureEnabled → hostApprovalGranted → credential validity → provider capability → external-write permission → real-money permission。
- 绕过尝试覆盖（HTTP direct / service direct / internal task / retry worker / replay / forged status / stale approval / test config leakage / env 误配）由 20 文件 / 187 用例（platform-write*、control-plane*、kill-switch*、transport*）断言。
- 结论：**PRODUCTION_DISABLED ⇒ REAL_EXTERNAL_WRITE = IMPOSSIBLE**。

**PRODUCTION_GATE_ACCEPTANCE = PASS · EXTERNAL_WRITE_BOUNDARY = PASS · REAL_MONEY_BOUNDARY = PASS**

## J. PROVIDER INTEGRATION READINESS（不接真实 provider）

- credentials：只允许 `credentialRef`（明文永不入库 / 不入日志 / 不回显）；`provider-credential-lifecycle` + `secret-rotation` 套件验证。
- connection → account lineage 固定；一用户多平台、同平台多账号可绑定（`multi-account` / `connection-onboarding`）。
- revoke / suspend / reconnect 安全；sandbox 与 production 严格隔离（环境校验 fail fast）。
- webhook 签名 + 幂等 + 去重（`webhook-verification*`，日志仅 `payloadHash`，无 secret）。
- provider 差异收敛在 `connector-capability` / adapter 层，**不需要改核心领域 Schema**；rate-limit / timeout / backoff 有接入位（provider readiness 契约）。

**PROVIDER_INTEGRATION_READY = PASS**

## K. SECURITY / NEGATIVE PATH

覆盖：横向越权、tenant/account spoof、case ID 枚举、VIEWER 提交、ADMIN 越过 OWNER-only gate、revoked membership、inactive user、过期凭据、畸形 payload、超大上传、错误 MIME、证据跨租户复用、伪造 organizationId、重复 callback、非法状态迁移、stale object version、缺失 audit log。所有高风险场景 fail-closed；无「500 后继续产生副作用」路径。

**SECURITY_ACCEPTANCE = PASS · NEGATIVE_PATH_ACCEPTANCE = PASS**

## L. OBSERVABILITY / AUDITABILITY

- 关键动作具备 request/action identity、tenant、account、provider、opportunity、case、claim、approval、idempotency、result、failure reason、timestamp。
- audit coverage 闸门 `AUDIT_COVERAGE_OK`；Secret/token 不入日志；audit 不跨租户读取；submission / payment 关键事件可追溯。

**AUDITABILITY_ACCEPTANCE = PASS · OBSERVABILITY_ACCEPTANCE = PASS**

---

## M/N. FINAL PRE-INTEGRATION ACCEPTANCE — 判定

```text
FINAL PRE-INTEGRATION ACCEPTANCE

BASELINE_INTEGRITY            = PASS
BUILD_ACCEPTANCE              = PASS
SCHEMA_ACCEPTANCE             = PASS
FRESH_DB_ACCEPTANCE           = PASS

PLATFORM_GOLDEN_PATH          = PASS
CARRIER_GOLDEN_PATH           = PASS
CUSTOMS_GOLDEN_PATH           = PASS
INDEPENDENT_SITE_GOLDEN_PATH  = PASS

CUSTOMS_MATCHING_SAFETY       = PASS
CUSTOMS_EVIDENCE_CHAIN        = PASS
CUSTOMS_FAIL_CLOSED           = PASS

CUSTOMER_QUALITY_GATE         = PASS
DATA_SAFETY_GATE              = PASS
TENANT_ISOLATION              = PASS
LINEAGE_INTEGRITY             = PASS

HITL_ACCEPTANCE               = PASS
HIGH_VALUE_REVIEW             = PASS
ACTION_GUARD_ACCEPTANCE       = PASS

CONCURRENCY_ACCEPTANCE        = PASS
IDEMPOTENCY_ACCEPTANCE        = PASS
EXACTLY_ONCE_ACCEPTANCE       = PASS

MONEY_LEDGER_ACCEPTANCE       = PASS
PAYMENT_BOUNDARY_ACCEPTANCE   = PASS

PRODUCTION_GATE_ACCEPTANCE    = PASS
EXTERNAL_WRITE_BOUNDARY       = PASS
REAL_MONEY_BOUNDARY           = PASS

PROVIDER_INTEGRATION_READY    = PASS

SECURITY_ACCEPTANCE           = PASS
NEGATIVE_PATH_ACCEPTANCE      = PASS

AUDITABILITY_ACCEPTANCE       = PASS
OBSERVABILITY_ACCEPTANCE      = PASS

INTERNAL_BLOCKERS      = []
INTERNAL_BLOCKER_COUNT = 0

CODE_COMPLETE          = YES
INTERNAL_ACCEPTANCE    = PASS
SECURITY_ACCEPTANCE    = PASS
FOUR_DOMAIN_GOLDEN_PATH = PASS
DATA_INTEGRITY         = PASS
CONCURRENCY_IDEMPOTENCY = PASS
PRODUCTION_GATE        = PASS
PROVIDER_INTEGRATION_READY = PASS

INTEGRATION_COMPLETE     = NO
REAL_VALIDATION_COMPLETE = NO
PRODUCTION_READY         = NO

FINAL_PRE_INTEGRATION_ACCEPTANCE = PASS
```

## P. 验收证据

| 项 | 值 |
|---|---|
| REVIEWED_HEAD | `ea20413`（FROZEN ACCEPTANCE TREE `0f7f7ac`） |
| test commands | `npx vitest run`（apps/api）；`npx tsc --noEmit`（api/web）；`npx next build`（web）；`npx prisma validate` / `prisma migrate deploy`（fresh DB） |
| test file count | **277** |
| test case count | **2725**（0 failed / 0 skipped） |
| PostgreSQL test count | 133 个 DB 套件（`-db.test.ts`） |
| HTTP E2E count | 44 个 HTTP/E2E 套件 |
| concurrency test count | 4 个专项文件 / 60 用例（另有内嵌并发断言） |
| build / typecheck | API tsc EXIT=0 · WEB tsc EXIT=0 · `next build` EXIT=0 |
| migration / fresh DB | 66 迁移从空库全部成功；78 表 / 173 FK / 208 唯一索引 / 175 CHECK / 237 触发器（31 append-only、174 tenant） |
| CI run ID / conclusion | `37142365134` / **success**（绑定 `0f7f7ac`） |
| changed files | 仅本报告（`docs/releases/FINAL-PRE-INTEGRATION-ACCEPTANCE.md`）——无产品代码 / Schema / 测试改动 |
| commits | 仅报告提交（不改变冻结验收树语义） |
| unresolved internal gaps | 无 |
| Layer 3 HOLD 清单 | HOST_ACTION_REQUIRED（生产部署 / DNS / 付费服务 / 生产凭据 / 生产支付）；API_INTEGRATION_REQUIRED（Amazon·TikTok·Walmart·Shopify OAuth、UPS/FedEx/DHL、Customs Data·Filing·Broker、Stripe/PayPal dispute read）；REAL_DATA_REQUIRED（真实客户数据、真实到账、真实 recovered cash）；LEGAL_OR_LICENSE_REQUIRED（Broker POA、IOR 权属、dispute 提交授权） |
