# TRACK C2 FINAL —— Multi-Account Foundation checkpoint

状态：**READY_FOR_REVIEW（本地全绿；等待架构方裁决）**
依据：MSG-20261002-65（C2 授权范围 + 12 项最低验收）· MSG-20261002-66（M1–M6 PASS WITH REVISE + CHANGE A/B）· MSG-20261002-67（PlatformAccount identity immutability，须并入 M4–M6 后提交 C2 FINAL）
分支：`gate/7-commercial-validation`（不在 main 开发）；边界：NO platform write · Payment = 0 · collection / autopay / external payment write OFF · R13 HOLD · `TRANSPORT=false` · 无生产凭据。

## 1. 交付批次

| 批次 | 内容 | 提交 |
|---|---|---|
| M1–M3 | `Platform` 枚举 + `PlatformAccount`（org-scoped identity）+ `SourceConnection.platformAccountId` + 触发器/清单同步 | `02ad99d` |
| slice 2a（M4–M6） | `accountId` 下推到 5 张表 + 结构化唯一 `(organizationId, accountId, factKey)` + legacy partial unique + fail-closed 回填 + 绑定写一次 + 跨租户守卫 | `9496d3e` |
| MSG-67 修复 | `cc_platformaccount_identity_immutable`：`platform` / `externalAccountId` / `identityVersion` 创建后不可改 | `4de0ad1` |
| slice 2b part 1 | 跨账户一致性守卫（`cc_account_consistency__*`）+ 服务端 account 派生（Opportunity / ClaimItem / Evidence）| `91b2858` + `eeafd02`（触发器改名修复 CI） |
| 验收矩阵补充 | Amazon + TikTok 不跨平台合并 · account 级并发幂等 · org 级聚合 | 本提交 |

## 2. 永久验收矩阵映射

| # | 要求（MSG-65 §TEST / MSG-66 / MSG-67） | 证明（测试文件 → 用例） |
|---|---|---|
| 1 | one org / two Amazon accounts | `c2-account-scope-db` → 「同 org 两个 account 的同一 externalId → 两条独立事实（不合并、不判冲突）」 |
| 2 | one org / Amazon + TikTok | `c2-acceptance-matrix-db` → 「#2 1 org / Amazon + TikTok：同一 externalId 不跨平台合并」 |
| 3 | same externalAccountId across two orgs → allowed / isolation | `c2-account-scope-db` → 「同一 externalAccountId 在两个 organization 下允许（org-scoped identity）」 |
| 4 | cross-account claim access → reject | `c2-cross-account-guards-db` → 「ClaimItem.accountId 与 opportunity.accountId 不一致 → DB 拒绝」 |
| 5 | cross-account evidence binding → reject | `c2-cross-account-guards-db` → 「cross-account evidence binding（ClaimItemEvidence）→ DB 拒绝」 |
| 6 | cross-account settlement linkage → reject | `c2-cross-account-guards-db` → 「cross-account settlement linkage（claimItem ↔ evidence）→ DB 拒绝」 |
| 7 | client account spoof → reject | `c2-account-scope-db` → 「accountId 由服务端从连接上下文派生（客户端提交 → 拒绝）」 |
| 8 | revoked account cannot ingest new facts | `c2-account-boundary-baseline` → 「REVOKED 连接不得再拉取（revoked account cannot ingest new facts）」 |
| 9 | reconnect / credential rotation 不重写历史 provenance | `c2-platform-account-identity-db` → 「credential rotation / reconnect 不改变 identity tuple」；`c2-account-boundary-baseline` → 「凭据轮换不重写历史 provenance」 |
| 10 | account-level concurrency / idempotency | `c2-acceptance-matrix-db` → 「#10 并发写入同 account 同 factKey → 恒为一条事实」 |
| 11 | organization-level aggregate view remains possible | `c2-acceptance-matrix-db` → 「#11 跨 account 事实可按 org 汇总」 |
| 12 | R46 full regression remains green | CI 全量套件（API · migration + typecheck + tests） |
| S1 | same provider / two accounts / same fact ID → 两条独立事实 | `c2-account-scope-db` → #1 用例 |
| S2 | client supplied `platformAccountId` 不得成为 trusted provenance | `c2-account-scope-db` → 「客户端提交 → 拒绝」（`CLIENT_ACCOUNT_FIELD_NOT_TRUSTED`） |
| S3 | ingest account identity 由 authenticated SourceConnection 服务端派生 | `c2-account-scope-db` → 「账户归属服务端派生」+ 「历史行回退派生」 |
| S4 | legacy（accountId NULL）不与新 account 事实合并，且 legacy 自身仍按 (org, factKey) 唯一 | `c2-account-scope-db` → 「legacy 仍按 (org, factKey) 唯一」 |
| S5 | account 绑定后不可改写（CHANGE A） | `c2-account-scope-db` → 「account 绑定写一次（SourceConnection.platformAccountId + SourceTransaction.accountId）」 |
| S6 | PlatformAccount 业务身份创建后不可改（MSG-67） | `c2-platform-account-identity-db` → 「三类 identity mutation → DB 拒绝且原记录不变」+「display/status 仍可更新」 |
| S7 | 跨租户 account 引用 fail-closed | `c2-account-scope-db` → 「跨租户 account 引用被拒绝」；`c2-platform-account-identity-db` → 「cross-tenant SourceConnection binding 继续被拒绝」 |

