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

---

## 九、双语（中文 / 英文）界面硬性要求

**来源**：2026-09-28 宿主明确指定（原话：把项目做成双语的，起码在左侧 / 右侧 / 上拐角有翻译功能，一个中文一个英文）。
这是**产品硬性要求**：UI 层任何交付都必须满足，未满足即标注 `NOT COMPLETE`。

1. **双语对等**：所有面向用户的界面（登录、账单 / 文件上传、机会列表、案件详情、证据、
   Claim 文本预览、结算与计费、审计与导出）必须同时提供**中文**与**英文**两套文案；
   不允许只做一种语言，另一语言留空或用机翻占位。
2. **切换入口固定可见**：必须有一个始终可见的语言切换控件，位置为**左上角 / 右上角 / 顶部导航栏**三选一
   （推荐顶栏右侧）。不允许只藏在设置深层页面。
3. **切换即时生效**：切换后当前页面文案立即更新，不刷新页面、不丢表单输入与页面状态；
   选择结果持久化（用户级偏好 > 浏览器本地 > 默认）。
4. **默认语言**：浏览器语言为 `zh*` → 中文，否则英文；用户显式选择优先。
5. **边界（不得越界）**：
   - 只影响**呈现层文案与日期 / 数字 / 货币格式**；不得改动领域模型、金额数值、状态机、规则与审计字段。
   - 金额、币种、状态枚举值与 API 字段名保持英文标识不变（仅展示层翻译）。
   - 对外生成的 Claim / Appeal 文本与证据包：按**客户选定语言**生成（默认跟随界面语言），并在文档中标注语言。
6. **工程要求**：单一文案源（如 `zh-CN` / `en` 两份资源文件），禁止在组件里硬编码文案；
   新增文案必须同时补齐中英两份；日期 / 数字使用 i18n 格式化，不手工拼字符串。
   （引入任何 i18n 依赖须先过许可证闸门与架构方审计。）
7. **验收判据**：任意页面切换语言后，可见文案 100% 覆盖目标语言，不出现未翻译 key、乱码或中英混排
   （品牌名与专有名词除外）。

**状态**：需求已登记，**尚未实现**（`apps/web` 尚未开工）。待架构方确认实现 Wave / Gate 与 i18n 方案后执行。

---

## 十、双模式数据接入（Dual-Mode Data Acquisition）

**状态**：ACCEPTED / NOT YET IMPLEMENTED（已接受，尚未完整实现；后端能力归 **C-0005 / Gate 3**，界面归后续 apps/web Gate）
**来源**：2026-09-28 宿主指定；架构方 P-0002 裁定为**产品硬性要求**。

CrossClaim 必须同时支持两种数据获取模式，且两者进入**同一条** canonical ingest 管线
（→ SourceTransaction → Rule Engine → RecoveryOpportunity），业务闭环不得因数据来源不同而分叉成两套产品：

| 模式 | 内部表达 | 数据链 |
|---|---|---|
| A. API / 授权连接 | `SourceConnection.kind = API` | SourceConnection → ExternalAdapter.pull → ImportBatch → SourceTransaction（保留 connectionId / importBatchId / raw._source / provider record id / pulledAt / cursor / since-until；**不得保存** access/refresh token、cookie、authorization header、API key） |
| B. 文件上传 | `SourceConnection.kind = FILE_UPLOAD` | SourceConnection → FileAsset → ImportBatch → SourceTransaction（经 Storage Adapter + Import foundation） |

关键约束：

