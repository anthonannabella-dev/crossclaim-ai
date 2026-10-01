# OAUTH_TOKEN_LIFECYCLE

## 1. 安全边界（所有平台统一）

```
Client Secret / Refresh Token / API Key / Consumer Secret
  → Secret Manager / Vault（唯一存放点）
SourceConnection
  → credential reference（永不存真实值，config 中亦不得出现）
日志 / 错误响应 / 回显 / Git
  → 永不出现真实凭据值
```

## 2. 生命周期

| 阶段 | 行为 | 证据要求 |
| --- | --- | --- |
| 授权（Authorize） | 平台官方 OAuth / 商户授权页；CrossClaim 不接触卖家密码 | 授权流程图 + 回调校验测试 |
| 存储（Store） | 写入 Secret Manager，返回 `credentialRef`；DB 只存引用 | 测试：DB/日志中不含真实值 |
| 使用（Use） | Adapter 通过 `credentialRef` 取用；只读 scope | 代码路径 + scope 断言 |
| 轮换（Rotate） | 支持主动轮换与到期前轮换；轮换过程不中断同步（双写窗口） | 轮换测试 + 审计事件 |
| 撤销（Revoke） | 平台撤销 / 客户主动撤销 → 立即停止同步并标记 `REVOKED` | 撤销测试 + 审计 |
| 断连（Disconnect / Uninstall） | 标记 `DISCONNECTED`，停止所有读取；触发数据生命周期流程 | 断连测试 + 审计 |
| 健康检查（Health） | 定期校验授权有效性；失败进入 `ERROR`/`NEEDS_REAUTH` | 健康检查测试 + 告警 |
| 审计（Audit） | 以上所有动作均落 AuditLog（动作/命令式命名） | audit-coverage 闸门 |

## 3. 各平台差异

| 平台 | 授权方式 | 备注 |
| --- | --- | --- |
| Amazon | LWA（OAuth seller authorization） | Public Developer 路线；Restricted 数据需单独评估 RDT |
| TikTok Shop | OAuth + Seller Authorization | Custom app ≠ 商业/Connector 批准 |
| Walmart | OAuth merchant authorization | Solution Provider 路线 |
| Shopify | OAuth（Public App） | 必须支持 uninstall/revoke + data deletion |
| WooCommerce | Application Authentication 或商户生成的只读 REST Key | Consumer Secret 等真实值只进 Secret Manager |

## 4. 禁止

- 保存卖家后台登录密码；使用 Cookie / 模拟登录作为生产方案；
- 把真实凭据写入 `SourceConnection.config`、业务表、日志或 Git；
- 在未获 HOST 批准前写入真实 Client Secret / Refresh Token。
