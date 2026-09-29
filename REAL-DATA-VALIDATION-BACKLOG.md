# REAL-DATA-VALIDATION-BACKLOG — CrossClaim AI

> 目的（宿主指令 2026-09-29）：**缺真实数据不得阻塞产品开发**。
> 本文档把「必须用真实数据才能完成的验证」逐项登记；这些项一律标记 `REAL_DATA_VALIDATION_PENDING`，
> 从开发关键路径上移出，等真实输入到位后统一执行 Production Validation。
>
> 状态口径（三轨分离）：
> - `CODE PASS`：代码、Schema/Contract、fixtures、单测、集成测试、E2E 全部就位。
> - `INTEGRATION PENDING`：外部 Adapter 未接真实系统（或已就绪但缺凭据/授权）。
> - `PRODUCTION VALIDATION PENDING`：必须用真实数据/真实账号跑通才能判定。
>
> 纪律：任何真实平台**自动提交**仍为 FORBIDDEN，流程恒为 `AI Prepare → Human Approve → Submit`。

---

## 1. 真实依赖清单

| # | 需要什么真实数据 / 能力 | 来源平台 | 用来验证什么 | 当前模拟测试覆盖 | 风险 | 上线前必须达到的验收标准 |
|---|---|---|---|---|---|---|
| RD-01 | Shopify 订单导出（含争议/拒付列） | Shopify 后台导出 | 适配器真实列名、多单号、发票号缺失比例 | `validation-run-shopify.test.ts` 9 用例 + fixture 场景包（正常/空/缺列/多单号/重复/1 万行/PDF/未知格式） | 真实列名漂移；invoiceNo 缺失比例可能接近 100% | 真实文件 PASS 或 QUARANTINE 原因可解释；必需列覆盖 3/3；未识别列清单可人工确认 |
| RD-02 | 结算/仓储报告导出 | Amazon Seller Central | 仓储盘亏/损毁/入库少件的字段与金额口径 | canonical 14 列 + 场景 fixture 14 类 | FNSKU / 费用类型 / 多币种差异 | 解析成功率与人工抽样核对一致；金额字段无单位歧义 |
| RD-03 | 结算导出 | Walmart、TikTok Shop | 同上（WFS 仓损、仅退款/DNR） | 同上 | 各平台字段语义不同 | 同上（每平台各一份） |
| RD-04 | 物流运费账单 | FedEx / UPS / DHL / 专线 | 燃油附加费、DAS 误判、SLA 延误的账单字段对位 | 参照数据适配 26 用例 + 解析器用例 | 账单列名与单位差异大 | 账单可结构化；能与参照数据生效窗口对齐（对齐失败必须 QUARANTINE） |
| RD-05 | 官方费率 / DAS / SLA 暂停公告 | 承运商官网发布的文件 | 参照数据真实结构（版本化、生效窗口） | 同上（含 0.125 费率刻度歧义、重叠窗口） | 格式随时变动 | 规范化工件与官方原文一致（抽样人工核对）；sha256 可复算 |
| RD-06 | 关税税率表 / 301 豁免清单 | 官方发布文件 | 参照数据真实结构（HS 6/8/10 位、生效窗口） | 参照数据适配 26 用例 | HS 位数与国家码写法不一 | 同上；未知字段全部进 UNKNOWN，不得臆测 |
| RD-07 | C88 / 7501 报关单 | 报关行 / 海关 | 结构识别（非 OCR）是否够用；人工录入路径是否可达 | PDF 仅结构识别 → QUARANTINE 用例 | 缺 OCR 时无法自动提取 | 结构识别可用 + 人工录入后进 canonical（OCR 另行批准） |
| RD-08 | 承运商 POD / 轨迹 | 17TRACK / EasyPost | 真实 POD 抓取与附件一致性 | POD 文件上传登记 5 用例（含跨租户拒绝） | 账号授权与限流 | 授权后抓取结果与人工上传登记一致；当前仅走文件上传登记 |
| RD-09 | Stripe test 账号 + webhook 签名密钥 + CLI | Stripe（测试模式） | webhook 全事件链、三类唯一性、重放与恢复 | payment/payment-attempt 全套 DB 用例 | 需要宿主授权 | 完整事件链跑通；`C-0010-C2` 验收矩阵全绿（见 `reports/C-0010-C2-runbook.md`） |
| RD-10 | 平台争议/工单 API（只读 + 提交沙箱） | Amazon SP-API / TikTok / Walmart | 代提交是否被条款允许、提交载荷真实校验、错误码语义 | 离线载荷构造 + 干跑校验 12 用例 | 平台条款与授权范围未知；如实为禁止代理提交则方案作废 | 条款书面核对 + 沙箱内**人工批准**单次提交成功且可撤回 |
| RD-11 | 真实卖家账户 + 真实 Claim 提交 | 各平台 | `AI Prepare → Human Approve → Submit` 全链路留痕 | 人工闸门与审计已就位（无真实提交） | 错误提交责任 | 每次提交有审计（谁/何时/载荷指纹/平台/结果）；可回滚或更正 |
| RD-12 | 真实赔付到账 + Success Fee | 平台结算 + Stripe | 到账识别、佣金 15%、账单状态与对账一致性 | 支付/对账/佣金 dry-run 用例 | 资金合规（KYC） | 到账-账单-佣金三方对账一致；差异清单为空或已归因 |

---

## 2. 执行规则

1. 上述任一项未完成时，**不得**阻塞其他模块开发；只在相关模块上标注 `REAL_DATA_VALIDATION_PENDING`。
2. 每个模块交付时同时给出三轨状态（CODE / INTEGRATION / PRODUCTION VALIDATION）。
3. 外部平台能力一律走 **Adapter 层**：接真实 API / CSV / 浏览器自动化时**只替换 Adapter**，
   不重新设计核心业务流程（归一化、检测、证据、人工复核、账单）。
4. 自动提交继续 FORBIDDEN；未完成真实条款核对前，不得把任何平台标记为「允许代理提交」。
5. 真实数据到位后，按 RD-01…RD-12 顺序重跑并回填本表（把 `PENDING` 改为实测结论 + 证据文件）。
