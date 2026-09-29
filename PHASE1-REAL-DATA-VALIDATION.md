# PHASE 1 — REAL DATA VALIDATION（受控启动）

> 依据架构方 **MSG-20260929-43**（Phase 1 = GO 受控启动）与 **MSG-20260929-44**（补充最小数据规模与三段验收）。
> 目标：验证产品**能否从真实业务数据中发现可验证线索**。不是验证：自动追回、自动提交、自动收费。
> 状态：`WAITING_FOR_HOST_DATA`（宿主提供真实/脱敏文件前，不产生任何商业结论）。

## 1. 范围与优先顺序

| 顺序 | ID | 数据源 | 输入 |
|---|---|---|---|
| 1 | RD-01 | Shopify 独立站 | Orders Export（CSV/XLSX） |
| 2 | RD-02 | Amazon 卖家平台 | 结算 / 库存导出 |
| 3 | RD-04 | 承运商运费账单 | FedEx / UPS / DHL / 专线账单 |

RD-01 优先原因：文件易得、无需 API、结构清晰，可最快验证 Adapter → Evidence 链路。

## 2. 最小数据规模（RD-01）

- **最低**：订单数 ≥ 500（几十单易被偶然性误导）
- **推荐**：1,000 – 10,000 orders（足以观察退款、履约、物流异常、拒付线索）
- **时间范围**：优先最近 3 个月；数据允许时可扩至 6–12 个月
- 脱敏允许：姓名/地址/邮箱/电话可整列占位；订单号可哈希但需同单一致

## 3. 三段验收（必须全部通过）

### Stage A — 数据可用性

必须输出：`Import PASS`、字段覆盖率报告、`UNKNOWN` 字段报告、`Quarantine` 报告。

要求：无大规模未知字段；无静默丢数据；`row trace` 保留（行号 + 列名可定位）。

### Stage B — 候选发现

**≥10 条 Candidate**（Candidate ≠ Claim）。

Candidate 定义：数据中存在需要人工进一步确认的异常线索（状态异常 / 金额差异 / 物流记录缺口 / 退款结算异常）。

### Stage C — 人工真实性确认（最重要）

人工抽样确认 **≥5 条**，逐条分类记录：

| 结果 | 记录 |
|---|---|
| 真实问题 | TRUE POSITIVE |
| 数据误判 | FALSE POSITIVE |
| 信息不足 | NEEDS DATA |

**Value Discovery Rate** = 人工确认真实异常数 ÷ 抽样检查数量（例如检查 20 条、确认 8 条 → 40%）。**只记录，不作为通过门槛。**

## 4. 必须产出 PHASE1-RESULT.md

```
# Phase1 Result

## Dataset
来源:
时间:
数量:

## Import Result

## Data Quality

## Candidate Findings

## Human Verification

## False Positive Analysis

## Missing Data

## Next Decision
```

## 5. Phase 1 暂不判断的指标

❌ 回收金额　❌ 成功率　❌ ARR　❌ 佣金收入

原因：这些依赖规则引擎、平台确认与真实追回，当前仍未开放。

## 6. 本阶段明确不做

- ❌ 自动提交 Claim / Appeal（`supportsClaimSubmission=false`，恒 `NEEDS_MANUAL`）
- ❌ 自动扣佣 / 自动 PAID / 任何自动资金动作
- ❌ 调用第三方平台 API 或使用真实账号授权
- ❌ 输出「可追回金额」的承诺性结论（真实追回效果只能由 Production Validation 判定）

## 7. 宿主需提供的文件（HOST APPROVAL REQUIRED）

RD-01 Shopify Orders Export：

- 必须字段：`Order ID`、`Order Name`、`Created At`、`Fulfillment Status`、`Financial Status`、`Tracking Number`、`Fulfilled At`、`Currency`、`Total Price`
- 可选字段：`Refund Subtotal`、`Shipping`、`Shipping Method`、`Destination Country`、`Weight`
- 交付方式：宿主自行放入本地目录后告知路径（不经聊天上传真实客户数据）

## 8. 执行步骤（收到文件后）

1. Validation Harness 跑 `文件 → Import → Normalization → Validation → Quarantine`（产出 Stage A 报告）。
2. 生成候选线索列表（仅事实与依据，不含金额承诺）→ Stage B。
3. 人工逐条确认并分类 → Stage C + Value Discovery Rate。
4. 产出 `PHASE1-RESULT.md`，交架构方裁决是否进入 Phase 2（建议单场景：FBA/物流退款审计）。

## 9. MSG-20260929-45 细化项（Phase 1 验收补充）

### 9.1 补充 A — 数据完整性基线（Import Integrity Check）

Stage A 必须记录并满足等式：

```
input rows = normalized rows + quarantine rows + rejected rows
```

**不允许**「输入 10000 行 → 输出 9000 行且无解释」。

### 9.2 补充 B — Candidate 必须可追溯

每个 Candidate 必须包含：

```
candidate_id
source_file_hash
source_row_reference
normalized_fact_reference
evidence_reference
created_reason
```

目的：人工复核时能回答「为什么系统认为这是一个候选？」

### 9.3 补充 C — False Positive 必须分类

| 类别 | 说明 |
|---|---|
| 数据误解 | 字段含义理解错误 |
| 规则缺失 | 需要额外业务规则 |
| 业务合理 | 实际没有损失 |
| 数据不足 | 缺关键字段 |

### 9.4 补充 D — Phase 1 退出条件（Decision Gate）

验证结束后只能进入以下三个状态之一：

```
PASS_TO_MVP
继续采集数据
STOP / REWORK
```

不得直接进入：自动追回 / 自动提交 / 收费。

### 9.5 冻结项（Phase 1 不开放）

| 功能 | 状态 |
|---|---|
| 自动 Claim 提交 | FORBIDDEN |
| 平台 API 接入 | HOLD |
| 自动计算追回金额 | HOLD |
| 自动扣佣 | HOLD |
| 自动资金流转 | HOLD |
| HS Code 判断 | HOLD |
| 物流 SLA 规则判定 | HOLD |