## 3. 数据库不变量（全部在 DB 层，应用层不是 correctness source）

- **身份**：`PlatformAccount` 唯一性 = `(organizationId, platform, externalAccountId, identityVersion)`；identity 三元组创建后不可改（`cc_platformaccount_identity_immutable`）。
- **绑定**：`SourceConnection.platformAccountId` 与 `accountId`（SourceTransaction / CanonicalFact / RecoveryOpportunity / ClaimItem / EvidenceArtifact）写一次（`cc_account_binding_immutable__*`）。
- **事实身份**：`(organizationId, accountId, factKey)` 唯一；`accountId IS NULL` 的 legacy 行走 partial unique `CanonicalFact_org_factkey_legacy_key`；account **不**拼进 factKey。
- **跨租户**：`cc_tenant_*_accountid` 守卫 + 既有 tenant 清单（78 baseline）。
- **跨账户一致性**：ClaimItem ↔ Opportunity、ClaimItemEvidence 两端、Settlement（claimItem ↔ evidence）——任一端为 NULL（legacy 窗口）时跳过判定。

## 4. 证据

| 项 | 结果 |
|---|---|
| C2 专项套件 | `c2-account-boundary-baseline` 7/7 · `c2-account-scope-db` 8/8 · `c2-platform-account-identity-db` 4/4 · `c2-cross-account-guards-db` 4/4 · `c2-acceptance-matrix-db` 3/3 |
| 全量回归 | CI（API · migration + typecheck + tests）success（历史基线 188 files / 1854+ tests；本批新增 5 个 C2 套件文件） |
| `tsc --noEmit` | 0 error |
| `prisma validate` | valid |
| upgrade deploy | PASS（42 → 46 migrations） |
| fresh deploy（临时库全量迁移） | PASS —— 5 张表 `accountId`、结构化唯一 + legacy partial unique、6 条绑定不可变触发器（tgtype 19）、5 条跨租户守卫（tgtype 23）、一致性守卫（tgtype 23）全部在位；tenant 与 append-only 清单门禁 PASS |

## 5. 未接线（明确记录，不冒充已完成）

- `pod-upload` / `closure-service`（2 处）/ `recovery-outcome` 的 `EvidenceArtifact` 创建路径尚未从连接上下文派生 `accountId`（当前保持 legacy NULL；跨账户守卫在任一端为 NULL 时跳过，因此不影响正确性，但证据的账户归因在这些路径上仍为空）。
- 本 checkpoint 完成后进入 **C2 FINAL 送审**；通过后按 MSG-65 进入 **TRACK B — Platform Readiness**，并按 HOST 指令在 C2 收口后执行 **PHASE X1 Architecture Audit**（Cross-System Recovery Layer）。
