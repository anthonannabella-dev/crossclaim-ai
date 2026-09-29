# PHASE 1 — REAL DATA VALIDATION（受控启动）

> 依据架构方 **MSG-20260929-43**：Phase 1 = GO（受控启动）。原则：**只验证「发现真实追回机会」的能力**，不验证自动化资金与自动提交链路。
> 状态：`WAITING_FOR_HOST_DATA`。宿主提供「真实/脱敏」文件之前，本阶段不产生任何商业结论。

## 1. 本批验证范围（三项，均为文件路径，无需 API）

| ID | 数据源 | 输入 | 验证目标 | 通过标准 | 不做事项 |
|---|---|---|---|---|---|
| RD-01 | Shopify 独立站（**首批优先**） | Orders Export（CSV/XLSX） | 能否从真实订单/履约导出中发现**运费与履约异常**（超收运费、承诺时效未达、缺件/拒收线索） | 导入无崩溃；异常行可定位到 行号 + 列名；产出的候选损失经人工确认≥1 条**真实**可追回线索 | 不自动提交；不触碰资金；不采集真实客户联系方式 |
| RD-02 | Amazon 卖家平台 | 结算/库存导出 | FNSKU / 赔偿 / 仓储费字段能否正确落位到事实层 | 字段映射与人工抽样一致；未识别字段一律 `UNKNOWN`（不猜测） | 不调用 SP-API；不做自动 Case |
| RD-04 | 承运商运费账单 | FedEx / UPS / DHL / 专线账单 | 燃油附加费 / DAS / SLA 赔付等字段能否定位与归一化 | 账单可结构化解析；金额与币种无歧义；解析失败件数进 `QUARANTINE` 并有原因码 | 不自动索赔；不修改账单 |

## 2. 宿主需提供的文件（HOST APPROVAL REQUIRED）

### RD-01 Shopify Orders Export（首批）

**必须字段**：`Order ID`、`Order Name`、`Created At`、`Fulfillment Status`、`Financial Status`、`Tracking Number`、`Fulfilled At`、`Currency`、`Total Price`

**可选字段**：`Refund Subtotal`、`Shipping`、`Shipping Method`、`Destination Country`、`Weight`

**格式**：CSV 或 XLSX；建议 1–3 个月窗口；**可脱敏**（客户姓名/地址/邮箱/电话可整列替换为占位符，订单号可哈希，但请保持同一订单内一致）。

**交付方式**：宿主自行放入本地目录（不通过聊天上传真实客户数据）。放入后告知路径，Codex 侧只做本地导入与验证。

## 3. 执行步骤（收到文件后）

1. 用现有 Validation Harness 跑 `文件 → Import → Normalization → Validation → Quarantine`，产出导入质量报告（成功/失败/隔离计数与原因码）。
2. 生成「候选追回线索」列表（仅事实与依据，**不含金额承诺**）。
3. 人工（宿主/架构方）逐条确认：是否为真实损失、是否可能追回。
4. 产出 `PHASE1-RESULT.md`：真实线索数、误报分析、字段缺口、是否进入 Phase 2 单场景 MVP。

## 4. 本阶段明确不做

- ❌ 自动提交 Claim / Appeal（`supportsClaimSubmission=false`，恒 `NEEDS_MANUAL`）
- ❌ 自动扣佣 / 自动 PAID / 任何自动资金动作
- ❌ 调用第三方平台 API 或使用真实账号授权
- ❌ 输出「可追回金额」的承诺性结论（真实追回效果只能由 Production Validation 判定）

## 5. 判据

Phase 1 = PASS 当且仅当：真实（或脱敏真实结构）文件贯通导入 → 事实层 → 人工复核，且至少一条**人工确认**的真实可追回线索。否则如实记录失败点与字段缺口，不做粉饰。
