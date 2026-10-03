# TRACK C2 · 第一批 — 现状模型取证 + Gap Matrix + Schema Delta 决策请求

> 依据：**MSG-20261002-65 ③**「NEXT = TRACK C2 Multi-Account / Multi-Platform Account Model；第一批只做：现状模型取证 → gap matrix → 是否需要 Schema Delta 的决策请求；**不要直接修改 Schema**」。
> 关系：本文是 `MULTI-PLATFORM-MULTI-ACCOUNT-AUDIT-AND-SCHEMA-DELTA-PROPOSAL.md` 的**对齐补充**（按 MSG-65 的 8 个问题与 12 项最低验收重述），**不含任何 Schema 变更**。
> 边界：Payment/autopay/collection/external write 全部 OFF；R13 HOLD；`TRANSPORT=false`；无生产凭据。

## 1. MSG-65 的 8 个问题 —— 逐条回答（带证据）

| # | 问题 | 现状判定 | 证据 |
| --- | --- | --- | --- |
| 1 | 一个 organization 能否连接多个 Amazon seller accounts？ | **PARTIAL** —— 可以，但只能用「同 channel 下不同 `label` 的多条 `SourceConnection`」近似；无 account 实体、无 external account id | `SourceConnection @@unique([organizationId, channel, label])`；无 `externalAccountId` 列 |
| 2 | 能否同时连接 Amazon + TikTok + Walmart？ | **BLOCKED** —— `Channel` 枚举无 `TIKTOK_SHOP` / `WALMART` / `SHOPIFY` / `STRIPE` / `PAYPAL` / `CUSTOMS` 值 | `enum Channel { AMAZON_FBA, AMAZON_OTHER, UPS, FEDEX, DHL, FREIGHT_FORWARDER, INSURANCE, CUSTOMS_BROKER, OTHER }` |
| 3 | 每个账号是否拥有独立 credential lifecycle？ | **PARTIAL** —— 连接级独立（`credentialRef` / `status` / `lastError*` 都在 `SourceConnection`），但没有账号级聚合与账号级状态 | `SourceConnection` 字段 + `@@unique([organizationId, channel, label])` |
| 4 | ingest 时 account identity 是否完全由服务端连接上下文决定？ | **FAIL（canonical 层）** —— `SourceTransaction.dedupeKey` 含 `connectionId`（服务端），但 `connectionId` 可空且 canonical 层**完全不含账户维度** | `dedupeKey = sha256(org\|connectionId\|referenceType\|externalId\|rowFingerprint)`；`factKeyOf()` 只返回 `${type}:${externalId}` |
| 5 | 客户端能否伪造另一个 accountId？ | **N/A → 引入时必须 fail-closed** —— 当前不存在 `accountId` 概念，因而无法伪造；但一旦引入 `PlatformAccount`，必须由服务端从连接上下文派生，禁止客户端提交 | 现有 ingest 入口不接受账户字段 |
| 6 | claim/evidence/receipt 是否能证明来源 account？ | **FAIL** —— `ClaimItem` / `EvidenceArtifact` / `Settlement` 均无账户维度，且 canonical fact 已丢失账户归属，只能靠 `connection → transaction` 间接推断 | `CanonicalFact @@unique([organizationId, factKey])`；`RecoveryOpportunity` 仅 `organizationId + domain + channel` |
| 7 | reconnect 后历史 account facts 是否保持可追溯？ | **PARTIAL/FAIL** —— 连接行保留（status/lastError），但 `label` 改名即失去稳定身份，历史 fact 无账户归属 | 同 #1/#4 |
| 8 | 同一个 external ID 在另一个 organization 下是否被错误冲突？ | **PASS（跨租户隔离正确）** —— 事实键唯一约束为 `(organizationId, factKey)`，不同 org 不冲突 | `CanonicalFact @@unique([organizationId, factKey])` |

**结论**：现有模型在**组织边界**上正确（#8），在**账号边界**上不成立（#4/#6 为硬缺口，#1/#2/#3/#7 为能力缺口）。若现在继续增加平台入口，会把错误的 ownership/boundary 复制到 Amazon / TikTok Shop / Walmart / carrier / customs 及未来连接器（与 MSG-65 判断一致）。

## 2. Gap Matrix（按 MSG-65 的 12 项最低验收展开）

