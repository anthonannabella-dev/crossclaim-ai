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

## 8. FINAL-2 修订（消费 MSG-20261005-17 = REVISE：C1 / C2 / C3）

授权：**MSG-20261005-17**（`REVIEWED_HEAD = 436599a6`；原文 5330 字符 / 375 行 / FNV `5a40eb34` / `FULL_COPY_OK`）。
已确认 PASS（本轮不重做）：`P2C_01`（verified action only）、`P2C_02`（unregistered PREPARE fail-closed）、
`P2C_03`（top-level tenant/actor guard）、`P2C_04`（deterministic convergence）、`P2C_08`（L5 / no execution
authorization）、`P2C_09`（生产模块持久化 API 不可达）。

### 8.1 三项必修

- **CHANGE C1 —— 可信 PREPARE registry**：执行入口不再接受泛型 `RecoveryToolRegistry`。改为只接受
  `RecoveryPrepareRegistry`，且该对象必须由 `createRecoveryPrepareRegistry()` 创建（模块内
  `WeakSet` 闭包品牌 `TRUSTED_PREPARE_REGISTRIES`）；伪造对象（即使 `kind` / `proofs` 外形一致）会被
  `isTrustedPrepareRegistry()` 判否，入口返回 `UNTRUSTED_PREPARE_REGISTRY` 且**零调用**。
  边界面量：`RECOVERY_PREPARE_BOUNDARY.trustedPrepareRegistryOnly = true`。
- **CHANGE C2 —— fact → opportunity / money identity binding**：fact source 契约改为返回
  `{ opportunityRef, fact }`；调用前校验 `loaded.opportunityRef === requested opportunityRef`
  （否则 `FACT_IDENTITY_MISMATCH`）、`loaded.fact.organizationId === input.organizationId`
  （否则 `TENANT_MISMATCH:FACTS`），并做金额一致性检查（`fact.currency` 与 `fact.recoverableAmount`
  必须与当前 **verified** `OpportunitySlice.recoverable` 一致，否则 `FACT_PLAN_MISMATCH`）。
  边界面量：`factIdentityBound = true`、`factPlanMoneyBound = true`。
- **CHANGE C3 —— 完整 output + string-value 敏感扫描**：新增统一
  `validatePreparedRecoveryPackagePreview()`，由工厂工具与执行入口**共用**，检查
  `kind / opportunityRef / persisted / submitted / executionAuthorized / executorInvoked /
  packageVersion / digestVersion / packageDigest 格式与重算 / pdfDigest 格式 / pdfBytes /
  canonicalJson 与 manifest 一致 / 敏感内容`；`scanPreparedPackage()` 现在同时扫 **key 与字符串值**
  （`Bearer ...`、`X-Amz-Signature=`、`token=`、`access_token=`、`refresh_token=`、`api_key=`、`sk-...`、
  JWT 样式、IBAN 样式、13–19 位卡号样式、signed http(s) URL）。外部/任一 registry 返回的 preview
  也必须过同一 validator（违规 → `PREVIEW_VALIDATION_FAILED:...`）。
  边界面量：`sharedPreviewValidator = true`、`sensitiveValueScan = true`。

### 8.2 最小 FINAL-2 证据（4 条负例 + 既有 10 例）

| # | 裁决要求 | 证据 |
| --- | --- | --- |
| F2C-01 | 同名同形 PREPARE registry + 假 DB/network 副作用 → 不予调用（counters = 0） | `F2C-01`：伪造品牌对象 + 同名工具（每次调用自增 `dbWrites` / `networkCalls`）→ `ok=false / UNTRUSTED_PREPARE_REGISTRY`，`effects = {0,0}` |
| F2C-02 | requested `opp-A` 但 fact source 返回 `opp-B` facts → `FACT_IDENTITY_MISMATCH`、preview = null | `F2C-02` |
| F2C-03 | verified recoverable = 300 USD 但 facts = 900 USD/EUR → `FACT_PLAN_MISMATCH` | `F2C-03` |
| F2C-04 | 合法字段携带 signed URL / Bearer token → `SENSITIVE_PACKAGE_CONTENT_REJECTED` | `F2C-04`（`instructionNote` 含 `X-Amz-Signature=`、`normalizedRefs` 含 `Bearer ...` → detail 含 `SENSITIVE_CONTENT`，preview = null） |
| 保留 | P2C-01..04 / 08 / 09 全部保持 | `P2C-01` / `P2C-02` / `P2C-03` / `P2C-04` / `P2C-08` / `P2C-09` |
| 新增 | C3 validator 对越界 preview 生效 | `P2C-07`：伪造 preview（`packageDigest='not-a-digest'`、`pdfBytes=0`、`canonicalJson` 不符、`executionAuthorized=true`）→ violations 含 `DIGEST_FORMAT / PDF_DIGEST_FORMAT / PDF_BYTES_INVALID / CANONICAL_JSON_MISMATCH / EXECUTION_AUTHORIZED_FLAG` |

### 8.3 FINAL-2 验证结果

```text
api tsc --noEmit → exit 0
recovery-si-phase2-c 10/10 PASS（P2C-01..09 + F2C-01..04；含 C3 validator 负例）
回归：recovery-si-phase2-ab 19 + recovery-si 11 + recovery-si-e2e 5 + recovery-si-revise 6
      + recovery-manual-package 9 = 50/50 PASS
合计 60/60 PASS
```

边界不变：`P2_C_PERSISTENCE / P2_C_EXTERNAL_WRITE = FORBIDDEN`、`RUNTIME_WIRING = NONE`、
`SCHEMA_DELTA_REQUIRED = NO`；`P2_D = NOT_AUTHORIZED`、`P2_E = HOLD_SCHEMA_DELTA`、`P2_F = HOLD`、
`P2_G = HOLD`；未来 Option B 仍并入 `P2-E Schema/Persistence Audit`；`FINAL_ACCEPTANCE_HEAD = 0f7f7ac`。
