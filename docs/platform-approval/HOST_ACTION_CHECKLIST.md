# HOST_ACTION_CHECKLIST（必须由宿主执行）

> 未经 HOST APPROVAL，Codex 不得执行下列任何动作。

## 1. 账号与申请（每平台）

- [ ] Amazon：注册/升级为 **Public Developer**，提交 Developer App 审核与数据用途说明
- [ ] TikTok Shop：确认**商业/Connector 路线**，提交公司主体资料与 TPRM 问卷
- [ ] Walmart：提交 **Solution Provider** 申请 + Sandbox 开通
- [ ] Shopify：创建 **Public App**（生产 HTTPS），提交 App Review
- [ ] WooCommerce：无平台审核（自助），但需确认是否使用 Application Authentication

## 2. 生产基础设施

- [ ] Production domain / DNS（含备案等法务事项）
- [ ] Production HTTPS / TLS 证书
- [ ] Production Secret Manager / Vault 实例（凭据唯一存放点）
- [ ] Encryption at rest（数据库/对象存储）
- [ ] Production / test 环境分离与 least-privilege 生产凭据
- [ ] 监控与告警通道（邮件/IM）接入

## 3. 法务与合规材料

- [ ] Privacy Policy / Terms of Service 法务确认（官网可访问）
- [ ] 第三方处理商列表与 DPA（含云、DB、对象存储、监控、邮件）
- [ ] Data retention / deletion 政策对外版本
- [ ] Emergency / Security contact（对外）
- [ ] 如平台要求：数据安全协议 / 数据处理协议签署

## 4. 生产凭据（严格 HOLD）

- [ ] 真实 Client Secret / Refresh Token / API Key 写入 Secret Manager（**不得**写入代码/仓库）
- [ ] 平台侧角色最小化（与 `*_SCOPE_MATRIX.md` 一致，READ-ONLY）
- [ ] 授权撤销 / 断连演练

## 5. 仍保持 HOLD（本阶段不得开启）

REAL EXTERNAL WRITE · Claim/Appeal 对外自动提交 · Production Enablement · 真实资金操作 · 客户真实提交 · Settlement/Billing linkage · Amazon write transport · TRANSPORT=false。
