# R45 — Implementation S2 · Outcome / Reimbursement **ingest** · Implementation Checkpoint

> 依据：**MSG-20261001-47 = PASS WITH REVISE**（Q3：批准进入 R45 S2，范围严格限定为
> ProviderOutcomeFact / ReimbursementFact ingest + server-side identity/fingerprint +
> replay idempotency + reversal ingest；**不实现 projector**；**不提前开放人工 outcome 的完整受保护 HTTP 路径**，留到 S4）。
> 边界：NO Settlement · NO Billing · NO Fee · NO RecoveryLedger mutation · NO platform write · TRANSPORT=false · NO production credentials。

---

## 1. 交付物

| 类别 | 内容 |
| --- | --- |
| 身份指纹（纯函数） | `apps/api/src/services/reconciliation/fingerprint.ts` —— `providerEventFingerprintV1`（v1） |
| ingest 服务 | `apps/api/src/services/reconciliation/ingest.ts` —— `ingestProviderOutcomeFact` / `ingestReimbursementFact` |
| 导出面 | `apps/api/src/services/reconciliation/index.ts` —— **保留 C-0005 既有跨源对账导出**，追加 R45 S2 导出 |
| 测试 | `reconciliation-fingerprint.test.ts`（7 纯函数）+ `reconciliation-ingest-db.test.ts`（12 真实 PostgreSQL） |

> 命名说明：本目录同时承载 **C-0005 跨源事实对账**（`reconcile.ts` / `prisma-repository.ts`，CanonicalFact 层面）
> 与 **R45 外部赔付事实 ingest**（`fingerprint.ts` / `ingest.ts`）。两者语义不同，互不替代；R45 S2 未改动 C-0005 任何行为。

---

## 2. 语义（逐条对应 MSG-20261001-47 Q3 预登记验收）

| 预登记要求 | 落实 | 证据 |
| --- | --- | --- |
| same external event → **same existing fact**（不是 duplicate → error/new fact） | `UNIQUE(organizationId, providerEventFingerprint)` 冲突 → 查回既有事实返回 `REUSED`（幂等复用、不双计） | DB-01（重复 ingest → REUSED + 仅 1 行）、DB-07（outcome 同口径） |
| same `providerEventId` + different resource identity → **distinct facts** | 指纹输入含 `provider + sourceResource + eventKind + identity`；资源空间不同 → 指纹不同 | DB-02（同 ID 不同 resource → 2 条）、纯函数 03 |
| same reversal replay → **existing reversal** | 冲正自身指纹唯一 → 同事件重放返回既有冲正事实 | DB-08（REUSED + 仍只有 1 条冲正） |
| different reversal event → same OBSERVED already fully reversed → **fail-closed** | 第二个冲正命中 partial unique `reimbursement_fact_full_reversal_unique` → 稳定错误码 `REVERSAL_ALREADY_APPLIED`（不当作幂等复用） | DB-09 |
| 冲正自身身份 | 冲正必须有 `providerEventId | canonicalSourceIdentity`（CHANGE B） | DB-03（缺失身份 → `MISSING_EVENT_IDENTITY`，零写入） |
| 冲正同源性 | 同租户 / 同 provider / 同 currency / 目标必须 OBSERVED；且冲正行不得携带金额 | DB-11（4 类拒绝码 + `REVERSAL_AMOUNT_NOT_ALLOWED` + `REVERSAL_TARGET_NOT_FOUND`） |

### 其他不变量

