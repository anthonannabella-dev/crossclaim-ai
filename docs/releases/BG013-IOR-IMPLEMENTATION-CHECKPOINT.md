# BG-013 — ENTERPRISE IOR RECOVERY LAYER I1 **IMPLEMENTATION CHECKPOINT**

- 依据：**MSG-20261003-136 = PASS WITH REVISE / APPROVED TO IMPLEMENT**（Design Request 无需再提交）
- 分支 `gate/7-commercial-validation`；实现 HEAD `2a62a10`；证据绑定 HEAD `dc1fe85`
- 边界不变：`filingSubmitted=false` / `externalWritePerformed=false` / `transportEnabled=false` / `Payment=0` / `collection=OFF` / `productionCredentials=ABSENT`

## 1. 交付物

| 项 | 内容 |
|---|---|
| Prisma | 3 模型 + 5 枚举：`CustomsIorIdentityFact` / `CustomsRightLineageFact` / `CustomsBrokerPoaFact`；`CustomsIorPrincipalType` / `CustomsIorVerificationStatus` / `CustomsIorVerificationSource` / `CustomsBrokerAuthorizationType` / `CustomsRightLineageOutcome` |
| Migration | `20261003210000_customs_ior_recovery_layer`（migrate deploy OK） |
| 模型总数 | 70 → **73**（67 core + 6 join），architecture-contract 142/142（含 73 计数断言） |
| 迁移总数 | 62 → **63**；README 计数同步（doc-sync 模板改为**按仓库实时计算**，不再硬编码） |

## 2. 逐条对应裁决要求

| 裁决要求 | 落点 |
|---|---|
| 三张独立事实表，不合并 | 三表独立（身份事实 ≠ 权利归属事实 ≠ Broker 授权事实） |
| `UNIQUE(org, contentDigest)` 不可变事实幂等 + corrected fact 追加历史 | `@@unique([organizationId, contentDigest])`；PG E2E「同 fact 重放 exactly-one / corrected 追加 / latest 为新」 |
| UPDATE / DELETE 拒绝 | `cc_append_only__*` 触发器（PG E2E 断言 `/APPEND_ONLY/`） |
| tenant lineage 必须与引用 identity 一致 | 新增 `cc_ior_lineage__*` 守卫：权利链 / Broker POA 的 principal 必须存在**同租户** IOR 身份事实（PG E2E `/LINEAGE_TENANT/`） |
| machine-safe CHECK 必须 DB 化 | `^[A-Za-z0-9._:@#/-]{1,96}$` CHECK；并显式拒绝裸 EIN（`^\d{2}-\d{7}$`）与纯数字 importer number（`^\d{6,12}$`） |
| 银行账号不属于这三表 | 三表无任何银行字段；银行账号相关只保留在 refund destination readiness（只读、非本 Delta） |
| `aceAccountRef` 仅 tokenized/opaque | 允许可空 + machine-safe 形状 CHECK |
| Broker POA 仅 5291 / equivalent；**4811 必须 DB 拒绝** | 枚举仅 `CBP_FORM_5291` / `EQUIVALENT_REGULATORY_POA`；PG E2E 用 `CBP_FORM_4811` 写入 → **DB 枚举错误**（非 service 层 unusable） |
| VERIFIED 必须有 evidence 且 source ≠ NONE | 两条 CHECK（`verified_needs_evidence` / `verified_needs_source`） |
| `expiresAt >= effectiveAt`；scope 非空 | 两条 CHECK（`expiry_window` / `scope_array`（jsonb 数组且长度 > 0）） |
| filingAuthorized=true ≠ filing performed | 表内**不存在** filingSubmitted / provider result 等外部执行字段（architecture-contract 同时校验 schema） |
| latest 由 query/view 推导 | 无 `isLatest` 列；按 `observedAt DESC, id DESC` 推导 |
| 不加 GIN | 未加 |

## 3. PostgreSQL 验收（`apps/api/src/__tests__/customs-ior-facts-db.test.ts`，8/8）

1. 同 fact 重放 → `UNIQUE(organizationId, contentDigest)` exactly-one；
2. corrected fact 追加历史，latest 返回新 fact；
3. UPDATE 拒绝 / DELETE 拒绝；
4. 裸 EIN 拒绝 / numeric importer number 拒绝 / credential 自由文本拒绝；
5. 跨租户 lineage 拒绝（权利链 + Broker POA）；
6. `CBP_FORM_4811` 作 Broker POA → DB 写入失败；
7. VERIFIED 缺 evidence 拒绝 / VERIFIED + source NONE 拒绝 / scope 空拒绝 / 过期窗口非法拒绝；
8. 权利三态 CHECK（自由文本拒绝）+ organizationId 隔离。

## 4. 运行库取证

11 个新触发器在运行库中**存在且启用**：`cc_tenant_*`（3，tgtype 23）、`cc_tenant_immutable__*`（3，19）、`cc_append_only__*`（3，27）、`cc_ior_lineage__*`（2，7）。
清单已同步 `tools/tenant-triggers/required-triggers.json`（95 baseline）与 `append-only-triggers.json`（38 条）。

## 5. 回归

- customs 全套 25 文件 / 215 用例 PASS
- architecture-contract 142/142；db-constraint-coverage 26/26
- `tsc --noEmit`（api）EXIT=0；doc-sync OK
- 未触碰任何既有表/列（纯新增）

## 6. 边界

`IOR verified ≠ claimant rights verified ≠ Broker POA verified ≠ filing authorized ≠ filing submitted ≠ refund received`；
真实 Broker / ABI / Filing Provider、真实 POA、真实客户 IOR 数据继续 `HOLD_EXTERNAL`。
