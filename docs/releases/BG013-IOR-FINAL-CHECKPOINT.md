# BG-013 — ENTERPRISE IOR RECOVERY LAYER I1 **FINAL CHECKPOINT**（CHANGE A 修订后）

- 前置裁决：**MSG-20261003-136 = PASS WITH REVISE / APPROVED TO IMPLEMENT**；**MSG-20261003-137 = REVISE（仅 CHANGE A）**
- 分支 `gate/7-commercial-validation`
- 边界不变：`filingSubmitted=false` / `externalWritePerformed=false` / `transportEnabled=false` / `Payment=0` / `collection=OFF` / `productionCredentials=ABSENT`

## 1. CHANGE A（本轮修订）

裁决指出 `CustomsIorIdentityFact` 缺少两条 VERIFIED 不变量，导致以下组合可落库：

```
verificationStatus = VERIFIED
verificationSource = NONE
verifiedAt         = NULL
```

**已修**（新 migration `20261003220000_customs_ior_identity_verified_invariant`，不改动已应用迁移）：

| 约束 | SQL |
|---|---|
| `CustomsIorIdentityFact_verified_needs_source` | `CHECK ("verificationStatus" <> 'VERIFIED' OR "verificationSource" <> 'NONE')` |
| `CustomsIorIdentityFact_verified_needs_verified_at` | `CHECK ("verificationStatus" <> 'VERIFIED' OR "verifiedAt" IS NOT NULL)` |

## 2. PostgreSQL 负向 + 非过度约束验收

`apps/api/src/__tests__/customs-ior-facts-db.test.ts` → **9/9**（原 8 条保持，新增 CHANGE A 用例）：

1. `VERIFIED + source = NONE` → **DB reject**
2. `VERIFIED + verifiedAt = NULL` → **DB reject**
3. `PENDING + verifiedAt = NULL` → **接受**
4. `UNVERIFIED + source = NONE + verifiedAt = NULL` → **接受**（证明不是过度约束）

## 3. 其余裁决项（MSG-20261003-137 已逐条判 PASS，继续保持不变）

三表独立拆分 · 5 枚举 · Broker POA 枚举排除 `CBP_FORM_4811` · `UNIQUE(organizationId, contentDigest)` · corrected fact 追加历史 · UPDATE/DELETE append-only · tenant + lineage 触发器 · machine-safe CHECK（裸 EIN / numeric importer number / 自由文本拒绝）· POA VERIFIED ⇒ evidence 且 source ≠ NONE · `expiresAt ≥ effectiveAt` · scope 非空 · right lineage 三态 CHECK · 无 `isLatest` · 无 GIN · 4811 DB 级负向测试。

## 4. 计数与回归

- 迁移 63 → **64**（新增 `20261003220000`）；模型保持 **73**（67 core + 6 join）
- `prisma migrate status`：**64 migrations，Database schema is up to date**
- customs IOR PG 套件 **9/9**；architecture-contract 142/142；db-constraint-coverage 26/26

## 5. 非阻塞备注（架构方 MSG-20261003-137 提及）

当前 credential 自由文本之所以被拒，是因为 machine-safe regex 不允许空格（例如 `Bearer sk_live...`）。架构方判定「足够满足当前 DB 边界」，未来若放宽 reference charset 再单独加强 secret-pattern CHECK —— 本轮不做。
