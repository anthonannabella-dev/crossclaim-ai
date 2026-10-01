# Success Fee 支付授权分离 与 Onboarding / 自动收费契约（R13）

> 依据：**HOST DIRECTIVE 2026-10-02（补充二）**。
> 状态：**长期产品规则** —— 现在只登记到 roadmap / architecture / product contract；
> **不打断** 当前 R45 → R46 执行队列。实际 `PaymentMethod` / `Mandate` / autopay enablement
> 在 **R46 Settlement/Billing linkage 完成后**，作为**独立 Payment Activation Gate** 实施、测试与审计。
> 机器可读镜像：`.autopilot/rules.json` → `payment_authorization_separation`；
> 与 `docs/releases/SUCCESS-FEE-BILLING-REDLINE.md`（R12：可计费判定与禁止清单）配套生效。

---

## 1. 两条授权链必须严格分离

| 授权类型 | 用途 | **不得**推导出的能力 |
| --- | --- | --- |
| **Platform OAuth / Seller Authorization**（Amazon SP-API / TikTok Shop / Walmart / Shopify …） | 平台数据与 API 能力（只读优先） | 不得视为成功费扣款授权；不得依赖平台卖家余额直接扣取 CrossClaim 佣金；不得推导出支付授权 |
| **CrossClaim Payment Authorization**（PaymentMandate / PaymentMethod） | 由客户**直接向 CrossClaim** 授权的成功费收取 | 不得用于平台数据访问 |

> 任何平台若存在独立 App Billing 机制，也必须作为**独立 Billing Authorization** 处理；**不得**从 OAuth 权限推导。

---

## 2. Onboarding 收费体验（冻结）

```
注册
→ 平台授权（Platform OAuth / Seller Authorization）
→ 免费扫描 / 发现 Recovery Opportunity
→ 客户点击「开始追回」
→ 接受 Success Fee 条款
→ 设置付款方式 / 签署有效 Payment Mandate
→ 进入正式追回执行
```

- **免费扫描阶段不得强制绑卡**（不得以绑卡作为查看 Recovery Opportunity 的前置条件）。
- 未完成「开始追回 → 条款 → Payment Mandate」之前，系统**不得**进入正式追回执行，也不得产生任何扣款动作。

---

## 3. 自动收费链路（唯一允许路径）

```
FULLY_RECONCILED
→ Settlement confirmed / received
→ RecoveryLedger
→ FeeCalculation
→ BillingInvoice
→ 已存在有效 Payment Authorization / PaymentMethod / Mandate
→ Payment Provider 自动收取成功费
```

- **没有有效 Payment Authorization 时**：只生成 `BillingInvoice` / Payment Request，**不得自动扣款**。
- 链路前置档位复用 R12 的可计费判定（`Settlement = RECEIVED` + `CONFIRMED` + `RECONCILED/PARTIAL` + 证据可追溯 + 未被冲回 + 费率来自既有 `FeeCalculation`）；
  `FULLY_RECONCILED` **不是**可计费充分条件，仍必须经过 Settlement 确认到账与账本事实。

---

## 4. 不保存支付敏感数据（PCI 边界）

CrossClaim **不保存**：PAN / card number / CVV / 网银密码。

只允许保存支付服务商返回的引用与状态：`Customer ID` / `PaymentMethod ID` / `Mandate ID` / `authorization status`（以及 provider、scope、有效/撤销时间等元数据）。

- 任何日志、审计、错误信息、数据库字段**不得**出现 PAN/CVV；
- 银行卡输入必须发生在支付服务商侧（hosted field / SDK），CrossClaim 不接触原始卡数据。

---

## 5. 不可逆的授权升级禁令

1. **平台账号授权永远不能自动升级为支付授权。**
2. 平台侧授权撤销 ≠ 支付授权撤销，反之亦然；两者生命周期各自独立登记。
3. 支付授权必须可**单独撤销**，撤销后立即停止自动扣款（仅保留账单事实）。
4. 任何「为了简化流程」而把 OAuth scope 当成扣款依据的实现，视为 **fail-closed 缺陷**。

---

## 6. 与既有 Gate 的关系（现在只登记，不实施）

| 项 | 当前状态 |
| --- | --- |
| R45（Outcome / Reimbursement Reconciliation） | 继续执行（S3 主体 CLOSED → S4 受保护动作） |
| R46（Settlement / Billing linkage） | 队列不变；完成后才进入本契约的实施 |
| PaymentMethod / Mandate / autopay enablement | **独立 Payment Activation Gate · HOLD**（需：客户明确预授权 + 支付通道正式验收 + 架构方与宿主书面放行；生产凭据 HOST APPROVAL REQUIRED） |
| 生产支付接入 / 真实扣款 | **HOLD** |

本契约 **不改变** 任何已 PASS 底座（Tenant Isolation / RBAC / HITL / Action Guard / Ledger / CAS / Row Lock / 幂等 / reconcile），不重新规划队列，不重复审计。

---

## 7. 状态字段（涉及支付/计费时输出）

```
PLATFORM_OAUTH_AS_PAYMENT_AUTHORIZATION = NEVER（恒为 NEVER；出现即缺陷）
PAYMENT_AUTHORIZATION_PRESENT = YES / NO / N-A
AUTOPAY_ENABLED = HOLD（直到 Payment Activation Gate 放行）
PAYMENT_MANDATE_REF_ONLY = YES（只保存 provider 引用，不保存 PAN/CVV）
ONBOARDING_FREE_SCAN_CARD_REQUIRED = NO（免费扫描阶段不得强制绑卡）
```
