# CARRIER QUEUE #5 — INVOICE + POD READ PLANE CHECKPOINT

状态：**READY_FOR_REVIEW**（read-only carrier evidence plane；真实凭据 / 真实 provider 调用继续 HOLD_EXTERNAL）
前序：MSG-20261003-109 ④ `CARRIER QUEUE #4 = PASS / CLOSED`；⑤ 授权本单元（⑪–㉖）。
IMPLEMENTATION_HEAD = ccc4345
IMPLEMENTATION_HEAD_FULL = ccc4345b1a1b492feac0361fde76299c37cb8e6d
CI = SUCCESS · RUN_ID = 37074580689 · CI_VERIFIED_HEAD = ccc4345
边界：**NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据**。

## 1. Invoice 只读事实平面（⑬⑭⑮⑯）

- `CarrierInvoiceReadPort.getInvoiceFacts({ provider, credentialRef, externalAccountId, organizationId, invoiceReference?, trackingNumber? })` → `CarrierRawInvoiceRecord[]`；invoiceReference / trackingNumber **只是查询条件**，account identity 仍由 verified lineage 决定。
- `CarrierInvoiceFact`：provider / externalAccountId / invoiceReference / invoiceDate / trackingNumber / shipmentReference / serviceLevel / currency / baseCharge / fuelSurcharge / accessorialCharges / tax / totalCharge / billedWeight / billedZone / rawChargeCodes[] / charges[] / rawReference / observedAt。
- **金额一律十进制字符串**（`isDecimalString` + `addDecimalStrings` BigInt 精确加总，不经过 float）；非法金额 → `INVALID_AMOUNT`，非 3 位大写货币 → `CURRENCY_REQUIRED`。
- 只建立 **carrier-billed facts**：outcome 带 `billingTruthOnly: true`，**不推导** refund due / recovery due / success fee due。
- charge kind 归一化 `BASE / FUEL / RESIDENTIAL / REMOTE_AREA / ADDRESS_CORRECTION / DIMENSIONAL / OVERSIZE / DUTY_TAX / OTHER`，**raw carrier charge code 全量保留**，未知 → `OTHER`（不猜）；UPS / FedEx charge map 各自独立。

## 2. POD 只读事实平面（⑰⑱⑲⑳）

- `CarrierPODReadPort.getPOD({ provider, credentialRef, externalAccountId, trackingNumber, organizationId })` → `CarrierRawPODRecord`（同样经过 verified lineage）。
- `CarrierPODFact`：provider / externalAccountId / trackingNumber / deliveryStatus（DELIVERED / ATTEMPTED / UNKNOWN）/ deliveredAt / deliveryLocation / recipientNameMasked / signed / signatureAvailable / proofType（SIGNATURE / PHOTO / ELECTRONIC / UNKNOWN）/ documentReference / rawReference / observedAt。
- 隐私：recipient name 只回 `maskRecipientName` 掩码（如 `J***`）；signature image 与完整 provider payload 不进入 response；原始文档只留 `documentReference`（artifact reference）。
- `deliveryEvidenceOnly: true`：POD 只说明 carrier 返回了什么交付证据，不推导 delivered successfully / customer received / claim invalid / refund not due。

## 3. Provenance / 失败分类 / raw 边界（㉑㉒㉓㉔）

- request ↔ response 双向绑定：account 不符 → `ACCOUNT_MISMATCH`；invoice reference 不符 → `INVOICE_IDENTITY_MISMATCH`；invoice tracking 不符 → `TRACKING_IDENTITY_MISMATCH`；POD tracking 不符 → `POD_TRACKING_IDENTITY_MISMATCH`（一律 reject，不覆盖）。
- 失败分类复用 `NOT_FOUND / NOT_AUTHORIZED / TEMPORARILY_UNAVAILABLE / RATE_LIMITED / PROVIDER_ERROR`；未知异常 → `PROVIDER_ERROR` 且不回显上游 message。
- raw payload 白名单：invoice record / invoice charge / POD record 均校验字段集合，未知字段 → `RAW_PAYLOAD_INVALID`，credential-like（含 `signatureImage`）→ `PLAINTEXT_CREDENTIAL_NOT_SUPPORTED`；完整 raw payload 不入 response。

## 4. 回归（㉕）

`carrier-invoice-pod-read` **15/15** 覆盖：unknown carrier fail-closed（invoice+POD）/ missing credentialRef / unverified lineage / cross-tenant / provider mismatch / plaintext credential / UPS·FedEx invoice normalized / raw charge codes 保留 + 未知→OTHER / 十进制金额安全（`0.1+0.2=0.3`）/ INVALID_AMOUNT / CURRENCY_REQUIRED / invoice account·reference·tracking 绑定 / raw payload 白名单（含 charge 内 credential-like）/ UPS·FedEx POD normalized / POD tracking 绑定 / 掩码与 signature image 拒收 / safe rawReference / NOT_FOUND·NOT_AUTHORIZED·RATE_LIMITED·TEMPORARILY_UNAVAILABLE / provider error sanitization / read-only 三恒值 + 无 SLA·退款资格字段 / 无真实请求。

合计：carrier-invoice-pod-read 15 + carrier-tracking-read 24 + carrier-auth-account-discovery 41 + carrier-connector-capability 8 + provider-readiness-http-db 1 = **89/89**；tsc api 0 error；API contract = `API_CONTRACT_OK`（implemented=84 / documented=71，未新增路由）；CI RUN = 37074580689（head ccc4345）5 jobs 全绿。

## 5. 未做（㉖㉘）

未 calculate late-delivery refund / carrier claim value；未 submit claim / refund；未 mutate shipment；未 expose signature image；未把 tracking·invoice number 当 tenant ownership；未引入第二套 account 事实源；未 enable TRANSPORT；未使用真实凭据。真实 UPS/FedEx invoice·POD read activation 继续 HOLD_EXTERNAL。

## 6. 请裁决（编号裁决 PASS / REVISE / BLOCK）

① Invoice 只读平面（金额纪律 / charge 归一化 / billingTruthOnly）是否收口；② POD 只读平面（掩码与隐私 / deliveryEvidenceOnly）是否收口；③ provenance 双向绑定与 raw 边界是否满足 ㉑㉔；④ 是否批准 CARRIER QUEUE #5 = PASS/CLOSED；⑤ 下一内部单元（建议 Carrier Queue #6 SLA Evidence Assembly，或架构方指定）。

边界：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
