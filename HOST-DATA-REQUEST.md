# HOST-DATA-REQUEST — Phase 1 数据交付请求单（登记 / 验收口径）

> 依据：宿主指令 2026-09-30「**需要的数据最后再补先做记录**」→ 数据缺口在此登记，**不阻塞**其余开发；
> 架构方 **MSG-20260929-75**：`NEXT = PHASE 1 REAL DATA VALIDATION`（唯一允许的下一提交）。
> 状态：`WAITING_HOST_DATA`。数据未到位前，本阶段**不产生任何商业结论**。
> 本文件是 Phase 1 数据交付的**单一口径**（清单 / 命名 / 验收命令 / 登记表）。

---

## 0. 一句话要求

交付一份**已脱敏**的订单导出（优先 RD-01 Shopify Orders Export）：**≥500 行**、最近 3 个月优先、
含 `order_id`、`occurred_at`、`amount`、`currency` 四列、**无 PII**、**无任何凭据**。

## 1. 本轮请求（RD-01）

| 项 | 要求 |
|---|---|
| 数据集 ID | **RD-01** |
| 来源 | Shopify 后台 Orders Export（CSV 优先；XLSX 可先另存为 CSV） |
| 规模 | 最低 **≥500 行**（推荐 1,000–10,000） |
| 时间范围 | **最近 3 个月优先**（可扩至 6–12 个月） |
| 必需列（canonical） | `order_id`、`occurred_at`、`amount`、`currency` |
| 可选列 | `refund_amount`、`shipping`、`shipping_method`、`destination_country`、`weight`、`fulfillment_status`、`financial_status`、`tracking_number`、`order_name`、`product_name` |
| 禁止列 | 买家/收件人姓名、邮箱、电话、地址、邮编、证件号等 PII（整列可替换为占位符） |
| 禁止内容 | 平台凭据、API Key、支付卡数据、真实可识别客户信息 |
| 格式 | UTF-8、逗号分隔、首行表头、每行字段数与表头一致（勿含跨行引号） |
| 交付方式 | 宿主自行放到 `D:\crossclaim-ai\inbox\`（该目录**不入 Git**，见 `.gitignore` 的 `inbox/*`），然后告知路径 |

**脱敏要求**：订单号可哈希，但**同一订单在所有行必须一致**（保证可追踪）。

## 2. 字段映射：不猜、不自动改写

架构方冻结项：**禁止猜测字段、禁止自动修正未知字段**。因此平台原生列名（如 `Order ID`、`Created At`、`Total Price`）
**不会**被自动当作 canonical 列使用。

两种合法交付方式：

| 方式 | 做法 | 适用 |
|---|---|---|
| **A（推荐）** | 交付**已按 canonical 命名**的 CSV（表头即 `order_id,occurred_at,amount,currency,...`） | 最快，直接进 Stage A |
| **B** | 交付平台原生导出 + 宿主/架构方**显式确认的映射表**（一列对一列） | 保留原始字段与证据链 |

方式 B 的映射表由人工书面确认后，Codex 才能做一次**离线转换**（转换脚本与转换结果一起入证据），
转换后再跑 Stage 0。`preflight` 在缺少 canonical 列时只会输出**别名提示**（例如
`order_id <- "Order ID"`），判定仍为 `NEEDS_FIX`，供人工确认，绝不自动通过。

## 3. 数据到位后的执行顺序（Stage 0 → Decision Gate）

```text
0) Stage 0 入场前置检查（只读）  node tools/validation/phase1-runbook.mjs preflight <dataset.csv>
1) Stage A 记账检查              node tools/validation/phase1-runbook.mjs audit-input <dataset.csv>
2) 导入（既有 pipeline）          文件 → parse → normalize → validate → ImportBatch / SourceTransaction（dedupeKey 幂等）
3) IMPORT-REPORT.md             templates/IMPORT-REPORT.md
4) DATA-QUALITY-REPORT.md       templates/DATA-QUALITY-REPORT.md
5) Stage B 候选发现（只读）       Candidate >= 10（Candidate ≠ Claim）
6) Stage C 人工抽样（>= 5）       TRUE_POSITIVE / FALSE_POSITIVE / NEEDS_DATA
7) PHASE1-RESULT.md             8 节 + Decision Gate
8) Decision Gate                PASS_TO_MVP / CONTINUE_DATA_COLLECTION / STOP_REWORK
```

Stage 0 检查项（全部只读，不改数据）：文件非空、表头存在、四列必需列齐全、行数 ≥500、
无 PII 列（保守按列名判定，业务标识如 `order_name` / `product_name` 白名单）、无裂行、
`order_id` 唯一、`occurred_at` 可解析；「最近 3 个月」为**非阻断**提示。

## 4. 验收判定（冻结口径）

| 阶段 | 通过条件 |
|---|---|
| Stage 0 | `verdict = READY_FOR_STAGE_A`（退出码 0） |
| Stage A | `input rows = normalized rows + quarantine rows + rejected rows`（**禁止 silent drop**） |
| Stage B | `Candidate >= 10` |
| Stage C | `human verification >= 5`，分类固定三值 |
| Decision Gate | 只能取 `PASS_TO_MVP` / `CONTINUE_DATA_COLLECTION` / `STOP_REWORK` |

阶段一**不判断**：回收金额 / 成功率 / ARR / 收费能力（商业指标冻结）。

## 5. 缺口登记表（intake register）

| 数据集 | 需要的输入 | 状态 | 缺口 / 下一步 |
|---|---|---|---|
| RD-01 | Shopify Orders Export（脱敏） | `WAITING_HOST_DATA` | 宿主交付 → `preflight` → `audit-input` |
| RD-02 | Amazon 结算/仓储导出 | `WAITING_HOST_DATA` | RD-01 走通后再请求 |
| RD-03 | Walmart / TikTok Shop 结算导出 | `WAITING_HOST_DATA` | 同上 |
| RD-04 | FedEx / UPS / DHL 运费账单 | `WAITING_HOST_DATA` | 与参照数据生效窗口对齐（对不上必须 QUARANTINE） |
| RD-05–RD-06 | 承运商费率 / 关税税率表原件 | `WAITING_HOST_DATA` | 抽样人工核对 + sha256 可复算 |
| RD-07 | C88 / 7501 报关单 | `WAITING_HOST_DATA` | 仅结构识别；OCR 需另行批准 |
| RD-08 | POD / 轨迹（授权后） | `WAITING_HOST_DATA` | 当前只走人工上传登记 |
| RD-09 | Stripe test 账号 + webhook 签名密钥 | `HOST APPROVAL REQUIRED` | 需宿主授权 |
| RD-10–RD-11 | 平台条款核对 + 真实账号 / 真实提交 | `HOST APPROVAL REQUIRED` | 自动提交仍 **FORBIDDEN** |
| RD-12 | 真实赔付到账 + Success Fee | `HOST APPROVAL REQUIRED` | 涉及资金合规（KYC） |

逐项技术细节与验收标准见 [`REAL-DATA-VALIDATION-BACKLOG.md`](REAL-DATA-VALIDATION-BACKLOG.md)；
投放目录说明见 [`inbox/README.md`](inbox/README.md)；执行 Runbook 见
[`PHASE1-VALIDATION-RUNBOOK.md`](PHASE1-VALIDATION-RUNBOOK.md)。

## 6. 本请求之外（一律 HOLD，须宿主本人处理）

生产部署、DNS、TLS、生产数据库、Secret 生成/轮换、真实平台账号授权、平台 API 正式申请、
KYC / 分账 / 收费 / Success Fee、真实客户数据、真实 Claim 提交、仓库可见性变更 —— 全部 `HOST APPROVAL REQUIRED`。

## 7. 纪律（每轮自检）

1. 不猜字段、不自动补金额、不自动推断规则；缺口只登记、只退回补齐。
2. 真实数据**不入仓库、不过聊天**；只放 `inbox/`（已 gitignore）。
3. 不修改 main、不绕过分支保护、不提前开启任何生产动作。
4. Phase 1 结论只允许「线索是否可人工确认」，不得外推为商业收益。
