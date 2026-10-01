# TIKTOK_SCOPE_MATRIX（TikTok Shop · V1 READ-ONLY）

> 正式路线：**Official API + Seller Authorization + Least Privilege**。禁止把模拟登录 TikTok Seller Center 作为生产主方案。
> ⚠️ **Custom / development app 可运行 ≠ 已获得多商户商业/Connector 接入批准**：两者必须在申请材料中区分。

| scope / resource | business purpose | required? | PII involved? | restricted? | read/write | retention | storage | risk | approval dependency | decision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Order（订单事实，最小字段） | Recovery 检测与关联 | YES | 最小化（默认不含 buyer 身份字段） | 按平台定义 | READ | 见 `PRIVACY_DATA_LIFECYCLE.md` | CanonicalFact + Evidence 引用 | MEDIUM | 商业/Connector 审核 + Seller 授权 | ACCEPT |
| Return / Refund（退货退款事实） | Recovery detection / reconciliation | YES | 最小化 | 按平台定义 | READ | 同上 | 同上 | MEDIUM | 同上 | ACCEPT |
| Settlement / Finance（结算与费用事实） | Fee discrepancy / settlement reconciliation | YES | NO | 按平台定义 | READ | 同上 | 同上 | MEDIUM | 同上 | ACCEPT |
| Logistics / Fulfillment | 物流追回 | YES | NO | 按平台定义 | READ | 同上 | 同上 | LOW | 同上 | ACCEPT |
| Dispute / Chargeback（如提供） | Chargeback recovery | TBD | 最小化 | 按平台定义 | READ | 同上 | 同上 | MEDIUM | 同上（可能需 PSP Adapter） | LATER（先确认 API 边界） |
| Buyer 身份字段（姓名/地址/电话/邮箱） | 与 Recovery 无直接关系 | NO | YES | 平台定义 | READ | —— | —— | HIGH | 需单独证据 | **REJECT（V1）** |
| 任何 WRITE scope | —— | NO | —— | —— | WRITE | —— | —— | HIGH | HOST + 架构批准 | **REJECT（V1）** |

## 需要提前准备的申请材料

公司主体资料 · 官网 · Product description · Privacy Policy · Terms of Service · 数据用途说明 · 数据流说明（`DATA_FLOW_DIAGRAM.md`）· Seller authorization flow（`OAUTH_TOKEN_LIFECYCLE.md`）· Scope matrix（本文件）· Demo account · Security controls（`SECURITY_CONTROLS_EVIDENCE.md`）· Data retention / deletion（`PRIVACY_DATA_LIFECYCLE.md`）· Incident Response（`INCIDENT_RESPONSE_PLAN.md`）· **TPRM / 数据安全问卷所需材料** · 平台要求的数据安全协议签署。

## 必须能向平台证明的四点

1. Seller explicitly authorizes CrossClaim；
2. CrossClaim only requests the data required to perform recovery services；
3. CrossClaim does not collect seller passwords；
4. Credentials/tokens are not stored in normal application tables；且 CrossClaim does not perform unauthorized platform writes。