- `OBSERVED.amount` 必须 > 0（服务层前置 + DB CHECK 双保险）：DB-04。
- 币种服务端 canonical 化（`usd` → `USD`）并校验 ISO-4217：DB-06。
- `providerCaseRefRaw` 只允许原始输入，**canonical 恒由服务端构造**（复用 R43 S4 canonicalizer：trim → NFKC → 去零宽 → 折叠空白，不 lower-case）：DB-07（`'  Case\u200b-001   ABC  '` → `'Case-001 ABC'`）。
- claimItem / case 弱引用归属前置校验（同租户 / case 绑定一致）：DB-10。
- 人工来源（`MANUAL_WITH_EVIDENCE`）在 S2 **fail-closed**（`MANUAL_PATH_DEFERRED`）—— 受保护写边界属于 S4：DB-05。
- 全部写入走 S1 已落库的数据库不变量（append-only / 唯一 / 同源性守卫），服务层不做任何 UPDATE。

---

## 3. 指纹 v1 规范（`providerEventFingerprintV1`）

```
sha256( "v1" | provider | sourceResource | eventKind | identity )
identity = "id:<providerEventId>"           // 存在原生稳定 ID 时保留（不丢弃 provider identifier）
         = "src:<canonicalSourceIdentity>"  // 否则使用服务端规范来源身份
```

- 字段先 canonicalize（provider/resource 小写、kind 大写、分隔符中和），避免大小写/空白导致重复事实；
- 两个身份都缺失 → `MISSING_EVENT_IDENTITY`（**不得**退化为「无身份」写入，否则重复 ingest 无法去重）；
- `fingerprintVersion = 'v1'` 落库（DB CHECK 强制）。

---

## 4. 明确未做（保持 S2 边界）

- **未实现 projector**（Projection / ProjectionFact 重算、tolerance policy 选取、override 应用均不在 S2）；
- **未开放人工 outcome 的受保护 HTTP / service 路径**（humanApproval + evidence 校验留到 S4，CHANGE B 预登记）；
- 未实现 basis 写入 / supersede（S4 受保护动作）；
- 未新增 Schema / migration / 触发器清单变更（S1 结构冻结，本批次零 Schema 变更）；
- 未触碰 Settlement · Billing · Fee · RecoveryLedger · 平台外写 · transport · 生产凭据。

---

## 5. 验收证据

| 项 | 结果 |
| --- | --- |
| `npx prisma validate` | **valid**（本批次零 Schema 变更） |
| `npx tsc --noEmit` | **PASS（0 error）** |
| 新增指纹纯函数测试 | **7/7 PASS** |
| 新增 ingest DB 测试 | **12/12 PASS** |
| C-0005 既有跨源对账回归 | **12/12 PASS**（`reconciliation.test.ts` 10 + `reconciliation-db.test.ts` 2） |
| 全量 API 套件 | **171 files / 1668 tests PASS**（本地全量；CI 侧 fresh migrate + 两套清单 + 全量测试 + two-stage upgrade 覆盖同一组不变量） |

---

## 6. 风险分类

- `FOUNDATION_REUSED` = R45 S1 七表与数据库不变量（指纹唯一 / append-only / 冲正同源性 / partial unique）、R43 S4 canonicalizer、既有 currency canonicalizer、既有 Prisma/事务口径。
- `LEGACY_REUSED` = 无。
- `OSS_CANDIDATE` = 无新增依赖（`OSS_DECISION = EXISTING`；`LICENSE / COMMERCIAL_USE / LICENSE_RISK = n/a`）。
- `NEW_RISK_BOUNDARY` = **YES**（新增外部事实 ingest 写路径 = 幂等/身份/一致性边界；但**无新 Schema**）。
- `ARCH_REVIEW_REQUIRED` = **YES**（幂等 / 事务 / 并发一致性边界 + 外部事实写入语义）。

## 7. 下一步（等待裁决）

- **PASS** → 进入 **R45 S3（deterministic projector）**：同事务整体替换（`DELETE → CAS → INSERT`，MSG-20261001-47 Q2 冻结顺序）+ `inputDigest`/`projectionVersion` + CHANGE A 弱引用强校验 + CHANGE C system exact policy 确定性取用/创建；
- **REVISE** → 按 CHANGE 逐项修订后重送；
- **BLOCK** → 停止该方向，不绕道。
