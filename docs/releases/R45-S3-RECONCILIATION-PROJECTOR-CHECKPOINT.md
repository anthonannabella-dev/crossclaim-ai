# R45 — Implementation S3 · Deterministic Projector · Implementation Checkpoint

> 依据：**MSG-20261002-48 = PASS**（R45 S2 CLOSED；批准进入 S3，范围与事务顺序已冻结）。
> 范围：immutable facts + effective basis + effective tolerance policy + 已存在的合法 override inputs
> → deterministic computation → persisted `ClaimReconciliationProjection` + `ClaimReconciliationProjectionFact` membership。
> **未实现** S4 的受保护写动作（basis set / supersede / override 创建 / provider outcome 人工录入）。
> 边界：NO Settlement · NO Billing · NO Fee · NO RecoveryLedger mutation · NO platform write · TRANSPORT=false · NO production credentials。

---

## 1. 交付物

| 类别 | 内容 |
| --- | --- |
| 纯计算层 | `apps/api/src/services/reconciliation/projection-compute.ts` —— 4 位定点 BigInt 金额运算、canonical inputDigest、状态判定（无 IO） |
| IO 层 | `apps/api/src/services/reconciliation/projector.ts` —— `rebuildClaimReconciliationProjection`（锁内固定输入 → 重建 → 整体替换 membership → audit） |
| 导出面 | `index.ts` 追加 S3 导出（C-0005 既有导出与 S1/S2 导出保持不变） |
| 测试 | `reconciliation-projection-compute.test.ts`（13 纯函数）+ `reconciliation-projector-db.test.ts`（14 真实 PostgreSQL） |

---

## 2. 事务顺序（与 MSG-20261002-48 冻结口径逐条一致）

```
lock projection / claim scope（ClaimItem … FOR UPDATE；projection header … FOR UPDATE）
→ 固定输入集合（effective OBSERVED facts − 已被冲正；effective basis；effective policy；合法 override）
→ 强校验 basis / policy 引用（同租户 / 同 claimItem / effective；scope 内唯一）
→ deterministic rebuild（纯函数，禁旧 Projection 参与）
→ 计算 inputDigest（canonical JSON + sha256，64 hex）
→ DELETE old membership
→ CAS header 到新 generation/version/inputDigest（WHERE id AND projectionVersion = 锁内读到的版本）
→ INSERT new membership（绑定新 generation）
→ audit（reconciliation.projection_rebuilt：previous/new digest、version、reason、actor、rebuiltAt）
→ commit
```

任何一步失败 → 整个事务 rollback，旧 header + 旧 membership 完整恢复（含 DELETE 已执行后的 CAS/INSERT 失败）。

---

## 3. 计算口径（v1，确定性）

| 项 | 规则 |
| --- | --- |
| 金额运算 | 4 位定点 `BigInt`（禁浮点）；金额字符串统一 4 位小数 |
| 容差 | `abs(net − expected) ≤ max(absoluteTolerance, expected × relativeTolerance)`；**policy 必填**（无 policy 即 fail-closed，禁止隐式 fallback） |
| UNMATCHED | 无计入事实（net = 0） |
| MATCHED | 有计入事实但**无 effective basis**（无法判定完整性，绝不宣称 recovered） |
| PARTIALLY_RECONCILED | net < expected 且超出容差 |
| FULLY_RECONCILED | 在容差内达到 expected |
| AMBIGUOUS | currency mismatch（不自动换汇）/ conflicting evidence（同 `providerEventId` 不同金额）/ 超出容差的过度回收（`OVER_RECOVERY_BEYOND_TOLERANCE`） |
| override | `UNMATCHED` → 该笔不计入；`MATCHED` → 正常计入；override 不修改任何原始事实 |
| inputDigest | canonical JSON（键排序）+ sha256；包含 claimItemId、basis（id/amount/currency/version）、policy（id/version/abs/rel）、全部 facts、全部 overrides |

> 旧 Projection **只用于 CAS/version coordination**，绝不作为下一次计算的输入（MSG-48 RISKS）。

---

## 4. CHANGE A / CHANGE C 的落地

