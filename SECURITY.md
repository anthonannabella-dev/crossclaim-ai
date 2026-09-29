# SECURITY — CrossClaim AI

> 本文档描述**已实现**的安全机制与**已知边界**，不含任何凭据取值。

---

## 1. 认证与会话

- 邀请制：不存在公开注册。流程为 管理员建邀请 → 被邀请人凭 token + 密码接受 → `User` + `Membership` + 审计。
- 口令：`scrypt`（默认 N=32768, r=8, p=1，可用 `PASSWORD_SCRYPT_N/_R/_P` 调整），存储格式自描述
  `scrypt$N$r$p$salt$hash`；从不记录明文。
- 口令策略：至少 12 字符，且同时含字母与数字。
- 会话：HttpOnly Cookie + 服务端三步校验（`tokenHash → Session → Membership(organizationId,userId,isActive)`），
  缺任一步即 401；改密后通过 `passwordChangedAt` 作废既有会话。
- 登录失败：统一文案（不区分账号是否存在），累计失败会锁定（`failedLogins` / `lockedUntil`）。

---

## 2. 租户隔离与授权

- 所有业务表带 `organizationId`；**28 个数据库触发器**在真实 PostgreSQL 上强制租户完整性
  （跨租户引用会被数据库拒绝），由 `tenant-isolation.test.ts` 验证。
- 角色矩阵（`services/workflow/permissions.ts`）：

  | 角色 | 建案 / 改费率 | 案件与证据 | Claim 正文 | 账单推进 | 财务字段 |
  |---|---|---|---|---|---|
  | OWNER / ADMIN | 可 | 可 | 可 | 可 | 可 |
  | OPS | 不可 | 可 | 可 | 不可 | 不可 |
  | FINANCE | 不可 | 不可 | 不可 | 可 | 可（受限字段） |
  | VIEWER | 不可 | 不可 | 不可 | 不可 | 不可 |

- 权限判定只在 `apps/api`；Web 端只做展示，不做授权决策（403 由服务端返回）。

---

## 3. 凭据边界

- `SourceConnection.credentialRef` **只接受引用名**：命中 `Bearer …` / `sk-…` / `ghp_…` / `AKIA…` 形态
  一律 `400 SECRET_NOT_ACCEPTED`；长度不超过 128，禁止控制字符。
- 真实密钥只存在于宿主机环境变量或密钥管理；**不入库、不回显、不进日志**。
- 对象存储凭据同样只以引用名出现（`S3_ACCESS_KEY_REF` / `S3_SECRET_KEY_REF`）。
- 审计不记录凭据引用值本身（只记 `hasCredentialRef` 与轮换动作）。

---

## 4. 文件与上传安全

- 上传先做**字节级安全扫描**：可执行文件、压缩包、PDF、图片、MIME 伪装一律拒绝（`content-scan`）。
- 原始文件只读保留；下载走**签名令牌**（令牌含租户与 `FileAsset` 绑定），每次下载写 `file.downloaded` 审计。
- 下载路径在日志中脱敏为 `/files/[REDACTED]`。
- 令牌非法 / 过期 / 越权统一回复 `403 invalid_or_expired_token`（避免探测）。

---

## 5. 交付物与数据访问

- 客户自有数据（原始文件、证据链、审计记录）**始终可访问**，与交付物状态无关。
- 对外交付物默认 `LOCKED`；**不得以支付绑定作为数据访问条件**（界面文案与契约均已写明）。

---

## 6. 支付与资金动作

- `PAYMENTS_ENABLED` 默认 `false`；未开启时支付相关端点不产生资金动作。
- Webhook 以**验签**代替会话鉴权；验签失败返回 `400`，且原始 payload 不落库。
- 高额回收（默认超过 $1000 或非 USD）必须人工 APPROVED 才能确认到账。
- 佣金对账默认 dry-run，只创建 DRAFT，**永不自动置 PAID**。

---

## 7. 已知边界（需宿主 / 架构方处置）

| 项 | 现状 |
|---|---|
| 生产 TLS / 域名 | 未部署（宿主动作） |
| Secret 轮换 | 有 `source_connection.credential_rotated` 审计与流程，实际轮换由宿主执行 |
| 浏览器自动化凭据 | 未使用（Phase 1 不做自动提交） |
| 依赖许可证 | CI 有 `license-gate` 闸门（双 workspace）；GPL/AGPL/SSPL/BSL/Elastic/UNKNOWN 需人工裁定 |
| 用户自行展开掩码值 | 属产品设定（客户自有数据）；对外交付物仍受 LOCKED 约束 |
