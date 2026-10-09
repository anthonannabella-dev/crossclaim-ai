# SI-RSI V2-01 — PAID_CUSTOMS_API_GATE（免费 / 付费关税 API 调用边界）

> 授权：HOST DIRECTIVE 2026-10-09「CUSTOMS OPPORTUNITY UNLOCK & AUTO-COMMISSION V2」PHASE A / PHASE D。
> 分支：`feat/customs-opportunity-unlock-v2`（自 `c6e03c51` 建立；未触碰 `main` / `release/rc-20261008-linux-deploy-v1` / U1 封板 `9ee36837`）。
> 本切片只做**边界与判定**，不接入真实 Provider、不发起外部调用、不扣款、不写库。

## 1. 交付物

| 文件 | 说明 |
| --- | --- |
| `apps/api/src/services/customs/customs-paid-api-gate.ts` | 收费关税调用边界的唯一判定与唯一通道 |
| `apps/api/src/__tests__/customs-paid-api-gate.test.ts` | 32 项单测（含验收指标断言） |

## 2. 边界模型

**收费操作（PAID_CUSTOMS_OPERATIONS）**：`DATA_READ` / `RATE_LOOKUP` / `FILING_CREATE` /
`DOCUMENT_UPLOAD` / `STATUS_READ` / `RFI_READ` / `RFI_RESPOND` / `REFUND_STATUS`。

- `RATE_LOOKUP` 在宿主书面确认其不计费之前，**一律按收费操作处理**（fail-closed）。
- `WEBHOOK` 为 provider → 我方入站事件，不产生出站调用费用，故不在收费集合内。

**免费操作（FREE_CUSTOMS_OPERATIONS）**：本地事实读取、差异计算、资格计算、预估计算、
历史扫描、IOR 就绪读取、证据谱系读取——全部只读本地事实源。

**调用方路径（CUSTOMS_CALLER_PATHS）**：`FREE_SCAN` / `CUSTOMER_PAID` / `OPERATOR_APPROVED`。
`FREE_SCAN` 触发任何收费操作 → 立即 `HOLD`（`FREE_PATH_CANNOT_CALL_PAID_OPERATION`），不再评估其余条件。

## 3. fail-closed 条件（全部满足才 ALLOW）

案件存在 → 机会归属同租户 → 有效付费权益且额度 > 0 → Standing Authorization 有效 →
外部写门禁已由宿主授权 → Provider 可用且已声明 providerId → 报价存在、合法、币种一致且未过期 →
报价 ≤ 单次核验上限 → 报价 ≤ 租户剩余预算 → Profit Gate = PASS → Kill Switch 未触发 →
支付开关开启 → 生产支付开关开启。

任一不满足 → `HOLD` 并返回具名原因码；原因码可累积（便于审计定位）。

## 4. 唯一收费通道

`wrapPaidCustomsProvider()` 包装 provider 的**每一个出站** operation：

- 未过 Gate → 记 `blocked` 并抛 `CustomsPaidApiGateError`，**绝不触达底层 provider**
  （不允许把 HOLD 伪装成成功结果）。
- 过 Gate → 记 `permitted` 后委派底层实现。
- `resolveContext()` 返回 `null` → 一律 HOLD。

## 5. 验收指标

```text
FREE_CUSTOMS_PAID_API_CALL_COUNT = 0
```

- `createPaidCustomsCallCounter()` 暴露 `freeCustomsPaidApiCallCount` 与 `snapshot()`。
- `assertNoFreeCustomsPaidApiCalls()` 在计数非 0 时抛出 `FreeCustomsPaidApiCallViolation`。
- 单元测试覆盖：免费路径触达收费方法（`HOLD` + 底层 provider 未被调用 + 断言失败）、
  纯免费流程计数为 0、非免费原因的 `HOLD` 不计入免费触达计数。

## 6. 金融金额处理

金额一律使用**定点 decimal string**（最多 4 位小数）：`normalizeDecimalAmount()` 规范化，
`compareDecimalAmounts()` 按整数部分长度 → 字典序 → 小数位补齐比较，全程**不使用浮点**。
非法金额（负数 / 科学计数 / 超精度 / 非字符串）→ `HOLD`。

## 7. 本切片不做的事（明确边界）

`CUSTOMS_PAID_API_GATE_BOUNDARY` 自证：`externalCallPerformed=false`、`providerInvoked=false`、
`chargedAmount=null`、`paymentCaptured=false`、`autoCollectionEnabled=false`、
`successFeeCalculated=false`、`transportEnabled=false`、`productionCredentials='ABSENT'`。

- 未接入真实 Provider；未修改 Provider 实现；未改变现有 C15 契约。
- 未接入真实支付通道；未启用任何自动收款。
- 未新增数据库迁移；未新增调度器 / Runtime。
- 尚未把 Gate 接入既有 HTTP 路由与 provider composition —— 属后续切片（V2-02）。

## 8. 验证状态

```text
VITEST_SLICE       = PASS（32/32；与相邻 customs 套件合并 50/50）
TSC_NOEMIT         = PASS（apps/api，0 error）
POSTGRESQL_IT      = NOT_RUN（本切片无数据库依赖）
LINUX_SYSTEMD      = NOT_VERIFIED（本机 Windows）
REAL_PROVIDER      = NOT_VERIFIED（未接入，保持 HOLD）
PRODUCTION_PAYMENT = NOT_VERIFIED（未接入，保持 HOLD）
```
