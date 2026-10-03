# INTEGRATION BOUNDARY REVIEW —— HTTP / Adapter / Transport 前置边界审计（设计 + 实施计划）

> 依据：**MSG-20261001-21 = PASS**（R36 checkpoint 关闭）NEXT —— 批准进入 Integration Boundary Review；下一轮先提交设计/实施计划，不直接开放真实 transport。
> 分支 `gate/7-commercial-validation` · Codex · 2026-10-01 · ROUND: **R37**

## 0. 边界与不做的事

- 本轮只出设计/实施计划：不接线 HTTP 路由、不接真实 adapter、不开启 transport、不使用生产凭据、不产生真实外写/资金/客户提交。
- `PLATFORM_WRITE_TRANSPORT_ENABLED=false` 与其余 HOLD 项保持；transport 开启是独立 Gate，不得由 HTTP 接线顺带开启。
- 账本侧已完成（M1–M3 + PG1–PG10，PG6/PG7 为永久回归门槛）；本计划只定义前置边界。

## 1. 分层链路（逐层不变量与失败模式）

```text
HTTP request
  → authn（会话/主体）
  → tenant membership/role
  → action guard（platform.write）
  → server-side snapshot（服务端重算，禁用客户端 digest）
  → approval binding（basisReference = 服务端快照摘要）
  → persistent ledger T1（唯一幂等执行链 + approval 唯一绑定 + 消费审计，同事务）
  → transport boundary（T2 投递；当前 HOLD）
```

| 层 | 不变量 | 失败模式 → 行为 |
| --- | --- | --- |
| authn | 主体必须来自服务端会话，不接受请求体自述身份 | 未认证 → 401；不得进入后续层 |
| tenant membership/role | `organizationId` 来自会话/路径且与主体 membership 一致 | 跨租户/无 membership → 404 或 403（fail-closed，不泄露存在性） |
| action guard | `platform.write` 为 `EXTERNAL_WRITE`，需 humanApproval + platformEnablement + productionGate + writeEnabled | 任一不满足 → DENY/REQUIRE_APPROVAL，零投递 |
| server-side snapshot | 由服务端从已授权数据重算（`platform-write-request/v1`） | 客户端传入 digest/摘要字段 → 忽略或拒绝；重算失败 → 400/409 |
| approval binding | `basisReference === snapshotDigest` 且租户/动作/未消费/未过期 | 不匹配 → 409，零消费零投递 |
| ledger T1 | 唯一幂等执行链 + approval 唯一绑定 + CAS + 同事务 `approval_consumed` | 任一步失败 → 整笔回滚（PG3） |
| transport boundary | T2 仅由状态机与端口决定；HTTP 层不得直接调用 sink | transport 关闭 → `NEEDS_MANUAL`，`sinkCalls=0` |

## 2. HTTP 身份/权限与跨租户 fail-closed

- 复用既有入口模式：`withActionGuard` / `assertAllowed`（守卫必须先于任何副作用）。
- 租户来源：路径 `:id` 对应的 Case 必须属于会话主体的组织；跨租户一律 404（不区分“不存在”与“不属于你”）。
- 角色：沿用既有 HITL 边界（提交与执行权限分离；执行人角色在锁后重验，与 claim.submit / appeal.submit 同口径）。
- 禁止客户端在请求体中声明 `organizationId` / `snapshotDigest` / `basisReference` 作为可信输入。

## 3. 请求/快照：客户端不得自证

- 服务端从 DB 事实（Case / Claim / Appeal / 证据引用 / 规范化 payload）重算快照与 `snapshotDigest`；
- 请求体只允许业务输入（正文、目标对象 id、目标平台标识等），不允许摘要/指纹/幂等键“声明值”；
- 幂等键由服务端派生（`pw1-<sha256(version|digest)>`）；客户端传入的幂等键若存在必须与服务端派生一致，否则 409（现有 `IDEMPOTENCY_KEY_MISMATCH`）。

## 4. 重放 / 并发：收敛到同一 ledger execution chain

- 同一 `(organizationId, idempotencyKey)` 唯一执行链（C1）；HTTP 重放返回既有链状态（REPLAYED / 既有状态），不新建第二条链；
- 同 approval 仅绑定一条能取得真实执行权的 attempt（C2）；并发下第二个请求 → 结构化拒绝（APPROVAL_ALREADY_BOUND 或 CAS mismatch）；
- HTTP 层不得做“先判定再写入”的 TOCTOU 决策：一切以 T1 事务内的 CAS/唯一约束结果为准。