1. **模式只用 `SourceConnection.kind` 表达**，不新增 `ImportMode` 之类的平行枚举；界面上的「连接数据源 / 上传文件」两个入口只是 UX 分组。
2. **SourceConnection 是持续存在的逻辑来源**：FILE_UPLOAD 下不要每上传一个文件就新建 connection（否则 dedupeKey 含 connectionId，同一文件无法幂等）；API 下「一个已授权账号 = 一个 SourceConnection」。
3. **FileAsset ≠ EvidenceArtifact**：上传文件只产生 FileAsset，解析业务事实产生 SourceTransaction；只有真的作为证据时才 FileAsset → EvidenceArtifact → CaseEvidence，禁止「上传即证据」。
4. **API 拉取不必全部物化成文件**：普通拉取以 raw + connection + 拉取元数据作为检测溯源（Level 1）；若 Case/Claim 依赖该 API 内容对外主张，则把当时内容固化为不可变快照（JSON/PDF）存成 FileAsset 再转 EvidenceArtifact（Level 2）。
5. **审计事件**：两种模式都要 `import.completed` / `import.failed`；API 另加 `adapter.pull_failed`；FILE_UPLOAD 另加 `file.uploaded` / `file.upload_failed`（上传失败不得假造 FileAsset）。
6. **跨模式去重**：现有 connection-scoped `dedupeKey` 不变（它是导入幂等键，不是全局业务身份键）；不同来源的 SourceTransaction 各自保留（provenance preservation），不自动 merge；但**算钱前必须做 cross-source reconciliation**：完全一致 → 保留双来源、只算一次；存在冲突（金额 / 币种 / 日期 / 单号不一致）→ `SOURCE_CONFLICT` / `NEEDS_REVIEW`，金额计算 fail closed。
7. **不存在全局 API > FILE 或 FILE > API** 的来源优先级；权威性由具体业务规则决定（客户合同 > 客户 Rate Card > Carrier Tariff > Policy > Default），与数据获取模式无关。
8. 真实 OAuth / API 正式申请 / 真实凭据仍属 **HOST APPROVAL REQUIRED**；C-0005 可先用 mock / fixture adapter 证明 API 模式。


## 十一、长期产品定位（范围冻结，2026-10-01 HOST PRODUCT DIRECTION）

**CrossClaim AI = 跨境资金损耗 Recovery OS**，统一承载四类 Recovery：

| # | Recovery 类别 | 渠道示例 |
| --- | --- | --- |
| 1 | Platform Recovery | Amazon FBA/FBM、TikTok Shop/FBT、Walmart/WFS |
| 2 | Logistics Recovery | UPS / FedEx / DHL / Freight Forwarder |
| 3 | Customs / Trade Recovery | 报关行、税则/税率、B2B 可追回损耗 |
| 4 | Independent-site / Payment Recovery | Shopify、Stripe、PayPal（Chargeback / Dispute） |

四类前端「发现规则」可以不同，**后端必须复用统一 Recovery Engine**：
`Source Data → Canonical Fact → RecoveryOpportunity → Case → Evidence → Claim/Appeal/Dispute → Settlement → RecoveryLedger → Billing`。

硬性要求：

1. 不为每个渠道重做孤立系统；平台/物流/海关/独立站共享案件、证据、权限、审计、到账、账本、收费能力。
2. **不得**把产品收缩为 Amazon/FBA 单点理赔工具（本文件§二 V1 范围是**交付顺序**，不是产品边界）。
3. 后续所有 Gate / Wave / Schema / Adapter / Claim / Appeal / Evidence / Settlement / Billing 设计，必须检查是否继续满足「统一跨渠道 Recovery Engine」。
4. 牌照 / 正式报关 / 平台真实写入保持既有合规边界与人工卡口；真实 API、生产凭据、平台外写继续 HOLD。

### 产品 backlog 登记：PRODUCT-SCOPE-04 — Independent-site / Chargeback Recovery

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 设计稿 | 完成 | `docs/releases/PRODUCT-SCOPE-04-INDEPENDENT-SITE-CHARGEBACK-RECOVERY-DESIGN.md`（A 承载评估 / B 最小 Schema Delta / C Shopify·Stripe·PayPal 接入需求 / D 复用映射 / E 设计要点与 backlog） |
| 自治队列登记 | 完成 | `.autopilot/TASKS.md`「产品范围冻结」节 + backlog 表（PS04-1…PS04-7） |
| 实施 | **未开工（仅登记与设计排队）** | PS04-1（枚举扩展，Schema/领域）与 PS04-5（资金链路）开工前必须经架构方裁决 |
