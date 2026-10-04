# C18 — SCHEMA DELTA PROPOSAL v3.1（ProviderTenantBinding 持久化 + WebhookReplayClaim 持久化）

> v3.1 修正（MSG-20261004-24）：删除 Prisma 示例中重复的 `bindingScopeKey`；新增 `jurisdictionAnchor` 落列（bindingScopeKey 的正式输入，与身份字段一并 immutable、纳入 snapshot）；CHECK 使用 Prisma 带引号的 camelCase 列名；binding identity 增加 DB 级 immutable trigger。
>
> 状态：**REVISED PROPOSAL / NOT APPLIED**。本文件只是提案 v3，**没有**改 `schema.prisma`、**没有**写 migration、**没有**跑 `migrate deploy`。
> v2 依据 MSG-20261004-22（四条必修 + 两条建议）；**v3 依据 MSG-20261004-23**：B 已 PASS，A 仅剩「多 binding 下的稳定身份 + 确定性选择」，本轮把该项收口（principalRef 显式落列、bindingScopeKey 变为 immutable/versioned 稳定身份、resolver selection contract 明确 exactly-one/BINDING_AMBIGUOUS、lineage snapshot 纳入 principalRef、append-only 明确用 trigger）。`C18_INTERNAL_SKELETON = CLOSED` 不变，`MIGRATION / SCHEMA_PRISMA_CHANGE / MIGRATE_DEPLOY = HOLD`。

## 0. 为什么是纯新增

两张表都只服务 C18 生产门槛（`server-derived provider 租户绑定 + 代客提交权证据`、`webhook replay atomic durable claim`），当前只有契约 + 端口 + 进程内参考实现：

| 能力 | 现有代码 | 缺的持久化 |
| --- | --- | --- |
| provider 租户绑定 + 关系证据 | `apps/api/src/services/customs/customs-provider-tenant-binding.ts` | `CustomsProviderTenantBinding`（+ lineage） |
| webhook 重放 atomic durable claim | `apps/api/src/services/customs/customs-provider-webhook-replay-claim.ts` | `CustomsProviderWebhookReplayClaim` |

## 1. v2 相对 v1 的修订（对应 MSG-20261004-22）

| # | v1 | v2 |
| --- | --- | --- |
| ① | `@@unique([organizationId, providerId])` 只到 providerId | 引入 provider-neutral **`bindingScopeKey`**，唯一键改为 `@@unique([organizationId, providerId, bindingScopeKey])`，不再锁死"同一 provider 仅一个账号" |
| ② | 无 tenant-owned 规范化 | A 表补 `organizationId` + `Organization` relation + `@@unique([organizationId, id])`；lineage 显式带 `organizationId` 并由 FK/tenant-integrity 保证与 binding 同租户 |
| ③ | lineage 只有 event/actor/note/occurredAt/sourceRef | lineage 增加**安全 canonical snapshot**（不含 secret）+ `snapshotDigest`，可重建历史；append-only 由 DB 真正 enforce（UPDATE/DELETE reject）；current 更新与 lineage append 同事务 |
| ④ | ReplayClaim 有 `outcome` 状态机 | **删除 `outcome`**，只做 immutable replay lock（`id/providerId/deliveryId/claimedAt`）；retention 保留但**不硬编码 180d**（真实 Provider 选定前 `AUTO_PURGE = OFF`） |
| 建议 | String 真值、无 DB CHECK | `relationship` / `status` / lineage `event` 改为 Prisma enum；`CROSSCLAIM_SAAS ⇒ 关系证据非空` 下沉 DB CHECK |
| v3 | （MSG-20261004-23 残留）无 principalRef 落列、bindingScopeKey 依赖可变账号、resolver 可能拿"第一条" | 显式 `principalRef` + `bindingScopeVersion` + immutable `bindingScopeKey` + `bindingSlotRef`；resolver 要求 exactly-one，>1 → `BINDING_AMBIGUOUS`；lineage snapshot 纳入 principalRef；append-only 用 trigger |

