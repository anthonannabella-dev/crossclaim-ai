# SCHEMA DELTA PROPOSAL — Integration Foundation（B2）+ Structured Domain Facts（B5）

状态：**PROPOSAL / DESIGN ONLY**（未写 migration；须架构方放行后才实施）。
来源：`docs/releases/BACKEND-ARCHITECTURE-DIRECTIVE.md` §6–§11、§30、§32 B2/B5；本提案与 `PHASE-B2-INTEGRATION-FOUNDATION-DESIGN.md`、`CARRIER-QUEUE-*-CHECKPOINT.md` 配套。
硬约束：不新增与 PlatformAccount / SourceConnection / Claim / Settlement 平行的事实源；凭据永不入库（只留 credentialRef）；tenant isolation / append-only 触发器沿用既有清单。

## 1. 8 个模型（列 / 约束 / 索引）

1. **OAuthAuthorizationSession**：`id, organizationId, actorUserId, provider, stateHash(unique), pkceRef, requestedScopes[], returnPath, expiresAt, consumedAt?, createdAt`；索引 `(organizationId, provider, expiresAt)`；`stateHash` 唯一（state 明文不落库）。
2. **ConnectionCapability**：`id, organizationId, connectionId, capability, status(SUPPORTED|UNSUPPORTED|REQUIRES_SCOPE|REQUIRES_PARTNER_APPROVAL|UNKNOWN), source, checkedAt, expiresAt?, metadata(json), createdAt, updatedAt`；唯一键 `(organizationId, connectionId, capability)`。
3. **ConnectionSyncState**：`id, organizationId, connectionId, resourceType(ACCOUNT|SHIPMENT|TRACKING|INVOICE|POD|SETTLEMENT), cursor?, watermark?, lastStartedAt?, lastSuccessAt?, nextSyncAt?, failureCount(default 0), lastErrorCode?, createdAt, updatedAt`；唯一键 `(connectionId, resourceType)`。
4. **DomainFactSnapshot**（immutable / versioned）：`id, organizationId, accountId, domain, channel, factType, entityKey, schemaVersion, payload(json), snapshotDigest, observedAt, createdAt`；唯一键 `(organizationId, accountId, domain, factType, entityKey, schemaVersion, snapshotDigest)`；`entityKey` 由服务端派生（禁止客户端可信标识）。
5. **DomainFactSnapshotSource**：`id, organizationId, snapshotId, sourceTransactionId, createdAt`；唯一键 `(snapshotId, sourceTransactionId)`；外键指向 SourceTransaction（**禁止无来源事实**）。
6. **DocumentExtraction**：`id, organizationId, fileAssetId, documentType(CBP_7501|C88|CHINA_CUSTOMS_DECLARATION|COMMERCIAL_INVOICE|RATE_CARD|POD|OTHER), extractor, extractorVersion, schemaVersion, status(PENDING|PROCESSING|EXTRACTED|NEEDS_REVIEW|FAILED), payload(json), payloadDigest, reviewRequired, errorCode?, startedAt?, finishedAt?, createdAt`；索引 `(organizationId, status)`、`(fileAssetId)`。
7. **AsyncJob**：`id, organizationId, jobType(CONNECTION_SYNC|DOCUMENT_EXTRACT|DOMAIN_NORMALIZE|OPPORTUNITY_SCAN|CLAIM_STATUS_SYNC|SETTLEMENT_SYNC), idempotencyKey(unique), status, payload(json), attemptCount, maxAttempts, nextRunAt, lockedAt?, lockedBy?, lastErrorCode?, createdAt, updatedAt, finishedAt?`；索引 `(status, nextRunAt)`；worker 使用 `FOR UPDATE SKIP LOCKED`。
8. **OutboxEvent**：`id, organizationId, eventType, aggregateType, aggregateId, payload(json), occurredAt, publishedAt?, attemptCount`；索引 `(publishedAt, occurredAt)`；与业务写**同事务**提交。

## 2. 与既有体制对齐

- 租户隔离：上表全部带 `organizationId`，纳入既有 tenant 触发器清单（`tools/tenant-triggers/emit-check-sql.mjs` 校验）。
- Append-only：OAuthAuthorizationSession（除 consumedAt）、DomainFactSnapshot / Source、OutboxEvent、DocumentExtraction（终态后）纳入 append/controlled-mutation 触发器清单（`emit-check-append-only-sql.mjs`）。
- 凭据：任何表都不含 access/refresh token、client secret；只允许 `credentialRef`。
- 与既有链的关系：`External Source → SourceConnection → SourceTransaction → (DomainFactSnapshot) → CanonicalFact/RuleEvaluation → RecoveryOpportunity → …` 不变；DomainFactSnapshot 只是结构化事实的版本化快照，**不替代** CanonicalFact。

## 3. Structured Domain Facts payload（B5）

### 3.1 `shipment/v1`

```json
{
  "trackingNumber": "1Z999AA10123456784",
  "carrier": "UPS",
  "serviceLevel": "GROUND",
  "labelPurchaseSource": "AMAZON_BUY_SHIPPING | MERCHANT_CARRIER | PLATFORM_SHIPPING | UNKNOWN",
  "shipperExternalAccountId": "UPS-ACCT-1",
  "promisedDeliveryAt": "2026-10-01T12:00:00.000Z",
  "actualDeliveryAt": "2026-10-01T14:00:00.000Z",
  "shippingCharge": "41.30",
  "currency": "USD",
  "invoiceReference": "UPS-INV-1",
  "destination": "US-TX",
  "pickupAt": null,
  "rateClass": null,
  "dimWeight": null,
  "actualWeight": null,
  "slaSuspension": null,
  "podState": "SIGNATURE | PHOTO | ELECTRONIC | NONE | UNKNOWN",
  "carrierException": null
}
```

规则：金额一律十进制字符串 + 3 位大写币种（同 Queue #5 口径）；未知字段保留 `null`，不得猜测。

### 3.2 `customs-entry/v1`

```json
{
  "documentType": "CBP_7501 | C88 | CHINA_CUSTOMS_DECLARATION | OTHER",
  "entryNumber": "…",
  "jurisdiction": "US | GB | CN | …",
  "entryDate": "2026-09-30",
  "importer": "…",
  "brokerReference": null,
  "hsCode": "…",
  "declaredValue": "1000.00",
  "dutyPaid": "52.00",
  "taxPaid": null,
  "currency": "USD"
}
```

## 4. 待架构方裁决点

① 8 模型是否放行（含 DomainFactSnapshot 与 CanonicalFact 的边界、`entityKey` 派生规则）；② DocumentExtraction 是否仅允许输出到 SourceTransaction / DomainFactSnapshot（禁止 PDF→LLM→Claim）；③ AsyncJob/Outbox 的并发与幂等验收口径；④ shipment/v1 与 customs-entry/v1 字段冻结；⑤ 实施排期（建议在 Queue #6/#7 与 B1 之后）。

## 5. 非目标

不引入 Python/FastAPI/Celery/Redis/Temporal；不改动既有 API contract；不在本提案内实现任何真实 provider 调用。
