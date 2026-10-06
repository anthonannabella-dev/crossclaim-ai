# STANDING AUTHORIZATION / RISK-TIERED AUTONOMOUS EXECUTION — 回报（SA-1 / SA-2）

授权：HOST 2026-10-06「Standing Authorization / Risk-tiered Autonomous Execution」
分支：`gate/7-commercial-validation`　基线 HEAD：`834e99e8`

审计结论（先扫描既有实现）：既有 Action Guard（`services/action-guard/*`：动作目录 `risk` + `requires` 闸门、
一次性 `humanApproval`、`evaluateActionGuard` 纯函数）与 `APPROVAL_REASON_CODES` / `verifyApprovalOrThrow`
已存在；**不存在**任何 standing / delegated authorization。因此本次**只新增授权与执行政策层**，
**未新建第二套 approval / authorization / guard**，最终执行权仍由既有 Action Guard 决定。

---

## 1. 交付文件

```
apps/api/src/services/standing-authorization/standing-authorization.ts   （授权记录 + 判定 + 撤销/版本）
apps/api/src/services/standing-authorization/risk-tier-policy.ts         （TIER 0–3 多维度分级）
apps/api/src/services/standing-authorization/action-guard-wiring.ts      （与既有 Guard 的组合判定）
apps/api/src/__tests__/standing-authorization.test.ts                    （19 例：覆盖验收 1–12）
```

## 2. 设计要点（对 HOST 要求的逐条落实）

| HOST 要求 | 落实 |
|---|---|
| 1 Standing Authorization：org/account/provider/action/limit/currency/domain/jurisdiction/effective·expires/version/terms/consent/renewal/scope digest | `StandingAuthorizationRecord` 全字段；`computeStandingAuthorizationScopeDigest`（规范化 sha256）；`createStandingAuthorization` 要求 `serverDerived=true`（客户端自报 scope → 抛 `STANDING_AUTH_CLIENT_FORGED`）；`revokeStandingAuthorization` / `bumpStandingAuthorizationVersion` 提供可撤销与版本化 |
| 授权修改后旧版本不得静默继续生效 | 请求携带 `expectedAuthorizationVersion` / `expectedTermsPolicyVersion`；不匹配 → **DENY**（`STANDING_AUTH_VERSION_STALE` / `..._TERMS_POLICY_MISMATCH`） |
| 2 Risk-tiered execution（不得只看金额） | `classifyRiskTier` 同时评估 **11 个维度**（AMOUNT · PROVIDER · DOMAIN · EVIDENCE_COMPLETENESS · EVIDENCE_CONFLICTS · AUTHORIZATION_VALIDITY · HISTORICAL_CONFIDENCE · ACTION_TYPE · JURISDICTION · PROVIDER_TERMS · REGULATORY_REQUIREMENTS），输出 TIER 0–3 与命中维度；受监管动作（`customs.*` / `broker.*` / `abi.*` 或 CUSTOMS 域或 regulatoryFlags）即使金额为 0 也是 **TIER_3** |
| 3 不得绕过 Action Guard / 保留 humanApproval | `evaluateAutonomousExecution` 以既有 Guard 结果为权威：Guard DENY 恒为 DENY；`humanApproval` 可由「一次性审批」**或**「有效 Standing Authorization」满足，且后者**仅**在 TIER_1 生效；`STANDING_AUTHORIZATION_SATISFIABLE_GATES = ['humanApproval']` |
| 不得用于绕过 Production/Platform/KillSwitch/Provider capability/Credential/Customs·POA/Regulatory/隔离 | `collectBlockingGates` 任一未满足 → **DENY**（Standing Authorization 无权满足）；`assertNoNonBypassableGateSatisfiedByStanding` 断言；`STANDING_AUTHORIZATION_NON_BYPASSABLE_GATES` 固化 8 项 |
| 4 高金额规则保留 | `> USD 1,000 → OWNER/ADMIN`、`≥ USD 10,000 → ADMIN` 原样保留（复用既有阈值常量）；`RISK_TIER_BOUNDARY.highValueHitl = 'KEEP'`，且**授权不得绕过**（金额超阈值 → TIER_2/3 → REQUIRE_APPROVAL） |
| 5 Customs：Standing Authorization ≠ Broker POA | `CUSTOMS_POA_BOUNDARY`（platformOAuth ≠ POA、paymentAuth ≠ POA、SA ≠ POA、Form 4811 不得当 POA、POA 复用需 verified + scope + jurisdiction 覆盖、失效需重新找客户/Broker）；`assertStandingAuthorizationIsNotBrokerPoa`；报关动作走 TIER_3 + REGULATORY，POA gate 未满足 → DENY |
| 6 客户体验（一次授权后低风险自动执行） | 政策层已支撑：OAuth → Standing Authorization → （必要时）Broker POA → 选择自动执行范围 → 低风险自动、超范围/高金额/冲突/法规 → HITL |
| 7 Revocation / expiry | 撤销 · 挂起 · 过期 · 未生效 · tenant/account/provider/domain/jurisdiction/currency 不匹配 · scope digest 篡改 → **DENY**（fail-closed，立即失效） |
| 8 Production 边界 | 本层不开启任何真实外写；`externalWritePerformed=false`、`executionPerformed=false` |