## 2. 枚举（Prisma enum，避免非法真值入库）

```prisma
enum CustomsProviderRelationship { CROSSCLAIM_SAAS  BROKER_OF_RECORD  CLIENT_DIRECT  REFERRAL_PARTNER }
enum CustomsProviderBindingStatus { ACTIVE  PENDING_VERIFICATION  SUSPENDED  REVOKED }
enum CustomsProviderBindingEvent { BOUND  REBOUND  REAUTH_REQUIRED  SUSPENDED  REVOKED  RESTORED }
```

## 3. 提案 A — `CustomsProviderTenantBinding`（v2）

```prisma
model CustomsProviderTenantBinding {
  id                      String   @id @default(uuid())
  organizationId          String
  organization            Organization @relation(fields: [organizationId], references: [id], onDelete: Restrict)
  /// server-derived opaque IOR / 法人引用（绑定身份的一部分；MSG-20261004-23 ①）
  principalRef            String
  /// 绑定身份版本（v1）；升级时新增列值而不是改写历史
  bindingScopeVersion     String   @default("v1")
  /// bindingScopeKey 的正式输入之一（provenance：可解释该 binding 当初为何属于此 scope key）。
  jurisdictionAnchor      String
  /// 稳定绑定身份键：v1 + principalRef + jurisdictionAnchor + bindingSlotRef 的 canonical sha256。
  /// 创建后 immutable；不依赖 mutable providerTenantRef / providerAccountRef；不因 jurisdictionScope 扩容而变化。
  bindingScopeKey         String
  /// CrossClaim 自有的稳定 slot（同一 principal + provider + jurisdiction 并存多账号时用于区分，
  /// 绝不是 provider 当前账号 ID 的别名）
  bindingSlotRef          String
  providerId              String
  providerTenantRef       String
  providerAccountRef      String
  relationship            CustomsProviderRelationship
  relationshipEvidenceRef String?
  relationshipVerifiedAt  DateTime?
  jurisdictionScope       String[]
  status                  CustomsProviderBindingStatus
  verifiedAt              DateTime?
  credentialReference     String?
  createdAt               DateTime @default(now())
  updatedAt               DateTime @updatedAt

  lineage CustomsProviderTenantBindingLineage[]

  @@unique([organizationId, id])
  @@unique([organizationId, providerId, bindingScopeKey])
  @@index([organizationId, providerId, principalRef, status])
  @@index([organizationId, providerId, status])
  @@index([organizationId, bindingScopeKey])
}
```

### 3.1 `bindingScopeKey` 派生（immutable / versioned）

```
bindingScopeKey = sha256(canonicalJson{
  version: "v1",
  principalRef,
  jurisdictionAnchor,   // '*' 或 ISO-3166 alpha-2
  bindingSlotRef        // CrossClaim 生成的稳定 opaque slot
})
```

约束（全部为硬约束，FINAL-3 请核这三条）：

1. **server-derived**：三个输入全部来自服务端；不接受客户端自报。
2. **immutable after creation**：一旦写入不可改写；账号 rebind（providerAccountRef A→B）**不**改变 binding identity，只追加 lineage。
3. **不依赖可变 provider 状态**：不使用 `providerTenantRef` / `providerAccountRef` / 当前 `jurisdictionScope` 内容；同一 `principalRef + provider + jurisdiction` 若要并存多账号，用 `bindingSlotRef` 区分。

### 3.2 Resolver selection contract（取代 `.find(providerId)`）

```
organizationId + providerId + principalRef + jurisdiction
  → exactly one applicable binding

0 条 → BINDING_UNKNOWN
>1 条（无法唯一确定）→ BINDING_AMBIGUOUS → fail-closed（nextAction = null）
```

- **绝不允许** `owned.find((row) => row.providerId === query.providerId)` 这种"第一条 provider binding"取法。
- 纯函数层另有 `PRINCIPAL_MISMATCH`（binding.principalRef ≠ query.principalRef）作为纵深防御。
- 代码已按此契约实现（`customs-provider-tenant-binding.ts`：`isValidProviderTenantBindingQuery` / `computeProviderBindingScopeKey` / `createInMemoryCustomsProviderTenantBindingResolver`），测试覆盖多账号选择、歧义 fail-closed、principal 不匹配。