## 5. HTTP 失败不得绕过 T1

- 顺序强制：HTTP → 守卫 → 快照/审批绑定 → T1（事务提交）→ T2（事务外投递）→ T3（独立事务收敛）；
- HTTP 断开/超时发生在 T1 之后：结果以账本状态为准，重试走同一条链（幂等）；
- HTTP 层不得直接调用投递端口；投递只能由编排层在 T1 成功提交后执行。

## 6. Adapter capability contract（能力矩阵）

| 能力 | 含义 | 缺失时的行为 |
| --- | --- | --- |
| `idempotentWrite` | 上游支持幂等写（同 key 不重复产生副作用） | 缺失 → 不得自动真实写入（NEEDS_MANUAL），仅允许人工路径 |
| `statusQuery` | 支持按 provider request/idempotency reference 只读查询状态 | 缺失 → UNKNOWN_PROVIDER_RESPONSE 只能人工对账，禁止自动 reconciliation |
| `ambiguousResponseSemantics` | 对超时/不确定响应有明确可复现处置语义 | 缺失 → 该平台必须 BLOCK 自动真实写入（保持 NEEDS_MANUAL） |

## 7. transport enablement = 独立 Gate

- 独立开关与独立审批：不得由 HTTP 接线、adapter 注册或配置变更顺带开启；
- 开启条件（至少）：获批 adapter + 能力矩阵满足 + 生产凭据由宿主配置 + 并发/崩溃恢复验收 + 独立 Production Enablement 裁决；
- 当前 `PLATFORM_WRITE_TRANSPORT_ENABLED=false` 为安全基线，任何改动需架构方单独裁决。

## 8. 验收计划（HTTP 批次，实现后执行）

| # | 断言 | 期望 |
| --- | --- | --- |
| H1 | 未认证 / 无 membership / 跨租户 | 401 / 403 / 404（fail-closed，零副作用） |
| H2 | 角色不足（FINANCE/VIEWER） | 403，零投递零消费 |
| H3 | Action Guard 未配置 / 能力不可用 | 403 `ACTION_GUARD_*`，零投递 |
| H4 | 客户端携带 snapshotDigest / basisReference / 幂等键声明 | 忽略或结构化拒绝（禁止自证） |
| H5 | 重复提交同一负载 | 收敛到同一 execution chain（重放语义） |
| H6 | 并发同一负载 | 恰一个 T1 提交，另一个结构化 no-op（PG1 口径） |
| H7 | transport 关闭 | 2xx 但 `platformWriteExecuted=false`（NEEDS_MANUAL），`sinkCalls=0` |
| H8 | HTTP 断连后重试 | 幂等：不重复消费 approval、不建第二条链（PG6 口径） |

> 实现后必须同时跑：金路径 E2E（`docs/releases/ENGINEERING-REGRESSION-POLICY.md`）、PG1–PG10、全量回归与 CI。

## 9. 实施步骤（获批后）

1. P1 路由与守卫接线（fail-closed，transport 仍关）：`POST /cases/:id/platform/write`（草案路径）；
2. P2 服务端快照 + 审批绑定接入（复用 `platform-write-request/v1` 与既有审批边界）；
3. P3 T1 编排接入（复用 `prisma-ledger.acquireExecutionRight`）与 T3 收敛；
4. P4 HTTP 层验收 H1–H8（真实 PostgreSQL + 真实 HTTP）；
5. P5 全量回归 + Golden Path E2E + CI → 送审 Integration Boundary Checkpoint。

## 10. 待架构方裁决的问题

1. 路由形态：`POST /cases/:id/platform/write` 是否接受？是否需要区分 prepare（内部）与 submit（外部）两个入口？
2. 是否要求 HTTP 层返回 `platformWriteExecuted=false` 显式字段（沿用当前入口口径）？
3. adapter capability contract 的三能力是否需要在 Schema/注册表层面显式声明（作为 adapter 获批前置）？
4. transport 独立 Gate 的形态（独立开关 + 独立审批记录）是否按 §7 设计？
