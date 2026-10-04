# [SEO → ARCHITECT] 公开 Checker 真实 engine 与输入 schema 设计送审

## 0. 背景与现状（可复核）

- 公开只读入口已接线但**默认关闭**（`PUBLIC_SEO_CHECKER_ENABLED=false`），端口组合层已落地：
  `apps/api/src/services/seo/seo-public-ports.ts`（engine registry **默认空**）。
- 因此当前行为是：`listRegisteredBasisKeys()` 返回空 → indexability gate 保守判 noindex；
  `runEligibility` 返回 `ENGINE_UNAVAILABLE`、`runCalculation` 返回 `estimate: null` —— **fail-closed，绝不编造金额**。
- 规则侧已有的契约（`RecoveryRuleDefinition v1`）：`eligibilityMethod = { kind: 'DECISION_TABLE', basisKey: 'engine:customs-drawback-eligibility' }`、
  `calculationMethod = { kind: 'DUTY_DIFFERENCE', basisKey: 'engine:customs-duty-difference' }`、
  `filingDeadline = { kind: 'STATUTORY', days, sourceReferenceId }`、`eligibility = { requiresIorIdentity, requiresAuthorizedSigner, requiresBrokerPoa, requiresFilingAuthorization, minimumEvidenceCount }`。
- 缺口：registry 里没有任何**真实 engine**，也没有与规则字段对应的**公开输入 schema**。
  这两者共同定义「公开 Checker 允许问什么、据此如何判定」——属于公开面语义，故先送审再实现。

## 1. 提案（最小、可审计）

### 1.1 公开输入 schema（无 PII、无租户数据）

仅允许与规则字段一一对应的布尔/整数回答，**不含**任何标识信息：

| key | 类型 | 含义 | 对应规则字段 |
| --- | --- | --- | --- |
| `hasIorIdentity` | boolean | 是否具备 IOR 身份 | `eligibility.requiresIorIdentity` |
| `hasAuthorizedSigner` | boolean | 是否有授权签字人 | `eligibility.requiresAuthorizedSigner` |
| `hasBrokerPoa` | boolean | 是否有 Broker POA | `eligibility.requiresBrokerPoa` |
| `hasFilingAuthorization` | boolean | 是否有申报授权 | `eligibility.requiresFilingAuthorization` |
| `evidenceCount` | integer ≥ 0 | 现有证据条目数 | `eligibility.minimumEvidenceCount` |

### 1.2 eligibility engine（DECISION_TABLE）

- 纯函数：`(rule.eligibility, answers) → { eligible, reasonCodes }`。
- **缺任何一个必填答案 → 不猜**：返回 `INVALID_REQUEST`（由 handler 映射 400）。
- `evidenceCount >= minimumEvidenceCount` 作为**纯计数**判定（不引入任何"成功率/追回率"）。reasonCodes 用稳定 token，例如 `MISSING_IOR_IDENTITY` / `INSUFFICIENT_EVIDENCE`。

### 1.3 calculation engine（DUTY_DIFFERENCE）

- 输入仅允许用户**自报**的两个金额 + 币种：`dutyPaidAmount`（number ≥ 0）、`refundableAmount`（number ≥ 0）、`currency`（`^[A-Z]{3}$`）。
- 输出：`estimate = { min, max, currency }`，其中 **min = max = max(0, min(dutyPaidAmount, refundableAmount))**；
  若该值 ≤ 0 → `estimate: null`（不给估算，而不是给 0 或负）。
- 强制 `disclaimerKey = 'seo.disclaimer.estimateOnly'`（页面已按此渲染"估算"标注）。
- **明确不做**：不推算追回率、不给案例金额、不引用规则外的法规或截止日（截止日只来自 `rule.filingDeadline`）。

## 2. 请裁定

1. 上述 5 个公开输入 key 与类型是否可接受？是否需要增删？
2. `evidenceCount >= minimumEvidenceCount` 这类**纯计数**判定是否可以（不引入任何统计/概率）？
3. DUTY_DIFFERENCE 用「min(max(dutyPaid, refundable), ...) = max(0, min(...))」且**min = max** 是否可以，
   还是必须给出区间（若是，区间应如何由用户自报数据推导）？
4. 是否需要为 `DUTY_DIFFERENCE` 单独做一次实现复核（implementation audit）？
5. 实现后可注册进 registry，并**仍只在 DEV/STAGING 显式开启**；生产公开仍 `HOLD` —— 请确认。

## 3. 边界（不变，本轮零代码改动）

- 公开入口仍**默认关闭**；未注册 engine 仍 fail-closed；不产出任何编造金额。
- `EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS / PRODUCTION_PUBLIC_CHECKER = HOLD`；`TRANSPORT=false`。
- 页面仍 default NOINDEX（gate 未变）；web 侧候选 canonical 仍是 `/{locale}/recover/{slug}`。

请在本次会话中直接回答；不要尝试写回 GitHub。不要使用上一轮缓存。
