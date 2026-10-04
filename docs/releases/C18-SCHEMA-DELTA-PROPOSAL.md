# C18 — SCHEMA DELTA PROPOSAL（ProviderTenantBinding 持久化 + WebhookReplayClaim 持久化）

> 状态：**PROPOSAL / NOT APPLIED**。本文件只是提案，**没有**写任何 migration、没有改 `schema.prisma`。
> 依据 MSG-20261004-16 / -17 / -18 的硬停条件：新 Schema / migration 必须先送 Schema Delta 审计，通过后才允许落库
> （“先送 Schema Delta，再 migration；不要先建表再审”）。
> 归属：LAYER 3 / P0 = C18 REAL CUSTOMS PROVIDER INTEGRATION（Gate 7 / gate/7-commercial-validation）。

## 0. 为什么需要这两张表

当前 C18 离线骨架把两件事做成了**契约 + 端口**，但没有持久化：

| 能力 | 现有代码（已 PASS / 待 Final） | 缺的持久化 |
| --- | --- | --- |
| server-derived provider 租户绑定（含代客提交权证据） | `apps/api/src/services/customs/customs-provider-tenant-binding.ts` | `CustomsProviderTenantBinding` |
| webhook 重放的 atomic durable claim | `apps/api/src/services/customs/customs-provider-webhook-replay-claim.ts` | `CustomsProviderWebhookReplayClaim` |

两者都是 **Production Enablement 硬门槛**：前者决定“我们是否有权替这位客户向 provider 提交”，后者决定“同一个 webhook 会不会被处理两次”。
它们不影响内部 golden path，也不改变任何既有表。

## 1. 设计原则（与既有架构一致）

1. **纯新增**：只 add model / add index / add enum；不修改、不重命名、不删除任何既有表或列。
2. **租户隔离**：所有业务查询一律带 `organizationId`；跨租户读取必须不可能（沿用 C17 / CA 系列口径）。
3. **append-only**：授权 lineage 与 webhook claim 都是“只追加”语义，不做就地更新历史事实。
4. **server-derived**：`verifiedAt` / `observedAt` / `contentDigest` / claim 时间等一律服务端计算，客户端自报即拒绝（现有代码已经这样做）。
5. **opaque 引用**：evidence / credential / source 一律只存 opaque 引用，绝不存合同正文、凭据本体、原始 webhook payload。
6. **无 PII**：不存 IP / UA / 邮箱 / 电话；SEO-3 的限流保留哈希键（若未来也要持久化，同样只存哈希）。

## 2. 提案 A — `CustomsProviderTenantBinding`

```prisma
model CustomsProviderTenantBinding {
  id                      String   @id @default(uuid())
  organizationId          String
  providerId              String   // provider-neutral id，与 C15 CustomsFilingProvider.providerId 同义
  providerTenantRef       String   // server-derived，opaque
  providerAccountRef      String   // server-derived，opaque（broker 账号 / ABI filer code 引用）
  relationship            String   // CROSSCLAIM_SAAS | BROKER_OF_RECORD | CLIENT_DIRECT | REFERRAL_PARTNER
  relationshipEvidenceRef String?  // opaque；代客提交权必须有值
  relationshipVerifiedAt  DateTime? // 该 relationship 的验证时间；未验证 = null
  jurisdictionScope       String[] // ['*'] 或 ISO-3166 alpha-2
  status                  String   // ACTIVE | PENDING_VERIFICATION | SUSPENDED | REVOKED
  verifiedAt              DateTime? // provider/账号绑定本身的验证时间
  credentialReference     String?  // 只允许是引用（未来接 Secret Manager / KMS key id）
  createdAt               DateTime @default(now())
  updatedAt               DateTime @updatedAt

  lineage CustomsProviderTenantBindingLineage[]

  @@unique([organizationId, providerId])
  @@index([organizationId, providerId, status])
}

model CustomsProviderTenantBindingLineage {
  id          String   @id @default(uuid())
  bindingId   String
  event       String   // BOUND | REBOUND | REAUTH_REQUIRED | SUSPENDED | REVOKED | RESTORED
  actorRef    String   // opaque
  note        String?
  occurredAt  DateTime
  recordedAt  DateTime @default(now())
  sourceRef   String?  // opaque（webhook delivery id / 人工工单号）

  binding CustomsProviderTenantBinding @relation(fields: [bindingId], references: [id], onDelete: Restrict)

  @@index([bindingId, occurredAt])
}
```

