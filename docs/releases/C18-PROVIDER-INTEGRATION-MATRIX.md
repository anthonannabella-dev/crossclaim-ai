# C18 — REAL CUSTOMS PROVIDER INTEGRATION MATRIX（Layer 3 / P0）

> 状态：**规划 + 矩阵阶段（HOLD_EXTERNAL）**。本文件是 C18 的执行骨架：接入矩阵、字段级 mapping、
> adapter 分层规则、离线可完成项与 HOST_ACTION_REQUIRED 清单。
> **任何标注 UNVERIFIED 的单元格都必须凭 provider 官方文档 / 沙盒实测 / 合同确认后才能变为事实**；
> 本文件禁止凭猜测填写 provider 的商务与合规事实。
>
> 边界（不变）：External Write = HOLD、Payment = HOLD、Provider Transport = HOLD、
> Production Credentials = HOLD、TRANSPORT=false；`FINAL_ACCEPTANCE_HEAD = 0f7f7ac` 未改动。

## 0. 目标链路（本阶段要接通的真实路径）

```
真实客户授权（IOR / POA / Authorized Signer）
  → CrossClaim 自动发现 Recovery Opportunity（现有 C1–C21 / CA-1–CA-6）
  → 计算可追回金额（现有 Estimate / Money Ledger）
  → 客户一次确认 + 只补缺失授权（CA-5 / CA-6 Authorization Center + One-click plan）
  → Claim-Ready Package（现有 C11/C14）
  → 【C18】Broker / ABI / Filing Provider 提交
  → Provider 状态回传（webhook / polling → C19 filing status 投影）
  → 真实追回到账（C20 settlement / recovery outcome）
  → Success Fee 计费（现有 Billing / FeeCalculation）
  → 全链路证据与审计留痕（AuditLog / append-only facts）
```

结论：**C18 的边界是「把已有 package 送出去、把状态收回来」，不是重做内部引擎。**

## 1. 候选 Provider 类别（先按能力分类，再逐家核验）

| 类别 | 代表形态 | 在链路中的角色 | 关键前置 |
|---|---|---|---|
| A. Customs Entry Data Provider | 贸易数据 / ACE-ABI 数据聚合服务 | 提供 entry / duty line / IOR 事实（对应 `CustomsEntryFactRecord`） | 数据来源合法性、POA 或数据授权、是否允许转售派生结果 |
| B. Licensed Customs Broker | 持牌报关行（US customs broker） | POA 授权后由 broker 代为提交 drawback / post-entry / protest | 是否接受第三方 SaaS 代客提交、POA 模板与签署方式、broker 内部审批 |
| C. ABI / Filing Software Provider | 报关软件 / ABI 传输服务商 | 提供 API 化 filing / status / RFI 通道 | 是否开放第三方 API、是否要求自有 broker 资质、沙盒可用性 |
| D. Duty Recovery / Drawback Specialist | 专做 drawback / refund 的服务商 | 端到端代提交 + 到账 | 分成模式、客户合同归属、是否允许 CrossClaim 作为前台 |

> **UNVERIFIED**：以上四类的具体厂商、商务条件、技术能力均需逐家核验（见 §3 核验清单）。

## 2. 接入矩阵字段（每家 provider 逐格填写 + 证据链接）

矩阵以 **provider-neutral 能力**为准，字段与 `customs-filing-provider.ts`（C15 契约）对齐：

