# WALMART_SCOPE_MATRIX（Walmart Marketplace · V1 READ-ONLY）

> 目标形态：**Solution Provider / 多商户商业 SaaS**（非单商户自用集成）。

| scope / resource | business purpose | required? | PII involved? | restricted? | read/write | retention | storage | risk | approval dependency | decision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Orders（订单事实，最小字段） | Recovery detection / 关联 | YES | 最小化（默认不含客户身份字段） | 按平台定义 | READ | 见 `PRIVACY_DATA_LIFECYCLE.md` | CanonicalFact + Evidence 引用 | MEDIUM | Solution Provider 审核 + merchant authorization | ACCEPT |
| Returns / Refunds | Recovery detection / reconciliation | YES | 最小化 | 按平台定义 | READ | 同上 | 同上 | MEDIUM | 同上 | ACCEPT |
| Settlement / Payments（费用与结算事实） | Fee discrepancy / settlement reconciliation | YES | NO | 按平台定义 | READ | 同上 | 同上 | MEDIUM | 同上 | ACCEPT |
| Performance / Reimbursement（若提供） | Recovery detection | TBD | NO | 按平台定义 | READ | 同上 | 同上 | LOW | 同上 | LATER（以现行 API 为准） |
| Listing management | 与追回无关 | NO | —— | —— | WRITE | —— | —— | MEDIUM | —— | **REJECT** |
| Price / Inventory write | 与追回无关 | NO | —— | —— | WRITE | —— | —— | HIGH | —— | **REJECT** |
| Order mutation | 与追回无关（V1） | NO | —— | —— | WRITE | —— | —— | HIGH | HOST + 架构批准 | **REJECT（V1）** |

## 需要提前准备（Solution Provider 路线）

- Solution Provider application materials（公司资料 / 业务说明 / 官网 / 隐私条款）；
- Sandbox 账号与环境（**HOST**）；
- OAuth merchant authorization 设计 + least-privilege scopes；
- Demo App / integration description（说明 CrossClaim 的服务范围与数据用途）；
- Security controls / Data handling / Privacy / Token lifecycle / Revocation / Production validation 材料（对应本目录其余文件）。
