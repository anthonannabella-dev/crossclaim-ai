# CrossClaim · API 对接清单（宿主逐项对接用）

> 生成：2026-09-29（Codex）· 分支 `gate/7-commercial-validation` · HEAD `01bdbd2`
> 依据：宿主指令「把需要接 API 的都先放着，最后用文档给我，我再逐一对接」
> 口径：本文档是**一切需要外部 API / 第三方账号 / 凭据**的动作的唯一入口。Codex 不会自行申请、不会自行接入、不会保存任何真实凭据取值；每一项都要宿主开闸后单独走一次。

---

## 0. 统一规则（先读这一段）

| 规则 | 内容 |
|---|---|
| 谁能开闸 | 宿主本人（HOST APPROVAL REQUIRED）：第三方账号授权 / API 正式申请 / 付费服务 / 生产部署 |
| 凭据形态 | 代码与数据库里**只出现引用名**（如 `vault:stripe-test-2026`）。命中 `Bearer …` / `sk-…` / `ghp_…` / `AKIA…` 形态的输入会被服务端直接拒绝（400 `SECRET_NOT_ACCEPTED`） |
| 凭据落地 | 真实值只写宿主机环境变量或密钥管理；不入库、不回显、不进日志（`envPresence()` 只报告「是否已设置」） |
| 只读优先 | Phase 1 所有平台接入**只读**；任何「向平台写入」的动作恒为关闭 |
| 验收方式 | 每个 API 项授权后都跑真实链路验收（真实事件、真实重放、真实重试），**不允许用本地脚本伪造** |
| 状态口径 | READY = 工程已就绪只等授权 · WAITING = 已原则批准、等宿主 · BACKLOG = 需先补设计 · FORBIDDEN = 禁止，不在本清单 |

---

## 1. 总览

| # | 项目 | 用途 | 需要宿主 | 工程侧现状 | 状态 |
|---|---|---|---|---|---|
| API-01 | Stripe（test mode） | 成功费收款闭环 | test 账号 + webhook signing secret + 允许 Stripe CLI | webhook 验签 / PaymentEvent / 执行恢复 / 对账差异清单全部就绪 | **WAITING AUTHORIZATION**（架构方已原则批准） |
| API-02 | 平台只读连接器（Amazon SP-API / Walmart / TikTok Shop） | 结算明细、扣费、退款、FBA 数据自动拉取 | 平台开发者应用 + 卖家授权（只读 scope） | 连接器契约 / 编排器 / quarantine / 来源指纹 / 连接生命周期 | **BACKLOG**（前置：C-0014 Cursor Persistence） |
| API-03 | 物流轨迹与承运商 API（17TRACK / EasyPost；FedEx / UPS / DHL） | 轨迹、签收（POD）、SLA 与账单明细 | 各家开发者账号 / API key / OAuth | 与 API-02 同一 Adapter 层；渠道枚举已含 UPS / FEDEX / DHL | **BACKLOG** |
| API-04 | 文档 AI（Docling + DeepSeek） | 扫描件字段抽取、异常解释 | 模型 API key（引用名） | 生态位已定，`apps/ai` 服务未建 | **BACKLOG**（OCR 亦明确后置） |
| API-05 | 对象存储与生产基础设施（S3 兼容 / 域名 TLS / Temporal） | 生产运行底座 | 存储账号、域名与证书、服务器 | 存储适配层（local/s3）已就绪，默认 local | **WAITING**（部署类，非第三方 API） |
| API-06 | 通知渠道（邮件等，可选） | 邀请直达邮箱、高额卡口通知 | SMTP / 邮件服务账号 | 邀请当前为令牌制，**未实现邮件发送** | 可选 · BACKLOG |

---

## 2. 逐项详情

### API-01 Stripe（test mode 联调）—— 唯一已被架构方「原则批准」的一项

**为什么需要 API**：成功费要在客户实际付款后自动对账（`BillingInvoice` → `Payment` → `Settlement`）。金额判定、佣金、退款归属属资金链路，已由架构方单独裁决，不在本项范围内。

