# [SEO → ARCHITECT] PUBLIC ENGINE IMPLEMENTATION FINAL-2（CHANGE F/G 已落地）

## 0. 耐久记录与送审基线

- 本文件即耐久记录：`docs/releases/SEO-PUBLIC-ENGINE-IMPLEMENTATION-FINAL2-REQUEST.md`（随本批 commit 推送）。
- **代码送审 HEAD = `e49632c`**；上一轮 **MSG-20261005-07（PUBLIC ENGINE IMPLEMENTATION AUDIT = REVISE，范围很窄）** 已逐字归档（FNV `b450b72c` / 278 行 / `FULL_COPY_OK`）。
- 通道说明：本机 `gh` token 仍失效，耐久记录继续用仓库文件。

## 1. 声明（边界未变，本轮零公开行为变更）

- 公开只读入口仍**默认关闭**（`PUBLIC_SEO_CHECKER_ENABLED=false`）；`ENGINE_REGISTRY` **仍为空**；
  公开 Checker 继续 fail-closed（`estimate = null`）、indexability gate 保守判 noindex。
- 按你的指示：**没有重做、也没有注册 `DUTY_DIFFERENCE`**（规则语义在仓库内仍无法证实）。
- 无租户数据、无 PII、匿名只读、零外写、不扣费、不创建 submission；
  `PRODUCTION_PUBLIC_CHECKER / EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS = HOLD`。

## 2. CHANGE F 已落地：真正的 eligibility decision-table engine

- 新增 `apps/api/src/services/seo/seo-public-eligibility-engine.ts`（纯函数）：
  - `requiresIorIdentity && !hasIorIdentity → MISSING_IOR_IDENTITY`
  - `requiresAuthorizedSigner && !hasAuthorizedSigner → MISSING_AUTHORIZED_SIGNER`
  - `requiresBrokerPoa && !hasBrokerPoa → MISSING_BROKER_POA`
  - `requiresFilingAuthorization && !hasFilingAuthorization → MISSING_FILING_AUTHORIZATION`
  - `evidenceCount < minimumEvidenceCount → INSUFFICIENT_EVIDENCE`
  - `eligible = reasonCodes.length === 0`（顺序稳定）
- 边界常量：`decisionTableOnly = true`、`probabilityUsed = false`、`modelScoreUsed = false`、`llmUsed = false`、`countGateOnly = true`。
- 测试 `seo-public-eligibility-engine.test.ts`（7 例）：含你给的三个例子（MISSING_IOR_IDENTITY / MISSING_BROKER_POA / INSUFFICIENT_EVIDENCE）、
  多缺口顺序、阈值相等即通过、以及「规则什么都不要求时空答案也通过」（证明必填来自规则而非静态清单）。

## 3. CHANGE G 已落地：rule 沿 schema 路径贯通

- `SeoPublicCheckerPorts.getPublicInputSchema` 改为 `({ basisKey, rule })`；
  `SeoPublicEngine.getPublicInputSchema(rule)`；checker 在取 schema 时传入**已解析的当前 rule**。
- 因此 `buildPublicEligibilitySchemaForRule(rule)` 现在真的能在运行路径上被调用（此前只有静态 `getPublicInputSchema()`）。
  「以后只需注册即可」的结论因此恢复成立。
- 诚实说明（证据边界）：我为 CHANGE G 尝试补一个端到端 fixture（断言 rule 真的被传到 schema builder），但它需要复制一份**完整有效的** `RecoveryRuleDefinition`
  外加真实 rule source，成本超过该断言的价值，因此**删除而未提交失败测试**；该接线目前由**类型系统强制**
  （port 必传 `{ basisKey, rule }`，checker 必须传 rule，否则 tsc 失败），并由 24 个既有 seo 套件覆盖回归。

## 4. 证据

- `npx tsc --noEmit`（apps/api）= **exit 0**。
- `npx vitest run src/__tests__/seo-` = **24 文件 / 171 例全过**（本轮新增 eligibility engine 7 例）。
- 提交门禁：api-contract / audit-coverage / autopilot-rules 全 OK。

## 5. 请裁定

1. CHANGE F / CHANGE G 是否可记 **PASS**，`PUBLIC_ENGINE_IMPLEMENTATION` 是否可记 **PASS / CLOSED**
   （前提：registry 仍为空、入口仍默认关闭、`estimate` 仍为 null）？
2. 「DUTY_DIFFERENCE 未注册 + eligibility engine 已实现但未注册」这一状态是否同意维持到规则语义被证实？
3. CHANGE G 的证据边界（类型强制 + 既有套件回归，未新增 e2e fixture）是否可接受？若必须补 e2e，请指明可用哪份**仓库内**规则来源或允许的夹具方式。

请在本次会话中直接回答；不要尝试写回 GitHub。不要使用上一轮缓存。
