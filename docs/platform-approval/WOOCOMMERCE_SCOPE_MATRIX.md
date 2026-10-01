# WOOCOMMERCE_SCOPE_MATRIX（WooCommerce · V1 READ-ONLY）

> WooCommerce 不走 Amazon 式中心化 Marketplace 审批：优先使用**官方 WooCommerce REST API**，按商户授权（Application Authentication）或商户生成的**只读 REST API Key** 接入。
> 默认 scope = **READ**；**不要**默认开放 `write` / `read_write`。

| API resource | business purpose | required? | PII involved? | read/write | retention | storage | risk | decision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Orders（最小字段） | Recovery 检测与关联 | YES | 最小化（不含客户身份字段） | READ | 见 `PRIVACY_DATA_LIFECYCLE.md` | CanonicalFact + Evidence 引用 | MEDIUM | ACCEPT |
| Refunds / Returns | Recovery detection / reconciliation | YES | 最小化 | READ | 同上 | 同上 | MEDIUM | ACCEPT |
| Products（仅关联所需标识） | 关联退款/费用上下文 | TBD | NO | READ | 同上 | 同上 | LOW | LATER（仅在确需时） |
| Reports（如可用） | 批量对账 | TBD | NO | READ | 同上 | 同上 | LOW | LATER |
| Customers（身份字段） | 与 Recovery 无直接关系 | NO | YES | READ | —— | —— | HIGH | **REJECT（V1）** |
| 任何写权限 | 与追回无关（V1） | NO | —— | WRITE | —— | —— | HIGH | **REJECT（V1）** |

## 正式接入模式

```
Merchant → CrossClaim connection page
  → WooCommerce Application Authentication / merchant authorization
  → merchant grants READ access
  → CrossClaim receives API credential
  → Secret Manager（CredentialRef）
  → WooCommerce Adapter
```

或（确有需要时）使用商户主动生成的**只读 REST API Key**。

**禁止**要求商户提供：WordPress 管理员密码 · FTP 密码 · Hosting 密码 · 数据库密码。

## 凭据与连接生命周期（必须实现）

- 凭据值**不得**写入普通业务数据库、不得出现在 `SourceConnection.config`、不得记录日志、不得回显、不得提交 Git；一律进入 **Secret Manager / Vault**，业务表只保留 **credential reference**。
- 必须支持：`revoke` · `reconnect` · `rotate` · `connection health` · `last sync` · `error state` · `audit` · `rate/retry control`。
- 必须 HTTPS。
