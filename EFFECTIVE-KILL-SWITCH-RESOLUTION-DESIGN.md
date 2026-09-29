# EFFECTIVE KILL SWITCH RESOLUTION DESIGN（设计稿，v1）

> 依据架构方 **MSG-20260929-62 Q1 = REVISE**（先不要让 APPLIED 直接改 runtime value；改为单独设计）与
> **MSG-20260929-63**（`GO: Effective Kill Switch Resolution Design`）。
> **性质：DESIGN ONLY。** 本稿**不改 Schema、不改 runtime value、不启用任何真实外部动作、不动任何业务代码**。
> 现网/现库行为保持：控制面（`KillSwitchRequest`）与运行时（Config Layer）**两个域**。

---

## 0. 问题陈述

当前有两个互不耦合的事实域：

| 域 | 内容 | 现状 |
|---|---|---|
| **Config Layer** | `KILLSWITCH_GLOBAL_<SCOPE>` 环境配置 + tenant 配置 + 内置默认 | 决定运行时 `value`（`resolveKillSwitch`） |
| **Control Plane** | `KillSwitchRequest`（PENDING_ENABLE / APPLIED / EXPIRED / CANCELLED） | 只做请求与审计，**不影响** `value` |

MSG-20260929-62 已裁定：**不要**让 APPLIED 直接改写 runtime value（避免控制面污染运行时事实源）。
本设计定义第三种东西 —— **Effective Value**：它是 Config Layer 与 Control Plane 的**只读合成投影**，
不是新的存储、不是对 Config 的写入。

## 1. Effective Value 解析模型（审查点 1）

### 1.1 三个概念严格区分

| 概念 | 定义 | 存储/来源 | 谁可写 |
|---|---|---|---|
| **Config Value** | 部署态开关值 | 环境变量 / 进程配置（`KILLSWITCH_GLOBAL_<SCOPE>`、tenant 配置映射） | 宿主/运维（部署动作） |
| **Control Request** | 控制面请求与其生命周期 | `KillSwitchRequest` 表（可控、可审计、可回放） | 平台内 OWNER/ADMIN（经 `POST /admin/kill-switch`） |
| **Effective Value** | 运行时**最终判定**，是上述两者的纯函数结果 | **不落库**（每次按需计算；仅进程内短缓存） | 无人可写（派生量） |

**硬约束（不变式）**

- ❌ `KillSwitchRequest` **绝不** `UPDATE` Config、绝不写环境变量、绝不写第二张"状态表"来复制 effective value。
- ❌ Effective Value **绝不**落库（避免出现第二份事实源）。
- ✅ 任何时刻：`Effective = f(EnvironmentDefault, GlobalConfig, TenantConfig, TenantControlState)`，纯函数、可复算、可解释（必须能回答「为什么是 disabled」→ `source`）。

### 1.2 解析链（自高到低）

```text
Environment Default
        ↓
Global Config            （可 HARD DISABLED：宿主硬开关）
        ↓
Tenant Config
        ↓
KillSwitchRequest Control State（该租户该 scope 的最近一条 APPLIED 请求）
        ↓
Effective Runtime Decision
```

## 2. 优先级规则（审查点 2）

**固定优先级（左侧胜出）**：

```text
Global HARD DISABLED  >  Tenant DISABLED  >  Tenant ENABLED  >  Environment Default
```

| 层 | 条件 | 结果 | `source`（建议值，见 D2） |
|---|---|---|---|
| 1 | Global Config = `disabled` | **disabled** | `global-hard-disabled` |
| 2 | Tenant Config = `disabled` 或 最近 APPLIED 控制请求 = `DISABLED` | **disabled** | `tenant-config` / `tenant-control` |
| 3 | Tenant Config = `enabled` 或 最近 APPLIED 控制请求 = `ENABLED` | **enabled** | `tenant-config` / `tenant-control` |
| 4 | 无租户信号，Global Config = `enabled`（软开启，见 D1） | enabled | `global-config` |
| 5 | 全部缺失 | 内置默认（见 Case C） | `environment-default` |
| — | 判定过程中任何异常 | **disabled**（fail closed，见 §4） | `fail-closed` |

