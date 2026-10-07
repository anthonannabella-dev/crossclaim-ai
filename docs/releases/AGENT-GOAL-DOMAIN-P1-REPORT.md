# AGENT GOAL DOMAIN（P1）—— 交付与证据

授权：HOST 2026-10-07「AGENT EXPERIENCE LAYER + DURABLE AUTHORIZATION + GOAL ORCHESTRATION」P1。
`EXACT_HEAD = 406d0433`（基线 `ea1eb7c2`）

结论：**P1 = CLOSED**。新增一层**极薄**的 Agent Goal 域，只表达「客户想得到什么结果」，
不构成第二 runtime / 第二事实源 / 第二 guard / 第二 policy engine，也不授予任何权限与外写能力。

---

## 1. 先扫描再实现（复用既有词汇，不造重复 vocabulary）

| 词汇 | 复用来源 |
|---|---|
| 域 | Prisma `enum RecoveryDomain`（`PLATFORM` / `LOGISTICS` / `CUSTOMS` / `INDEPENDENT_SITE`）；对 Experience Memory 的 `CARRIER` 做**显式映射**而不新增第三套 |
| 动作 | `services/action-guard/action-guard.ts` 的 `ACTION_GUARD_CATALOG`（模块加载即断言规划面动作全部在目录内） |
| 任务命名空间 | `runtime/rsi-domain-pack.ts` 的 `RECOVERY_TASK_DEDUPE_PREFIX = 'task:recovery:'`（保留路由） |
| 工具安全边界 | `services/intelligence/recovery-tool-registry.ts`「模型不得发明工具名」的既有立场 |
| 非可绕过 gate | `services/standing-authorization/standing-authorization.ts` 的 `STANDING_AUTHORIZATION_NON_BYPASSABLE_GATES` |
| 摘要工具 | `services/config-execution-durability/digests.ts` |

## 2. 交付文件（`apps/api/src/services/agent-goal/`）

| 文件 | 职责 |
|---|---|
| `goal-contract.ts` | goal 契约：白名单 goal type / 域 / 执行偏好 / 时间范围；错误码；边界常量 |
| `goal-schema.ts` | 严格形状校验：逐层 allowlist + 越权键分类（tenant / action / service） |
| `goal-compiler.ts` | 自然语言 → 结构化 goal（**确定性优先，modelCallCount = 0**）；注入拒绝；未知意图 fail safely |
| `goal-validator.ts` | 服务端验证：server context 强制、枚举白名单、类型/数量规则、时间窗口确定性夹紧 |
| `goal-capability-resolver.ts` | 服务端事实快照 → 每域可用动作（不判定执行权；Production Gate / Kill Switch / POA / 法规 fail-closed） |
| `goal-task-planner.ts` | goal + capabilities → `task:recovery:<DOMAIN>:goal:<digest>` 任务草案（幂等、不新增 runtime） |
| `goal-runtime-adapter.ts` | 只把任务转发给**注入的既有 runner**；拒绝非 recovery 命名空间；`secondRuntime = 0` |
| `index.ts` | 统一出口 |
| `src/__tests__/agent-goal.test.ts` | 29 例回归 |

## 3. 执行链（本单元只到 plan 为止）

```
Natural Language
  → Goal Compiler（确定性，0 次模型调用）
  → Structured Goal（不含 tenant / account / provider / action / service / tool）
  → Server Validation（server truth 注入 organization / actor）
  → Capability Resolution（既有 ACTION_GUARD_CATALOG）
  → Task Plan（task:recovery:* 命名空间，幂等）
  → 既有 ONE SI Runtime（P2 接线）
```

## 4. 安全要求逐条落实

