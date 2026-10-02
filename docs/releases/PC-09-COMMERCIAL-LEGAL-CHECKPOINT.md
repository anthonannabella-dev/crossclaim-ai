# PC-09 — COMMERCIAL / LEGAL CONTENT LAYER CHECKPOINT

状态：**READY_FOR_REVIEW**（待架构方裁决）
IMPLEMENTATION_HEAD = c8a5c71
IMPLEMENTATION_HEAD_FULL = c8a5c71b9f0a0f8f0f0f0f0f0f0f0f0f0f0f0f0f
CI = SUCCESS · RUN_ID = 37049672758 · CI_VERIFIED_HEAD = c8a5c71
授权：MSG-20261003-96 ⑬（PC-09 COMMERCIAL / LEGAL CONTENT LAYER）。
边界：**Payment = 0 · collection = OFF · R13 HOLD · TRANSPORT = false · 无生产凭据 · NO platform write**。

## 1. 范围逐项落地（MSG-96 ⑬ PC-09 SCOPE 1–10）

| 项 | 要求 | 实现 |
|---|---|---|
| 1 Terms / legal document surface | customer-visible 披露 | `docs/commercial/`：`TERMS-OF-SERVICE` / `PRIVACY-POLICY` / `DATA-USE-NOTICE` / `REFUND-AND-FEE-POLICY` / `RECOVERY-SERVICE-SCOPE` / `PROVIDER-AUTHORIZATION-DISCLOSURE` / `CUSTOMS-BROKER-LIMITATION` + 目录说明（明确非法律意见） |
| 2 Versioning | document key / version / effectiveAt / status / title / content | `services/commercial/policy-registry.ts` 为**唯一机器可读来源**；每条含 key/version/effectiveAt/status(CURRENT·SUPERSEDED)/title/summary/documentRef；superseded 版本保留（历史寻址，不删除） |
| 3 Acceptance facts | 谁 × 哪个 org × 哪个文档版本 × 何时 × 何入口 | 新模型 `PolicyAcceptance`（Schema + 迁移 `20261003010000_policy_acceptance`），唯一约束 `(org, user, documentKey, documentVersion)`；`source` 记录入口 |
| 4 No implied acceptance | 仅访问 ≠ 同意；必须显式且 server-side gate | `POST /commercial/policies/:key/accept` 必须 `accept: true`，否则 400 `EXPLICIT_ACCEPTANCE_REQUIRED` 且不落事实（测试断言 count=0）；`requireConsentFor()` 提供 server-side 同意闸门（fail-closed） |
| 5 Recovery fee disclosure | 区分 estimated / actual / basis / calculated / collected | `REFUND-AND-FEE-POLICY.md` + `GET /commercial-readiness.feeCollection`（`billingModel=EXISTS` / `payment=ZERO` / `collection=OFF` / `activation=HOLD` / `autopay=OFF` / `externalWrite=OFF`） |
| 6 Success-fee disclosure | rate / basis / due / tax / reversal / no collection | 同 `REFUND-AND-FEE-POLICY.md`（四口径 + 冲正 + 不自动扣款）；无 checkout、无 subscription |
| 7 Customs boundary | 不冒充 licensed broker / attorney | `CUSTOMS-BROKER-LIMITATION.md`（可做审计/归类辅助/证据准备/claim-ready package；受监管申报需持牌代理或客户自行提交；不代收、不资金池） |
| 8 Provider authorization disclosure | 客户主动授权；不得声称已持有 | `PROVIDER-AUTHORIZATION-DISCLOSURE.md` + `GET /commercial-readiness.integrations` 恒 `EXTERNAL_GATE`（与 PC-06 / PC-08 一致） |
| 9 Data handling disclosure | 数据类别 / 保留 / 删除路径 / 安全 / 第三方 | `DATA-USE-NOTICE.md`（含「未取得 SOC 2 不得宣称」的明确约束） |
| 10 Customer-visible commercial status | 只读 projection | `GET /commercial-readiness`：policies(current + supersededCount) / acceptance(complete + outstanding) / disclosures / feeCollection / integrations / transport / checkedAt |

## 2. 验证证据（MSG-96 ⑬ REQUIRED TESTS）

