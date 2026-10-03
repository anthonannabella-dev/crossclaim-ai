# SHOPIFY_SCOPE_MATRIX（Shopify · V1 READ-ONLY · Public App 方向）

> 商业模式为多商户 SaaS，因此按 **Public App / merchant authorization** 设计；**不要把单店 Custom App 当最终架构**。
> ⚠️ Shopify **Protected Customer Data** 必须分层处理：不能因为「Order 对象里面有」就默认全部读取。

| API resource | scope | business purpose | protected customer data? | direct identifier? | read/write | required for MVP? | retention | storage | redaction support | review required? | decision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Orders（订单事实） | `read_orders` | Recovery 必需事实（金额/时间/状态/退款关联） | 可能（若含客户字段） | **V1 不取**（不申请姓名/地址/电话/邮箱） | READ | YES | 见 `PRIVACY_DATA_LIFECYCLE.md` | CanonicalFact + Evidence 引用 | YES（写入 CanonicalFact 前剥离直接标识） | YES（App Review） | ACCEPT（**字段级最小化**） |
| Refunds / Returns | `read_returns`（以现行 scope 为准） | Recovery detection / reconciliation | 最小化 | NO | READ | YES | 同上 | 同上 | YES | YES | ACCEPT |
| Transactions / Payments（官方权限允许范围内） | 依现行 scope | payment-related facts | 最小化 | NO | READ | YES | 同上 | 同上 | YES | YES | ACCEPT |
| Fulfillment / Logistics | `read_fulfillments`（以现行 scope 为准） | 物流追回 | 最小化 | NO | READ | YES | 同上 | 同上 | YES | YES | ACCEPT |
| Fees / Settlement 相关输入 | 以现行 API 为准 | Fee discrepancy | NO | NO | READ | YES | 同上 | 同上 | YES | YES | ACCEPT |
| Chargeback / dispute 事实 | 若需对应支付提供方 API → **拆 PSP Adapter** | Chargeback recovery | 最小化 | NO | READ | LATER | 同上 | 同上 | YES | 视 PSP | LATER（PSP 独立处理） |
| Customer 直接标识（name/address/phone/email） | 不申请 | 与 Recovery 无直接关系 | **YES（Protected）** | YES | READ | NO | —— | —— | —— | —— | **REJECT（V1）** |
| 任何 write scope（products/orders/inventory 写） | 不申请 | 与追回无关（V1） | —— | —— | WRITE | NO | —— | —— | —— | —— | **REJECT（V1）** |

## App Review 需要准备

HTTPS production app · OAuth/authentication · Privacy Policy · Terms · Emergency/security contact · App description · test/demo flow · **uninstall/revoke handling** · data deletion/privacy handling · OWASP / web security 证据 · encryption in transit · secure token handling · only required network services exposed。

## V1 结论

**Shopify V1 可以避免直接身份类 Protected Customer Fields**：追回链路依赖订单/退款/履约/费用事实即可；直接标识字段一律不申请（若未来确需，按 Protected Customer Data 分层与 App Review 要求单独评估）。