关键不变量（与代码一致，落库后由唯一约束 + 事务保证）：

- `(organizationId, providerId)` 唯一 → 一个租户对一个 provider 只有一条**当前**绑定；
  历史变化由 lineage 表达，不靠多行绑定。
- `relationship = 'CROSSCLAIM_SAAS'` 时，代码要求 `relationshipVerifiedAt != null` 且 `relationshipEvidenceRef` 是合法 opaque 引用，
  否则 fail-closed（`RELATIONSHIP_NOT_VERIFIED`）。数据库层建议加 **CHECK**（若采用原生迁移）或由服务层强校验 + 审计测试覆盖。
- `status != 'ACTIVE'` → 一律 fail-closed，不构造任何提交请求。
- `credentialReference` 只存引用，**永不**存 secret 值。

## 3. 提案 B — `CustomsProviderWebhookReplayClaim`

```prisma
model CustomsProviderWebhookReplayClaim {
  id          String   @id @default(uuid())
  providerId  String
  deliveryId  String
  claimedAt   DateTime @default(now())
  outcome     String   @default("CLAIMED") // CLAIMED | PROCESSED | REJECTED（终态仅用于取证）

  @@unique([providerId, deliveryId])
  @@index([claimedAt])
}
```

关键不变量：

- `(providerId, deliveryId)` 唯一约束 = **atomic durable claim** 的落地点。
  实现方式：`INSERT ... ON CONFLICT DO NOTHING`（或 Prisma 捕获 P2002）后以“受影响行数 / 是否新建”判定**唯一赢家**；
  并发两个相同 webhook 时只有一个拿到 `CLAIMED`，另一个必须得到 `ALREADY_CLAIMED` → 返回 `REPLAY_DETECTED`。
- **先验签再 claim**：坏签名绝不写入 claim 行（否则攻击者可用坏签名烧掉合法 deliveryId）。
- 只存 `providerId` / `deliveryId` / 时间 / 取证状态；**不存 raw body、不存 payload、不存签名**。
- 保留策略：建议按 `claimedAt` 分区或定期清理（例如 180 天），但保留窗口必须 ≥ provider 官方重投窗口 + 对账窗口。

## 4. 迁移与回滚策略

- 类型：**additive only**（纯新增表 + 索引 + 外键），无数据回填、无 drop、无列改名。
- 影响面：现有 71 个 migration、82 个 Prisma model 均不受影响；C17 `CustomsSubmissionAttempt*` 不变。
- 顺序：本提案 → Schema Delta 审计 → 通过后写 migration（`prisma migrate dev` 生成 SQL 并 review）→ 落库 → 服务层接线（把端口实现从 in-memory 换成 Prisma store）→ 回归。
- 回滚：删除两张新表即可（无既有表依赖）；但一旦开始写入真实 claim / 绑定，回滚需先确认没有在途 webhook。
- 生产门槛不变：迁移通过**不等于**开启真实 transport / 真实 filing / 外写；这些仍由 HOST_ACTION_REQUIRED 控制。

## 5. 明确的“不做”

- 不新增任何 provider-specific 字段（不把某个 broker 的字段写死进核心表）。
- 不把 `RuleVersion` 的 SEO 契约下沉成表（SEO-2/3 仍走现有 JSON + typed codec）。
- 不引入 secret 存储；`credentialReference` 保持引用语义。
- 不修改 C17 的 ledger 不变量，也不新增第二套 submission root。
- 不在本批写 migration，不跑 `migrate deploy`。

## 6. 送审问题（Schema Delta 审计）

1. 两张表的字段与唯一约束是否足够支撑 C18 生产门槛？是否需要 `relationship` 的 CHECK 约束（CROSSCLAIM_SAAS ⇒ verified 字段非空）？
2. `CustomsProviderTenantBinding` 采用「一租户一 provider 一条当前绑定 + lineage 表」是否优于「多行有效窗口」？
3. `CustomsProviderWebhookReplayClaim` 的保留策略与 `outcome` 字段是否有必要，还是保持最小（providerId + deliveryId + claimedAt）？
4. 是否同意迁移顺序：本提案 → 审计 → migration → 服务层切换；以及“迁移通过 ≠ 开外写”的边界表述？
