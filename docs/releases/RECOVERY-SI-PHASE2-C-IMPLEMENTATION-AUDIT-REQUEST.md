> **[HISTORICAL_SNAPSHOT]** 本文是历史审计 / 证据快照，原文保留不改写（历史裁决不删除）。
> 其中关于 `RUNTIME_WIRING` / `STEP_3_RUNTIME_POLICY_WIRING` / `RSI_OUTCOME_SINK_RUNTIME_WIRING`
> 的**当时状态**已被后续实现取代：SUPERSEDED_BY=c0b61792（STEP_3_RUNTIME_POLICY_WIRING：
> Recovery SI 作为 domain capability pack 接入 ONE CrossClaim SI Runtime；后续 FINAL-2..6 与 PHASE 2
> 见 ca23b1df / adcab905 / ca298187 / 5f9ce46f / 6e98e66e）。
> 唯一**现行**状态请以 `docs/releases/CURRENT-SI-RSI-STATUS.md` 为准
> （SUPERSEDED_BY=cdd95258 为该状态件的基线 HEAD）。

# Recovery SI P2-C（Option A）Implementation Audit —— 送审请求

- 分支：`gate/7-commercial-validation`
- **REVIEWED_HEAD = `436599a6`**（P2-C Option A 实现提交；本轮全部代码与测试在该 SHA 上）
- 前置：**MSG-20261005-16 = PASS WITH REVISE**（`REVIEWED_HEAD = 565b9813`；FNV `fee1c080` / 315 行 / `FULL_COPY_OK`），其中 `P2_C_OPTION = A` 已批准、`P2_C_PERSISTENCE / P2_C_EXTERNAL_WRITE = FORBIDDEN`，并要求「完成后送 P2-C Implementation Audit；不得调用现有任何 RecoveryPackage 持久化 API，也不得顺带进入 P2-D」。
- 耐久记录：`docs/releases/RECOVERY-SI-PHASE2-C-EVIDENCE.md`

## 1. scope（本轮只做确定性内存包）

| 项 | 内容 |
| --- | --- |
| 新增模块 | `apps/api/src/services/intelligence/recovery-package-preview.ts` |
| 复用纯函数 | `buildRecoveryManifest()` / `serializeCanonicalManifest()` / `computePackageDigest()` / `renderManifestPdf()`（内存 Buffer）/ `sha256Hex()` |
| 固定路径 | verified PREPARE action → 静态 domain→PREPARE 绑定 → registry `access = PREPARE` → tenant 三角校验 → 注入的 fact source（tenant-scoped persisted facts）→ manifest → canonical JSON → packageDigest → in-memory PDF + pdfDigest → `PreparedRecoveryPackagePreview` |
| 返回标记 | `persisted = false`、`submitted = false`、`executionAuthorized = false`、`executorInvoked = false`；对象名不是数据库实体 |

## 2. invariant

- **零落库**：不 import `@prisma/client`；不调用 `generateRecoveryPackage()` / `persistPackageArtifacts()` / `transitionRecoveryPackage()`；不写 `RecoveryPackage` / `FileAsset` / `AuditLog`；不做 claim draft mutation；
- **零外写 / 零 submission / 零资金**：无 provider 调用、无网络、无凭据读取；
- **tenant**：`input.organizationId === ctx.organizationId === actorOrganizationId` 在任何 fact 读取之前校验；fact 自身租户不符 → fail-closed；
- **入口内重新 verify**：沿用 `CHANGE_B1`（`prioritizeOpportunities()` + `verifyRecoveryPlan()`），不接受外部 verification 快照；
- **确定性收敛**：同输入 → 同 canonical manifest → 同 `packageDigest` → 同 `pdfDigest`（不要求并发唯一赢家）；
- **敏感边界**：包内允许租户内部事实；`P2_C_TO_RSI_OUTCOME_SIGNAL = FORBIDDEN`、`P2_C_TO_MODEL_NETWORK = FORBIDDEN`；credential / token / raw provider payload / storage key / signed URL 一律拒绝；
- **权限**：`P2_C_OWNER_APPROVAL_REQUIRED = NO`（纯计算），但既有 RBAC / tenant / fresh facts 不放宽；`READY_FOR_EXECUTION` 仍非执行许可；
- 不建第二套 Runtime；`L5` 不放宽；`RUNTIME_WIRING = NONE`。

