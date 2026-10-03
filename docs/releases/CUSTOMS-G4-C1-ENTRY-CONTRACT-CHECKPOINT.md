# CUSTOMS G4 / C1 — Customs Entry Data / Evidence Contract CHECKPOINT

- 时间：2026-10-03T09:34:56.145Z（HEAD 3f5b9e3）
- 单元：G4 内部链第一环 **C1 = Customs Entry 事实契约层**（无 Schema 变更、无路由、无外写）
- 边界：readOnly=true · filingPerformed=false · paymentPerformed=false · productionCredentials=ABSENT · TRANSPORT=false

## 1. 交付物

| 产物 | 路径 | 证据 |
|---|---|---|
| 契约模块 | `apps/api/src/services/customs/customs-entry-contract.ts` | `normalizeCustomsEntryFact` / `sumDecimalStrings` / `CUSTOMS_ENTRY_CONTRACT_BOUNDARY` |
| 回归测试 | `apps/api/src/__tests__/customs-entry-contract.test.ts` | 16/16 PASS（vitest） |

## 2. 契约语义（fail-closed 原因码）

- `INVALID_REQUEST` / `INVALID_ENTRY_NUMBER` / `INVALID_DATE` / `INVALID_CURRENCY` / `INVALID_AMOUNT`
- `MIXED_CURRENCY_DUTY_LINES`（**不跨币种相加**；混币必须先按币种拆单）
- `UNKNOWN_DUTY_LINE_KIND`（未知 kind 拒绝；raw code 必须原样保留，不猜测）
- `UNKNOWN_SOURCE`（来源仅 `BROKER_DOCUMENT` / `ABI_VENDOR` / `EDI_SFTP` / `USER_UPLOAD`）
- `RAW_PII_NOT_ALLOWED`（importerName / importerAddress / consignee* / contact* / accessToken / credential* / rawPayload；**递归扫描**，含嵌套 duty line）

## 3. 硬边界（写入事实本身）

- 事实对象自带 `readOnly: true` / `filingPerformed: false` / `paymentPerformed: false` / `productionCredentials: 'ABSENT'`。
- 金额一律十进制字符串 + BigInt（scale 6），输出最少 2 位小数；不接受科学计数法 / NaN。
- 只接受 safe reference（禁止空格 / 自由文本进入引用字段）。
- **不推导** eligibility / recoverableAmount / claim package / successFee；不做 FX 换算（`CUSTOMS_ENTRY_CONTRACT_BOUNDARY` 显式声明）。

## 4. 闸门证据

- `vitest run customs-entry-contract` → 16/16 PASS
- `tsc --noEmit`（api）→ 0 error；`tsc --noEmit`（web）→ 0 error
- API contract → implemented=88 documented=75（无新增路由，计数不变）
- audit coverage → OK；autopilot rules → OK
- 本地 `migration-checksums` 因 CRLF 检出必红（基线已知）；CI 为权威

## 5. 下一单元

1. **C2 Duty Calculation Truth**：基于 C1 事实推导 duty/tax 真值（只做确定性计算，不产生 recoverable amount）。
2. **C3 Classification / Rate Discrepancy**：HTS 分类与税率差异检测（只暴露差异，不裁决）。
3. **C1/C2 持久化**：`CustomsEntryFact` 落库属 **Schema 变化** → 先出 Schema Delta 请求送架构方审计，再落 migration。

## 6. 未发生的事项（显式声明）

- 无真实 broker / ABI / EDI 调用；无真实 filing；无真实付款；无生产凭据。
- 无 Schema / migration 变更；无 HTTP 路由变更；无前端变更。
