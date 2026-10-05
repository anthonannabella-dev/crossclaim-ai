# Recovery SI P2-C（Option A）实施证据 —— 确定性内存包预览

- 分支：`gate/7-commercial-validation`
- 授权：**MSG-20261005-16 = PASS WITH REVISE**（`REVIEWED_HEAD = 565b9813`；原文 5083 字符 / 315 行 / FNV `fee1c080` / `FULL_COPY_OK`，已逐字归档）
- 授权范围：`P2_C_V1 = AUTHORIZED_WITH_CONDITIONS`、`P2_C_OPTION = A`、`P2_C_PERSISTENCE = FORBIDDEN`、`P2_C_EXTERNAL_WRITE = FORBIDDEN`
- 本轮交付：**只做确定性内存包生成**；未进入 P2-D / P2-E / P2-F / P2-G

## 1. 交付物

| 文件 | 作用 |
| --- | --- |
| `apps/api/src/services/intelligence/recovery-package-preview.ts` | P2-C Option A：静态 domain→PREPARE 绑定 + 逐 domain PREPARE 工具 + 入口内重新 verify + 确定性内存包预览 |
| `apps/api/src/__tests__/recovery-si-phase2-c.test.ts` | P2C-01..09 验收（6 例） |

复用的既有**纯函数**（不新增第二套实现）：

```text
services/recovery/recovery-package.ts
  buildRecoveryManifest()
  serializeCanonicalManifest()
  computePackageDigest()
  renderManifestPdf()      （内存 Buffer）
  sha256Hex()
```

## 2. 固定调用路径（到此停止）

```text
verified PREPARE action（入口内部重新 prioritizeOpportunities + verifyRecoveryPlan）
  → 静态 domain→PREPARE 绑定（recovery.package_preview.prepare / carrier / customs / independent_site）
  → registry access = PREPARE 校验
  → tenant 三角校验（input.organizationId === ctx.organizationId === actorOrganizationId）
  → 注入的 fact source 读取 tenant-scoped persisted facts（本模块不读库）
  → buildRecoveryManifest()
  → serializeCanonicalManifest()（canonical JSON）
  → computePackageDigest()
  → renderManifestPdf()（optional in-memory PDF）+ pdfDigest
  → 返回 PreparedRecoveryPackagePreview
```

返回对象显式携带：`kind = 'RECOVERY_PACKAGE_PREVIEW'`、`persisted = false`、`submitted = false`、
`executionAuthorized = false`、`executorInvoked = false`；**不命名成数据库实体** `RecoveryPackage`。

## 3. 明确禁止（本模块**未 import、未调用**）

```text
generateRecoveryPackage()
persistPackageArtifacts()
transitionRecoveryPackage()
claim.prepare 的 DB mutation 路径
prisma.*            （本模块不引用 @prisma/client）
FileAsset / AuditLog / RecoveryPackage 写路径
```

## 4. 最小验收证据（MSG-20261005-16 规定的 P2C-01..09）

| # | 要求 | 证据（`recovery-si-phase2-c.test.ts`） |
| --- | --- | --- |
| P2C-01 | 只有 verified PREPARE action 才触发（篡改/陈旧 → 零调用） | `P2C-01`：2 个机会 → 2 次调用；把 `opp-customs` 的 `expectedRecovery` 篡改后，入口内重新 verify → 该机会零调用、fact 只多加载 1 次 |
| P2C-02 | 未登记 PREPARE → fail-closed | `P2C-02`：注册表剔除 `recovery.carrier.package_preview.prepare` → 零调用、零 fact 读取 |
| P2C-03 | 跨租户 / actor 错配 | `P2C-03`：伪造跨租户 state → `ok=false / TENANT_MISMATCH`、零调用；actor 错配 → 每次调用以 `TENANT_MISMATCH` fail-closed、零 fact 读取 |
| P2C-04 | **DETERMINISTIC_CONVERGENCE**（同输入 → 同 digest；DB 写入 0） | `P2C-04`：顺序两次 + `Promise.all` 并发两次 → 4 次结果的 `packageDigest` 与 `pdfDigest` 各自唯一 |
| P2C-05 | 禁止业务写入 = 0 | `P2C-05/P2C-06/P2C-09`：源码扫描无 `prisma.*` / 无 `@prisma/client` / 无 claim.prepare 路径；边界常量 `databasePersistence / recoveryPackageDbCreate / fileAssetCreate / claimDraftDbMutation / auditLogWrite = false` |
| P2C-06 | network / provider / credential = 0 | 同上：源码无 `fetch(` / `node:http(s)` / `axios` / `process.env` / 凭据读取；边界 `networkCalls = 0`、`credentialReads = 0`；四个工具安全证明 `NETWORK=false / CREDENTIAL_READ=false` |
| P2C-07 | 输出 schema / 身份 / 敏感边界 | `P2C-07`：facts 属于其它租户 → `TENANT_MISMATCH:FACTS`；miswired 工具返回别的 `opportunityRef` 或 `executionAuthorized=true` → `PREVIEW_IDENTITY_OR_AUTHORIZATION_INVALID`；`scanPreparedPackage` 命中 `signedUrl` / `storageKey` 即拒绝 |
| P2C-08 | L5 拒绝 + 无执行许可 | `P2C-01/P2C-08`：`decideRecoveryExecutionRequest('CUSTOMS_FILING').permanentlyForbidden = true`、`allowedForRsi = false`；预览的 `executionAuthorized / executorInvoked = false`；`ownerApprovalRequired = false` 但不放宽 RBAC |
| P2C-09 | 持久化 API 从 P2-C 不可达 | `P2C-09`：三个禁用 API 既不在 import 列表内，也无任何调用点（只扫描去注释后的代码） |

## 5. 敏感与数据边界

```text
P2_C_CUSTOMER_FACTS_INTERNAL = ALLOWED   （claimItemId / caseId / normalizedRefs / evidenceId / 金额）
P2_C_TO_RSI_OUTCOME_SIGNAL   = FORBIDDEN
P2_C_TO_MODEL_NETWORK        = FORBIDDEN
P2_C_OWNER_APPROVAL_REQUIRED = NO
```

仍禁 credential / token / raw provider payload / storage key / signed URL / bank·card secrets。

## 6. 本轮验证结果

```text
api tsc --noEmit → exit 0
recovery-si-phase2-c 6/6 PASS
回归：recovery-si-phase2-ab 19 + recovery-si 11 + recovery-si-e2e 5 + recovery-si-revise 6
合计 47/47 PASS
```

## 7. 未做（等待各自授权）

- `P2-D Action Guard dry-run`：`NOT_AUTHORIZED`（P2-C 通过不得自动进入）；
- `P2-E 持久化 / Schema Delta`：`HOLD_SCHEMA_DELTA`（含未来 Option B 的 `RecoveryPackage` 落库、`AuditLog`、`FileAsset`、supersede/withdraw 生命周期）；
- `P2-F 模型`、`P2-G 真实执行`：`HOLD`；
- `RSI_OUTCOME_SINK_RUNTIME_WIRING`：`NOT_AUTHORIZED`；
- `RUNTIME_WIRING = NONE`（本轮不接 route / event loop / `rsi:run`）。

边界不变：`EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS / REAL_CLAIM_SUBMIT / CUSTOMS_FILING / RSI_MODEL_NETWORK / RSI_PAID_MODEL_CALLS = HOLD`；`SECOND_RUNTIME / L5_RELAXATION = FORBIDDEN`；`FINAL_ACCEPTANCE_HEAD = 0f7f7ac`。