DB 级 CHECK（migration 手写 SQL 部分）：

```sql
CHECK ("relationship" <> 'CROSSCLAIM_SAAS'
       OR ("relationshipEvidenceRef" IS NOT NULL AND "relationshipVerifiedAt" IS NOT NULL))
```

语义：**一个租户 + 一个 provider + 一个 binding scope** 才唯一；同一客户在同一 filing provider 下的不同 IOR / 法人 / 辖区可以有各自的 binding，不被锁死。

## 4. 提案 A2 — `CustomsProviderTenantBindingLineage`（v2，可重建历史）

```prisma
model CustomsProviderTenantBindingLineage {
  id              String   @id @default(uuid())
  organizationId  String
  organization    Organization @relation(fields: [organizationId], references: [id], onDelete: Restrict)
  bindingId       String
  binding         CustomsProviderTenantBinding @relation(fields: [bindingId], references: [id], onDelete: Restrict)
  event           CustomsProviderBindingEvent
  actorRef        String
  note            String?
  /// 该事件后的安全 canonical 绑定快照（不含任何 secret / 凭据本体 / 合同正文）：
  /// { providerTenantRef, providerAccountRef, principalRef, bindingScopeVersion, bindingScopeKey,
  ///   bindingSlotRef, relationship,
  ///   relationshipEvidenceRef, relationshipVerifiedAt, jurisdictionScope, status, verifiedAt }
  snapshot        Json
  snapshotDigest  String   // sha256(canonical(snapshot))；migration 补 CHECK ("snapshotDigest" ~ '^[0-9a-f]{64}
  occurredAt      DateTime
  recordedAt      DateTime @default(now())
  sourceRef       String?

  @@index([organizationId, bindingId, occurredAt])
}
```

强制项（migration 必须真正实现，不只在文档里声明）：

1. **append-only = trigger**（MSG-20261004-23 ④ 已裁决）：沿用仓库既有模式 `cc_append_only__*` + `BEFORE UPDATE OR DELETE` trigger 直接 reject；**不以** `REVOKE UPDATE, DELETE` 为主（权限模型可能被 owner/migration role 绕过，且与现有 DB invariant 风格不一致）。
2. **tenant integrity trigger**：`lineage.organizationId` 必须等于其 binding 的 `organizationId`，沿用 `crossclaim_assert_tenant_integrity()` + `BEFORE INSERT OR UPDATE` trigger。
3. **同事务**：current binding 的更新与 lineage append 必须在同一事务内完成（服务层 + 测试保证）。
4. 服务层写入前计算 `snapshotDigest`（canonical key-sorted SHA-256，与 C18-8 `providerSubmissionPayloadDigest` 同一 canonical 规则）。
5. `previousSnapshot` **不需要**（MSG-20261004-23 ②：上一条 lineage 本身即 previous state）；snapshot 语义表述为"可重建任一时点的 authorization / provider-binding decision state"（`credentialReference` 故意不入 snapshot，凭据轮换审计另行处理）。

## 5. 提案 B — `CustomsProviderWebhookReplayClaim`（v2，immutable replay lock）

```prisma
model CustomsProviderWebhookReplayClaim {
  id          String   @id @default(uuid())
  providerId  String
  deliveryId  String
  claimedAt   DateTime @default(now())

  @@unique([providerId, deliveryId])
  @@index([claimedAt])
}
```

