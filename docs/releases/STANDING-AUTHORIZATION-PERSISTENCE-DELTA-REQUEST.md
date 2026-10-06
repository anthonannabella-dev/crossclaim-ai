# STANDING AUTHORIZATION — 最小持久化 Schema Delta 审计请求（**未实施**）

授权依据：HOST 2026-10-06「STANDING AUTHORIZATION / RISK-TIERED AUTONOMOUS EXECUTION」；
工程纪律「Schema Delta 必须先做最小审计、不静默改 Production Schema」。

状态：**REQUEST ONLY / NOT APPLIED**。本次交付的 Standing Authorization 为**纯函数 + 端口**实现
（`StandingAuthorizationRecord` + `evaluateStandingAuthorization` + 调用点可选透传），**未新增表、未新增 migration**。

---

## 1. 为什么需要（真实缺口）

SA-3b 已把判定接入真实入口（`hitl-submission`（workflow/http-routes 的 6 处 + recovery/http-request）、
`action-pack-runtime`），但**授权记录本身没有持久化承载**：调用方目前只能从内存/注入的
`loadAuthorization(query)` 端口取得记录。因此「客户一次授权 → 后台持续运行」在**进程重启后无法续用**，
也无法做到审计级「授权变更历史 / 撤销留痕」。

## 2. 提议的最小 Delta（1 表，无需新增枚举）

| 项目 | 内容 |
|---|---|
| 表名 | `StandingAuthorization` |
| 主键 | `id String @id`（= `authorizationId`） |
| 关键列 | `organizationId String` · `platformAccountId String` · `provider String` · `allowedActionTypes Json`（稳定 code 数组） · `monetaryLimitUsd Decimal(18,4)` · `currency String` · `domain String` · `jurisdiction String` · `effectiveAt DateTime` · `expiresAt DateTime` · `authorizationVersion Int` · `termsPolicyVersion String` · `consentEvidenceRef String` · `revocationState String` · `revokedAt DateTime?` · `revokedBy String?` · `revocationReason String?` · `scopeDigest String` · `createdAt DateTime` |
| 约束 | `@@unique([organizationId, platformAccountId, provider, authorizationVersion])`（同 scope 版本唯一）· `@@index([organizationId, platformAccountId, provider, revocationState, expiresAt])` · CHECK：`monetaryLimitUsd >= 0`、`authorizationVersion >= 1`、`revocationState IN ('ACTIVE','REVOKED','SUSPENDED')`、`scopeDigest` 长度 64、`expiresAt > effectiveAt` |
| 版本化语义 | **追加式版本**：修改授权必须插入新 `authorizationVersion`（旧版本行保留，供审计与"旧版本不得继续生效"的对账）；不在原行上改写 scope |
| 撤销语义 | 撤销通过写 `revocationState/revokedAt/revokedBy/reason`（或按审计口径插入撤销事件）；`scopeDigest` 不变 |
| 租户隔离 | 与既有 tenant-owned 表一致：`organizationId` 非空 + tenant guard 触发器登记（`tools/tenant-triggers/*`） |

**明确不做**：不建第二套 approval 表、不复制 Action Guard 目录、不建第二事实源。

## 3. 安全要求（Delta 实施时必须一并满足）

1. 只能由 server-side 流程写入（禁止客户端自报 scope / limit / allowedActionTypes）。
2. 追加式版本：不允许静默修改既有版本的 scope 字段（否则破坏"旧版本失效"语义）。
3. 撤销必须留痕（谁、何时、为什么），且撤销后旧版本立即失效（本模块判定已 fail-closed，落库需保持一致）。
4. 不改变 Policy / Guard / Control Plane / Action Catalog 归属；不授予任何 External Write。

## 4. 影响面与回滚

* 影响：新增 1 表 + 触发器清单登记 + 架构契约模型计数同步；**不改动既有表**。
* 回滚：Drop 该表即回到本请求之前形态；本次交付的代码在无表时仍可用注入式 `loadAuthorization` 端口运行。

## 5. 请求

请架构方裁定：**APPROVE / APPROVE WITH REVISE / REJECT**，并给出
`STANDING_AUTHORIZATION_SCHEMA_DELTA = APPROVED(_WITH_REVISIONS) | REJECTED`，
以及是否要求在本程序内立即实施（若要求，将按既有流程：migration → tenant 触发器登记 → 架构契约同步 → PG 级测试 → 全量回归）。

