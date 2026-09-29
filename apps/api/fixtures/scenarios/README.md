# Synthetic scenario fixtures（离线失败/边界场景包）

> 用途：在不接真实平台、不用真实数据的前提下，把**失败模式与边界**固定成可重复的 fixture。
> 归属：`apps/api/fixtures/scenarios/`；由 `src/__tests__/validation-run-scenarios.test.ts` 驱动。
> 边界：只检验「能不能被结构化」；**不做金额判断、不生成索赔、不接平台**。

## 场景清单

| # | 文件 / 构造方式 | 场景 | 期望 |
|---|---|---|---|
| 01 | `01-normal.csv` | 正常数据（必需列 + 可选列齐全） | `PASS`，必需 3/3 |
| 02 | `02-empty.csv` | 空数据（只有表头） | `PASS` 但 `adaptedRowCount=0` |
| 03 | `03-missing-required.csv` | 缺必需列（只有 orderId） | `QUARANTINE`，含 ACTION |
| 04 | `04-unknown.txt` | 非法/未知格式 | `QUARANTINE`（`UNKNOWN_FORMAT`） |
| 05 | `05-duplicate-rows.csv` | 重复数据（两行完全相同） | `PASS`，两行都保留、行号不同、`rawRowHash` 相同 |
| 06 | `06-extreme-values.csv` | 极端值（0 / 负数 / 超大金额 / 超长文本 / 非 ASCII） | `PASS`，原值不丢 |
| 07 | `07-messy-headers.csv` | 表头大小写/空格/下划线混杂 | `PASS`，别名映射命中必需列 |
| 08 | `08-partial-columns.csv` | 部分字段（仅必需列） | `PASS`，可选 0/11 |
| 09 | 测试内构造（PDF 头） | PDF | `QUARANTINE`（`PDF_STRUCTURE_ONLY_NO_OCR`） |
| 10 | 测试内构造（空 JSON 数组） | JSON 空数组 | `QUARANTINE`（可读报告，不抛未捕获异常） |
| 11 | 测试内构造（1 万行 CSV） | 大批量 | `PASS`，行数一致，耗时在阈值内 |
| 12 | `04-unknown.txt` 改名 `.csv` | 伪装扩展名 | 按内容判定 → `QUARANTINE` |
| 13 | `05-duplicate-rows.csv` 连跑两次 | 重复执行（幂等输入） | 两次报告一致（sha256 相同） |
| 14 | `03-missing-required.csv` | 人工确认路径 | `ambiguities[].action` 非空 |

> 说明：429 / 超时 / 部分成功 / 重试耗尽属于**连接器运行时**场景，不在本目录（那些由
> `api-connector-runtime` / `sync-runner` 的测试覆盖，凭据与网络全部用注入桩，不触网）。

## 运行方式

```bash
cd apps/api
npx vitest run src/__tests__/validation-run-scenarios.test.ts
```

不需要数据库、不需要网络、不需要任何凭据。
