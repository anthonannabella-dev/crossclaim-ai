# CUSTOMS / DUTY RECOVERY + PROVIDER FOLLOW-UP INTELLIGENCE — 最终回报（B-S12）

授权：HOST 2026-10-06（A 部分 Provider Follow-up Intelligence P1–P10 / B 部分 Customs Duty Recovery P1–P18）
分支：`gate/7-commercial-validation`
范围：**只做只读判定 / 草稿装配 / fail-closed 门禁**；不做任何真实申报、外部写、扣款或生产启用。

---

## 1. 交付切片（每片独立 commit / test / push / checkpoint）

### A 部分 — Provider Follow-up Intelligence（P1–P10）

| Slice | 内容 | commit |
|---|---|---|
| A-S1 | Provider Submission Scheduler Core（provider-aware rate/burst/retry-after/backoff/jitter/concurrency/cooldown；durable queue、幂等、account 隔离、restart recovery、lease、exactly-once 执行权、dead-letter、UNKNOWN 禁止 blind retry） | `fe2b8205` |
| A-S2 | Amazon Support **只读** adapter（listCases/getCase/listContacts/attachment metadata） | `5d98e829` |
| A-S3 | ProviderCaseFact / ProviderContactFact（append-only）+ ProviderCaseProjection | `c6bf1674` |
| A-S4 | Case Response Intelligence（16 类分类、advisory only、prompt-injection → NEEDS_MANUAL_REVIEW） | `c115ea9a` |
| A-S5 | General Evidence Resolver（六态、tenant/account 双重过滤、CONFLICT → HITL） | `266c2dd9` |
| A-S6 | DocumentIngestionPort（STRUCTURED > PDF 原生文本 > OCR fallback；OCR ≠ Canonical Truth） | `0f319be7` |
| A-S7 | Follow-up Package（只出草稿；high-value HITL 不可绕过） | `1379fb22` |
| A-S8 | Recovery Case Lifecycle 只读投影（先审计既有事实模型；不新建状态机） | `d2f76581` |
| A-S9 | Customer UX/API projection contract（禁止单一 SUBMITTED 混淆内部准备与平台已收到） | `e6e2e6a7` |
| A-S10 | 真实 PostgreSQL 端到端 + 长期安全断言（只读链） | `18e4b18e` |

### B 部分 — Customs / Duty Recovery（P1–P18）

| Slice | 内容 | commit |
|---|---|---|
| B-S2（含 B-P1 复用） | Customs 文档分类（19 类；required 必要条件 fail-closed；9801/9802 ≠ drawback） | `3936aa0f` |
| B-S3 | CBP 7501 候选字段抽取（13 字段 + 行项目；低置信/不可规范化 → QUARANTINE） | `71035890` |
| B-S4 | OCR trust boundary + 候选 → Customs Fact 对账（五态；禁 last-write-wins） | `3c37ed14` |
| B-S5 | 通用 Evidence Resolver 接入 Customs（10 项需求 → 证据链四态） | `56c892cb` |
| B-S6 | Import ↔ Export/Return/Destruction 匹配（EXACT/PARTIAL/AMBIGUOUS/NO_MATCH + 维度一致性） | `a45c1676` |
| B-S7 | US Jurisdiction Rule Pack v1（8 类恢复候选；未核验期限一律 INDETERMINATE） | `c9f29a53` |
| B-S8 | Drawback 专门路径（fail-closed；最高只到 CLAIM_READY） | `bf31f997` |
| B-S9 | Broker/ABI/Filing readiness（15 项门槛 + POA 复用 + RFI 草稿） | `ca223828` |
| B-S10 | Claim-Ready Package vNext + Customs high-value HITL（不伪称 3PL） | `b389e00d` |
| B-S11 | Refund → Settlement → Success Fee guard 严格化（VERIFIED + CONFIRMED + RECONCILED 才 billable） | `28d66afc` |
| B-S12 | 全链 PG E2E + 长期安全断言 + 本最终回报 | `456149db` |

---

## 2. IMPLEMENTED_FILES（本程序新增/修改）

### Provider Support（A 部分 + B 部分共享）

```
apps/api/src/services/provider-support/provider-case.ts
apps/api/src/services/provider-support/amazon-support-read.ts
apps/api/src/services/provider-support/fixtures.ts
apps/api/src/services/provider-support/case-facts.ts
apps/api/src/services/provider-support/prisma-case-fact-store.ts
apps/api/src/services/provider-support/case-response-intelligence.ts
apps/api/src/services/provider-support/prisma-interpretation-store.ts
apps/api/src/services/provider-support/evidence-resolver.ts
apps/api/src/services/provider-support/prisma-evidence-source.ts      ← B-S12 补 hts / invoiceNo 抽取
apps/api/src/services/provider-support/document-types.ts
apps/api/src/services/provider-support/ocr-provider.ts
apps/api/src/services/provider-support/document-classifier.ts
apps/api/src/services/provider-support/field-extraction.ts
apps/api/src/services/provider-support/document-ingestion.ts
apps/api/src/services/provider-support/follow-up-package.ts
apps/api/src/services/provider-support/recovery-case-lifecycle.ts
apps/api/src/services/provider-support/customer-recovery-status.ts
apps/api/src/services/provider-support/customs-document-classification.ts
apps/api/src/services/provider-support/customs-7501-extraction.ts
apps/api/src/services/provider-support/customs-fact-reconciliation.ts
apps/api/src/services/provider-support/customs-evidence-requirements.ts
apps/api/src/services/provider-support/customs-import-export-matching.ts
apps/api/src/services/provider-support/index.ts
```

