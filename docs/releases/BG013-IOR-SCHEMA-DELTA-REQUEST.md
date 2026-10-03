# ENTERPRISE IOR RECOVERY LAYER — SCHEMA DELTA REQUEST（I1 持久化）

> 类型：**Schema Delta Request（仅请求批准；不含 migration、不含实现）**
> 依据：HOST DIRECTIVE《ENTERPRISE IOR RECOVERY LAYER INCREMENTAL DIRECTIVE》① ② ③ ⑨
> 分支 `gate/7-commercial-validation` · Codex · 2026-10-03
> 前置已落地（**无 Schema 变更**）：契约层 6 模块 + BG-014 资格接线 + BG-015 全链装配（均 read-only，零外写）

---

## 0. 请求摘要

把现有 **readiness boolean**（`importerOfRecordConfirmed` / `claimantConfirmed` / `recoveryRightConfirmed`）逐步升级为
**evidence-backed、append-only、可审计事实**，使下列断言可被数据库而非仅被服务层保证：

1. IOR / claimant 身份只能来自 **server-side 校验来源**，不接受客户端自报 truth；
2. Entry → IOR → claimant → right → remedy → filing authorization 的权利链可回溯；
3. Broker POA 是 **CBP Form 5291 / equivalent regulatory POA** 的独立授权事实，与 Platform OAuth、Payment Authorization 严格分离；
4. 核心事实层**不得**出现 EIN / importer number / 银行账号 / credential 原文。

本请求**只申请 Schema 批准**；获批后才实施 migration 与持久化接线，且 HOLD_EXTERNAL 全部保持
（`filingSubmitted=false` / `externalWritePerformed=false` / `transportEnabled=false` / `Payment=0` / `collection=OFF` / `productionCredentials=ABSENT`）。

## 1. 新增枚举（5）

```
enum CustomsIorPrincipalType { IMPORTER_OF_RECORD DRAWBACK_CLAIMANT }
enum CustomsIorVerificationStatus { UNVERIFIED PENDING VERIFIED REVOKED UNKNOWN }
enum CustomsIorVerificationSource { BROKER_ATTESTATION ACE_LOOKUP CUSTOMER_DOCUMENT MANUAL_REVIEW NONE }
enum CustomsBrokerAuthorizationType { CBP_FORM_5291 EQUIVALENT_REGULATORY_POA }
enum CustomsRightLineageOutcome { COMPLETE NEEDS_MANUAL BROKER_REVIEW }
```

与 `services/customs/enterprise-ior/*.ts` 词表逐一对齐（`IOR_PRINCIPAL_TYPES` / `IOR_VERIFICATION_STATUSES` /
`IOR_VERIFICATION_SOURCES` / `BROKER_AUTHORIZATION_TYPES` / `RightLineageResult.outcome`）。

> **不新增** `CBP_FORM_4811`：4811 只属 refund destination / special address / third-party designation 语义，
> 不得进入 Broker POA 枚举（否则等于把错误授权类型合法化）。

## 2. 新增表 ①`CustomsIorIdentityFact`（append-only）

| 字段 | 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| `id` | `String @id @default(uuid())` | 否 | |
| `organizationId` | `String` | 否 | FK → Organization（Cascade） |
| `jurisdiction` | `String` | 否 | 例如 `US` |
| `principalType` | `CustomsIorPrincipalType` | 否 | IOR / drawback claimant |
| `importerOfRecordRef` | `String` | 否 | 复用现有 `importerOfRecordRef` 口径（safe reference） |
| `legalEntityRef` | `String` | 否 | 法人实体引用 |
| `aceAccountRef` | `String?` | 是 | **仅** safe/opaque reference（tokenized），禁止 ACE 账号原文 |
| `verificationStatus` | `CustomsIorVerificationStatus` | 否 | |
| `verificationSource` | `CustomsIorVerificationSource` | 否 | 客户端自报不是合法来源 |
| `verifiedAt` | `DateTime?` | 是 | |
| `effectiveFrom` | `DateTime?` | 是 | |
| `effectiveTo` | `DateTime?` | 是 | |
| `digest` | `String` | 否 | 事实摘要（64 hex） |
| `sourceReference` | `String` | 否 | 来源引用（machine-safe） |
| `observedAt` | `DateTime` | 否 | 事实观测时间 |
| `recordedAt` | `DateTime @default(now())` | 否 | |

约束/索引（请求批准项）：

| # | 项 | 目的 |
| --- | --- | --- |
| I1-C1 | `@@unique([organizationId, jurisdiction, importerOfRecordRef, digest])` | 幂等 append（同一事实重复写入不产生第二行） |
| I1-C2 | `@@index([organizationId, importerOfRecordRef, observedAt])` | 按 IOR 回看历史 |
| I1-C3 | `@@index([organizationId, verificationStatus])` | 就绪扫描 |
| I1-C4 | CHECK：`digest ~ '^[0-9a-f]{64}$'` | 摘要形状 |
| I1-C5 | CHECK：引用列 `~ '^[A-Za-z0-9._:@#/-]{1,96}$'` | **拒绝裸 EIN / importer number / 含空格自由文本** |

