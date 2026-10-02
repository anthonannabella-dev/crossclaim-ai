# PLATFORM SAFETY / EXTERNAL SUBMISSION BOUNDARY —— 长期架构约束（P0 Safety）

状态：**REGISTERED（docs-only；本轮未改代码）** · 来源：**HOST ARCHITECTURE DELTA — PLATFORM SAFETY / EXTERNAL SUBMISSION BOUNDARY** · 优先级：**长期 P0 Safety Constraint**（不得被后续「全自动化 / 无人值守」需求覆盖）
审计对象：HEAD `e99717c`（R46 S1–S6 CLOSED，TRACK C2 第一批已交付）
边界：`NO platform write` · `TRANSPORT=false` · `NO production credentials` · `platformWriteExecuted=false` · `externalSubmission=NEEDS_MANUAL` · Action Guard + HITL + fail-closed 保持

## 0. 轻量审计结论（HOST 第六节 6 项）—— **全部 PASS**

| # | 检查项 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 无 Playwright / Puppeteer / Selenium / CDP 产品依赖 | **PASS** | `apps/api`、`apps/web` 的 `package.json` 无相关依赖；`apps/api/src` 与 `apps/web/app` 全量搜索 `playwright|puppeteer|selenium|webdriver|chrome-remote|cdp` **零命中** |
| 2 | 无 Seller credential / cookie / session 持久化 | **PASS** | `schema.prisma` 中与凭据相关的只有 `SourceConnection.credentialRef String?`（**引用**）；无 seller cookie / session / token 列；`Session` 模型是 CrossClaim 自身登录会话（`tokenHash`），与本约束无关 |
| 3 | 无真实 Amazon / TikTok / Walmart endpoint 写调用 | **PASS** | `src` 内搜索 `sellingpartnerapi|api.amazon|open-api.tiktok|marketplace.walmart|api.walmart|graphql.shopify|api.stripe` **零命中**；`adapters/amazon-sp-read-only-adapter.ts` 仅 `transport.get(...)`（读），且「不读 env、不持有凭据、不创建 transport」；`adapters/types.ts` 的 `submitClaim()` 直接抛 `NEEDS_MANUAL`（Phase 1 禁止任何外部平台写入） |
| 4 | `claim.submit` / `appeal.submit` / `recovery.manual.submit` 仍 `platformWriteExecuted=false` | **PASS** | 源码级：`services/claims/claim-submission.ts:51-52,240-241`、`services/appeals/appeal-submission.ts:53-54,266-267`、`services/recovery/http-request.ts:117-118,357-358`（均 `externalSubmission: 'NEEDS_MANUAL'` + `platformWriteExecuted: false`）；`services/billing/billing-draft.ts` 同 |
| 5 | `credentialRef` 仍只存引用 | **PASS** | 全仓 `credentialRef` 赋值仅出现在测试夹具中的逻辑引用（`CROSSCLAIM_UPS_RO`、`NEW_SECRET_REF`）；产品源码不写真实 token/password/cookie；轮换走 `rotateCredentialRef`（引用级） |
| 6 | Production credentials 仍 HOLD | **PASS** | `services/action-guard/capability-source.ts:52`「生产闸门默认 **NOT_SATISFIED**」；`action-guard.ts` 将 `claim.submit`/`appeal.submit`/`platform.write` 定为 `EXTERNAL_WRITE`，必须同时满足 `humanApproval + platformEnablement + productionGate`；产品源码不读取平台密钥 env（仅测试读取 env） |

**结论：全部满足 → 记录 PASS，本约束进入 Architecture Constraints，不改代码。** 未发现实际缺口，因此不触发最小修复。

## 1. 平台接入优先级（永久固定）

1. **Official OAuth / Official API**
2. 官方导出文件 CSV / XLSX / PDF / JSON
3. Claim-Ready Package + Human Submit
4. Browser Automation —— **不作为默认生产 fallback**

除非某平台**明确允许**且经过**独立合规审核 + 架构审批**，否则**禁止**实现：

- 保存 Seller Center 用户名 / 密码
- 保存浏览器 Cookie / Session
- 模拟登录 Seller Center
- 绕 CAPTCHA / MFA
- Playwright / Puppeteer / Selenium 批量代登录
- 未授权页面抓取
- UI 自动点击批量提交 Claim
- 多商户共用一个 session / token

