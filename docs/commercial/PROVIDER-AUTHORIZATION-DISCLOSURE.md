# Provider Authorization Disclosure（平台授权披露）

> documentKey: `provider-authorization-disclosure`。

- 未来对 Amazon / TikTok Shop / Walmart / 承运商等的接入**必须由客户主动授权**（Platform OAuth / Seller Authorization）。
- **当前不持有**任何客户的生产平台授权；平台接入状态恒为 `EXTERNAL_GATE`，不得显示为 READY。
- Platform OAuth ≠ Payment Authorization：平台授权不构成付款授权。
- 撤销：客户可撤销授权；撤销后与该连接相关的接入停止（`CONNECTION_STATUS_BLOCKED` 语义）。
