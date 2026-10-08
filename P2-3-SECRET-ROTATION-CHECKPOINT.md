# P2-3 SECRET ROTATION CHECKPOINT

> ⚠️ **SUPERSEDED（历史归档）** —— 自 2026-10-08 起，CrossClaim 唯一正式部署入口为仓库根目录 `DEPLOYMENT.md`
> （配合 `deploy/release-manifest.json` 与 `node deploy/verify-release.mjs` 门禁）。
> 本文仅作历史记录保留，**不得作为部署流程依据**；内容冲突时以 `DEPLOYMENT.md` + manifest 为准。
> 归档索引：`docs/archive/DEPLOYMENT-HISTORY.md`


> 类型：**IMPLEMENTATION CHECKPOINT（P2-3，Design + Implementation）**
> 依据：**MSG-20260929-72**（`P2-3 SECRET ROTATION` = GO，范围冻结）
> 分支：`gate/7-commercial-validation` @ **113cd9b**；main = `1e21219`
> 边界：**未执行任何真实轮换/生产操作/云账号操作/OAuth 真凭证接入**；真实轮换 = **HOST APPROVAL REQUIRED**

---

## 1. 交付物

| 文件 | 内容 |
|---|---|
| `apps/api/src/services/operations/secret-rotation-audit.ts` | `secret.rotated` 审计（白名单 + 拒绝取值类字段）、`recordSecretRotation`（安全日志 + 可选租户 AuditLog）、`SECRET_INVENTORY`（仅名称）、`SECRET_ROTATION_FLOW`、`SECRET_ROTATION_ROLLBACK` |
| `tools/secrets/secret-rotation-plan.mjs` | 只读计划工具（清单/流程/回滚/审计要求）；`--execute` **一律拒绝**（exit 2，提示 HOST APPROVAL REQUIRED）；**不读取任何 env/取值** |
| `apps/api/src/__tests__/secret-rotation.test.ts` | 9 项用例（清单无取值、流程/回滚冻结、事件白名单、取值字段拒绝且不泄漏、未知字段拒绝、必填校验、平台级不写 AuditLog、租户作用域写且无取值、工具拒绝执行） |
| `P2-3-SECRET-ROTATION-DESIGN.md` | 设计 + 运行手册（清单/流程/回滚/审计/边界/验收） |

commit：**113cd9b**

## 2. 对照架构方冻结范围

| 冻结要求 | 实现 |
|---|---|
| Secret inventory（仅名称） | ✅ `SECRET_INVENTORY`：`DATABASE_URL` / `SESSION_SECRET` / `AUDIT_IP_SALT` / `STORAGE_URL_SECRET` / `STRIPE_WEBHOOK_SECRET` / `SOURCE_CONNECTION_CREDENTIAL_REF` / `OAUTH_CLIENT_CREDENTIAL_REF`（全部 `hostApprovalRequired: true`） |
| Rotation flow：prepare→generate→overlap→switch→verify→revoke old→audit | ✅ `SECRET_ROTATION_FLOW`（用例 02 冻结顺序） |
| Audit：`secret.rotated` 仅记 `secretName`/`actor`/`timestamp`/`result`/`changeRequestId`；禁止 value/hash/prefix/suffix | ✅ `buildSecretRotationEvent` 白名单；用例 03/04/05（8 种取值/派生字段逐个拒绝，错误不回显取值） |
| Rollback：新值无效 → 回退旧值 → 验证 → 审计（不允许无审计） | ✅ `SECRET_ROTATION_ROLLBACK`；`result` 支持 `ROLLED_BACK`（用例 02/08） |
| 本阶段禁止：真实轮换 / 生产操作 / 云账号 / OAuth 真凭证 / 第三方连接 | ✅ 工具 `--execute` 拒绝；未接触任何真实凭据；未改 Schema；未接业务动作 |
| Platform vs 租户作用域 | ✅ 平台级只写结构化安全日志；仅当显式提供 `organizationId`（如 `credentialRef`）才写 AuditLog（用例 07/08） |

## 3. 测试与 CI

| 项 | 结果 |
|---|---|
| P2-3 单元用例 | 9/9 PASS（`secret-rotation.test.ts`） |
| 全量（CI） | **114 files / 1084 tests 全绿** |
| API contract | `API_CONTRACT_OK`（未新增端点） |
| Audit coverage | `AUDIT_COVERAGE_OK`（`secret.rotated` 出现在代码动作清单；已登记于设计稿与运维手册族） |
| **CI（HEAD `113cd9b`，run `36612472498`）** | **五作业全部 SUCCESS**：API（迁移 + typecheck + 114 files / 1084 tests）/ Web（build）/ 许可证闸门 / Deploy smoke（fresh install + upgrade）/ Backup restore verify（synthetic） |
| 计划工具行为 | `node tools/secrets/secret-rotation-plan.mjs` 打印清单；`--execute` → exit 2 + `HOST APPROVAL REQUIRED` |

## 4. 边界确认

- ❌ 未执行真实 Secret 轮换；未操作生产/云平台/OAuth/第三方
- ✅ 仓库与日志中无任何 Secret 取值（`secret.rotated` 白名单在构造期拒绝取值类字段）
- ✅ 未改 Schema、未接 Action Guard、未阻断任何业务、`Production Enablement` 仍 HOLD
- ⚠ 真实轮换演练（含 overlap 窗口与回滚）**必须由宿主执行**，属 HOST APPROVAL REQUIRED

## 5. 待裁决

- **Q1**：`34d1d47` / `113cd9b`（含本报告提交）是否批准 fast-forward 合并到 `main`？
- **Q2**：下一步是否进入 **P2-4 Production Validation Runbook**（按 MSG-70 D5 修订门槛：Stage A `input = normalized + quarantine + rejected`、Stage B `Candidate >= 10` 且 `Candidate != Claim`、Stage C `human verification >= 5` 分类 TRUE/FALSE/NEEDS DATA；真实数据仍 **WAITING_HOST_DATA**）？
