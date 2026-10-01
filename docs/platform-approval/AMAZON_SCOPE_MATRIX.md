# AMAZON_SCOPE_MATRIX（Amazon SP-API · V1 READ-ONLY）

> 目标形态：CrossClaim 作为服务多卖家的 **Public Developer Application**（LWA / OAuth seller authorization）。
> V1 原则：**尽最大可能不申请 Restricted PII**；不为「以后也许能用」申请任何 role。

| scope / role | business purpose | required? | PII involved? | restricted? | read/write | retention | storage | risk | approval dependency | decision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Selling Partner Insights / Finances（financial + settlement 读取） | 追回检测与对账（settlement reconciliation / fee discrepancy） | YES | NO | NO（需确认现行 role 表） | READ | 见 `PRIVACY_DATA_LIFECYCLE.md`（按事实保留，超期删除/匿名化） | CanonicalFact + EvidenceArtifact 引用 | MEDIUM | Developer App 审核 + 数据用途说明 | ACCEPT |
| Reimbursements（FBA reimbursement 事实） | Recovery detection（核心） | YES | NO | NO | READ | 同上 | 同上 | MEDIUM | 同上 | ACCEPT |
| FBA Inventory / FBA Inventory Summary | 物流追回与库存差异 | YES | NO | NO | READ | 同上 | 同上 | LOW | 同上 | ACCEPT |
| Orders（不含 buyer PII 的订单事实） | 关联 reimbursement / fee 与案件 | YES | **V1 仅取 order id / 时间 / 金额 / 状态** | NO（受限字段不取） | READ | 同上 | 同上 | MEDIUM | 同上 | ACCEPT（**不请求 buyer name/address/phone/email**） |
| Reports（settlement / reimbursement reports） | 批量对账（推荐主路径） | YES | NO | NO | READ | 报文按保留策略 | 文件 + 行级 provenance | MEDIUM | 同上 | ACCEPT |
| Fees / Fee Preview | Fee discrepancy | YES | NO | NO | READ | 同上 | 同上 | LOW | 同上 | ACCEPT |
| Restricted PII（buyer name/address/phone/email） | 与 Recovery detection / reconciliation 无直接关系 | **NO** | YES | **YES（Restricted）** | READ（若申请） | —— | —— | HIGH | 需单独业务证据 + 安全材料 | **REJECT（V1）**；仅当出现不可替代业务需求时另行评估 Restricted Data Token |
| Any WRITE scope（claims / listings / inventory / pricing） | —— | NO | —— | 依 scope | WRITE | —— | —— | HIGH | 需 Architecture + HOST 批准 | **REJECT（V1；对外提交继续 HOLD）** |

## V1 结论

- **Amazon V1 可以避免 Restricted PII**：追回检测与对账链路（Finances / Reimbursements / FBA / Fees / Reports / 订单**非 PII**事实）已足以支撑主要 Recovery Detection。
- 若未来确需受限数据，必须：单独业务证据 → 架构方裁决 → 安全材料补充 → HOST 批准后再申请（并评估 Restricted Data Token）。
- Seller 授权与撤销、Token 安全存储与轮换见 `OAUTH_TOKEN_LIFECYCLE.md`。

## 当前缺口（Amazon）

1. Developer App 注册与数据用途说明（**HOST**）；
2. 生产 HTTPS/域名 + Secret Manager（**HOST**）；
3. 安全控制证据（IR / 保留删除 / 监控告警）——Codex 可起草，证据需在实施后产生；
4. Adapter 实施（TRACK A 完成后再进入实施批次）。
