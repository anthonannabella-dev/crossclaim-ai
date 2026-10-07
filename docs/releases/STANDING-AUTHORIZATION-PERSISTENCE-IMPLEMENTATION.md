# STANDING AUTHORIZATION 持久化 —— 最小 Delta 实施记录（P0）

授权：HOST 2026-10-07「AGENT EXPERIENCE LAYER + DURABLE AUTHORIZATION + GOAL ORCHESTRATION」P0。
前置审计件：`docs/releases/STANDING-AUTHORIZATION-PERSISTENCE-DELTA-REQUEST.md`（REQUEST ONLY）。

结论：**APPROVED_BY_HOST_DIRECTIVE → IMPLEMENTED**。按最小增量实施 1 表，无新增枚举，
不建第二套 approval / authorization / guard，不授予任何 External Write。

`EXACT_HEAD = 0a710d8b`（本单元实现提交；基线 `96a26c29`）

---

## 1. 为什么（真实缺口）

SA-1 / SA-3 / SA-3b 已交付「授权核心 + 风险分级 + 判定解析器 + 真实调用点接线」，
但授权记录本身**没有持久化承载**：调用方只能注入 `loadAuthorization(query)` 端口，
因此「客户一次授权 → 后台持续运行」在进程重启后无法续用，也没有审计级的版本 / 撤销留痕。

## 2. 交付内容

| 类别 | 文件 |
|---|---|
| Schema | `apps/api/prisma/schema.prisma` → `model StandingAuthorization`（109 个模型） |
| Migration | `apps/api/prisma/migrations/20261007090000_standing_authorization/migration.sql` |
| 服务 | `apps/api/src/services/standing-authorization/standing-authorization-store.ts` |
| 测试 | `apps/api/src/__tests__/standing-authorization-persistence-db.test.ts`（10 例，真实 PostgreSQL） |
| 清单同步 | `tools/tenant-triggers/required-triggers.json`（+1 baseline）、`tools/tenant-triggers/append-only-triggers.json`（+1 受控变更守卫 + 前缀） |
| 架构契约 | `apps/api/src/__tests__/architecture-contract.test.ts`（模型总数 108 → 109；`StandingAuthorization` 纳入 CORE / TENANT_OWNED） |

## 3. 表结构（1 表，无新增枚举）

字段与 Delta 请求逐一对应：`id`(=authorizationId) / `organizationId` / `platformAccountId` / `provider` /
`allowedActionTypes`(JSONB) / `monetaryLimitUsd` DECIMAL(18,4) / `currency` / `domain` / `jurisdiction` /
`effectiveAt` / `expiresAt` / `authorizationVersion` / `termsPolicyVersion` / `consentEvidenceRef` /
`revocationState` / `revokedAt` / `revokedBy` / `revocationReason` / `scopeDigest` / `createdAt`。

约束与索引：

* `@@unique([organizationId, platformAccountId, provider, authorizationVersion])`（同 scope 版本唯一，追加式）；
* `@@unique([organizationId, id])`（复合键基础，租户一致性约定）；
* `@@index([organizationId, platformAccountId, provider, revocationState, expiresAt])`（按 scope 取最新/判活）；
* CHECK：`monetaryLimitUsd >= 0`、`authorizationVersion >= 1`、`revocationState IN ('ACTIVE','REVOKED','SUSPENDED')`、
  `length(scopeDigest) = 64`、`expiresAt > effectiveAt`、`allowedActionTypes` 必须是非空 JSON 数组、
  **撤销必须留痕**（非 ACTIVE 状态必须有 `revokedAt` + 非空 `revokedBy`；ACTIVE 状态三者必须为空）。

## 4. 不变量（实现即强制）