## 3. 新增表 ②`CustomsRightLineageFact`（append-only）

| 字段 | 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| `id` | `String @id @default(uuid())` | 否 | |
| `organizationId` | `String` | 否 | FK → Organization（Cascade） |
| `entryReference` | `String` | 否 | 弱引用 CustomsEntryFact（不建 FK） |
| `importerOfRecordRef` | `String` | 否 | |
| `claimantRef` | `String` | 否 | |
| `remedyRoute` | `String` | 否 | 与 remedy taxonomy 对齐（校验在应用层 + CHECK 白名单） |
| `iorRightsForRemedy` | `String` | 否 | `CONFIRMED` / `UNCLEAR` / `ABSENT` |
| `claimantRightsForRemedy` | `String` | 否 | 同上 |
| `filingAuthorized` | `Boolean` | 否 | 仅表示授权事实，不触发 filing |
| `outcome` | `CustomsRightLineageOutcome` | 否 | |
| `reasonCodesJson` | `Json` | 否 | 归档 reason codes（不改变判定） |
| `evidenceKindsJson` | `Json` | 否 | 已附证据种类清单（引用见 ③） |
| `digest` | `String` | 否 | |
| `observedAt` / `recordedAt` | `DateTime` | 否 | |

约束：`@@unique([organizationId, entryReference, remedyRoute, claimantRef, digest])`；
CHECK 白名单约束 `iorRightsForRemedy` / `claimantRightsForRemedy` ∈ {CONFIRMED, UNCLEAR, ABSENT}。

## 4. 新增表 ③`CustomsBrokerPoaFact`（append-only）

| 字段 | 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| `id` | `String @id @default(uuid())` | 否 | |
| `organizationId` | `String` | 否 | FK → Organization（Cascade） |
| `principalRef` | `String` | 否 | importer / drawback claimant |
| `brokerRef` | `String` | 否 | |
| `jurisdiction` | `String` | 否 | |
| `authorizationType` | `CustomsBrokerAuthorizationType` | 否 | **仅 5291 / equivalent** |
| `scopeJson` | `Json` | 否 | 至少一项（空 scope fail-closed） |
| `effectiveAt` | `DateTime` | 否 | |
| `expiresAt` | `DateTime?` | 是 | |
| `evidenceArtifactRef` | `String?` | 是 | 缺失 → 不可用（fail-closed） |
| `verificationStatus` | `CustomsIorVerificationStatus` | 否 | |
| `verificationSource` | `CustomsIorVerificationSource` | 否 | |
| `digest` / `observedAt` / `recordedAt` | | 否 | |

约束：`@@unique([organizationId, principalRef, brokerRef, jurisdiction, digest])`。

## 5. 运行库不变量（与既有平台一致）

| 不变量 | 机制 |
| --- | --- |
| append-only | `cc_immutable__<Table>` 触发器拒绝 UPDATE/DELETE（与 G8/G9 同族） |
| tenant guard | `cc_tenant_<table>` 触发器 + 同步 `tools/tenant-triggers/required-triggers.json` 清单 |
| 跨租户不可见 | 读取一律按 `organizationId` 过滤；写入跨租户拒绝 |
| 无 PII/credential | CHECK 形状约束 + 应用层 `scanRawSensitive` 双重防线 |

## 6. 与既有模型的关系

- 不修改、不删除任何既有表/列；**不触碰** `CustomsEntryFactRecord` / `CustomsDutyTruthRecord` /
  `CustomsEligibilityRecord` / `CustomsRecoveryEstimateRecord` / `CustomsClaimReadyPackage` / `RecoveryQualification`。
- `entryReference` 对 CustomsEntryFact 为**弱引用**（不建 FK），避免跨域强耦合。
- 现有 readiness boolean 保留；本 delta 为其提供 evidence-backed 事实来源。

## 7. 明确不包含

- 不写 migration（获批后另起提交）；
- 不新增 HTTP 入口、不改 Action Guard；
- 不接真实 Broker / ABI / Filing Provider；
- 不开启任何真实外写或生产凭据；
- 不新增 VAT/GST 主线（指令 ⑩：仅登记 future backlog）。

## 8. 影响面与回滚

- 影响面：+3 表、+5 枚举、+3 组触发器、+1 触发器清单条目；对既有查询/索引零影响。
- 回滚：`DROP TABLE ...` ×3 + `DROP TYPE ...` ×5；无数据回填、无破坏性操作。

## 9. 待批问题（请逐条裁定）

1. 三张 append-only fact 表 + 5 个枚举是否批准？
2. `I1-C5`（引用列 CHECK machine-safe 形状，拒绝裸 EIN / importer number）是否批准？是否要求同时加银行账号形状 CHECK？
3. `aceAccountRef` 是否允许以 tokenized/opaque reference 存储（当前提案：允许，仅形状约束）？
4. `digest` 唯一键口径（`organizationId + 业务键 + digest`）是否认可？
5. 是否要求额外 **latest view**（由 `observedAt DESC, id` 推导）而非物化列？
6. 是否需要为 `scopeJson` 增加 GIN 索引（Broker POA scope 查询）？
