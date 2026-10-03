# EXTERNAL-DATASET-SMOKE — 外部公开数据集（结构冒烟记录）

> 状态：**STOPPED（宿主 2026-09-30 指示「暂时先过」）**
> 本文件只是记录：**不产生任何 Phase 1 结论**，不进入 `PHASE1-RESULT.md`，不参与 Decision Gate。
> 数据与报告均落在本地（gitignore 范围内），**不入库、不上传**。

---

## 1. 背景与目的

宿主询问「能不能去网上公开的找一份真实的数据来验证」。结论：**可以验证管线结构，但不能替代 Phase 1 商业验证**。
因此仅作为「适配器面对真实第三方导出」的一次结构冒烟，用来观察冻结项「**禁止猜测字段**」在真实文件上的表现。

## 2. 数据集

| 项 | 值 |
|---|---|
| 来源 | UCI Machine Learning Repository — *Online Retail* |
| 地址 | `https://archive.ics.uci.edu/static/public/352/online+retail.zip`（**免登录**） |
| 许可 | **CC BY 4.0**（允许商用，需署名）——因此**未**选用需要登录且为 CC BY-NC-SA 的 Olist/Kaggle 类数据 |
| 规模 | 541,909 行（2010-12 ~ 2011-12，英国在线零售订单/退货明细，含负数退款行） |
| 本地落地 | `inbox/external/uci-online-retail.zip` + `inbox/external/uci-online-retail/Online Retail.xlsx`（`inbox/*` 已 gitignore） |
| zip sha256 | `F5385CBB54BBEBF7196389109C6B0621FAAB0C304E3702548165E71C84AEDE8B` |
| xlsx sha256 | `43465a06f2ccf7c8b5bd2892bc7defb52f97487934fe93b16ae4c3936424676d` |

## 3. 冒烟结果（只读适配器）

```text
npx tsx tools/validation-run/run.ts --in "<...>/Online Retail.xlsx"
→ ADAPTER_QUARANTINE: REQUIRED_COLUMNS_MISSING
```

| 项 | 值 |
|---|---|
| engineeringStatus | PASS |
| format | XLSX（541,909 行全部读取） |
| status | **QUARANTINE（REQUIRED_COLUMNS_MISSING）** |
| 命中的规范列 | `InvoiceNo → invoiceNo`、`Description → note`（必需列 1/3、可选列 1/11） |
| 未识别列（**不猜含义**） | `StockCode`、`Quantity`、`InvoiceDate`、`UnitPrice`、`CustomerID`、`Country` |
| 不确定项 | `orderId`、`trackingNo` → `ACTION: manual confirmation required` |
| 报告 | `apps/api/out/adapter-quarantine-43465a06/VALIDATION-INPUT-ADAPTER-REPORT.md`（`out/` 已 gitignore） |

## 4. 结论

1. **「不猜字段」边界有效**：面对真实的第三方导出，适配器没有做任何自动映射，而是 QUARANTINE + 列出未识别列 + 要求人工确认。
2. **不能用于 Phase 1**：该数据集没有物流/账单字段（无 `trackingNo`、无交付日期、无账单金额），无法支撑 Stage B（Candidate）与 Stage C（人工确认），更不能触发 `PASS_TO_MVP`。
3. 若今后要把此类外部数据作为「适配器结构冒烟」正式留档，需**架构方单独授权一次提交**；本记录不代表已获授权。

## 5. 处置

- 按宿主指示**停止推进**；数据与报告留在本地，可随时删除，不影响任何证据链。
- Phase 1 状态不变：`WAITING_HOST_DATA`；真实数据到位前不产生商业结论。
