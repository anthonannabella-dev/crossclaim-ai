# BG-019 — GOLDEN PATH CRITICAL-STATE READ SURFACE（四域）CHECKPOINT

- 依据：**MSG-20261003-139 CHANGE E**（前端 COVERED = 「有真实 backend 数据源，并能在 UI 中观察该域 Golden Path 的关键状态与 fail-closed 状态」）
- 分支 `gate/7-commercial-validation`；REVIEWED_HEAD `fb37b85`
- 边界不变：External Write=HOLD · Real Money=HOLD · Customer Submission=HOLD · Production Credentials=HOST_ONLY

## 1. 四域只读关键状态面

| 域 | 只读面 | 可见关键状态 | 真实数据源 |
|---|---|---|---|
| Customs | `/integration-status?entryFactId=` / `?opportunityId=` | filing status、return→claim evidence、entry fact + 四类 latest 投影（BG-020 端点） | `/customs-opportunities/:id/filing-status`、`/customs-entry-facts/:id/return-claim-evidence`、`/customs-entry-facts/:id` |
| Carrier | `/integration-status?packageId=` | carrier response 读模型（currentStatus / verificationLevel / history / hasProviderVerifiedFact） | `/carrier-claim-packages/:id/responses` |
| Platform | `/platform-recovery-state?caseId=`（本轮新增） | opportunity → claim-ready 包就绪 → 提交状态（claimSubmitted / providerWrite）→ recovered / fee / billing 真值；显式 `External submission: NOT ENABLED / NEEDS_MANUAL` | `/cases/:id`、`/cases/:id/claim-package`、`/recovery-money?caseId=` |
| Independent-site | `/integration-status?disputeReference=`（本轮新增） | 五状态分开呈现 submitted / won / settled / recovered / billable；响应 disposition、到账 verification + evidenceArtifactRef、recoveredAmount、15% feeAmount、invoiceDraft；显式 `notPersisted` | `/independent-site-disputes/:ref/state`（BG-021 事实层） |

## 2. fail-closed 状态可见性

- Customs：`boundary.filingSubmitted=false` / `transportEnabled=false` 直接显示；读取不重算。
- Carrier：`hasProviderVerifiedFact=false` 时显示「无 provider 验证事实」。
- Platform：顶部琥珀色横幅固定显示 `External submission: NOT ENABLED / NEEDS_MANUAL`。
- Independent-site：`WON` 不等到账、`UNVERIFIED` 不计入 recovered，UI 文案显式声明。

## 3. 诚实披露（未伪造）

1. Platform qualification 细分字段不在该读模型中：页面显示 opportunity 状态并标注「以 Qualification Gate 持久化判定为准，本页不重算」。
2. Independent-site 的 qualification / evidence / claim-ready 未持久化（PS04 Phase 1 为进程内链）：读模型以 `notPersisted` 显式返回，UI 原样展示。
3. 未为满足 UI 验收新增任何写路由；`platform.write` 仍为 NEEDS_MANUAL、TRANSPORT=false。

## 4. 证据

- `independent-site-state-read.test.ts` → 6/6 真实 PostgreSQL（WON≠到账、UNVERIFIED≠recovered、五状态分离、与 chargeback-recovery-flow 同源一致、RBAC 403 / 400 / 404 / 跨租户 404）。
- Layer 2 Golden Path Matrix：四域 0 缺口。
- `API_CONTRACT_OK`（implemented=92 / documented=79）；api + web tsc 均 EXIT=0。

## 5. 请裁定

四域 frontend cell 是否可判 COVERED（Platform / Independent-site 由 partial 转 CLOSED）？若仍有缺口，请指出具体域与状态。