### 2.1 已裁决的三个 Case

| Case | 输入 | 结果 | source |
|---|---|---|---|
| **A** | global = disabled，tenant = enabled | `disabled` | `global` |
| **B** | global = enabled，tenant = disabled | `disabled` | `tenant` |
| **C** | 无任何配置 | `submission`/`billing`/`integration`/`platform_connector`/`workflow` → `disabled`；`observability` → `enabled` | `default` |

> ⚠ **Case A 与现行实现的差异（实现前必须批准）**：现行 `resolveKillSwitch` 在 global=disabled 且 tenant=enabled 时返回
> `{ value: 'disabled', source: 'tenant' }`（见 `kill-switch.test.ts` 04）。本设计要求 `source='global'`（硬开关胜出且来源可解释）。
> 这属于 `source` 语义变更，**本稿不实施**，列为 D2 一并裁决。

### 2.2 控制面请求如何参与（但不污染）

| 请求状态 | 参与 Effective Value？ | 说明 |
|---|---|---|
| `PENDING_ENABLE` | ❌ 不参与 | 只作为 pending 视图（GET full 的 `pendingRequest`），未确认不得改变生效值 |
| `APPLIED`（target=ENABLED） | ✅ 参与（作为 tenant 层信号） | 需经双人确认才可能到达 |
| `APPLIED`（target=DISABLED） | ✅ 参与（安全方向，单人即时） | 只可能让结果更严格 |
| `EXPIRED` / `CANCELLED` | ❌ 不参与 | 失效请求不得影响运行时 |

**同一 scope 多条 APPLIED 时**：取 `appliedAt` 最新的一条（并列时取 `confirmedAt` 最新，再并列取 `id` 字典序），保证确定性、可复算。

## 3. Cache 设计（审查点 3）

| 项 | v1 决定 |
|---|---|
| 是否缓存 | **只做进程内短缓存**（`Map`），不做分布式缓存 |
| 为什么不用 Redis | 避免运行期状态漂移（双事实源风险）；控制面写入频率极低，DB 读取足够 |
| 缓存粒度 | `(organizationId)` → 该租户 6 个 scope 的控制面快照（**一次查询**取全量，避免 6 次往返） |
| TTL | **5 秒**（建议区间 1–30 秒，见 D3）；Config 层不缓存（进程启动/配置加载时确定） |
| 失效方式 | ① 本实例成功写入 `KillSwitchRequest`（请求/确认/取消/过期）后**立即失效**该租户缓存；② TTL 到期自然失效；③ 跨实例最多存在 **≤TTL** 的陈旧窗口（可解释、有界） |
| 失败时是否可用缓存 | ❌ 业务 scope 一律**不用缓存兜底**（fail closed）；`observability` 例外（见 §4） |
| 可观测性 | resolver 暴露 `cacheHit` / `evaluatedAt` / `staleMs`（不含租户机密） |

> 关键点：缓存只影响**读取成本**，不影响**判定结果**（TTL 内结果与直读一致，除非恰好跨一次控制面写入，此时最多陈旧 ≤TTL）。

## 4. Fail Closed（审查点 4）

| 异常 | 结果 | 说明 |
|---|---|---|
| `unknown scope` | disabled | 白名单外一律拒绝（含新增 scope 未登记） |
| `unknown value`（配置值非法） | disabled | 非法配置视为更严格层（不得退化为默认 enabled） |
| `missing config` | 默认层 | 见 Case C（observability 例外） |
| `corrupted record`（控制面记录缺字段/枚举越界/时间无法解析） | disabled | 记录不可信 → 不得作为开启依据 |
| **数据库不可用 / 查询超时** | `submission` / `billing` / `integration` / `platform_connector` / `workflow` → **deny（disabled）**；`observability` → 降级但不影响业务安全（可返回上次已知值 + `degraded=true`） | 控制面不可读时，绝不放行业务动作 |
| 双人确认窗口内未确认 | 不参与 | 过期即失效（`EXPIRED`），不产生 enabled |

