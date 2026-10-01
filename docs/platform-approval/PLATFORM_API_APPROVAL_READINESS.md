# PLATFORM_API_APPROVAL_READINESS

> 持久规则：`.autopilot/RULES.md` **R11 Platform API Approval Readiness（并行准备线）**；机器可读镜像 `.autopilot/rules.json` → `platform_api_approval_readiness`；校验器挂在既有 `tools/autopilot/check-autopilot-rules.mjs`。
> **本线不得打断主开发队列**：TRACK A = R44 → R45 → R46 → Full Regression → Production Candidate；TRACK B = 本文件所在准备线。

---

## 1. 目标（不是现在申请，而是提前就绪）

在产品代码完成**之前**，把 Amazon / TikTok Shop / Walmart / Shopify / WooCommerce（以及 P2/P3 的 WooCommerce 之外的独立站）在 API 准入、安全材料、OAuth/授权方式、最小 Scope、数据生命周期与生产安全要求上**准备好**，避免「代码已完成但材料/安全/隐私未就绪，额外等待数周」。

**Codex 职责**：PREPARE · IMPLEMENT SAFE FOUNDATION · DOCUMENT · TEST · IDENTIFY GAPS。
**Codex 不做**：替宿主申请平台账号、提交申请、写入真实 Client Secret / Refresh Token、开启 write scope、接生产支付凭据。

## 2. 平台范围与优先级（P1 顺序不得改变 Recovery OS 主线）

| 优先级 | 平台 | 商业模式定位 | 目标形态 |
| --- | --- | --- | --- |
| P1 | **Amazon SP-API** | 多卖家 Public Application | Public Developer App + LWA（seller authorization） |
| P1 | **TikTok Shop** | 多商户商业 SaaS / Connector | Official API + Seller Authorization |
| P1 | **Walmart Marketplace** | Solution Provider（多商户商业 SaaS） | Solution Provider + OAuth merchant authorization |
| P1 | **Shopify** | 独立站第一优先，多商户 SaaS | Public App + merchant authorization |
| P2 | **WooCommerce** | 自托管独立站 | 官方 REST API + merchant authorization（或商户生成的只读 key） |
| P3 / OSS_LATER | BigCommerce、其他独立站、其他 PSP、其他物流商 | 保留 ExternalAdapter 接口 | 进入实施批次时再核 OAuth/Marketplace/Scopes/Security |

## 3. 统一接入原则（所有平台一致）

```
Official API / Official OAuth
  → Platform Adapter
  → SourceConnection
  → Raw SourceTransaction
  → CanonicalFact
  → Rule Engine
  → RecoveryOpportunity
  → Recovery OS
  → Evidence / Case / Claim / Appeal
  → Settlement → RecoveryLedger → Billing
```

**禁止**：

- 平台 SDK 直接进入 Recovery OS 核心；平台字段直接污染核心领域模型；
- 客户密码进入 CrossClaim；保存 seller 后台登录密码；
- 未授权抓取 / Cookie 偷取 / 模拟登录作为正式生产数据接入方案；
- 绕过官方 API 风控；
- LLM 决定金额、Deadline、Settlement、Fee、Ledger；
- API 接入绕过 Tenant Isolation / RBAC / Audit / HITL / Action Guard。
- 浏览器自动化**只能**作为极特殊辅助能力评估，不得作为正式多租户 SaaS 的主 API 路线。

## 4. V1 统一策略：READ-ONLY FIRST

- 第一阶段申请 **READ-ONLY + LEAST PRIVILEGE + MINIMUM DATA**。
- 只有参与 **Recovery detection / Evidence / Settlement reconciliation / Fee discrepancy / Logistics recovery / Chargeback·dispute recovery / Recovery tracking** 的字段才申请；否则默认不申请。
- **REAL EXTERNAL WRITE 继续 HOLD**；**Claim / Appeal 自动对外提交继续 HOLD**。
- 第一阶段链路保持：`AI Prepare → Human Review → Human Approve → Manual / Approved Submission`。

## 5. 五平台准备度（2026-10-01 实测）