### Customs（B 部分）

```
apps/api/src/services/customs/rule-pack/us/us-rule-pack-v1.ts
apps/api/src/services/customs/drawback/drawback-candidate-route.ts
apps/api/src/services/customs/broker-filing-readiness.ts
apps/api/src/services/customs/claim-ready-package-vnext.ts
apps/api/src/services/customs/customs-success-fee-guard.ts
```

### 复用的既有实现（未重写、未复制）

* `services/customs/enterprise-ior/remedy-deadline.ts`（期限引擎，policy-driven、无全球 3–5 年硬编码）
* `services/customs/enterprise-ior/broker-poa.ts`（CBP Form 5291 语义；4811 不得当 POA）
* `services/customs/customs-claim-ready-package.ts`（确定性 claim-ready 装配器）
* `services/customs/customs-refund-settlement-linkage.ts` + `services/commercial/fee-policy.ts`（fee guard）
* `services/recovery-rules/recovery-rule-definition.ts`（规则版本化契约与 opaque 引用约束）

---

## 3. SCHEMA_DELTA / MIGRATIONS

| 项目 | 结果 |
|---|---|
| Prisma schema 变更（本程序 A-S6 / A-S7 / A-S8 / A-S9 / A-S10 / B-S2…B-S12） | **无** |
| 新增 migration | **无** |
| 新增表 / 枚举 | **无**（B-S7 规则包复用既有 remedy 词表；B-S9 复用既有 POA 判定） |
| A 部分早期切片的迁移（A-S1/A-S3/A-S4 各自新增 tenant-owned 表） | `20261006150000_provider_submission_scheduler` / `20261006160000_provider_case_facts` / `20261006170000_provider_case_interpretation`（均已在本程序早期 slice 应用并 push） |

> 说明：A-S5 及之后、以及整个 B 部分（P1–P18）均为**只读投影 / 纯函数判定 / 草稿装配**，
> 未引入新的持久化模型，符合「先审计既有事实模型、不新建重复状态机」的要求。

---

## 4. TEST_COUNTS（本地 `apps/api`）

| 套件 | 用例数 |
|---|---|
| `provider-submission-scheduler` / `-db` | 14 / 12 |
| `amazon-support-read` | 14 |
| `provider-case-facts` / `-db` | 8 / 7 |
| `provider-response-intelligence` / `-db` | 8 / 5 |
| `evidence-resolver` / `-db` | 14 / 4 |
| `document-ingestion`（A-S6/B-S1） | 31 |
| `follow-up-package`（A-S7） | 25 |
| `recovery-case-lifecycle`（A-S8） | 31 |
| `customer-recovery-status`（A-S9） | 26 |
| `provider-followup-e2e-db`（A-S10） | 13 |
| `customs-document-classification`（B-S2） | 28 |
| `customs-7501-extraction`（B-S3） | 17 |
| `customs-fact-reconciliation`（B-S4） | 19 |
| `customs-evidence-requirements`（B-S5） | 16 |
| `customs-import-export-matching`（B-S6） | 18 |
| `us-rule-pack-v1`（B-S7） | 18 |
| `drawback-candidate-route`（B-S8） | 16 |
| `broker-filing-readiness`（B-S9） | 16 |
| `claim-ready-package-vnext`（B-S10） | 16 |
| `customs-success-fee-guard`（B-S11） | 18 |
| `customs-duty-recovery-chain-e2e-db`（B-S12） | 9 |
| `architecture-contract`（既有，持续回归） | 157 |

全量回归（`npx vitest run`）：**435 文件 / 4344 tests → 4343 passed + 1 failed**。
唯一失败仍为既有 isolation debt：`recovery-si-phase2-e-db` P2E-DB5（**单独运行 20/20 PASS**，
与本程序改动无关，历史切片亦为同一失败）。

`tsc --noEmit`：**exit 0**（每个 slice 均验证）。
GitHub Actions：**NOT_OBSERVED**（本地证据为准，不声称 CI 绿）。

---

## 5. 硬边界核对表（均为 false / HOLD / 未解锁）