**需要宿主提供**

1. Stripe **test** 账号（不接生产）
2. test 模式的 webhook signing secret
3. 宿主机允许运行 Stripe CLI（架构方选定方式 b：`stripe listen --forward-to`）

**凭据放哪**：只在启动 API 的那个 shell 里设置 `PAYMENT_WEBHOOK_SECRET`，验证结束立刻删除；`PAYMENTS_ENABLED` 默认 `false`，验证期间临时置 `true`。

**工程侧已就绪**

- 端点 `POST /payments/webhook`（原始 body + `Stripe-Signature`，验签失败 → 400，不走会话鉴权）
- `PaymentEvent` / `PaymentProcessingAttempt` / `Payment` 三张表 + 执行恢复、重放、重试到期扫描
- 财务对账差异清单（只读，零写入）
- 9 条 provider 形状用例（签名、事件链、退款、未知事件、金额不符 → 人工卡口）

**授权后 Codex 会跑**（手册：`reports/C-0010-C2-runbook.md`）：
事件成功 → 账单 PAID；同事件重放 → DUPLICATE、不重复入账；失败/退款事件不产生 attempt；投递失败 → attempt#1 RETRYABLE_FAILED → provider 重投 → attempt#2 SUCCEEDED；只读 SQL 校验唯一性与审计完整性；结束回滚 `PAYMENTS_ENABLED=false`。

**风险提示**：`PAYMENT_REVIEW_THRESHOLD` 默认 `1000.0000` —— 超过阈值的人工卡口必须保留。

---

### API-02 平台只读连接器（Amazon SP-API / Walmart / TikTok Shop）

**为什么需要 API**：无 API 时靠宿主手工导出文件（已支持，见 `tools/validation-run/README.md`）。接入 API 后可自动、连续地拉结算明细与扣费项。

**需要宿主提供**：平台开发者应用（client id / secret）+ 卖家授权（**只读 scope**）；一个已授权账号 = 一个 `SourceConnection`。

**凭据放哪**：`SourceConnection.credentialRef` 只存**引用名**（`kind=API` 时必填，初始状态 `NEEDS_AUTH`）；真实 token 由宿主机密钥管理提供，**绝不入库**（不保存 access/refresh token、cookie、authorization header、API key）。

**工程侧已就绪**：连接器契约（不可变 `connectorId` + 非空只读 scope）、Fetcher / Normalizer 分离（Fetcher 不得直接产生 ClaimItem）、编排器 + quarantine、来源指纹 v1（幂等）、有界重试 Runner、连接生命周期与轮换审计。

**前置依赖（架构方裁定）**：**C-0014 Cursor Persistence** 仍为 BACKLOG —— 真实平台同步需要游标持久化（多租户同步状态 / retry / rate limit / connector health / sync history）。当前文件游标仅限测试与开发使用。

**授权后 Codex 会跑**：单平台只读拉取 → 规范导入 → 来源指纹幂等（重复拉取不重复入账）→ quarantine 判定 → 审计不扩散凭据 → 限流与重试点验。

---

### API-03 物流轨迹与承运商官方 API（17TRACK / EasyPost；FedEx / UPS / DHL）

**为什么需要 API**：轨迹与签收（POD）是延误/丢件类索赔的证据来源，也是 SLA 判定的输入；承运商账单明细用于账单争议。

**需要宿主提供**：聚合商或承运商的开发者账号与 key（或 OAuth 应用）。

**工程侧已就绪**：与 API-02 同一 Adapter 层（`platform` 例如 `ups` / `fedex` / `dhl`）；渠道枚举已含 `UPS` / `FEDEX` / `DHL` / `FREIGHT_FORWARDER`；平台特有字段只允许出现在 `AdapterRecord.source`（证据），不得进入核心领域模型。

**顺序建议**：先接**一家**验证整条链路，再横向铺开 —— 避免一次接四家导致排障困难。