- **CHANGE A（弱引用强校验）**：basis 读取时强校验「同租户 + 同 claimItem + effective（`supersededAt IS NULL`）」，并断言唯一；policy 读取强校验「同租户 + 同 provider + 同 operation + effective」，scope 内多于一条即 fail-closed（`POLICY_NOT_UNIQUE`）。cross-tenant basis/policy 不会被采用（测试覆盖）。
- **CHANGE C（system exact policy 不得依赖 seed 永久存在）**：`ensureSystemExactPolicy` = 先查询唯一 system exact policy → 缺失时以确定性 id **受控幂等创建** → 并发创建由 unique scope 收敛 → 最终 Projection 必须持久化真实 `tolerancePolicyId + policyVersion`（测试覆盖：缺失→显式创建；并发→最终唯一）。
- CHANGE B（evidence 数组逐条校验）属于**人工 outcome 写路径（S4）**，S3 不涉及。

---

## 5. 永久验收（对应 MSG-20261002-48 清单）

| MSG-48 验收项 | 覆盖 |
| --- | --- |
| 同一输入重复 rebuild → 相同 deterministic result / inputDigest | DB-P02（digest 相同、版本 +1） |
| 删除 Projection 后可从 facts/basis/policy 重建相同结果 | DB-P03 |
| DELETE 后 CAS 故障 → rollback，旧 header + membership 逐行保持 | DB-P04（故障注入缝隙） |
| DELETE + CAS 后 INSERT 故障 → 同样完整 rollback | DB-P05（故障注入缝隙） |
| stale generation membership → 拒绝 | DB-P06 |
| dangling / cross-tenant basis → fail-closed | DB-P07（cross-tenant basis 不被采用；无 basis → MATCHED 不宣称 recovered） |
| dangling / cross-tenant policy → fail-closed | DB-P08/P09 + `POLICY_NOT_UNIQUE` 断言 |
| system exact policy 缺失 → 显式、幂等地持久化创建 | DB-P08 |
| 两 worker 并发创建 exact policy → 最终唯一 | DB-P09（并发重建） |
| Projection 必须保存实际 basisId + tolerancePolicyId/version | DB-P01 |
| reversal 后 rebuild 可使 FULL → PARTIAL/UNMATCHED | DB-P11（原事实保留，投影重算为 UNMATCHED） |
| currency mismatch → 不自动换汇 | 纯函数 06 + DB-P12 |
| 多候选 / conflicting evidence → fail-closed | 纯函数 07 + DB-P13（AMBIGUOUS） |
| ProjectionFact membership generation 与 header 严格一致 | DB-P01/P02/P05/P06 |
| projector 不写任何 immutable Fact | DB-P01（facts/outcome 计数不变） |
| audit 记录 previous/new digest 等 | DB-P10（`reconciliation.projection_rebuilt`） |

---

## 6. 验收证据

| 项 | 结果 |
| --- | --- |
| `npx prisma validate` | **valid**（本批次零 Schema 变更） |
| `npx tsc --noEmit` | **PASS（0 error）** |
| 纯计算层单测 | **13/13 PASS** |
| projector DB 验收 | **14/14 PASS** |
| 全量 API 套件 | **173 files / 1695 tests PASS**（本地全量；CI 侧 fresh migrate + 两套触发器清单 + 全量测试 + two-stage upgrade 覆盖同一组不变量） |

---

## 7. 风险分类与下一步

- `FOUNDATION_REUSED` = R45 S1 数据库不变量（指纹唯一 / append-only / 冲正同源性 / partial unique / generation 立即校验）、S2 身份口径、R43 canonicalizer、既有 audit 写入器、既有 advisory/row-lock 与 CAS 口径。
- `OSS_CANDIDATE` = 无新增依赖（`OSS_DECISION = EXISTING`；LICENSE / COMMERCIAL_USE / LICENSE_RISK = n/a）。
- `NEW_RISK_BOUNDARY` = **YES**（投影重算的一致性/并发边界；无新 Schema）。
- `ARCH_REVIEW_REQUIRED` = **YES**。
- 下一步：PASS → **R45 S4（受保护动作：basis set / basis supersede / override / provider outcome 人工录入）**；REVISE → 按 CHANGE 修订；BLOCK → 停止该方向。

## 附录 · MSG-20261002-49 裁决结果与 REVISE 落地

> 裁决：**PASS WITH REVISE — MSG-20261002-49**（REVIEWED_HEAD `46074bd`；归档 FULL_COPY_OK）。**S3 主体可标记 CLOSED**（13/13 纯计算 + 14/14 PostgreSQL + 全量 1695 tests 与风险面匹配）。