| 边界 | 状态 |
|---|---|
| `PLATFORM_WRITE_TRANSPORT_ENABLED` | **false** |
| REAL PLATFORM WRITE / BROKER · ABI · CBP WRITE | **HOLD**（无 adapter、无端口、无 transport） |
| PRODUCTION CREDENTIALS / PRODUCTION_ENABLEMENT | **HOLD / ABSENT**（所有产物声明 `productionCredentials: 'ABSENT'`） |
| REAL_MODEL_NETWORK / PAID_MODEL_CALLS | **HOLD**（LLM/OCR 一律端口注入；默认实现 fail-closed） |
| 收费 OCR | **未接入**（仅 `OcrProviderPort` + mock fixture） |
| PAYMENT / 自动扣佣 / AUTO_PAYMENT | **HOLD**（fee guard 仅判定资格，`autoChargePerformed=false`、`paymentCollectionPerformed=false`） |
| TRANSPORT / EXTERNAL_WRITE | **false**（无外发出口；Notification 不发） |
| SECOND_RUNTIME / SECOND_POLICY_ENGINE / SECOND_CONTROL_PLANE / SECOND_MODEL_GATEWAY / SECOND_COST_LEDGER / SECOND_META_EVIDENCE_STORE | **FORBIDDEN（未创建）** |
| L5_RELAXATION | **FORBIDDEN（未放宽）** |
| Seller Center 用户名 / 密码 / Cookie / Session | **不保存**；CAPTCHA/MFA **不绕过**；Browser Automation **不作为生产 fallback** |
| OCR / LLM 直接写 Canonical Truth 或决定 eligibility | **禁止**（多处 fail-closed 断言：`assertOcrCandidateNotCanonical`、`assertCandidateIsNotCustomsTruth`、`assertClassificationIsNotCustomsTruth`、`assertRulePackDoesNotDecideOrFile`、`assertReconciliationDidNotWriteTruth`） |

---

## 6. 关键安全不变量（长期断言，均有测试覆盖）

1. **OCR ≠ Customs Truth**：OCR 候选置信硬上限 9900、`OCR_ONLY` 永不并入结论、冲突禁 last-write-wins、OCR 不得破平局。
2. **内部准备 ≠ 平台已收到**：`READY_INTERNAL` 与 `SENT` 是两个状态；平台受理必须有 PROVIDER_VERIFIED/AUTHORITY_VERIFIED。
3. **匹配 ≠ 权利**：`EXACT/PARTIAL/AMBIGUOUS/NO_MATCH` 只描述一致性；AMBIGUOUS 绝不自动择优。
4. **规则包 ≠ 结论**：US 规则包 v1 的期限政策全部 UNVERIFIED → 对外一律 INDETERMINATE；只有法务核验政策才可能放行。
5. **Drawback 最高只到 CLAIM_READY**：无 FILED/SUBMITTED；9801 / 9802 不是 drawback；不计算可退金额。
6. **就绪度 15 门槛缺一不可**：POA 复用需 VERIFIED + 覆盖 remedy + 辖区一致 + 未过期；RFI 只出草稿，不真实 respond。
7. **High-value HITL 不可绕过**：> USD 1000 → OWNER，≥ USD 10000 → ADMIN；REVIEWER 不能替代。
8. **成功费只在 verified actual incremental recovered 上产生**：来源必须 VERIFIED、结算必须 CONFIRMED、对账必须 RECONCILED；争议/冲正需冲回；同一 settlement 只计一次。
9. **不伪称 3PL 对账已完成**：输入声称即 fail-closed，包内字段恒为未发生。
10. **租户/账户隔离**：证据、匹配、就绪度、客户视图全部在查询层与决策层双重过滤。

---

## 7. FINAL_VERDICT

| 项 | 结论 |
|---|---|
| A 部分（Provider Follow-up P1–P10） | **COMPLETE / PUSHED** |
| B 部分（Customs Duty Recovery P1–P18） | **COMPLETE / PUSHED** |
| SCHEMA_DELTA | **NONE**（B 部分全为只读/纯函数；A 部分早期 3 个迁移已应用） |
| MIGRATIONS | **NONE（本程序 B 部分）/ 3（A 部分早期，已应用）** |
| tsc | **PASS** |
| 全量回归 | **4343 / 4344 PASS**（唯一失败为既有 isolation debt `recovery-si-phase2-e-db` P2E-DB5，单独运行通过） |
| GitHub CI | **NOT_OBSERVED** |
| PRODUCTION_READY | **NO** —— 生产启用相关能力全部 HOLD，需 HOST 另行授权 |
| MODEL_GATEWAY_RUNTIME_WIRED / ACTION_RUNTIME_PRODUCTION_ENABLED / META_IMPROVEMENT_INTEGRATED | **未声明为 TRUE**（无真实 E2E 证据） |
| FINAL_NEXT_REQUIRED | **YES**（如需推进 UK/EU Rule Pack、真实 provider 写入或生产启用，均须 HOST 授权） |

**仍处于 HOLD（需 HOST 授权才能继续）**：真实平台/报关行写、真实 ABI/CBP 申报、生产凭据、
收费 OCR、模型联网调用、支付与自动扣佣、生产启用。