## 3. HOST 要求的返回字段

```
STANDING_AUTHORIZATION    = YES（v1：server-derived / versioned / revocable / auditable / tenant·account scoped；scope digest 防篡改）
RISK_TIER_POLICY          = YES（TIER 0–3；11 维度；受监管动作恒 TIER_3；高金额不可绕过）
ACTION_GUARD_WIRING       = YES（复用既有 Action Guard；一次性审批 OR 有效授权；授权仅满足 humanApproval）
LOW_RISK_AUTONOMY_READY   = YES（政策与判定层就绪；TIER_1 可在授权范围内自动放行）
HIGH_VALUE_HITL           = KEEP（>1,000 → OWNER/ADMIN；≥10,000 → ADMIN）
CUSTOMS_POA_BOUNDARY      = KEEP（SA ≠ Broker POA；15-gate readiness 不变）
PRODUCTION_EXTERNAL_WRITE = HOLD
CURRENT_HEAD              = STANDING-AUTH-HEAD
TEST_EVIDENCE             = standing-authorization 19/19（覆盖验收 1–12）+ action-guard-approval-verifier 9/9 + architecture-contract 157/157；tsc exit 0
```

## 4. 验收对照（HOST 第 9 条 1–12）

| # | 要求 | 测试 | 结果 |
|---|---|---|---|
| 1 | 有效授权 + 低风险 → Guard 判定授权满足 | ① | ALLOW / authorizedBy=STANDING_AUTHORIZATION / satisfiedGates=[humanApproval] |
| 2 | 无授权 → REQUIRE_APPROVAL | ② | REQUIRE_APPROVAL（TIER_2） |
| 3 | 已撤销 → DENY | ③ | DENY（STANDING_AUTH_REVOKED） |
| 4 | 已过期 → DENY | ④ | DENY（STANDING_AUTH_EXPIRED） |
| 5 | 金额超 scope → REQUIRE_APPROVAL | ⑤ | REQUIRE_APPROVAL（AMOUNT_EXCEEDS_LIMIT） |
| 6 | action 超 scope → REQUIRE_APPROVAL | ⑥ | REQUIRE_APPROVAL（ACTION_NOT_ALLOWED） |
| 7 | account / provider 不匹配 → DENY | ⑦ | DENY（ACCOUNT_MISMATCH / PROVIDER_MISMATCH） |
| 8 | 高金额规则不可绕过 | ⑧ | 1,500 → TIER_2/OWNER；12,000 → TIER_3/ADMIN；授权 5,000 仍 HITL |
| 9 | Customs POA 不能被 Standing Authorization 替代 | ⑨ | 受监管 → TIER_3/REQUIRE_APPROVAL；POA 未满足 → DENY（customsPoaGate） |
| 10 | Production Gate=false 时即使授权有效也不得外写 | ⑩ / ⑩b | DENY（productionGate / killSwitch / credential / capability / regulatory / isolation / platformEnablement） |
| 11 | 并发·重复执行保持 exactly-once | ⑪ | 判定稳定 + wiringDigest 一致 + executionPerformed=false |
| 12 | authorization version change 后旧执行权不能继续使用 | ⑫ | 旧版本 DENY（VERSION_STALE）；对齐新版本后 SATISFIED |

