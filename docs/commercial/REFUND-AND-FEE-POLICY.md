# Refund / Fee Policy（退款与费用政策）

> documentKey: `refund-and-fee-policy`。

- **区分四个口径**：estimated recovery（估计）／actual recovered（实际追回）／fee basis（计费基数）／fee collected（已收取）。
- **成功费**：仅在**确认到账**且完成对账后计算；费率、计税口径（含税/不含税）与冲正后费用调整规则随本政策版本披露。
- **计费基数**：只取自已确认到账的 Settlement / RecoveryLedgerEntry；不取自平台 approved 状态或申请金额。
- **当前状态**：`Payment = 0`、`collection = OFF` —— **不自动扣款**、无 checkout、无 subscription billing。
- **冲正**：发生 reversal / correction 时按新事实重算，不沿用旧金额。