未来若提出 Browser Automation，必须作为**独立 Gate / Design Proposal**，不得通过普通 adapter 偷接入。

## 2. 「内部提交状态」与「平台真实提交状态」必须可区分

HOST 要求系统能明确回答 A–E，审计结论：**现有 Schema 已能通过字段组合可靠区分，保留 Schema，仅需补 projection / UI / contract。**

| 问题 | 现有承载 | 判定 |
| --- | --- | --- |
| A. CrossClaim 内部是否已批准？ | Action Guard approval + `approval_consumed` 审计（`approvalId` 绑定） | ✅ 可答 |
| B. 是否已生成最终提交包？ | `RecoveryManualSubmission` + `RecoveryManualSubmissionReference`（package/artifact 事实） | ✅ 可答 |
| C. 是否已由人工记录「准备提交」？ | `RecoveryManualSubmission` 提交事实（内部状态推进） | ✅ 可答 |
| D. 是否真的向第三方平台发送？ | **`platformWriteExecuted = false`**（+ `PlatformWriteAttempt` 账本，transport 放行后才有 attempt） | ✅ 可答 |
| E. 第三方是否 ACK / 返回 case reference？ | `RecoveryManualSubmissionReference.providerCaseRefRaw / providerCaseRefCanonical`（唯一键含 org） | ✅ 可答 |

**禁止**用一个含糊的 `SUBMITTED` 同时表示「CrossClaim 内部状态已推进」与「Amazon/TikTok/Walmart 已实际收到 Claim」。

**处置**：无需 State Model Delta；后续批次补 **projection / UI / 契约**（例如对外呈现用「Internal Approved / Package Ready / Recorded Ready to Submit / Not Sent to Platform / Provider Acknowledged」这类显式措辞，避免运营误读内部 `SUBMITTED`）。若未来出现无法用字段组合表达的场景，再提最小 State Model Delta Proposal。

## 3. 真实 Platform Write 必须经过独立 Production Gate（逐平台 15 项）

任何平台从 `platformWriteExecuted=false` 变为 `true` 之前，必须逐平台满足：

1. 平台 Terms 已核对并形成文档证据；2. 确认第三方应用是否允许代表 Seller 执行该具体动作；3. 使用官方 OAuth / API；4. 最小权限 Scope；5. **每个 Platform Account 独立授权**；6. Token/Secret 进入外部 Secret Manager（**不进入业务表与日志**）；7. Sandbox / Test Account 验证；8. Action Guard；9. Human Approval；10. payload fingerprint / idempotency；11. duplicate submission protection；12. rate limit / retry / backoff；13. tenant / platform / account kill switch；14. audit trail；15. **单次灰度真实提交成功后才逐步放开**。

不得因为内部 `claim.submit` 已完成就直接接真实 endpoint。R46 的 PASS **不等于** R13 Payment Activation 通过。

## 4. 平台账号隔离（与 TRACK C2 联动）

每个 Platform Account 的 `OAuth authorization` / `credential reference` / `token lifecycle` / `revoke` / `reconnect` / `rate limit state` / `platform case reference` 必须独立；Store A 授权失效不得影响 Store B。

任何 Claim / Appeal / External Submission 必须可追溯：

```
Organization → Platform → Platform Account → Source Connection → Case → Claim/Appeal → External Submission
```

禁止不同店铺共享 token/session，禁止把 A 店 Claim 提交到 B 店。（该维度当前缺口与最小修复见 `TRACK-C2-BATCH1-AUDIT-GAP-MATRIX-AND-DELTA-REQUEST.md`，待架构方裁决后实施。）

## 5. 本批不做

不开启任何真实平台外写 · 不申请生产凭据 · 不实现浏览器机器人 · 不修改当前 Production HOLD · 不打断 R46 / Recovery 主线 · 不为未来 API 提前写假 endpoint · 不为「自动化程度」降低 HITL。

## 6. 目标

CrossClaim 成为**正规的 API / OAuth-first Recovery Platform**，而不是依赖 Seller Center 浏览器机器人运行的自动化脚本。

## 7. 优先级与不可覆盖性

本约束为**长期 P0 Safety Constraint**：任何后续提案（含「全自动化」「无人值守」「批量代登录」等）不得覆盖；如需变更，必须走独立 Gate + 合规审核 + 架构审批。