| 平台 | 集成模式 | READ_ONLY | 最小 Scope | Restricted/Protected 数据 | 准备度（文档/安全材料） | 最大缺口 |
| --- | --- | --- | --- | --- | --- | --- |
| Amazon SP-API | `OFFICIAL_API`（Public Developer 目标） | YES（计划） | YES（计划） | **V1 可避免 Restricted PII** | ~40%（scope 矩阵 + 设计已就绪；生产安全证明与账号注册未做） | 生产安全证据（HTTPS/域名/Secret Manager/IR/保留删除）+ Developer App 注册（HOST） |
| TikTok Shop | `OFFICIAL_API` + Seller Authorization | YES（计划） | YES（计划） | 需列明并最小化 | ~25%（路线明确；公司主体/官网/隐私条款/TPRM 未备） | 商业/Connector 路线材料 + 公司主体与法律文档（HOST） |
| Walmart Marketplace | Solution Provider | YES（计划） | YES（计划） | 需列明 | ~20%（路线明确；Solution Provider 申请材料未备） | Solution Provider 申请材料 + Sandbox/OAuth 设计落地（HOST 申请） |
| Shopify | `OFFICIAL_API`（Public App 目标） | YES（计划） | YES（计划） | **V1 可避免直接身份类 Protected Customer Fields** | ~35%（App Review 清单已列；生产 app/HTTPS/OWASP 证据未做） | App Review 提交所需生产 HTTPS app + 隐私/数据删除处理（HOST + 实施） |
| WooCommerce | `OFFICIAL_API` + Application Authentication / 只读 REST Key | YES（默认） | YES（默认） | 不涉及平台中心化 PCD 审批 | ~45%（接入模式与凭据边界明确；Secret Manager/连接页未落地） | Production Secret Manager + 连接生命周期（Codex 可实施；Secret Manager 需 HOST） |

## 6. 未变化的安全底座（复用，不重做）

Tenant Isolation · RBAC · Membership · Audit · HITL · Action Guard · CAS · Row Lock · Idempotency · Kill Switch · CredentialRef · Secret rejection · File scanning · Signed download · deterministic money logic · append-only / controlled ledger semantics。

## 7. Production Security 需要补齐（IMPLEMENTED + TESTED + EVIDENCE AVAILABLE）

生产 HTTPS/TLS · Production domain · Production Secret Manager/Vault · Encryption at rest / in transit · Secret·OAuth token rotation · OAuth revoke handling · App uninstall/disconnect handling · Data retention policy · Data deletion policy · Customer authorization withdrawal · Backup/restore policy · Dependency vulnerability scanning · CVE response policy · OWASP Top 10 baseline · Security logging/monitoring · Alerting · Incident Response Plan · Production/test 环境分离 · least-privilege 生产凭据。

> 「代码支持」不算证据：平台申请需要 **IMPLEMENTED + TESTED + EVIDENCE AVAILABLE**（见 `SECURITY_CONTROLS_EVIDENCE.md`）。

## 8. 交付物（本目录）

| 文件 | 用途 |
| --- | --- |
| `PLATFORM_API_APPROVAL_READINESS.md` | 本文件（总纲 + 准备度与缺口） |
| `PLATFORM_SCOPE_MATRIX.md` | 五平台汇总矩阵（统一列） |
| `AMAZON_SCOPE_MATRIX.md` / `TIKTOK_SCOPE_MATRIX.md` / `WALMART_SCOPE_MATRIX.md` / `SHOPIFY_SCOPE_MATRIX.md` / `WOOCOMMERCE_SCOPE_MATRIX.md` | 平台专属 scope 矩阵（含业务目的 / PII / MVP / 保留 / 审批依赖 / 决策） |
| `DATA_FLOW_DIAGRAM.md` | 端到端数据流 + LLM 边界 |
| `SECURITY_CONTROLS_EVIDENCE.md` | 生产安全控制与证据状态 |
| `PRIVACY_DATA_LIFECYCLE.md` | 数据生命周期问答（授权→存储→删除→备份） |
| `OAUTH_TOKEN_LIFECYCLE.md` | OAuth / token 生命周期与 Secret Manager 边界 |
| `INCIDENT_RESPONSE_PLAN.md` | 事件响应计划 |
| `HOST_ACTION_CHECKLIST.md` | 必须由宿主执行的动作清单 |

## 9. 执行方式（TRACK A / TRACK B 并行）

| 轨道 | 内容 | 是否阻塞对方 |
| --- | --- | --- |
| **TRACK A** | R44 → R45 → R46 → Full Regression → Production Candidate | 不等待 TRACK B |
| **TRACK B** | 平台要求清单 → Scope 最小化 → Security Evidence → Privacy/Terms → OAuth 设计 → 数据生命周期 → 申请包就绪 | **不得**阻塞 TRACK A |

## 10. 宿主控制（未经 HOST APPROVAL 不得）

正式向平台提交申请 · 创建付费平台账号 · 使用真实客户账户 · 写入真实 Client Secret · 写入真实 Refresh Token · 开启真实平台 write scope · 提交真实 Claim/Appeal · 开启生产支付接入 · 使用生产凭据。

## 11. 每轮涉及平台接入时的状态字段

```
PLATFORM =
INTEGRATION_MODE =
OFFICIAL_API = YES / NO
READ_ONLY = YES / NO
MINIMUM_SCOPE = YES / NO
PII_REQUIRED = YES / NO / TBD
PROTECTED_OR_RESTRICTED_DATA = YES / NO
OAUTH_READY =
TOKEN_STORAGE_READY =
REVOCATION_READY =
DATA_DELETION_READY =
SECURITY_EVIDENCE_READY =
APPROVAL_PACKAGE_READY =
HOST_ACTION_REQUIRED =
NEW_RISK_BOUNDARY =
ARCH_REVIEW_REQUIRED = YES / NO
```