| C2 能力 | 现有支持 | 缺口 | 结论 |
| --- | --- | --- | --- |
| one org / two Amazon accounts | 两条不同 label 的连接 | 无 account 实体与稳定身份 | 需 Delta |
| one org / Amazon + TikTok | Amazon 可；TikTok 无枚举值 | `Platform` 维度缺失 | 需 Delta |
| same externalAccountId across two orgs → isolation | 事实键已按 org 隔离 | 引入 account 后需保持 org-scoped 唯一 | 需约束设计 |
| cross-account claim access → reject | 无 account 维度 → 无法表达/拒绝 | ClaimItem/Claim 缺 account 归属 | 需 Delta |
| cross-account evidence binding → reject | 同上 | EvidenceArtifact 缺 account 归属 | 需 Delta |
| cross-account settlement linkage → reject | Settlement 有 claimItem/case，无 account | 需 account 归属 | 需 Delta |
| client account spoof → reject | N/A | 引入后需服务端派生 + 拒绝客户端字段 | 需服务层契约 |
| revoked account cannot ingest new facts | 连接级 status 已有 | 账号级状态与 ingest 校验缺失 | 需 Delta + 服务层 |
| reconnect / credential rotation 不重写历史 provenance | 连接行不删除 | 历史 fact 无 account 归属 | 需 Delta + 回填策略 |
| account-level concurrency / idempotency | 连接级 dedupe 已含 connectionId | account 维度缺失 | 需 Delta |
| org-level aggregate view remains possible | 现有 org 级查询可用 | 需 account 维度才能做 per-store 小计 | 需 Delta（只加维度，不改口径） |
| R46 full regression remains green | 已 CLOSED（MSG-65） | — | 作为 C2 的回归门槛保留 |

## 3. 核心唯一性（按 MSG-65 对齐）

- **禁止** `UNIQUE(platform, externalAccountId)` 之类**全局**模型（会让不同 organization 共用同一外部账号身份）。
- 原则：**organization-scoped / connection-scoped identity**，例如 `organizationId + provider + externalAccountIdentity + identityVersion`。
- 具体落地形式由本审计决定（见 §4），**本轮不实施**；`identityVersion` 用于外部身份格式演进时避免错误合并，且身份变化不得自动重认同一账户。

## 4. 最小 Schema Delta 决策请求（沿用已提交提案，按 MSG-65 措辞收敛）

1. **新枚举 `Platform`**（`AMAZON`/`TIKTOK_SHOP`/`WALMART`/`SHOPIFY`/`STRIPE`/`PAYPAL`/`UPS`/`FEDEX`/`DHL`/`CUSTOMS`/`OTHER`）；保留 `Channel` 兼容，不重写。
2. **`PlatformAccount`（Store/Account 稳定身份）**：`id` · `organizationId` · `platform` · `externalAccountId` · `identityVersion` · `marketplace?` · `region?` · `displayName` · `status(ACTIVE/NEEDS_AUTH/DISABLED/REVOKED)` · 时间戳；唯一性 `(organizationId, platform, externalAccountId, identityVersion)`；**token/secret 不入此表**（仍由 `SourceConnection.credentialRef`）。
3. **`SourceConnection.platformAccountId?`**：一个 Store 可挂多条连接（Orders/Settlement/Inventory/Returns/FileUpload/Email；Shopify + Stripe/PayPal 同理）。
4. **账户维度下推**：`SourceTransaction.accountId?` / `CanonicalFact.accountId?` / `RecoveryOpportunity.accountId?` / `ClaimItem.accountId?` / `EvidenceArtifact.accountId?`（全部**服务端派生**，客户端不得自证）。
5. **fact identity 升级**：`factKey` 含账户维度；唯一约束改为 `(organizationId, accountId, factKey)` + **partial unique 兼容 legacy**（`accountId IS NULL` 走旧索引），确保「不同账号不再合并」。
6. **回填与 fail-closed**：迁移内置重复审计（同 org 同 factKey 不同 account → 冲突清单，**禁止静默合并**）；无法推断的历史行保持 `NULL`（legacy unscoped）；新写入强制账户维度。

## 5. C2 最低验收（12 项 → 未来永久回归基线）

1. one org / two Amazon accounts；2. one org / Amazon + TikTok；3. same externalAccountId across two orgs → allowed/isolation；4. cross-account claim access → reject；5. cross-account evidence binding → reject；6. cross-account settlement linkage → reject；7. client account spoof → reject；8. revoked account 不能 ingest 新事实；9. reconnect/credential rotation 不重写历史 provenance；10. account-level concurrency/idempotency；11. organization-level aggregate view 仍可行；12. **R46 full regression 保持绿色**（S1–S6 的 186 files / 1839 tests 作为门槛）。

## 6. 本批不做（与 MSG-65 一致）

不直接修改 Schema · 不为每平台写并行系统 · 不实现全量同步模块 · token/secret 不入 `PlatformAccount` · 不用 `label` 当身份 · 不合并跨账户 CanonicalFact · 当前不做 Enterprise RBAC / account-scoped ACL（仅预留挂点）· 不开放 Production API / external write · 不把 `R46 = CLOSED` 解释为 R13 通过。

## 7. 请裁决

1. §1 的 8 问判定与 §2 gap matrix 是否认可？
2. §4 的最小 Schema Delta 方向是否批准（实施时仍会提交具体迁移 + 回填审计 + 12 项验收）？
3. `identityVersion` 是否作为外部账户身份的必填维度？