- 唯一职责：**这个 deliveryId 有没有被领取过**。没有 `outcome`、没有状态机（避免"防重锁兼状态机"和 append-only 声明自相矛盾）。
- 领取语义：`INSERT ... ON CONFLICT DO NOTHING`（或捕获 P2002）后按"是否新建"判定唯一赢家；并发相同 webhook 只有一个 `CLAIMED`，另一个 `REPLAY_DETECTED`。
- **先验签再 claim**：坏签名绝不 INSERT（否则攻击者可用坏签名烧掉合法 deliveryId）。
- 不存 raw body / payload / 签名。
- **保留策略**：`retention >= provider 官方最大 redelivery/replay window + CrossClaim 对账/事故窗口`；真实 Provider 选定前 **`AUTO_PURGE = OFF`**（记录极小，早删 replay key 的风险远大于多存）；选定后再定 180d/365d 并补 cleanup test。`@@index([claimedAt])` 保留，用于未来 cleanup。

## 6. Migration 执行顺序（v2，仍 HOLD）

```
Revised Schema Delta（本文件）
→ ARCHITECT PASS
→ 修改 schema.prisma
→ 生成 migration SQL
→ 人工 review SQL（含 CHECK / append-only enforce / tenant integrity）
→ prisma validate
→ fresh DB migration
→ Prisma stores 替换进程内实现
→ 真实 PostgreSQL concurrency / tenant / append-only E2E
→ C18 Production Persistence Checkpoint
```

配套验收（migration PASS 后必须补）：

- B：两个独立 PG 连接并发同一 `(providerId, deliveryId)` → 恰好一个 `CLAIMED` + 一个 `ALREADY_CLAIMED`。
- A：cross-tenant reject；非法 relationship 状态 reject；`CROSSCLAIM_SAAS` 缺证据在 **DB 层** reject；并发 rebind 不丢 lineage；lineage `UPDATE`/`DELETE` 被拒绝。

## 7. 明确的"不做"

- 不修改既有 71 个 migration / 82 个 model；不动 C17 ledger 与 `CustomsSubmissionAttempt*`。
- 不引入 provider 专有字段；`bindingscope` 在真实 Provider 选定前保持 provider-neutral。
- 不存 secret / 凭据本体 / 合同正文 / raw webhook payload。
- 不把 SEO 契约（RuleVersion）下沉成表。
- 本轮**只改提案**；不写 migration、不改 `schema.prisma`、不跑 `migrate deploy`。

## 8. 送审问题（C18 SCHEMA DELTA FINAL-2）

