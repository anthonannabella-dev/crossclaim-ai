# P2-3 SECRET ROTATION DESIGN（设计 + 实现交付，v1）

> ⚠️ **SUPERSEDED（历史归档）** —— 自 2026-10-08 起，CrossClaim 唯一正式部署入口为仓库根目录 `DEPLOYMENT.md`
> （配合 `deploy/release-manifest.json` 与 `node deploy/verify-release.mjs` 门禁）。
> 本文仅作历史记录保留，**不得作为部署流程依据**；内容冲突时以 `DEPLOYMENT.md` + manifest 为准。
> 归档索引：`docs/archive/DEPLOYMENT-HISTORY.md`


> 依据架构方 **MSG-20260929-72**（`P2-3 SECRET ROTATION` = GO，范围冻结）。
> **性质**：Design + Implementation（**不执行任何真实轮换**）；真实轮换 = **HOST APPROVAL REQUIRED**。

---

## 1. Secret 清单（仅名称；架构方冻结范围）

权威定义（代码）：`apps/api/src/services/operations/secret-rotation-audit.ts :: SECRET_INVENTORY`
计划工具（只读）：`tools/secrets/secret-rotation-plan.mjs`

| Secret（仅名称） | 轮换类别 | 重叠窗口 | 影响面 |
|---|---|---|---|
| `DATABASE_URL` | stop-and-start | 0（滚动重启） | 数据库连接短暂不可用 |
| `SESSION_SECRET` | overlap | 60 min | 会话令牌派生（既有会话失效，需公告） |
| `AUDIT_IP_SALT` | overlap | 0 | 审计 IP 哈希（历史哈希不重算） |
| `STORAGE_URL_SECRET` | overlap | 30 min | 签名下载令牌（窗口内旧链接仍可验证） |
| `STRIPE_WEBHOOK_SECRET` | overlap | 30 min | Webhook 验签（窗口内双密钥） |
| `SOURCE_CONNECTION_CREDENTIAL_REF` | reference-only | — | 连接凭据**引用名**（真实值在外部密钥管理） |
| `OAUTH_CLIENT_CREDENTIAL_REF` | reference-only | — | 未来 OAuth 凭据引用（占位，接入需另批） |

> 仓库中**只存引用名**；任何 Secret 取值不进仓库、不进日志、不进审计。

## 2. 轮换流程（架构方冻结顺序）

```text
prepare（登记变更单：谁 / 何时 / 哪一项 Secret 名称）
   ↓
generate（在密钥管理中生成新值）
   ↓
overlap-window（双值可接受；窗口 = 相关 TTL + 余量）
   ↓
switch（应用读取新值；滚动重启最小化停机）
   ↓
verify（登录 / 导入 / 签名下载 / webhook 冒烟各一次）
   ↓
revoke-old（验证通过后再撤销旧值）
   ↓
audit（secret.rotated）
```

## 3. 回滚（必须覆盖"新值无效"）

```text
detect-invalid-new-secret（验证失败 / 错误率上升）
   ↓
restore-old-secret（立即回退旧值）
   ↓
verify（再次冒烟）
   ↓
audit-failure（secret.rotated，result=ROLLED_BACK/FAILED）
```

**不允许**出现"回滚了但没有审计记录"。

## 4. 审计（`secret.rotated`）

| 项 | 规定 |
|---|---|
| 动作名 | `secret.rotated` |
| 允许字段 | `secretName` / `actorUserId` / `timestamp` / `result` / `changeRequestId` |
| `result` 取值 | `SUCCESS` / `FAILED` / `ROLLED_BACK` |
| **禁止字段** | secret 取值、hash、prefix、suffix、length、`oldSecret`、`newSecret`、`secretMaterial`（实现会在**构造事件时**拒绝，错误只报字段名） |
| 语义 | 属 **security operation audit**；平台级 Secret 只写结构化安全日志，**只有**租户作用域轮换（如 `credentialRef`）在显式提供 `organizationId` 时才写 AuditLog |
| 读取 secret | **不产生任何审计** |

实现：`buildSecretRotationEvent`（白名单 + 拒绝取值类字段）、`recordSecretRotation`（安全日志 + 可选租户审计）。

## 5. 工具（只读）

```bash
node tools/secrets/secret-rotation-plan.mjs                # 列出全部 Secret 与流程/回滚/审计要求
node tools/secrets/secret-rotation-plan.mjs DATABASE_URL   # 单项计划
node tools/secrets/secret-rotation-plan.mjs --execute      # 一律拒绝（exit 2，提示 HOST APPROVAL REQUIRED）
```

工具**不读取任何环境变量/取值**（测试中有静态断言）。

## 6. 权限与边界（本阶段）

| 项 | 状态 |
|---|---|
| 真实 Secret 轮换 | **HOST APPROVAL REQUIRED**（本阶段禁止执行） |
| 生产环境操作 / 云平台账号操作 | ❌ 禁止 |
| OAuth 真凭证接入 / 第三方平台连接 | ❌ 禁止 |
| 生产部署 / DNS / TLS | ❌ 不在本阶段 |
| Action Guard / 业务阻断 | ❌ 继续 HOLD |
| Production Enablement | **HOLD** |

## 7. 验收

| # | 项 | 证据 |
|---|---|---|
| 1 | 清单只含名称与元数据、无取值样式 | `secret-rotation.test.ts :: 01`（静态断言 + 逐项 key 白名单） |
| 2 | 流程与回滚顺序冻结 | `:: 02` |
| 3 | 事件只含五个允许字段 | `:: 03` |
| 4 | 取值类字段一律拒绝且错误不泄漏取值 | `:: 04`（8 种取值/派生字段逐个断言） |
| 5 | 未知字段被拒绝（白名单封闭） | `:: 05` |
| 6 | 必填字段缺失/非法被拒绝 | `:: 06` |
| 7 | 平台级轮换只写安全日志（不写租户 AuditLog） | `:: 07` |
| 8 | 租户作用域才写 AuditLog，且写入内容无取值 | `:: 08` |
| 9 | 计划工具存在、拒绝 `--execute`、不读取 env | `:: 09` |

## 8. 后续（Final Production Gate 前）

1. 真实轮换演练（宿主执行，含 overlap 窗口与回滚演练）→ 产出演练报告；
2. 把 `secret.rotated` 纳入运维手册（OPERATIONS.md）与安全事件族；
3. 与 P2-4（真实数据验证）并行推进。
