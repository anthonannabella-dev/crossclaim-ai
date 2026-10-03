# ACTION GUARD · platform.write 设计与安全边界

> 授权依据：**MSG-20261001-16 NEXT** —— "下一批允许先完成接口、状态机、权限、幂等、审批绑定、
> 模拟适配器及 fail-closed 测试；不得因本裁决直接启用任何真实平台写操作。"
>
> 本设计只覆盖 ② 授权队列最后一项 `platform.write` 的**离线边界**；真实外写仍为 HOLD。

## 1. 非目标（本批次不做，且不得由本批次推断出授权）

| 项目 | 状态 |
| --- | --- |
| 真实平台写入（Amazon / TikTok / Walmart / 承运商 / 支付渠道） | **HOLD** |
| 真实凭据注入 / Secret 轮换 | **HOLD**（HOST ONLY） |
| Production Enablement / 生产部署 | **HOLD** |
| 资金动作 / 客户提交 | **HOLD** |
| 尝试账本落库（新表 / 新列） | **需架构方单独裁决**（领域与 Schema 变化） |
| 对外 HTTP 入口 | **下一增量**（须按既有批次口径补真实 HTTP + PostgreSQL 验收后再送审） |

硬开关：`PLATFORM_WRITE_TRANSPORT_ENABLED = false`（`services/platform-write/types.ts`）。
任何把该值改为 true 的动作都属于必须回架构方审计的类别。

## 2. 接口（端口与职责）

| 文件 | 职责 | 关键约束 |
| --- | --- | --- |
| `services/platform-write/types.ts` | 动作名（单一来源再导出）、硬开关、状态/结果类型、端口契约、审计事件白名单 | 动作名唯一来源是 `action-guard/approval-verifier.ts`，本模块不散落字面量 |
| `services/platform-write/snapshot.ts` | 服务端版本化提交快照 `platform-write-request/v1`（键排序 canonicalJson + sha256）、幂等键派生 | 审批创建与执行核验必须复用同一函数 |
| `services/platform-write/state-machine.ts` | 尝试状态机、迁移表、重试上限、纯函数退避 | 非法迁移抛 `ILLEGAL_TRANSITION`，不静默兜底 |
| `services/platform-write/ledger.ts` | 尝试账本端口 + 内存实现 | 内存实现不得冒充持久化（落库需 Schema 裁决） |
| `services/platform-write/simulated-adapter.ts` | 模拟投递通道（唯一可接线端口） | `simulated` 恒为 true；无网络、无 env、无凭据；调用记录可断言"恰一次/零次" |
| `services/platform-write/index.ts` | 编排：幂等键自证 → Action Guard → 审批绑定 → 幂等账本 → 传输闸门 → 模拟通道状态机 | fail-closed；`sinkCalls` 在拒绝路径必须为 0 |

端口全部通过依赖注入提供（`PlatformWriteDeps`）：`guard` / `approvals` / `ledger` / `sink` /
`capabilities` / `audit` / `now`。生产接线必须使用既有守卫路径
（`withActionGuard` / `assertAllowed`，见 `services/action-guard/guard-enforcement.ts`、
`runtime-guard.ts`），本批次不新增任何绕过守卫的调用点。

## 3. 状态机

| 当前 | 允许迁移到 | 触发 |
| --- | --- | --- |
| PENDING | IN_FLIGHT / BLOCKED | 开始投递 / 任一前置闸门拒绝 |
| IN_FLIGHT | SUCCEEDED / RETRYABLE / FAILED | 上游成功 / 可重试失败 / 硬拒绝 |
| RETRYABLE | IN_FLIGHT / DEAD_LETTER | 未达上限重试 / 达到上限收敛 |
| SUCCEEDED / FAILED / DEAD_LETTER / BLOCKED | —（终态） | — |

- 重试上限：`PLATFORM_WRITE_MAX_ATTEMPTS = 3`（含首次）。
- 退避为纯函数 `attemptBackoffMs`（250ms → cap 4000ms）；**本模块不 sleep**，等待交给上层调度器。
- 终态不可离开；从终态发起迁移一律抛错。

## 4. 权限（Action Guard）

`platform.write` 在目录中为 `EXTERNAL_WRITE`，需要 `humanApproval` + `platformEnablement` +
`productionGate`，并在运行时额外要求 `writeEnabled === true` 与 `tenantEnabled` / feature flag。
判定顺序（任一不满足即 BLOCKED，零投递）：

1. 幂等键自证：显式给定的键必须等于服务端派生值（`IDEMPOTENCY_KEY_MISMATCH`）。
2. Action Guard 决策非 ALLOW → 直接返回守卫错误码（`ACTION_GUARD_*`）。
3. 审批绑定核验（见 §6）。
4. 幂等账本（见 §5）。
5. 传输闸门：关闭时返回 `NEEDS_MANUAL` / `PLATFORM_WRITE_TRANSPORT_DISABLED`，**不投递、不推进状态、不消费审批**。
6. 仅当 `simulatedTransport` 显式为真且端口 `simulated === true` 时才执行模拟投递；否则抛 `SIMULATED_SINK_REQUIRED`。