1. `bindingScopeKey` 的派生口径（principalRef/IOR + jurisdiction + account hint）是否足够 provider-neutral、且足以支撑"同客户多 IOR/多辖区多账号"？（派生规则的实现细节将随后写进 Schema Delta FINAL-2 的实现说明。）
2. lineage 的 snapshot 字段集是否完整到"仅靠 lineage 即可重建任一时点的绑定真值"？是否还需要显式 `previousSnapshot`？
3. B 删除 `outcome` 后，webhook 处理生命周期若将来需要，是否同意另建 append-only fact（而不是复活 outcome）？
4. append-only 的实现方式选择：revoke DML 权限 vs trigger 拒绝，哪一种更符合本仓库既有迁移风格？
)  -- 逐句 review 时确认列名为带引号 camelCase
  occurredAt      DateTime
  recordedAt      DateTime @default(now())
  sourceRef       String?

  @@index([organizationId, bindingId, occurredAt])
}
```

强制项（migration 必须真正实现，不只在文档里声明）：

1. **append-only = trigger**（MSG-20261004-23 ④ 已裁决）：沿用仓库既有模式 `cc_append_only__*` + `BEFORE UPDATE OR DELETE` trigger 直接 reject；**不以** `REVOKE UPDATE, DELETE` 为主（权限模型可能被 owner/migration role 绕过，且与现有 DB invariant 风格不一致）。
2. **tenant integrity trigger**：`lineage.organizationId` 必须等于其 binding 的 `organizationId`，沿用 `crossclaim_assert_tenant_integrity()` + `BEFORE INSERT OR UPDATE` trigger。
3. **同事务**：current binding 的更新与 lineage append 必须在同一事务内完成（服务层 + 测试保证）。
4. 服务层写入前计算 `snapshotDigest`（canonical key-sorted SHA-256，与 C18-8 `providerSubmissionPayloadDigest` 同一 canonical 规则）。
5. `previousSnapshot` **不需要**（MSG-20261004-23 ②：上一条 lineage 本身即 previous state）；snapshot 语义表述为"可重建任一时点的 authorization / provider-binding decision state"（`credentialReference` 故意不入 snapshot，凭据轮换审计另行处理）。

## 5. 提案 B — `CustomsProviderWebhookReplayClaim`（v2，immutable replay lock）

```prisma
model CustomsProviderWebhookReplayClaim {
  id          String   @id @default(uuid())
  providerId  String
  deliveryId  String
  claimedAt   DateTime @default(now())

  @@unique([providerId, deliveryId])
  @@index([claimedAt])
}
```

- 唯一职责：**这个 deliveryId 有没有被领取过**。没有 `outcome`、没有状态机（避免"防重锁兼状态机"和 append-only 声明自相矛盾）。
- 领取语义：`INSERT ... ON CONFLICT DO NOTHING`（或捕获 P2002）后按"是否新建"判定唯一赢家；并发相同 webhook 只有一个 `CLAIMED`，另一个 `REPLAY_DETECTED`。
- **先验签再 claim**：坏签名绝不 INSERT（否则攻击者可用坏签名烧掉合法 deliveryId）。
- 不存 raw body / payload / 签名。
- **保留策略**：`retention >= provider 官方最大 redelivery/replay window + CrossClaim 对账/事故窗口`；真实 Provider 选定前 **`AUTO_PURGE = OFF`**（记录极小，早删 replay key 的风险远大于多存）；选定后再定 180d/365d 并补 cleanup test。`@@index([claimedAt])` 保留，用于未来 cleanup。

## 6. Migration 执行顺序（v2，仍 HOLD）

```
Revised Schema Delta（本文件）
→ ARCHITECT PASS
→ 修改 schema.prisma
→ 生成 migration SQL
→ 人工 review SQL（含 CHECK / append-only enforce / tenant integrity）
→ prisma validate
→ fresh DB migration
→ Prisma stores 替换进程内实现
→ 真实 PostgreSQL concurrency / tenant / append-only E2E
→ C18 Production Persistence Checkpoint
```

配套验收（migration PASS 后必须补）：

- B：两个独立 PG 连接并发同一 `(providerId, deliveryId)` → 恰好一个 `CLAIMED` + 一个 `ALREADY_CLAIMED`。
- A：cross-tenant reject；非法 relationship 状态 reject；`CROSSCLAIM_SAAS` 缺证据在 **DB 层** reject；并发 rebind 不丢 lineage；lineage `UPDATE`/`DELETE` 被拒绝。

## 7. 明确的"不做"

- 不修改既有 71 个 migration / 82 个 model；不动 C17 ledger 与 `CustomsSubmissionAttempt*`。
- 不引入 provider 专有字段；`bindingscope` 在真实 Provider 选定前保持 provider-neutral。
- 不存 secret / 凭据本体 / 合同正文 / raw webhook payload。
- 不把 SEO 契约（RuleVersion）下沉成表。
- 本轮**只改提案**；不写 migration、不改 `schema.prisma`、不跑 `migrate deploy`。

## 8. 送审问题（C18 SCHEMA DELTA FINAL-2）

1. `bindingScopeKey` 的派生口径（principalRef/IOR + jurisdiction + account hint）是否足够 provider-neutral、且足以支撑"同客户多 IOR/多辖区多账号"？（派生规则的实现细节将随后写进 Schema Delta FINAL-2 的实现说明。）
2. lineage 的 snapshot 字段集是否完整到"仅靠 lineage 即可重建任一时点的绑定真值"？是否还需要显式 `previousSnapshot`？
3. B 删除 `outcome` 后，webhook 处理生命周期若将来需要，是否同意另建 append-only fact（而不是复活 outcome）？
4. append-only 的实现方式选择：revoke DML 权限 vs trigger 拒绝，哪一种更符合本仓库既有迁移风格？