| 要求 | 实现方式 |
|---|---|
| tenant scoped | `organizationId` 非空 + `cc_tenant_standingauthorization` 基线触发器 + `cc_tenant_immutable__StandingAuthorization` 归属不可变触发器 |
| server-derived | 只经 `createStandingAuthorization`（`serverDerived !== true` → `STANDING_AUTH_CLIENT_FORGED` 抛错）落库 |
| 版本化 / 追加式 | 同 scope 同版本唯一；修改 = 追加新 `authorizationVersion` 行 |
| 旧版本保留 | 不删除、不原地改写；`loadStandingAuthorization` 取**最新版本**（含撤销行），旧版本请求由既有判定 `VERSION_STALE` → DENY |
| 撤销留痕 | `revocationState/revokedAt/revokedBy/revocationReason` 四列 + CHECK 约束；撤销某 scope = 该 scope **全部版本**转 REVOKED |
| 过期 / 撤销 / 版本过期 fail-closed | 复用既有 `evaluateStandingAuthorization`（本模块不做放行判定） |
| scopeDigest 不得静默篡改 | 读取时既有判定复核 digest（不一致 → DENY）；数据库侧 `cc_standing_auth_scope_immutable__StandingAuthorization` 禁止 UPDATE 改写任何 scope 列 |
| 不建第二套 approval | 未新增 approval / 目录 / 判定实现；仅新增「授权记录存储」 |
| 不授予 external write | `STANDING_AUTHORIZATION_STORE_BOUNDARY.grantsExternalWrite = false`；本模块不执行任何动作 |
| 接既有 resolver 端口 | `createPrismaStandingAuthorizationResolverDeps(prisma)` → `StandingAuthorizationResolverDeps.loadAuthorization` |
| 真实调用点继续复用 | 调用点（`hitl-submission` / `action-pack-runtime`）仍走 SA-3b 的 `verifyApprovalOrThrow` / `withActionGuard`，只是授权来源从内存换成 durable store |

## 5. 测试证据（真实 PostgreSQL）

套件 `standing-authorization-persistence-db`：**10/10 PASS**

| 例 | 覆盖 |
|---|---|
| PG-SA1 | 落库 → **新 PrismaClient（进程重启等价）**仍可加载；判定 SATISFIED |
| PG-SA2 | 同版本重复写入幂等（REUSED，1 行）；scope 不一致 → VERSION_CONFLICT（不产生第二行） |
| PG-SA2b | 并发写同一版本 → 恰好 1×APPENDED + 1×REUSED，行数 1 |
| PG-SA3 | 撤销留痕（谁/何时/为什么）+ 撤销后 DENY（`STANDING_AUTH_REVOKED`，不回退人工审批）+ 重复撤销幂等 |
| PG-SA4 | 过期 → DENY（`STANDING_AUTH_EXPIRED`） |
| PG-SA5 | 追加式版本：v1 行保留、加载取 v2、旧版本请求 DENY（`VERSION_STALE`）、撤销覆盖全部版本 |
| PG-SA6 | account 不匹配 → DENY；金额超限 → **REQUIRE_APPROVAL**（不是 DENY） |
| PG-SA7 | tenant 隔离：跨租户按 scope / 按 id / 列表查询一律空 |
| PG-SA8 | 数据库级兜底：scope 改写、归属改写、负额度、版本 0、非法状态、digest 长度、撤销不留痕、非法 actions 全部被拒 |
| PG-SA9 | 接入既有 resolver 端口：有效授权 → ALLOW(STANDING_AUTHORIZATION)；撤销后 → DENY |

配套验证：

* `api tsc --noEmit` = **exit 0**
* `prisma validate` = **valid**；`prisma migrate deploy` = 89 migrations 全部成功（本机 `crossclaim` DB）
* 定向安全横扫 **236/236 PASS**：architecture-contract（159，含模型总数 109）· tenant-isolation（19）·
  standing-authorization（19）· verifier-wiring（10）· resolver（14）· callsite-wiring（5）· persistence-db（10）
* 触发器清单（对照真实库）：
  `emit-check-sql.mjs` → **OK: required tenant triggers=114 baseline, 91 immutable, 2 scoped**；
  `emit-check-append-only-sql.mjs` → **OK: append-only/controlled-mutation triggers=68**

## 6. 边界（未解锁）

* `REAL_PROVIDER_WRITE` / `CUSTOMS_FILING` / `PAYMENT` / `AUTO_COMMISSION_CHARGE` / `PRODUCTION_CREDENTIALS` /
  `PRODUCTION_ENABLEMENT` / `EXTERNAL_WRITE` / `TRANSPORT` = **HOLD**（本单元未触碰）。
* 高金额 HITL（> USD 1,000 → OWNER/ADMIN；≥ USD 10,000 → ADMIN）= **KEEP**，授权不得绕过。
* Customs 15-gate readiness 不变；Standing Authorization ≠ Broker POA。
* 本单元不改变任何调用点的默认行为（未注入 `standingAuthorization` 时仍走一次性审批）。

## 7. 下一步（本任务后续单元）

`STANDING_AUTHORIZATION_DURABLE = PASS` 后，P1（Agent Goal Domain）→ P2（Goal → 现有 ONE SI Runtime）
→ P3（Goal 持久化）→ P4–P8（Goal Console / Needs Your Attention / Agent Run / Authorization UI / 导航）
按 HOST 顺序继续；Authorization 管理 UI（P7）直接复用本表读取面 `listStandingAuthorizations`。