| # | 字段 | 取值 / 格式 | 决策影响 | 证据要求 |
|---|---|---|---|---|
| 1 | API 形态 | REST / SOAP / SFTP / 仅 UI | 决定 adapter 传输层 | 官方 API 文档链接 |
| 2 | 认证方式 | OAuth2（客户授权）/ API Key / mTLS / 双向签名 | 决定 `ProviderCredentialRef` 与凭据边界 | 文档 + 沙盒实测 |
| 3 | Webhook 支持 | 有 / 无 / 仅轮询 | 决定 C19 状态回传是 push 还是 pull | 文档 + 签名验证方式 |
| 4 | Sandbox | 可用 / 需申请 / 无 | 决定能否离线完成 mock→sandbox E2E | 申请入口 |
| 5 | POA 签署方式 | 电子签 / 纸质 / provider 平台内签 | 决定 CA-5 ③/④ 的客户动作 | 模板 + 法律审查 |
| 6 | IOR 要求 | 是否必须 IOR 本人 / 可否 claimant 代位 | 决定 CA-2 signer 类型与 `IOR_NOT_CONFIRMED` 判定 | 官方政策链接 |
| 7 | 支持国家/辖区 | US / EU / UK / … | 决定 `jurisdiction` 路由与 policy | 覆盖清单 |
| 8 | 能力覆盖 | DRAWBACK / DUTY_REFUND / POST_SUMMARY_CORRECTION / PROTEST / EXCLUSION_REFUND / DUPLICATE_DUTY | 映射到 `CustomsFilingOperation` | 文档 + 实测 |
| 9 | API 申请门槛 | 自助 / 审核 / 需资质 / 需 Partner | 决定 HOST_ACTION 时点 | 申请页面 |
| 10 | Partner / Reseller / Referral | 是否开放、条件、分成 | 决定商务路径 | 合同/条款 |
| 11 | 收费模式 | 按件 / 按成功 / 订阅 / 分成 | 与 Success Fee 的关系须显式声明 | 价目表 |
| 12 | **是否允许第三方 SaaS 代客提交** | 允许 / 需书面授权 / 禁止 | **决定 CrossClaim 是否为合法提交主体** | 书面条款（法务） |
| 13 | 撤销授权机制 | API revoke / 平台操作 / 需人工 | 映射到 CA-3/CA-4 revoke / expire / supersede | 文档 + 实测 |
| 14 | Production approval | 自助上线 / 人工审核 / 需合规材料 | 决定上线路径与时长 | 官方流程 |

### 2.1 字段级 mapping（我方 → provider）

| 我方事实（server-derived） | 载体（现有） | C18 DTO 字段 | provider 映射 |
|---|---|---|---|
| organization / tenant | `organizationId`（全表 scoped） | `tenantRef` | provider 侧 tenant/account（1:1 绑定，禁止跨租户复用） |
| principal / IOR | `CustomsIorIdentityFact.importerOfRecordRef`（opaque ref） | `principalRef` | provider 的 importer 标识（**只允许 opaque ref / provider 内部 ID**） |
| jurisdiction | `CustomsRightLineageFact` / policy | `jurisdiction` | provider country/jurisdiction code |
| remedy | `lineage.remedyRoute`（DRAWBACK / PROTEST / …） | `remedy` | provider 的 program/type 枚举 |
| broker | `CustomsBrokerPoaFact.brokerRef` + CA-4 session | `brokerRef` | provider 侧 broker identity |
| POA | `CustomsBrokerPoaFact`（append-only，含 scope/jurisdiction/有效期） | `poaRef` + `poaScope` | provider 的 POA 记录 / 授权号 |
| authorized signer | `CustomsAuthorizedSignerFact`（类型 / 权限 / 有效期） | `signerRef` + `signerType` | provider 的签署人身份（如适用） |
| filing authorization | `lineage.filingAuthorized`（与追回权分离） | `filingAuthorized` | provider 侧是否能代表提交 |
| evidence package | Claim-Ready Package（`packageId` + `packageDigest`） | `packageRef` + `contentDigest` | provider 的文档上传/材料清单 |
| submission | C15 `createSubmission` / C17 ledger | `submissionRef` | provider submission id |
| provider status | C19 filing status facts | `providerStatus` + `sourceLevel` | provider status enum（禁止隐式升级） |
| recovery outcome | C20 settlement / recovery outcome | `recoveryOutcome` | provider 的 paid/approved 事实 |

硬规则：
1. **opaque only**：不把 EIN / importer number / 银行账号等原始敏感值写入任何 provider 请求或我方事实表；
   一律使用 opaque ref 或 provider 内部 ID（沿用 `evaluateIorIdentity` / `OPAQUE_REF_RE` 口径）。
2. **digest 稳定**：所有对外载荷都要有规范化 digest（沿用 C17 ledger / CA-3 的 digest 规范），用于幂等与对账。
3. **状态不升级**：`USER_REPORTED ≠ ACCEPTED`、`APPROVED ≠ PAID`（沿用 C19 的护栏）。

