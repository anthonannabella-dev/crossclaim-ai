# CUSTOMS EXECUTION — SCHEMA DELTA / BOUNDARY AUDIT REQUEST（C17 + C21 + FEE GUARD WIRING）

状态：**READY_FOR_REVIEW（设计/授权请求，未实施）**
前序：MSG-20261003-123 ⑧ 授权 Customs C1+/C15–C21 内部开发；契约层已交付 C15（`a992d2f`）、C16/C19/C21（`db5c378`）、C19 ingest + C20（`c5dedaf`）。
边界：**NO platform write · TRANSPORT=false · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · 无生产凭据 · 真实 filing = HOLD_EXTERNAL**。

## 1. 请求一 — C17 `CustomsSubmissionAttempt` Schema Delta

目的：把「同一 claim / package / filing operation 至多一次真实 filing」的幂等真值落到数据库（retry / timeout / worker concurrency 均不得重复申报）。

拟新增 Prisma 模型（append-only / tenant-scoped / idempotent，复刻 `platform.write` 与 Queue #9B/#10 FINAL 已验证模式）：

```text
CustomsSubmissionAttempt {
  id                  String   @id              // attemptId（确定性哈希或 uuid）
  organizationId      String
  opportunityId       String
  caseId              String?                  // 真实 lineage（存在则 FK）
  claimItemId         String?                  // 真实 lineage（存在则 FK）
  packageId           String
  packageDigest       String                   // sha256
  provider            String
  operation           String                   // FILING_CREATE / DOCUMENT_UPLOAD / RFI_RESPOND ...
  jurisdiction        String
  remedyType          String
  idempotencyKey      String
  providerSubmissionId String?
  submissionStatus    String                   // ATTEMPTED / UNKNOWN_PROVIDER_RESPONSE / RECONCILING / SUBMITTED / FAILED_CONFIRMED / MANUAL_REVIEW
  submittedAt         DateTime?
  recordedAt          DateTime
  createdAt           DateTime @default(now())
}
```

约束与守卫（拟）：

- `UNIQUE(organizationId, provider, operation, idempotencyKey)`（并发收敛核心）。
- CHECK：`submissionStatus` 属上述枚举；`submissionStatus ∈ {SUBMITTED} → providerSubmissionId IS NOT NULL`；`packageDigest ~ ^[0-9a-f]{64}$`。
- append-only 触发器（UPDATE / DELETE 拒绝）；状态变化走新事实/受控 supersede，不覆盖历史。
- tenant guard 沿用 `cc_tenant_*` + `cc_tenant_immutable__CustomsSubmissionAttempt`（不新造隔离机制）。
- 可判定语义（与 `platform.write` 账本一致）：ambiguous provider response → `UNKNOWN_PROVIDER_RESPONSE` + 退避对账（1/5/15/60min，24h → `MANUAL_REVIEW`），**不得盲重试**。
- 不存 credential / raw payload / 客户 PII 明文。

## 2. 请求二 — C21 HTTP 路由 + Action Guard / 权限模型

拟新增路由：`POST /customs-opportunities/:id/start-recovery`

- client 只能提供 `opportunityId`（route param）与必要确认字段；`recoverableAmount / classification / eligibility / ruleVersion / IOR / claimant / broker / packageDigest / feeRate / filingRoute / deadline` 一律不得由 client 提供（C21 契约层已 fail-closed）。
- Action Guard 动作 `customs.recovery.start`（**INTERNAL_WRITE**，不是 EXTERNAL_WRITE；不启用 TRANSPORT）。
- capability `customs.recovery.start`；RBAC：OWNER / ADMIN / OPS 允许，FINANCE / VIEWER / 未知拒绝。
- 响应：`READY_TO_FILE` + immutable submission snapshot（server-derived）；否则稳定拒绝码（`EVIDENCE_INCOMPLETE` / `NOT_ELIGIBLE` / `AMOUNT_NOT_READY` / `REMEDY_ROUTE_MISSING` / `DEADLINE_PASSED` / `PACKAGE_NOT_READY` / `AUTHORIZATION_NOT_READY`(+C16 blockers) / `FILING_CAPABILITY_MISSING`）。
- **本路由在 C17 账本落地前不执行任何 filing**：仅生成 snapshot 与 route 决策（`filingSubmitted=false`）；真实申报仍需 C18 provider + 宿主授权。
- 读模型 GET `/customs-opportunities/:id/filing-status`（tenant-scoped；返回 C19 projection；不含 credential）。

## 3. 请求三 — Commercial fee guard 接入既有 FeeCalculation 创建路径

- 把 C10–C11 的 `evaluateFeeGuard` 接入既有创建路径（`record-fee.ts` / `commission-reconciliation.ts` / 未来所有路径），使「client 提供费率」「estimate basis 计费」「无 verified recovered truth」在三处以上路径全部 fail-closed。
- 默认 FeePolicy 由 20% → **15%**（HOST DIRECTIVE 2026-10-03）：请裁决落地方式（新增 versioned 策略记录 + 明确旧策略 effectiveTo，或数据迁移脚本）。
- 继续保持：`Payment = 0` / `collection = OFF` / `autopay = OFF` / 不扣款 / 不收款。

## 4. 明确不做 / 仍需宿主授权

- 不做：真实 customs filing / authority submission、真实 broker/provider 接入（C18）、生产凭据、真实客户 entry/duty/IOR 数据、真实资金链路（refund 对接、Settlement 实盘、15% 实际扣费）。
- 以上属 `HOLD_EXTERNAL` / `HOST APPROVAL REQUIRED`，不在本请求范围内。

## 5. 请裁决（编号裁决 PASS / REVISE / BLOCK）

① 是否批准 C17 `CustomsSubmissionAttempt` Schema Delta（字段 / 唯一约束 / CHECK / append-only / tenant guard / ambiguous-response 语义）；② 是否批准 C21 HTTP 路由 + `customs.recovery.start` Action Guard 与权限矩阵（在 C17 落地前不执行 filing）；③ 是否批准把 fee guard 接入既有 FeeCalculation 路径并把默认 FeePolicy 定为 15%（含落地方式）。