## 5. SA-3（已完成）：接入既有 approval-verifier / guard-enforcement

* `approval-verifier.ts`：`verifyApprovalOrThrow` 新增**可选** `standingAuthorization` 参数（既有调用方不传 → 行为完全不变）：
  - `decision=ALLOW` 且 `authorizedBy=STANDING_AUTHORIZATION` 且 `satisfiedGates` **仅含 humanApproval** 且 `action` 匹配 → 放行并标记 `authorizedBy='STANDING_AUTHORIZATION'`；
  - 越权（`satisfiedGates` 含非可绕过 gate）→ `ACTION_GUARD_STANDING_AUTHORIZATION_OVERREACH`；
  - 动作不匹配 → `..._ACTION_MISMATCH`；判定 `DENY`（撤销/过期/不匹配）→ `..._DENIED`（**不回退**到审批路径）；
  - 判定 `REQUIRE_APPROVAL`（超范围/高金额）→ 回退到一次性 `approvalId` 路径（verifier 缺失 → `VERIFIER_MISSING`）。
* `guard-enforcement.ts`：`withActionGuard` 新增同名可选参数并透传 —— 生产受保护动作（`guard-enforcement` 是统一执行助手）可逐调用点以授权替代一次性审批；未提供时行为与既有完全一致；放行路径仍需审计端口（缺失即拒绝）。
* 测试：`standing-authorization-verifier-wiring` **10/10**（含 `withActionGuard` 放行恰好执行一次 / 越权零副作用 / 未提供授权时保持既有 fail-closed）。

## 6. SA-4（已完成）：全量回归 + 状态矩阵

* 全量 `npx vitest run`：**441 文件 / 4442 tests → 4440 passed + 2 failed**；两个失败均为**既有 DB 套件的并行隔离 flake**（`recovery-si-phase2-e-db` P2E-DB5 单独运行 20/20 PASS；`customs-entry-fact-store-db` 单独运行 7/7 PASS），二者均**未被本程序改动**（最近提交分别为历史 G8 / P2-E 单元），与本程序改动无关。
* `CURRENT-SI-RSI-STATUS.md` 已补两行：`STANDING_AUTHORIZATION = YES(v1)`、`LOW_RISK_AUTONOMY = PARTIAL（政策与判定层就绪；逐调用点默认启用待评估）`。
* `tsc --noEmit` = exit 0（SA-1/SA-2、SA-3 两轮均验证）。

### 6.1 TEST_EVIDENCE（SA-4b，exact HEAD 见 commit）

| 项目 | 结果 |
|---|---|
| `api tsc --noEmit` | **exit 0** |
| `prisma validate` | **valid**（88 migrations found；`prisma migrate status` = Database schema is up to date） |
| 定向安全横扫 | **9 文件 / 231 tests PASS**：architecture-contract（157）· tenant-isolation · b2-tenant-ownership-behavior-db · action-guard-hitl-concurrency-db（HITL 原子消费/恰一次/并发首提/成功后撤销）· action-guard-hitl-r3-race-db · standing-authorization（19/19）· standing-authorization-verifier-wiring（10/10）· standing-authorization-resolver（14/14）· standing-authorization-callsite-wiring（5/5）· customs-duty-recovery-chain-e2e-db（Customs golden path） |
| 全量 `npx vitest run` | **443 文件 / 4461 tests → 4460 passed + 1 failed**：仅 `recovery-si-phase2-e-db` P2E-DB5（既有并行隔离 flake，**单独运行 20/20 PASS**；同一套件在上一轮全量中亦为唯一失败；本轮 `customs-entry-fact-store-db` G8 未复现，进一步佐证其为本跑批次 flake） |
| 本程序新增套件合计 | `standing-authorization` 19 + `…-verifier-wiring` 10 + `…-resolver` 14 + `…-callsite-wiring` 5 = **48 tests** |
| SA-3 / SA-3b 回归子集 | 各 32 文件（464 / 307 tests）PASS |
| SA-1/SA-2 宽域回归 | 86 文件 / **828 tests PASS** |