## 5. Audit Boundary（审查点 5）

| 事件 | 写 AuditLog？ |
|---|---|
| `KillSwitchRequest` created（PENDING_ENABLE 建立） | ✅ 写（`killswitch.changed`, `phase=request`） |
| `KillSwitchRequest` confirmed（PENDING_ENABLE → APPLIED） | ✅ 写（`phase=confirm`，含 `confirmationBy`） |
| `KillSwitchRequest` applied（target=DISABLED 直接 APPLIED） | ✅ 写（`phase=request`, `state=APPLIED`） |
| `KillSwitchRequest` cancelled（被拉闸取消） | ✅ 写（`phase=cancel`） |
| `KillSwitchRequest` expired（惰性收口） | ✅ 写（`phase=expire`, actorType=SYSTEM） |
| **读取 resolver / 计算 Effective Value** | ❌ **不写** |
| **每次 API 查询（GET /admin/kill-switch、内部调用 resolver）** | ❌ **不写** |
| 缓存命中 / 缓存失效 | ❌ 不写（需要时走 metrics/日志，不进 AuditLog） |

原则：**AuditLog 只记录"谁改变了什么"，不记录"谁读取了什么值"**，避免审计污染与噪音。

## 6. 与现有冻结项的关系（审查点 6）

Kill Switch 是**安全控制层**，不是业务自动化层。Effective Value 只回答"这个动作面是否允许"，因此：

- ❌ 不自动提交 Claim / Appeal，不代表客户主张
- ❌ 不自动扣佣、不自动付款、不自动修改 Settlement / RecoveryLedgerEntry / BillingInvoice
- ❌ 不调用任何第三方平台 API
- ✅ `submission`/`billing`/`workflow` 等 scope 的 effective=disabled 只表示"未来动作被冻结"，已发生的历史事实零改动
- ✅ 现有 `PENDING_ENABLE` 审批流、双人确认、CSRF、幂等、CAS、审计边界全部保持

## 7. 验证矩阵（审查点 7）

**架构方指定的 7 行（必须全部覆盖）**

| # | 场景 | 期望结果 |
|---|---|---|
| 1 | global disabled + tenant enabled | `disabled` |
| 2 | tenant disabled + default enabled | `disabled` |
| 3 | 全部缺失 | fail closed（业务 5 项 disabled；observability enabled） |
| 4 | 非法 scope | `disabled` |
| 5 | 数据库异常 | 安全拒绝（业务 5 项 deny） |
| 6 | 读取 resolver | AuditLog 计数不增加 |
| 7 | tenant 隔离 | 不能读取其他租户 |

**建议补充（实现阶段一并覆盖）**

| # | 场景 | 期望结果 |
|---|---|---|
| 8 | global disabled + tenant ENABLED 控制请求（APPLIED） | `disabled`（hard 胜出，source=global） |
| 9 | tenant DISABLED 控制请求 + tenant config enabled | `disabled`（source=tenant-control） |
| 10 | PENDING_ENABLE（未确认） | effective 不变（仍 disabled），pending 仅出现在 full 视图 |
| 11 | EXPIRED / CANCELLED 请求 | 不参与 effective |
| 12 | 多条 APPLIED（ENABLED→DISABLED→ENABLED） | 取最新 APPLIED，结果确定且可复算 |
| 13 | `unknown value` / 损坏记录 | `disabled` |
| 14 | 缓存 TTL 内连续读取 | 结果一致、第 2 次不产生 DB 查询（可观测） |
| 15 | 控制面写入后 | 本实例缓存立即失效（下一次读取为最新） |
| 16 | observability 在 DB 不可用时 | `degraded=true`，不因开关阻塞监控 |

## 8. 接口与实现草图（仅供裁决，本稿不落地）