## 5. 幂等

- 快照摘要 `digest = sha256(canonicalJson(snapshot))`；
  幂等键 `pw1-<sha256('platform-write-request/v1|' + digest)[0..40]>`，**不随尝试次数变化**。
- 账本语义：同键同摘要且已成功 → `REPLAYED`（零投递，返回既有 `externalRef`）；
  同键不同摘要 → `IDEMPOTENCY_CONFLICT`（拒绝复用，零投递）。
- 结构保证：模拟端口拒绝缺少幂等键/摘要的请求（`SIMULATED_PORT_REQUEST_INVALID`）。

## 6. 审批绑定

审批记录必须同时满足：同租户、`action === 'platform.write'`、未消费、未过期、
`basisReference` 等于本次提交的服务端快照摘要。拒绝码：
`APPROVAL_NOT_FOUND` / `APPROVAL_ACTION_MISMATCH` / `APPROVAL_TENANT_MISMATCH` /
`APPROVAL_ALREADY_CONSUMED` / `APPROVAL_EXPIRED` / `APPROVAL_BINDING_MISMATCH`。
本批次**只读不消费**审批：消费与落库属于后续（Schema/事务边界）增量。

## 7. 模拟适配器

- `createSimulatedPlatformWritePort(platform, outcomes)`：按调用顺序消费预置结果，用完后默认成功；
  记录每次调用的请求副本，供"恰一次 / 零次"断言。
- 结构约束：端口契约中 `simulated: true` 为字面量类型 —— 真实写入适配器在**类型层面**无法满足该契约；
  运行时再加一道 `SIMULATED_SINK_REQUIRED`。
- 与既有只读适配器规则一致：`services/adapters/registry.ts` 继续拒绝注册任何实现写面的适配器。

## 8. fail-closed 验收矩阵（`apps/api/src/__tests__/platform-write.test.ts`，17/17）

| # | 场景 | 期望 |
| --- | --- | --- |
| 01 | 默认（通道关闭） | `NEEDS_MANUAL`，sinkCalls=0，账本 0，状态仍 PENDING，审计只写 needs_manual |
| 02 | `writeEnabled=false` | BLOCKED / `ACTION_GUARD_REQUIREMENTS_NOT_MET` |
| 03 | 缺 approvalId | BLOCKED / `ACTION_GUARD_HUMAN_APPROVAL_REQUIRED` |
| 04 | 审批不存在 | BLOCKED / `APPROVAL_NOT_FOUND` |
| 05 | 审批动作不通用 | BLOCKED / `APPROVAL_ACTION_MISMATCH` |
| 06 | 跨租户审批 | BLOCKED / `APPROVAL_TENANT_MISMATCH` |
| 07 | 审批过期 / 已消费 | BLOCKED / `APPROVAL_EXPIRED`、`APPROVAL_ALREADY_CONSUMED` |
| 08 | 审批后载荷变化 | BLOCKED / `APPROVAL_BINDING_MISMATCH` |
| 09 | 模拟通道成功 | PENDING→IN_FLIGHT→SUCCEEDED，恰一次投递，审计顺序 attempted→settled |
| 10 | 同键重放 | `REPLAYED`，sinkCalls=0，不重复投递 |
| 11 | 显式幂等键不一致 | BLOCKED / `IDEMPOTENCY_KEY_MISMATCH` |
| 12 | 可重试到上限 | `DEAD_LETTER`，attempts = sinkCalls = 3 |
| 13 | 上游硬拒绝 | `FAILED` 且不重试（sinkCalls=1） |
| 14 | 快照规范化 | 键顺序无关摘要一致；任一字段变化摘要与幂等键都变化 |
| 15 | 非模拟端口 | 抛 `SIMULATED_SINK_REQUIRED`（真实通道不可启用） |
| 16 | 状态机 | 非法迁移抛错、终态不可离开、退避为纯函数 |
| 17 | 静态探针 | platform-write 模块无 `fetch(`/axios/`node:http`/env/凭据解析 |

## 9. 后续需要架构方裁决的事项

1. 尝试账本落库形态（新表/新列、索引、保留期、审计关联）——领域与 Schema 变化。
2. 是否开放对外 HTTP 入口，以及入口的审批载荷策略与幂等键传递方式。
3. 真实通道开启条件（凭据来源、平台侧幂等语义、失败补偿、对账口径）。
4. 审批消费时机（本批次只读；消费与业务写入的原子性边界需单独设计）。

## 10. 本批次证据

```text
apps/api: npx vitest run src/__tests__/platform-write.test.ts        → 17/17 PASS
apps/api: npx tsc --noEmit                                          → PASS
apps/api: npx prisma validate                                       → valid
回归    : action-guard-enforcement / -catalog-integrity / action-guard → 22/22 PASS
```
