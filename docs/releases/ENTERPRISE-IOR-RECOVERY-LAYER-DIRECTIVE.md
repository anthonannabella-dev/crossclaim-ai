# ENTERPRISE IOR RECOVERY LAYER — HOST DIRECTIVE + 增量实现登记

- 时间：2026-10-03T15:45:08.544Z（HOST DIRECTIVE，基于当前仓库增量推进）
- 原则：**不重做** Customs G4 / C15–C21 / P0 Survival Gates；在其上增加 Enterprise IOR 层；以**最小 Schema Delta + 复用现有组件**实现。

## 一、指令要点（11 节）

| # | 要求 | 本轮状态 |
|---|---|---|
| ① | IOR / Claimant Identity：server-side verified identity；禁止客户端自报 truth；禁止裸存 EIN / importer number / 银行 / credential | **契约层 DONE**（`services/customs/enterprise-ior/ior-identity.ts`，8/8 测试之一组） |
| ② | Recovery Right Lineage：Entry → IOR → claimant → right → remedy → filing authorization；不明确 → IOR_RIGHTS_UNCLEAR / CLAIMANT_RIGHTS_UNCLEAR → NEEDS_MANUAL / BROKER_REVIEW | **契约层 DONE**（`right-lineage.ts`） |
| ③ | Broker POA：按 CBP Form **5291** 或 equivalent；**不得**用 4811 作 Broker POA；Platform OAuth ≠ Broker POA ≠ Payment Authorization | **契约层 DONE**（`broker-poa.ts`；4811 作为 Broker POA → WRONG_AUTHORIZATION_TYPE） |
| ④ | Remedy Taxonomy + Deadline Engine：versioned policy，按 jurisdiction+remedy 计算；缺关键日期 → INDETERMINATE，不调用昂贵 provider、不 filing；禁止全局 3–5 年规则 | **契约层 DONE**（`remedy-deadline.ts`） |
| ⑤ | Evidence Taxonomy：7501 / 28 / 29 / ACE / broker record / duty payment / return / export / destruction / ruling / exclusion / POA / refund evidence；safe-reference + digest | **契约层 DONE**（`evidence-taxonomy.ts`，13 类） |
| ⑥ | Enterprise IOR Qualification：复用现有 Qualification Gate，新增 IOR readiness 输入（不建第二套引擎） | PENDING（下一增量接线） |
| ⑦ | Refund Destination Readiness：只读抽象；不代收；不存银行原文；APPROVED ≠ PAID；estimated ≠ fee basis | **契约层 DONE**（`refund-destination.ts`） |
| ⑧ | Commercial Policy：保持 15%，不改为 15–30%；CrossClaim fee 与 Broker fee 独立 | 不变（既有 FeePolicy） |
| ⑨ | 真实外部能力（C18 first real filing/broker/ABI）继续 HOLD_EXTERNAL / HOST APPROVAL REQUIRED | 保持 |
| ⑩ | 暂不新增 VAT/GST（仅登记 future backlog） | 已登记（不在当前主线） |
| ⑪ | 验收：全链 fail-closed；任何 IOR/claimant/right/deadline/POA/provider capability 不明确 → 不得自动提交；filingSubmitted=false / externalWritePerformed=false / transportEnabled=false / Payment=0 / collection=OFF / productionCredentials=ABSENT | 契约层已验证；持久化与接线待做 |

## 二、本轮已交付（契约层，commit 见 RUN_LOG）

| 模块 | 路径 | 关键 fail-closed 语义 |
|---|---|---|
| IOR identity | `apps/api/src/services/customs/enterprise-ior/ior-identity.ts` | 客户端自报 → CLIENT_REPORTED_TRUTH；裸敏感值 → RAW_SENSITIVE_VALUE；UNVERIFIED/REVOKED/过期 → 不可用 |
| Right lineage | `right-lineage.ts` | 证据缺 → unclear-rights → BROKER_REVIEW；未验证 IOR → NEEDS_MANUAL；`autoFilingAllowed` 恒 false |
| Broker POA | `broker-poa.ts` | 4811 作 Broker POA → WRONG_AUTHORIZATION_TYPE；缺证据/过期/未验证 → 不可用 |
| Remedy deadline | `remedy-deadline.ts` | 无 policy 或缺 anchor → INDETERMINATE 且不调用昂贵 provider |
| Evidence taxonomy | `evidence-taxonomy.ts` | 未知类型 / 不安全引用 / 非法 digest → 抛错 |
| Refund destination | `refund-destination.ts` | 裸银行账号 → RAW_BANK_ACCOUNT_NOT_ALLOWED；不代收、APPROVED≠PAID、estimated≠fee basis |

测试：`apps/api/src/__tests__/enterprise-ior-layer.test.ts`（8/8 PASS）。

## 三、下一增量（保持自治）

1. **I1 持久化**：IOR identity / right lineage / broker POA 事实的 append-only 持久化（需 **Schema Delta 送架构方审计**）。
2. **I2 资格接线**：把 IOR readiness 输入接入现有 Recovery Qualification / Economics Gate（不建第二套引擎）。
3. **I3 全链组装**：Entry → verified IOR → verified claimant/right → remedy+deadline → qualification → evidence → estimate → claim-ready → broker authorization readiness → filing-provider readiness → refund destination readiness（fail-closed，零外写）。
