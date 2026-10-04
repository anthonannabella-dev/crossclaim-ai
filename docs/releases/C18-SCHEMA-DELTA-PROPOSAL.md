# C18 — SCHEMA DELTA PROPOSAL v2（ProviderTenantBinding 持久化 + WebhookReplayClaim 持久化）

> 状态：**REVISED PROPOSAL / NOT APPLIED**。本文件只是提案 v2，**没有**改 `schema.prisma`、**没有**写 migration、**没有**跑 `migrate deploy`。
> v2 依据 MSG-20261004-22 的四条最小必修 + 两条建议（enum、DB CHECK）修订；`C18_INTERNAL_SKELETON = CLOSED` 不变，`MIGRATION / SCHEMA_PRISMA_CHANGE / MIGRATE_DEPLOY = HOLD`。

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
  providerId              String
  providerTenantRef       String
  providerAccountRef      String
  /// provider-neutral 绑定作用域键：由 (principalRef/IOR, jurisdiction, account hint) 稳定派生，
  /// 真实 Provider 选定前不绑定任何 provider 专有字段。
  bindingScopeKey         String
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
  @@index([organizationId, providerId, status])
  @@index([organizationId, bindingScopeKey])
}
```

DB 级 CHECK（migration 手写 SQL 部分）：

```sql
CHECK (relationship <> 'CROSSCLAIM_SAAS'
       OR (relationship_evidence_ref IS NOT NULL AND relationship_verified_at IS NOT NULL))
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
  /// { providerTenantRef, providerAccountRef, bindingScopeKey, relationship,
  ///   relationshipEvidenceRef, relationshipVerifiedAt, jurisdictionScope, status, verifiedAt }
  snapshot        Json
  snapshotDigest  String   // sha256(canonical(snapshot))
  occurredAt      DateTime
  recordedAt      DateTime @default(now())
  sourceRef       String?

  @@index([organizationId, bindingId, occurredAt])
}
```

强制项（migration 必须真正实现，不只在文档里声明）：

1. **append-only**：对 lineage 表 revoke `UPDATE` / `DELETE`（或等价 trigger：`UPDATE`/`DELETE` 直接 `RAISE EXCEPTION`）。
2. **tenant integrity**：`lineage.organizationId` 必须等于其 binding 的 `organizationId`（复合 FK 或 trigger 校验）。
3. **同事务**：current binding 的更新与 lineage append 必须在同一事务内完成（服务层 + 测试保证）。
4. 服务层写入前计算 `snapshotDigest`（canonical key-sorted SHA-256，与 C18-8 `providerSubmissionPayloadDigest` 同一 canonical 规则）。

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