## 3. 最小证据（MSG-20261005-16 规定的 P2C-01..09）

| # | 要求 | 证据 |
| --- | --- | --- |
| P2C-01 | verified action only | 2 个机会 → 2 次调用；篡改 `expectedRecovery` 后入口内重新 verify → 该机会零调用、fact 只多加载 1 次 |
| P2C-02 | unregistered PREPARE fail-closed | 注册表剔除 domain 工具 → 零调用、零 fact 读取 |
| P2C-03 | tenant / actor mismatch | 伪造跨租户 state → `TENANT_MISMATCH` 零调用；actor 错配 → 每次调用 fail-closed、零 fact 读取 |
| P2C-04 | deterministic convergence | 顺序 2 次 + `Promise.all` 并发 2 次 → 4 次结果 `packageDigest` / `pdfDigest` 各自唯一 |
| P2C-05 | forbidden business writes = 0 | 源码扫描无 `prisma.*` / 无 claim.prepare 路径；边界常量 5 项写路径全 false |
| P2C-06 | network / provider / credential = 0 | 源码无 `fetch(` / `node:http(s)` / `axios` / `process.env` / 凭据读取；边界 `networkCalls = 0`、`credentialReads = 0`；工具安全证明 `NETWORK=false / CREDENTIAL_READ=false` |
| P2C-07 | output schema / identity / sensitive | facts 租户不符 → `TENANT_MISMATCH:FACTS`；miswired 工具返回别的 `opportunityRef` 或 `executionAuthorized=true` → `PREVIEW_IDENTITY_OR_AUTHORIZATION_INVALID`；`scanPreparedPackage` 命中 `signedUrl` / `storageKey` 即拒绝 |
| P2C-08 | L5 denied + no execution authorization | `decideRecoveryExecutionRequest('CUSTOMS_FILING')` 永久拒绝；预览四个执行许可标记全 false |
| P2C-09 | persistence APIs unreachable | 三个禁用 API 既不在 import 列表内，也无调用点（只扫描去注释后的代码） |

## 4. tests（本地实测）

```text
api tsc --noEmit → exit 0
recovery-si-phase2-c 6/6 PASS
回归：recovery-si-phase2-ab 19 + recovery-si 11 + recovery-si-e2e 5 + recovery-si-revise 6
合计 47/47 PASS
```

## 5. schema delta

```text
SCHEMA_DELTA_REQUIRED = NO（本轮零 Prisma schema / migration 变更）
```

## 6. requested verdict

1. `P2C-01..09` 是否可记 **PASS**、`RECOVERY_SI_P2_C_OPTION_A` 是否可 CLOSED？
2. 是否确认 `P2-C` 未触达任何 `RecoveryPackage` 持久化 API、且 `P2_C_PERSISTENCE = FORBIDDEN` 继续成立？
3. 是否确认 `P2-D / P2-E / P2-F / P2-G` 仍需各自单独送审（P2-C 通过不得自动进入 P2-D）？
4. 若未来要做 Option B（落库），是否同意**并入 P2-E Schema/Persistence Audit**（不复用本轮授权）？
5. 若仍需修订，请只列最小集合。

请在本次会话中直接回答；不要尝试写回 GitHub。不要使用上一轮缓存。

## 7. 边界声明（本轮未改动）

```text
P2_D = NOT_AUTHORIZED
P2_E = HOLD_SCHEMA_DELTA
P2_F = HOLD
P2_G = HOLD
RSI_OUTCOME_SINK_RUNTIME_WIRING = NOT_AUTHORIZED
RUNTIME_WIRING = NONE
EXTERNAL_WRITE = HOLD
PAYMENT = HOLD
TRANSPORT = HOLD
PRODUCTION_CREDENTIALS = HOLD
REAL_CLAIM_SUBMIT = HOLD
CUSTOMS_FILING = HOLD
RSI_MODEL_NETWORK = HOLD
RSI_PAID_MODEL_CALLS = HOLD
SECOND_RUNTIME = FORBIDDEN
L5_RELAXATION = FORBIDDEN
FINAL_ACCEPTANCE_HEAD = 0f7f7ac
```