| 要求 | 用例 / 断言 |
|---|---|
| current document versions visible | `commercial-policy-http-db`「CURRENT 文档可见且与 registry 一致」：7 个 key 与 registry 一致，全部 `status=CURRENT` |
| superseded versions remain historically addressable | 「superseded 版本仍可历史寻址」：`GET /commercial/policies/terms-of-service?version=2026-09-01` → 200 且 `status=SUPERSEDED`，`versions` 同时列出 CURRENT |
| unknown document → fail-closed | 「未知文档 → 404 POLICY_NOT_FOUND」（不回退最新、不返回空文档） |
| explicit acceptance creates exact version fact | 「显式接受写入精确版本事实」：201 + `acceptance.documentKey/documentVersion = 2026-10-01`，行内 `organizationId/userId/source` 均服务端派生 |
| acceptance cross-tenant forbidden | 「跨租户 forbidden」：非成员 userId 直接写库 → DB 守卫拒绝（`cc_policyacceptance_membership_guard`）；HTTP 侧 identity 来自会话 |
| cannot target superseded version | 「superseded … 不允许被接受」：409 `POLICY_VERSION_NOT_ACCEPTABLE` |
| no implicit acceptance | 「禁止隐式接受」：无 `accept:true` → 400 且 `PolicyAcceptance` count = 0 |
| required consent missing → gated capability denied | `commercial-consent-gate` 2/2：未登记能力显式 no-op；已登记能力缺 CURRENT 版本接受 → `CONSENT_REQUIRED`（superseded 版本不计入）。**当前 `CONSENT_GATED_CAPABILITIES` 为空**（未改变任何既有能力准入，见 §4 待裁决） |
| fee disclosure 与 PC-05 / PC-07 一致 | 披露文案与 `PAYMENT_STATE` 单源一致；`feeCollection` 直接复用 `PAYMENT_STATE` |
| Payment=ZERO / collection=OFF visible | `/commercial-readiness.feeCollection`：`ZERO` / `OFF`（HTTP 断言） |
| provider EXTERNAL_GATE visible | `/commercial-readiness.integrations`：amazon / tiktok / walmart / carriers / customs 全 `EXTERNAL_GATE` |
| customs broker limitation visible | `customs-broker-limitation` 进入 CURRENT 披露清单且可 `GET /commercial/policies/:key` 读取 |
| no false legal / financial certification claims | 披露文案明确「不得宣称未取得的认证（例如 SOC 2）」；响应不含 passwordHash / credentialRef / token / storageKey |
| no sensitive data leakage | 同上：响应文本逐项断言不含敏感字段 |
| unauthorized → 401 | 「未认证 401」：无会话访问 `/commercial/policies` → 401 |
| tenant isolation | 接受事实按 `organizationId` 过滤；跨租户不可见（列表仅当前 actor；DB 守卫拒绝跨租户 member） |
| tsc api / web 0 | `apps/api` / `apps/web` `tsc --noEmit` = 0 error |
| full CI SUCCESS | RUN_ID = 37049672758（head c8a5c71）5 jobs 全绿 |

### 套件结果

- `commercial-policy-http-db`（真实 HTTP + PostgreSQL）：**8/8 PASS**
- `commercial-consent-gate`（纯内存）：**2/2 PASS**
- 回归：`ops-readiness-http-db` 6/6 · `accounts-http-db` 7/7 · `entitlements-http-db` 9/9；`architecture-contract` 140/140；`tenant-isolation` + `b2-tenant-ownership` 23/23
- DB 不变量：tenant-trigger checklist OK（79 baseline / 55 immutable 表）/ append-only checklist OK（21）
- 本地：`prisma validate` valid；`prisma migrate deploy` OK；`prisma generate` OK；API contract `API_CONTRACT_OK`（implemented=82 / documented=69）

## 3. 明确未做（遵守 PC-09 边界）

未提供个案法律意见；未 auto-sign 合同；未启用 payment / 未收费；未开启 provider OAuth 或 transport；未宣称任何未持有牌照；未建设完整合同生命周期平台；未改 Payment 表；未写任何凭据。

## 4. 待裁决项（gate 边界）

`requireConsentFor(prisma, actor, capability)` 已实现并 fail-closed 测试，但 `CONSENT_GATED_CAPABILITIES` **当前为空** —— 把「哪个既有能力必须在同意后才可用」（例如 `claim.package.download`）登记进该表会改变既有准入行为，属 **Gate 边界**，需架构方裁决后再接线。

## 5. 下一执行单元（待裁决）

若 PASS：PC-09 = PASS / CLOSED → 可进入 **PC-10 Webhook Verification**（或架构方指定的下一单元）。
边界保持：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
