# PRODUCT_SPEC —— CrossClaim AI 产品定义

**品牌**：CrossClaim AI — 跨渠道资金追回智能体
**品类**：Recovery OS｜资金追回操作系统
**一句话**：一次接入，持续发现并追回散落在平台、物流、货代、保险和关税里的钱。

---

## 一、用户与痛点

| 用户 | 痛点 |
|---|---|
| 跨境电商卖家（FBA 为主） | 平台少赔、错扣尺寸费、库存丢失无人追；单笔金额小、笔数多，人工追不值得 |
| 物流/货代财务 | 承运商账单附加费名目繁多，合同费率对不上，SLA 延误退款没人申请 |
| 有进口业务的贸易商 | 关税多缴、归类差异造成的多缴难以自查；找 Broker 逐票核代价高 |

---

## 二、三个追回域与 V1 范围

| 域 | V1 是否做 | 说明 |
|---|---|---|
| **Platform Recovery** | Wave 5 做 | Amazon FBA 丢失/损坏、库存与入库差异、重量尺寸错误、赔付遗漏与错付 |
| **Logistics Recovery** | **Wave 4 先做**（第一个闭环） | 承运商账单审计、合同费率核对、重复收费、附加费、SLA 延误退款、丢件破损 |
| **Customs / Trade Recovery** | Wave 6 做 | 多缴发现、测算、证据整理、案件包、Broker 协作、到账核对 |

**为什么先做 Logistics**：数据来源不依赖平台账号授权（客户可以直接给账单文件），
规则确定性高（合同 + 费率表 + 轨迹三方比对），能最快跑通"发现 → 追回 → 到账 → 记账"整条链。

---

## 三、核心用户旅程（V1 目标闭环）

```
客户上传：承运商账单（Excel/CSV/PDF）
       + 合同 / Rate Card
       + 轨迹文件
            ↓
系统归一化 → SourceTransaction
            ↓
规则引擎比对（合同 > Rate Card > 官方 Tariff > 政策 > 默认）
            ↓
产出 RecoveryOpportunity（含可追回金额与依据）
            ↓
人工确认 → 建立 Case → 绑定 Evidence
            ↓
生成 Claim 文本（AI 起草，人工确认后提交）
            ↓
Settlement（确认到账）
            ↓
RecoveryLedger（只增不改）
            ↓
Billing（成功费）
```

---

## 四、AI 的边界

**AI 做**：文档理解、字段抽取、异常解释、责任方建议、证据推荐、案件总结、Claim/Appeal 文本。

**AI 不做**（章程硬约束）：定金额、定佣金、定 Deadline、写账本、改状态、直接对外提交。

**对外提交保留人工卡口**：Phase 1 由系统生成规范文本与证据包，人工在平台侧提交。

---

## 五、外部集成策略（渐进式）

### Phase 1 — 轻量接入（快速上线 MVP）

| 集成 | 用途 | 权限 |
|---|---|---|
| 文件上传（PDF / Excel / CSV） | 承运商账单、合同、轨迹 | 无 |
| 文档 AI（Docling + DeepSeek） | 扫描比对、字段抽取 | 无外部账号 |
| Amazon SP-API（**只读**） | 后续 FBA 数据扫描 | 卖家授权，只读 |

**Phase 1 明确不做**：自动向平台提交工单。生成"一键申诉文档"，由卖家自行提交。
**理由**：规避平台风控与账号风险，且平台权限申请周期不可控。

### Phase 2 — 全自动化

| 集成 | 用途 |
|---|---|
| 物流聚合 API（EasyPost / 17TRACK 一类） | 批量轨迹自动化，一次对接多家专线 |
| FedEx / UPS / DHL 官方 API | 运单状态、送达时间、账单明细 |
| Stripe | 客户绑卡 + 追回成功后自动收取成功费 |

### 计划中的集成（尚未接入，需宿主授权）

- Amazon SP-API（Reports / Finances / Listings Items）
- FedEx / UPS / DHL Developer API
- EasyPost / 17TRACK 等聚合物流 API
- Stripe

> ⚠️ 上述均属 `HOST APPROVAL REQUIRED`（第三方账号授权 / API 正式申请 / 付费服务）。
> 当前**一个都没有接入**，`SourceConnection` 里也不会存在对应的真实凭据。

---

## 六、收费模型

| 项 | 设定 |
|---|---|
| 计费基础 | **成功费**：追回成功后按追回金额百分比计费（对外区间 15%–20%，具体以合同为准） |
| 无追回 | 不收费 |
| 载体 | `FeeCalculation`（费率快照 + 可复算）→ `BillingInvoice` |
| 与到账的关系 | 先有 `Settlement`（客户实际到账），才可能产生 `FeeCalculation` |

---

## 七、明确不做的事

1. 不代客户做需要牌照的动作（正式报关申报、海关最终判断）
2. 不在无客户授权时抓取平台数据
3. 不绕过平台 API 限制或反自动化规则
4. 不让 LLM 决定任何金额、费率、Deadline
5. 不做"上传即证据"的隐式默认
6. 不做无法复算的收费

---

## 八、V1 交付判据

见 `AGENTS.md` §八 与架构章程的完成标准。核心是：

**一个真实模拟链路跑通** —— 承运商账单 + 合同 + 轨迹 → 发现异常 → 生成 Opportunity
→ 建 Case → 绑 Evidence → 生成 Claim → 模拟 Settlement → 写 RecoveryLedger → 生成 Billing。

在跑通之前，状态一律标注 **NOT COMPLETE**。