```ts
// packages: apps/api/src/services/operations/kill-switch-resolver.ts（拟）
export interface EffectiveKillSwitch {
  scope: KillSwitchScope;
  value: KillSwitchValue;              // 'enabled' | 'disabled'
  source:
    | 'global-hard-disabled'           // 硬开关
    | 'tenant-control'                 // APPLIED 控制请求
    | 'tenant-config'
    | 'global-config'
    | 'environment-default'
    | 'fail-closed';
  controlState: 'NONE' | 'PENDING_ENABLE' | 'APPLIED' | 'EXPIRED' | 'CANCELLED';
  degraded?: boolean;                  // DB 不可用 / 降级
  evaluatedAt: string;                 // ISO
  cacheHit?: boolean;
}

export interface EffectiveKillSwitchResolver {
  resolve(scope: KillSwitchScope, organizationId: string): Promise<EffectiveKillSwitch>;
  resolveAll(organizationId: string): Promise<EffectiveKillSwitch[]>;
  invalidate(organizationId: string): void;   // 控制面写入成功后由写路径调用
}
```

- 现有 `resolveKillSwitch`（纯配置解析）**保留**，作为 resolver 的一层输入函数（不再直接对外表达"最终判定"）。
- `GET /admin/kill-switch` 未来改为展示 `effective`（含 `source` / `degraded`），并在 full 视图保留 `pendingRequest` / `lastRequest` / 审计回溯。
- 业务调用方（未来接线 Submission/Billing 等 check point）**只能**读取 `EffectiveKillSwitchResolver`，不得直接读配置或控制面表。

## 9. 非目标（Non-Goals）

- ❌ 不改 Prisma Schema、不新增迁移
- ❌ 不在本轮改动 runtime value 语义（MSG-20260929-62 Q1 明确"本次合并前不要修改"）
- ❌ 不引入 Redis / 分布式缓存 / 状态同步服务
- ❌ 不让控制面直接改写配置或环境变量
- ❌ 不启用任何真实外部动作（Production Enablement 仍 HOLD）

## 10. 待裁决（D1–D6）

| # | 问题 | 建议 | 影响 |
|---|---|---|---|
| **D1** | 第 4 层「Global Config = enabled（软开启）」是否保留？架构方给的链只列到 Tenant ENABLED > Environment Default | 保留，置于 Tenant ENABLED 之下、Default 之上（与现行实现的 global 层语义一致） | 若不保留，则 global 只能收紧不能放宽，需同步改现有测试 05 |
| **D2** | `source` 取值是否改为 `global-hard-disabled` / `tenant-control` / `tenant-config` / `global-config` / `environment-default` / `fail-closed`？（现行为 `tenant` / `global` / `default`） | 采用新取值（可解释性优先）；并在 API.md 标注为破坏性变更 | Case A 的 source 由 `tenant` 变 `global`，需同步 `kill-switch.test.ts` 与 API.md |
| **D3** | 进程内缓存 TTL | **5 秒**（上限 30 秒） | 跨实例陈旧窗口上限 = TTL |
| **D4** | DB 不可用时 `observability` 是否允许返回上次已知值 | 允许（`degraded=true`）；业务 scope 一律 deny | 监控可用性 vs 严格 fail closed |
| **D5** | `APPLIED` 控制请求是否设有效期/复核周期 | v1 无自动过期（除非新请求覆盖或运维拉闸）；复核周期属未来运营策略 | 防止"很久以前的开启"无限期生效 |
| **D6** | 控制面 `PENDING_ENABLE` 是否出现在 effective 输出 | 不参与值，仅 full 视图的 `pendingRequest` | 避免"未确认即生效" |

## 11. 后续执行顺序（获批后）

```text
本设计稿裁决（GO / REVISE）
        ↓
Implementation Design Freeze（把 D1–D6 的裁决结果写回本文件）
        ↓
Implementation Checkpoint（resolver + GET 改造 + 验证矩阵 16 行 + CI）
        ↓
Concurrency / Security Review
        ↓
（另行批准后）Runtime Activation Policy 与 Production Enablement
```

> 当前状态：**DESIGN ONLY**；架构方裁决前不动代码、不动 runtime value、不开启真实动作。