### 1. 状态语义冻结（②）

| 状态 | 冻结语义 |
| --- | --- |
| `UNMATCHED` | 无计入事实（net = 0） |
| `MATCHED` | 事实已唯一关联到该 Claim，但**缺少有效 ExpectedRecoveryBasis** → 无法判断 PARTIAL/FULL；**不得**被 UI/API/audit 描述为 `recovered` / `fully recovered` / `reimbursement complete` / `billable` |
| `PARTIALLY_RECONCILED` | net < expected 且超出容差 |
| `FULLY_RECONCILED` | 在容差内达到 expected（仅表示对账完成，**不代表已可计费**） |
| `AMBIGUOUS` | fail-closed 异常态：**匹配歧义**（多候选 / conflicting evidence / currency mismatch）或**金额异常**（`AMOUNT_EXCEEDS_EXPECTED`） |

代码侧以 `PROJECTION_STATUS_MEANINGS` 常量固化（含单测断言），供 API/UI 复用，避免上层自行措辞。

### 2. REVISE ①：金额异常与匹配歧义分离

- 过度回收（`netMatchedObserved > expected + tolerance`）不再使用通用原因码；改为结构化异常 **`AMOUNT_EXCEEDS_EXPECTED`** 写入 `ambiguityReasons` 与 projection rebuild audit。
- v1 枚举只有 5 个状态，因此 `status` 仍为 `AMBIGUOUS`，但语义已明确：这是 **fail-closed exceptional state（金额异常）**，**不是**「多个候选 Claim」的匹配歧义；后续扩展状态模型时优先拆出 `EXCEPTION` / `CONFLICT`。

### 3. REVISE ②（CHANGE A）：引用损坏必须 fail-closed

投影重建在**任何写入之前**校验（`assertWeakReferencesIntact`）：

- 既有 Projection 的 `basisId` 必须存在且同租户、同 claimItem → 否则 `PROJECTION_BASIS_REFERENCE_INVALID`；
- 既有 Projection 的 `tolerancePolicyId` 必须存在且同租户（或系统级） → 否则 `PROJECTION_POLICY_REFERENCE_INVALID`；
- 本 claim 的 basis supersede 链不得漂移（`supersededAt` 非空时 successor 必须存在且同租户同 claim） → 否则 `BASIS_SUPERSEDE_CHAIN_INVALID`。

只有「**真正不存在 effective basis**」才会落到 `MATCHED`；引用损坏一律 fail-closed，绝不解释成「业务上还没建立 basis」。

### 4. REVISE ③（CHANGE B）：inputDigest 覆盖全部有效输入

`inputDigest = sha256(canonicalJson({ algorithmVersion, claimItemId, basis{id,amount,currency,version}, policy{id,version,absolute,relative}, facts[{id,amount,currency,providerEventId,providerCaseRefCanonical,occurredAt}], overrides[{factId,decisionKind}] }))`

- 新增 `algorithmVersion = reconciliation-projection/v1`（算法版本变化 → 新 digest）；
- 单测覆盖：fact identity/content、reversal（事实从输入消失）、basis id/version/amount/currency、policy id/version/absolute/relative、override、算法版本 —— 任一变化 → digest 变化；仅输入顺序变化而语义相同 → digest 不变；
- projection rebuild audit 同步记录 `algorithmVersion` 与 previous/new digest。

### 5. REVISE 后验收

| 项 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | PASS（0 error） |
| 纯计算层单测 | **15/15 PASS**（新增 MATCHED 语义冻结 + digest 全输入覆盖） |
| projector DB 验收 | **16/16 PASS**（新增 dangling basis / cross-tenant policy → fail-closed） |
| Schema 变更 | 无（仍为零 Schema 变更） |

### 6. NEXT

批准进入 **R45 S4 — Protected Reconciliation Actions**：`recovery.reconciliation_basis_set` / `recovery.reconciliation_basis_supersede` / `recovery.reconciliation_override` / `recovery.reconciliation_provider_outcome_record`，全部 INTERNAL_WRITE + humanApproval + 锁后 ACTIVE membership/role 重验；人工 outcome 需 evidence 逐条校验；supersede 遵循 S1 冻结顺序并保证后置失败恢复旧 effective basis；**不得顺带开放 Settlement/Billing 或「可收费 recovered amount」**。