## 3. 逐家核验清单（每个候选 provider 走一遍）

1. 官方 API/OAuth/Webhook 文档 → 存入 `docs/releases/C18-EVIDENCE/<provider>/`（链接 + 抓取日期）。
2. 申请沙盒账号（**这一步通常是 HOST_ACTION_REQUIRED**）。
3. 沙盒实测：认证 → 建单 → 上传材料 → 查状态 → 撤销授权 → 错误路径。
4. 商务/法务确认：§2 第 10–14 项（尤其"是否允许第三方 SaaS 代客提交"）。
5. 产出：`C18-PROVIDER-<NAME>-PROFILE.md`（矩阵填满 + 证据链接 + 结论：可接入 / 需条件 / 不可行）。

## 4. Adapter 分层（不得污染核心引擎）

```
Recovery Engine（现有，provider-neutral）
  └── CustomsFilingProvider 契约（C15：capabilities + 7 个方法）
        ├── SandboxFilingProvider（本阶段实现：内存/Stub，零外写）
        ├── MockAbiProvider（negative-path 测试用）
        └── <RealProvider>Adapter（未来：仅在拿到凭据与授权后实现，feature-gated）
```

规则：
- 单一 provider 的分支、字段名、错误码 **只允许出现在 adapter 内**；
- core 只依赖 C15 契约与 `CustomsFilingOperation` 能力位；
- 任何真实 adapter 必须默认 disabled，通过显式 enablement 裁决 + tenant 级绑定才可用；
- 外写仍走既有 Action Guard / idempotency ledger（C17），不得绕过。

## 5. 离线可完成清单（不等凭据，持续自治推进）

| 单元 | 内容 | 风险 | 审计 |
|---|---|---|---|
| C18-1 | 本矩阵 + 每 provider profile 骨架 | LOW | NO |
| C18-2 | C18 DTO/schema（provider-neutral 请求/响应 + digest） | MEDIUM | NO |
| C18-3 | SandboxFilingProvider（零外写，覆盖 8 个 capability + 7 个方法） | MEDIUM | NO |
| C18-4 | Webhook 验证骨架（签名校验 + 时间窗 + 重放拒绝 + sourceLevel 映射） | HIGH | YES |
| C18-5 | 幂等/重试/对账：与 C17 ledger 的接线 + 歧义响应不盲重试 | HIGH | YES |
| C18-6 | tenant/account lineage：provider tenant ↔ organization 1:1 绑定与 fail-closed | HIGH | YES |
| C18-7 | 授权生命周期：provider 侧 revoke/expire/re-auth 与 CA-3/CA-4 的映射 | HIGH | YES |
| C18-8 | Negative-path + mock/sandbox E2E（含跨租户 / 无授权 / 已撤销 / provider 拒绝） | MEDIUM | YES |

## 6. HOST_ACTION_REQUIRED（一次性列清，避免逐条打断）

真正需要宿主动作的（其余继续自治推进）：

1. **Provider 账号**：选定目标 provider 类别并注册/申请开发者或 Partner 账号（含公司信息、用途说明）。
2. **商务协议**：接受其 Developer/Partner/Reseller 条款；确认"第三方 SaaS 代客提交"是否被允许（法务结论）。
3. **资质材料**：提交公司/KYC/IOR/报关行关系等材料（如需）。
4. **生产凭据**：提供 Client ID / Client Secret / mTLS 证书 / webhook 签名密钥（进 secret 管理，不入库不入日志）。
5. **真实 POA**：以客户身份签署真实 POA / 授权书；确认可复用范围（同 principal/jurisdiction/scope/route）。
6. **费用**：沙盒外的任何付费（月费/按件/保证金）。
7. **开启真实外写**：明确授权从 HOLD 切换为 ALLOW（含首个真实提交的时间窗与范围）。
8. **真实报关/退款/资金动作**：真实 filing、真实到账、真实计费动作的授权。

> 在此之前，C18-1…C18-8 全部可按上表离线推进；每个单元完成即 commit + push，并按风险等级送审计。