| HOST P1 要求 | 落实 |
|---|---|
| 自然语言不得直接执行 | 编译器只产出结构化 goal；无执行路径；`AGENT_GOAL_BOUNDARY.naturalLanguageExecutesNothing = true` |
| 严格 schema + allowlist | `goal-schema.ts` 逐层白名单；未知字段 → `GOAL_UNKNOWN_FIELD`；三层封顶，不做任意深度遍历 |
| 禁止 LLM 输出 service/function 名称后调用 | 契约里根本没有 service/tool/function 字段；出现即 `GOAL_SERVICE_INJECTION` |
| 未知意图 fail safely | `GOAL_UNSUPPORTED_INTENT`（不猜测、不默认放行） |
| 默认执行偏好保守 | 未声明「直接处理/自动」时 = `REQUIRE_APPROVAL_EACH` |
| 只读型 goal 不得静默升级 | `DISCOVER_ONLY` / `REVIEW_ATTENTION` 强制 `executionMode = DISCOVER_ONLY`，否则拒绝 |
| 以下信息必须由 server truth 决定 | organization / account / provider / capability / action catalog / permission / authorization / 金额 / 风险分级 / provider 可用性 / customs readiness / production gate / external write gate / HITL —— 全部不在 goal 里，由 resolver + 既有 Guard 决定 |
| 执行动作由谁决定 | `goal-capability-resolver` 明确 `decisionOwner = services/action-guard`；规划器只给候选 |

## 5. 测试证据

套件 `agent-goal`：**29/29 PASS**（`npx tsc --noEmit` = exit 0）

| 组 | 覆盖 |
|---|---|
| Compiler | HOST 中文示例 → `DISCOVER_AND_RECOVER` / 3 域 / 12 个月 / USD 1000 偏好 / `AUTO_WHEN_AUTHORIZED`；未知意图 fail safely；空/超长输入；默认保守；`REVIEW_ATTENTION` 强制只读；**文本注入动作名 / service 名 / 「忽略审批规则」→ 拒绝** |
| Validator | 合法草稿 → server-derived goal（tenant 来自服务端、`grantsPermissions=false`）；**跨租户字段（organizationId / platformAccountId / provider / standingAuthorization）→ GOAL_TENANT_FORGED**；**action / actions / approvalId / task / service / tool / endpoint / url / prompt → 精确 reason 拒绝**；嵌套注入同样拒绝；不支持域 / 未知 goal type / 未知执行模式 / 未知时间范围拒绝；畸形（非对象 / 类型错误 / 缺字段 / 未知字段）拒绝；只读型声明自动执行拒绝；审计型多域拒绝；缺租户上下文拒绝；时间窗口夹紧到 1..36 |
| Capability | 规划面动作全在 `ACTION_GUARD_CATALOG`；Production Gate 未满足 → `claim.submit` / `platform.write` blocked；有效授权下 `recovery.manual_submit` 可自动而外部写仍阻断；无有效授权 → 内部写不再自动（TIER 0 只读仍自动）；Customs POA 未满足 → `customs.*` 阻断；Kill Switch / 法规限制 → 只剩只读动作 |
| Planner + Adapter | 任务落在 `task:recovery:<DOMAIN>:goal:<digest>`；重复规划幂等（同 dedupeKey、同 planDigest）；适配器只转发注入的既有 runner 并如实回传状态；非 recovery 命名空间拒绝；`secondRuntime !== 0` 拒绝；未注入 runner 拒绝自建循环；边界常量 `createsSecondRuntime/FactSource/Guard/PolicyEngine = false` |

## 6. 边界（未解锁）

`REAL_PROVIDER_WRITE` / `CUSTOMS_FILING` / `PAYMENT` / `AUTO_COMMISSION_CHARGE` / `PRODUCTION_CREDENTIALS` /
`PRODUCTION_ENABLEMENT` / `REAL_MODEL_NETWORK` / `PAID_MODEL_CALLS` / `EXTERNAL_WRITE` / `TRANSPORT` = **HOLD**；
`SECOND_RUNTIME` / `SECOND_POLICY_ENGINE` / `SECOND_GUARD_IMPLEMENTATION` / `SECOND_CONTROL_PLANE` /
`SECOND_MODEL_GATEWAY` / `SECOND_COST_LEDGER` / `SECOND_META_EVIDENCE_STORE` = **FORBIDDEN**（本单元未新增任何其一）。
高金额 HITL（> USD 1,000 → OWNER/ADMIN；≥ USD 10,000 → ADMIN）= **KEEP**；Standing Authorization ≠ Broker POA。

## 7. 下一步

P2 —— 把 `goal-runtime-adapter` 接到真实的 ONE SI Runtime 组合（`createRsiDomainPackRunner`），
并补「Recovery 命名空间不可被抢占 / caller runner 不得绕过 Recovery routing」的集成回归。