---

### API-04 文档 AI（Docling + DeepSeek）

**为什么需要 API**：扫描件 / PDF 的字段抽取与异常解释需要模型能力（`AI_SERVICE_URL` + `DEEPSEEK_API_KEY_REF`，只写引用名）。

**现状**：`apps/ai` 尚未建立（README 已明确标注未完成）；**OCR 已被架构方判为 BACKLOG**（理由是会把商业验证变成文档解析工程）。

**建议**：等 VALIDATION-RUN-001 跑完、确认商业价值后再开闸；届时先只做「字段抽取」，不做任何金额或追回判断。

---

### API-05 对象存储与生产基础设施

| 项 | 变量 | 现状 |
|---|---|---|
| 对象存储 | `STORAGE_DRIVER`（local / s3）、`S3_ENDPOINT`、`S3_BUCKET`、`S3_REGION`、`S3_ACCESS_KEY_REF`、`S3_SECRET_KEY_REF` | 适配层就绪，默认 `local`；生产切 `s3` 需宿主提供存储账号 |
| 签名下载密钥 | `STORAGE_URL_SECRET`、`STORAGE_TOKEN_KEY`、`STORAGE_SIGNED_URL_TTL_SECONDS` | 机制就绪，真实值待配置 |
| 审计盐值 | `AUDIT_IP_SALT` | IP 只落加盐哈希，生产必须单独配置 |
| 域名与 TLS | — | 生产部署属宿主动作（含 DNS） |
| 工作流引擎 | `TEMPORAL_ADDRESS`、`TEMPORAL_NAMESPACE` | 默认本地；生产按需 |

**注意**：这一项不是第三方 API 授权，而是**部署前置**；但同样只能由宿主开闸。

---

### API-06 通知渠道（可选）

现状：邀请是**令牌制**（管理员建邀请 → 被邀请人凭 token 接受），**没有邮件发送组件**；人工卡口（HITL）通知也只在系统内。

若希望「邀请直达邮箱 / 高额卡口即时通知」，需要邮件服务账号（SMTP 或服务商 API），我们再补一层发送适配器（不影响现有鉴权与审计）。属可选，等宿主点名。

---

## 3. 建议对接顺序

1. **一份真实 / 脱敏真实平台导出文件**（不需要 API，直接加速商业验证；见 `reports/VALIDATION-RUN-001-REQUEST.md`）
2. **API-01 Stripe test mode**（唯一已原则批准、工程 100% 就绪的一项）
3. **API-02 平台只读连接器**（先补 C-0014 游标持久化，再只接**一家**平台）
4. **API-03 物流 / 承运商**（先一家）
5. **API-04 文档 AI**（等商业验证结论）
6. **API-05 生产基础设施**（与部署节奏一致）

---

## 4. 明确不在本清单的动作（禁止或暂缓）

| 动作 | 状态 | 原因 |
|---|---|---|
| 自动提交 Claim / Appeal 到平台 | **FORBIDDEN** | 类型层已锁死（`supportsClaimSubmission: false`），提交闸门恒返回 `NEEDS_MANUAL`；要开启必须重新走架构方审计 |
| 平台风控绕过 / 无授权抓取 | **FORBIDDEN** | 产品章程硬约束 |
| 海关 / 报关申报相关接口 | **FORBIDDEN / 需牌照判断** | 合规与牌照边界，须宿主与架构方共同裁定 |
| OCR 自动化 | BACKLOG | 会把商业验证变成文档解析工程 |
| 支付渠道扩展（PayPal / 微信 / 支付宝等） | BACKLOG | 先验证价值闭环，再谈支付闭环 |

---

## 5. 维护规则

- 新增任何 API 需求 → 先回架构方审计（范围 / 依赖 / 许可证），再进本清单
- 每项开闸后只做该一项的接入 + 真实验收，不在同一轮顺手扩范围
- 本文档不记录任何凭据取值，只记录引用名与「是否已配置」