### 6.2 全量回归结果

| 字段 | 值 |
|---|---|
| FULL_REGRESSION | **4460 / 4461 PASS**（唯一失败为既有 `recovery-si-phase2-e-db` P2E-DB5 隔离 flake，单独运行通过） |
| API_TSC | PASS（exit 0） |
| PRISMA_VALIDATE | PASS（schema valid；88 migrations up to date） |
| 无 schema delta | 本程序未新增表 / 未新增 migration（授权持久化与 Experience Memory 持久化均为 REQUEST ONLY） |

## 6b. SA-3b（已完成）：真实调用点接线

* 新增 `services/standing-authorization/standing-authorization-resolver.ts`：把「持久化授权 + 风险分级 + 非可绕过 gate 快照 + 既有 Guard 判定」组合成**调用点唯一来源**的判定，输出与 `verifyApprovalOrThrow` 的 `standingAuthorization` 参数同构：
  - 无授权 → 未声明自动执行时返回 `null`（**既有一次性审批路径零影响**）；声明自动执行 → `DENY`；
  - 授权被撤销 / 过期 / 未生效 / 篡改 / 身份·范围不匹配 → 声明自动执行 `DENY`，未声明 `null`（不阻断合法的人工审批）；
  - 授权有效但超范围 / 超金额 / 受监管 / 证据冲突 / 无历史置信度 → `REQUIRE_APPROVAL`（回退 HITL）；
  - 授权有效 + TIER_0/TIER_1 + 非可绕过 gate 全满足 → `ALLOW（authorizedBy=STANDING_AUTHORIZATION）`。
* 真实入口接入（均为**可选**参数，未提供即行为不变）：
  - `services/action-guard/hitl-submission.ts`（`createHitlSubmissionBoundary`）—— 该边界被 `services/workflow/http-routes.ts` 的 6 处与 `services/recovery/http-request.ts` 使用，覆盖 claim.submit / appeal.submit / recovery.manual_submit 等受保护提交；
  - `services/action-runtime/action-pack-runtime.ts`（`runActionPack`）—— RSI Action Pack 执行链（platform.write / claim.submit 等经同一共享 verifier 的动作）。
* 持久化缺口（**未实施**）：授权记录目前无表，调用方通过注入 `loadAuthorization` 端口取得；因此「客户一次授权 → 进程重启后续用」需要 Schema Delta：`docs/releases/STANDING-AUTHORIZATION-PERSISTENCE-DELTA-REQUEST.md`（1 表、追加式版本、撤销留痕、租户隔离；**REQUEST ONLY**）。
* 测试：`standing-authorization-resolver` **14/14** + `standing-authorization-callsite-wiring` **5/5**（HITL 边界：授权放行恰好执行一次 / 授权 DENY 零副作用 / 越权 OVERREACH 零副作用 / 未提供授权时行为不变）+ 既有 SA/action-guard 套件；SA-3b 回归 **32 文件 / 307 tests PASS**。

## 7. 尚未完成 / 边界

* 逐调用点「默认开启」：本次是**可选接入**（未提供 `standingAuthorization` 即保持既有"每次审批"）。若要默认启用，需要按调用点评估风险分级上下文（amount / provider / domain / evidence / experience）后再逐点切换。
* 高金额阈值调整（如需要）→ 独立 Policy / Product Review；本程序默认 **KEEP**。
* 生产边界不变：`REAL_PROVIDER_WRITE` / `CUSTOMS_FILING` / `PAYMENT` / `AUTO_COMMISSION_CHARGE` /
  `PRODUCTION_CREDENTIALS` / `PRODUCTION_ENABLEMENT` = **HOLD**；Standing Authorization **不**开启任何真实外写。
* 高金额阈值调整（如需要）→ 独立 Policy / Product Review；本程序默认 **KEEP**。

