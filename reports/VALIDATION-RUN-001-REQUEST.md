# VALIDATION-RUN-001 · 数据请求单（给宿主 / 客户对接人）

> 目的：CrossClaim 的工程能力已经建成，**唯一缺的是真实数据验证**。
> 本页只说明「需要我们拿到什么、怎么保护、我们会产出什么」。不含任何代码与凭据。

## 1. 为什么需要这份数据

目前的结论只能说明「系统能跑通」，不能说明「这门生意成立」。要回答的是：

| 问题 | 用什么回答 |
|---|---|
| 真实账单里到底有多少可追回的异常？ | 异常行数 / 总行数 |
| 可追回金额规模有多大？ | 可追回金额合计（按币种） |
| 我们会高估还是低估？ | 规则金额与人工判断的残差分布 |
| 客户是否认可？ | 客户对清单的反馈（有价值 / 无价值 / 金额不可信 / 缺哪些字段） |

**没有这一步，任何「验证成功」的说法都不成立。**

## 2. 我们需要什么（任选其一即可起步）

**A. 脱敏后的真实结构账单**（首选，最省事）
- 一个渠道即可：UPS / FedEx / DHL / 其他承运商 / 平台结算单
- 保留**真实结构**：表头、字段名、行数、金额与日期格式
- 可以把订单号、运单号、客户名替换成占位符——**格式请保持原样**

**B. 真实账单 + 由我们脱敏**（需要客户书面同意我们接触原始文件）
- 我们会在本地脱敏后才进入验证流程，原始文件不入库、不进报告

## 3. 我们只要这些字段（模板见 `tools/validation-run/template.csv`）

```text
orderId, trackingNo, invoiceNo, channel, promisedDeliveredAt, actualDeliveredAt,
billedAmount, billedCurrency, invoiceAmount, invoiceCurrency,
evidenceRef, settlementRef, claimOutcome, note
```

- 缺失字段**不要编造**：留空即可，工具会把问题逐条列出来
- `claimOutcome` 只接受枚举（NOT_STARTED / IDENTIFIED / SUBMITTED_MANUAL / RECOVERED / REJECTED / UNKNOWN）
- `settlementRef` 可以在这一轮留空（发现阶段通常还没有赔付）

## 4. 我们会怎么保护数据

- 脱敏在**本地**完成：订单号 / 运单号按生产掩码规则打码；文件路径与赔付单号只留**确定性指纹**
- 报告里只登记 **sha256 与行数**，不登记客户名、账号、合同原文
- 金额、币种、日期、渠道保留（否则无法验证），但它们不是客户身份信息
- **不接任何平台账号、不发任何外部请求、不写库**：跑完只在本地产出三个文件

## 5. 你会拿到什么

运行一次后会得到（目录：`out/validation-run-<sha256 前 8 位>/`）：

```text
anonymized.csv   脱敏后的输入（可复核）
summary.json     机器可读结果（含三层状态）
report.md        人读报告
```

三层状态的含义（这是规矩，防止把工程样例当成商业结论）：

```text
engineeringStatus   : PASS | FAIL        ← 只是「输入结构合规、链路跑通」
validationRunStatus : RUN_RECORDED | NOT_RUN   ← TEMPLATE 输入一律 NOT_RUN
commercialConclusion: OPEN               ← 商业结论只能由人来写
```

## 6. 执行方式（我们这边跑，你只需给文件）

```powershell
cd D:\crossclaim-ai\apps\api
npx tsx ../../tools/validation-run/run.ts --in <你的 csv> --input-kind desensitized-real-structure
```

跑完把 `report.md` 与 `summary.json` 交回即可；我们会把它登记进
`reports/C-0009.1-validation-runs.md`（状态仍由人工填写）。

## 7. 如果你现在拿不到真实数据

那就**保持 `OPEN`**——按架构方的规矩，不允许用工程样例或模拟数据冒充商业验证。
在拿到第一份真实数据之前，项目在商业维度上就是「未验证」，这一点不会因为工程做得多而改变。
