# READ-ONLY KILL SWITCH CONSUMPTION DESIGN（设计稿，v1）

> 依据架构方 **MSG-20260929-66**：`EffectiveKillSwitchResolver Implementation = COMPLETE`，`Merge = APPROVED`，
> `NEXT = GO: READ-ONLY-KILLSWITCH-CONSUMPTION-DESIGN`。
> **性质：DESIGN ONLY。** 本稿**不改代码、不改 Schema、不接任何业务动作**；`Runtime Action Enablement` 继续 **HOLD**。

---

## 1. 批准范围（原文约束）

**允许（本设计可覆盖的消费点）**

- ✅ health / status
- ✅ admin console 展示
- ✅ operations dashboard 标识
- ✅ future action guard 的**设计占位**

**禁止（本设计与后续实现都不得做）**

- ❌ 自动阻断业务流程
- ❌ 自动提交 Claim
- ❌ 自动扣佣
- ❌ 自动付款
- ❌ 修改 Settlement
- ❌ 接平台 API

## 2. Consumer Registry（MSG-20260929-66 §八.1）

| # | Consumer | 位置（现有 / 拟） | 当前状态 | 读取什么 | 呈现什么 | 失败行为 |
|---|---|---|---|---|---|---|
| C1 | **Kill Switch 读 API**（已实现） | `GET /admin/kill-switch` | **已实现（READ ONLY）** | `EffectiveKillSwitchResolver`（全部 6 scope） | `scope`/`value`/`source`/`controlState`/`pendingRequest`/`lastRequest`/`degraded`/`stale`/`evaluatedAt` | resolver 降级 → 业务 scope `disabled`/`fail-closed`；observability 标 `stale` |
| C2 | **Admin Console 展示**（Kill Switch 页/卡片） | `apps/web`（`app/lib/console.ts` 的 `ADMIN_MODULES` 静态白名单，拟新增一项） | 未实现（DESIGN） | C1 的 API 输出 | 六 scope 的 `value` + `source`（人类可读解释）+ `evaluatedAt`；OWNER/ADMIN 另见 `degraded`/`stale`/`controlState` | API 失败 → 页面显示"降级：无法读取（不显示旧值）"；**不阻断任何操作** |
| C3 | **Operations Console 标识**（只读横幅） | `apps/web` `/operations`（拟） | 未实现（DESIGN） | C1 输出（OPS 只拿 `scope`/`value`/`source`） | 例如"submission 已关闭（global-hard-disabled）"只读横幅 | 同上；**不改变页面可用功能** |
| C4 | **Health / Status** | `GET /health`（进程级）+ `GET /admin/system-health`（租户级，已有） | 未实现（DESIGN） | **进程级只读探针**：resolver 是否可用（能否完成一次 DB 读取与解析）；**不含任何租户数据** | `killSwitch.resolver = ok | degraded`、`evaluatedAt` | 探针失败 → `degraded`（不阻断 /health 返回 200 的进程活性语义；具体等级见 D2） |
| C5 | **Future Submission Guard** | `apps/api/src/services/workflow/*`（未来） | **设计占位**（ACTION GATE） | 未来经 Central Guard Layer 读取 scope=`submission` | 拒绝理由：`KILL_SWITCH_DISABLED` + `scope` + `source` + `evaluatedAt` | fail closed：resolver 失败 → 拒绝 |
| C6 | **Future Billing Guard** | `apps/api/src/services/workflow/*`（未来） | **设计占位**（ACTION GATE） | 未来经 Central Guard Layer 读取 scope=`billing` | 同上 | fail closed：resolver 失败 → 拒绝 |

> 说明：C1 是当前**唯一已实现**的消费点；C2–C4 属只读展示/探针（本设计的实现候选）；C5/C6 只是**边界占位**，实现前需另行批准（见 §5）。

## 3. Guard Boundary（MSG-20260929-66 §八.2）

**现在（本设计阶段）**

```text
EffectiveKillSwitchResolver
        ↓
   Display only
(读 API / 控制台 / health 探针)
```

**未来（需另行批准后才可进入）**

```text
EffectiveKillSwitchResolver
        ↓
   Action Guard            ← 唯一允许的判定位
        ↓
  Business Action          ← 只有经过 Guard 才可执行
```

**硬规则**

1. **中间不能跳过**：任何业务动作要受 Kill Switch 约束，必须经过 Action Guard；不得在业务服务里直接读配置、读 `KillSwitchRequest` 表或调 `resolveKillSwitch`。
2. **展示路径永远不能阻断**：Display only 的消费者（C2/C3/C4）只能渲染状态，**不得**因状态而改变请求结果（不得返回错误、不得提前 return）。
3. **Guard 只做判定，不做动作**：Action Guard 不提交 Claim、不扣佣、不付款、不改 Settlement、不调平台 API；它只回答"允许/拒绝 + 原因"。

## 4. 禁止隐式接入（MSG-20260929-66 §八.3）

以下是**明确禁止**的写法（散落业务代码的隐式开关）：

```ts
// ❌ 禁止：业务服务里散落读取与短路
if (killSwitch.disabled) return error;
if (resolveKillSwitch(config, 'billing', orgId).value === 'disabled') throw ...;
if (await prisma.killSwitchRequest.findFirst(...)) throw ...;
```

**未来唯一允许的形态**：Central Guard Layer（单一模块 + 单一入口）

```ts
// apps/api/src/services/operations/kill-switch-guard.ts（未来；本稿不实现）
export type KillSwitchGuardedAction =
  | 'submission.dispatch'
  | 'billing.advance'
  | 'claim.submit'
  | 'payment.charge';

export interface KillSwitchGuardDecision {
  allowed: boolean;
  scope: KillSwitchScope;
  value: KillSwitchValue;
  source: KillSwitchResolutionSource;
  evaluatedAt: string;
  reasonCode?: 'KILL_SWITCH_DISABLED' | 'KILL_SWITCH_RESOLVER_DEGRADED';
}

export async function assertActionAllowed(
  action: KillSwitchGuardedAction,
  ctx: { organizationId: string; actorUserId: string },
): Promise<KillSwitchGuardDecision>;
```

设计约束（供未来实现审查）：

- 映射表集中声明 `action → scope`（唯一事实源），业务代码不得自行推断 scope。
- Guard 失败（resolver 抛错 / 解析失败）→ **拒绝**（I4），错误码 `KILL_SWITCH_RESOLVER_DEGRADED`，不泄露内部信息。
- 允许/拒绝均不改变业务事实；拒绝只阻止"未来动作"。
- 是否写审计（拒绝事件）见 D3 —— 默认建议：**审计拒绝**（与 `killswitch.changed` 同一 action 家族，例如 `killswitch.blocked`），但不得记录每次成功读取。

## 5. 未来 Action Guard 的触发点清单（仅占位，未实现）

| 触发点 | scope | 说明 | 现状 |
|---|---|---|---|
| Submission 派发（对外提交前的检查点） | `submission` | 注意：**自动提交 Claim 属红线**，即使 Guard 允许也不得自动提交（仍需人工） | HOLD |
| Billing 推进（advanceBillingInvoice 的 check point） | `billing` | 仅"是否允许推进账单流程" | HOLD |
| Payment 收费 | `billing`（或未来独立 scope） | 资金链路，需单独审批 | HOLD |
| 平台连接器调用 | `platform_connector` | 17TRACK/EasyPost 等本身仍 HOLD | HOLD |
| Workflow 批处理 | `workflow` | 内部编排 | HOLD |
| Observability 采集 | `observability` | 监控不应因开关被关闭 | 设计上永远 `enabled`（除非硬关闭） |

> 本表只是把未来落点写清楚；**任何一项接线都必须走新的裁决**（属"安全语义 + 对外动作"变更）。

## 6. 可见性与缓存（与既有裁定保持一致）

| 角色 | 可见字段 |
|---|---|
| OWNER / ADMIN | `value` / `source` / `controlState` / `pendingRequest` / `lastRequest` / `degraded` / `stale` / `evaluatedAt` |
| OPS | 仅 `scope` / `value` / `source`（MSG-20260929-66 §五：保持最小暴露） |
| FINANCE / VIEWER | 403（不可读） |

- 消费者**不得**自行加缓存（不得 CDN / 浏览器缓存；HTTP 保持 `cache-control: no-store`）；进程内缓存只存在于 resolver（TTL 5s / 上限 30s）。
- 消费者展示 `evaluatedAt` 与 `stale`：陈旧值必须显式标注，**不得伪装实时**。

## 7. 实现计划（获批后；本稿不执行）

| 步骤 | 内容 | 交付物 |
|---|---|---|
| S1 | Admin Console 只读展示（Kill Switch 模块加入 `ADMIN_MODULES` 白名单 + 只读渲染） | 页面 + 渲染测试（无写控件、无阻断逻辑） |
| S2 | Operations Console 只读标识 | 只读横幅 + 断言（无阻断副作用：断言请求结果不受影响） |
| S3 | Health 探针（进程级） | `GET /health` 增加 `killSwitch.resolver` 字段 + 测试 |
| S4 | 消费点契约测试 | "Display only 不得阻断"专项：以 disabled 状态调用既有业务端点，断言结果与 enable 时**逐字节一致** |

## 8. 验证计划（未来实现的验收矩阵）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 控制台在 `disabled` / `enabled` 下渲染 | 只显示状态；页面不出现任何操作按钮或阻断提示 |
| 2 | OPS 角色访问展示 | 仅 `scope`/`value`/`source`；无 `degraded`/`stale`/`evaluatedAt` |
| 3 | resolver 降级（DB 不可用） | 展示层显示"降级/陈旧"；健康探针 = `degraded`；**既有业务端点行为不变** |
| 4 | 读取展示不写审计 | 展示前后 `AuditLog` 计数不变 |
| 5 | 租户隔离 | 租户 A 的展示只包含 A 的 scope 状态；不出现 B 的数据 |
| 6 | 无隐式接入（静态扫描） | 业务服务中不出现 `resolveKillSwitch(` / `killSwitchRequest.findMany` / `disabled` 短路 |
| 7 | 「Display only 不阻断」回归 | 同一业务请求在 disabled/enabled 下结果一致（逐字段） |

## 9. 待裁决（D1–D5）

| # | 问题 | 建议 |
|---|---|---|
| **D1** | Admin Console 的 Kill Switch 展示是否按租户（当前租户）展示，还是仅展示"本租户可见的 6 个 scope"？ | 按租户（与 C1 一致），不引入跨租户视图 |
| **D2** | Health 探针失败时 `/health` 的返回等级：① 仍 200 但标 `degraded`；② 503 不就绪 | 建议 ①（进程活性与业务开关解耦；就绪判定由专门 checklist 承担） |
| **D3** | 未来 Action Guard 的**拒绝**事件是否写审计 | 建议写（`killswitch.blocked` 家族），但绝不记录成功读取 |
| **D4** | 运营看板标识是否需要显示 `source` 的六值原文（可能对非技术使用者过于技术化） | 建议显示人类可读文案 + 折叠的原始 `source` |
| **D5** | 是否允许在 Admin Console 提供"发起变更"入口（表单） | 建议 **暂不**：变更入口目前只经 API；控制台保持只读（避免把控制面写路径暴露到前端） |

## 10. 边界声明

- **DESIGN ONLY**：本稿不改代码、不改 Schema、不改运行时取值、不接任何业务动作。
- `Runtime Action Enablement = HOLD`；`Production Enablement = HOLD`。
- 任何业务动作接线（§5）都必须单独裁决，且不得绕过 Central Guard Layer。

---

## 11. R2 修订（按架构方 MSG-20260929-67 = GO_WITH_MINOR_REVISE）

本轮只补三处：**source 展示层与内部值分离 / Consumer Registry 增加 READ_ONLY-ACTION_GUARD 分类 / blocked audit 边界说明**；其余裁定（D1/D2/D5）原样生效，仍为 **DESIGN ONLY**。

### 11.1 补充一：source 展示层与内部值分离（D4 = REVISE）

**规则：内部枚举值（machine value）与展示文案（human text）必须分离，UI 不得直接暴露内部枚举。**

| 内部 `source`（API 原值） | 展示文案（zh-CN / en 示例） | 说明 |
|---|---|---|
| `global-hard-disabled` | 已由系统全局安全策略关闭 / Disabled by system-wide safety policy | 宿主硬开关 |
| `tenant-control` | 已由本租户的控制面请求关闭（或开启） / Set by tenant control request | 控制面 APPLIED |
| `tenant-config` | 已由本租户配置关闭（或开启） / Set by tenant configuration | 租户配置层 |
| `global-config` | 已由系统配置开启 / Enabled by system configuration | global 软开启 |
| `environment-default` | 系统默认（未启用） / System default | 默认层 |
| `fail-closed` | 因无法确认状态而保持关闭 / Disabled because state could not be verified | 失败/异常 |

呈现规则：

1. **默认只显示文案**（不可见内部枚举）；
2. OWNER/ADMIN 可"展开查看原始值"（`source: global-hard-disabled`）——用于排障与审计对齐；
3. OPS 维持既有最小暴露（`scope` / `value` / `source`），但 UI 亦以文案呈现；原始枚举随 API 字段返回（OPS 现有契约不变）；
4. **展示层不得因为文案而改变判定**：文案是渲染映射，判定仍只依据 resolver 的 `value`/`source`（单一事实源）。
5. 文案映射集中在一处（未来实现：`apps/web/app/lib/kill-switch-labels.ts`），不得散落各页面；未识别的 `source` 一律按"已关闭（原因未知）"呈现（fail closed 的展示面）。

### 11.2 补充二：Consumer Registry 增加 Consumer Type 分类（MSG-20260929-67 R1）

每个消费者必须显式标记类型：`READ_ONLY`（只展示，永不阻断）或 `ACTION_GUARD`（判定并影响动作，未来才允许）。

| Consumer | Type | 状态 |
|---|---|---|
| `GET /admin/kill-switch` | **READ_ONLY** | 已实现 |
| Admin Console 展示 | **READ_ONLY** | 未实现（本设计 S1） |
| Operations Console 标识 | **READ_ONLY** | 未实现（本设计 S2） |
| Health / Status 探针 | **READ_ONLY** | 未实现（本设计 S3） |
| Future Submission Guard | **FUTURE ACTION_GUARD** | 占位（需另行批准） |
| Future Billing Guard | **FUTURE ACTION_GUARD** | 占位（需另行批准） |

仓库级约束（未来实现检查项）：

- `READ_ONLY` 消费者的代码路径**禁止**出现 `throw` / `return error` / 提前返回等"阻断"语义；它们只能读取并渲染。
- 只有 `ACTION_GUARD` 类型模块允许返回拒绝决策，且必须经 Central Guard Layer（§4）。
- 实现期建议加静态扫描用例：`READ_ONLY` 消费者文件不得引用 `assertActionAllowed`；业务服务不得直接引用 resolver。

### 11.3 补充三：blocked audit 边界说明（D3 = ACCEPT_WITH_REVISE）

**未来 Action Guard 拒绝时的审计边界（本稿只定义，不实现）**

| 事件 | 是否写审计 | action | 允许记录的字段 | 明确禁止 |
|---|---|---|---|---|
| 业务动作被 Guard 拒绝 | ✅ 写 | `killswitch.blocked` | `action`（如 `submission.dispatch`）、`scope`、`value`、`source`、`reasonCode`、`actorUserId`、`occurredAt`、`traceId?` | ❌ token / secret / API key / 请求 payload 全文 / 客户数据 / PII |
| resolver 读取 / effective value 查询 | ❌ 不写 | — | — | — |
| Dashboard 展示 / health check | ❌ 不写 | — | — | — |

补充约束：

1. **只审计"尝试执行且被拒绝"**，不审计"读取状态"——保持 `AuditLog` 只回答"谁改变了什么/谁被拒绝"。
2. `killswitch.blocked` 与被拒绝的业务实体**不建立外键**（避免把安全事件耦合进业务事实表）；只在 `changes` 中记录标识与原因码。
3. 审计写入失败时的行为：**拒绝决策仍然生效**（拒绝优先），但必须记录结构化安全日志（不进 AuditLog）；不得因为审计失败而放行动作（I4 延伸）。
4. 与既有 `killswitch.changed` 的区分：`changed` = 控制面状态变化；`blocked` = 业务动作被安全策略拒绝。

### 11.4 R2 后的执行顺序

```text
本 R2 提交 → 架构方复核（GO / REVISE）
        ↓
READ-ONLY-KILLSWITCH-CONSUMPTION-IMPLEMENTATION（仅 S1–S4，READ_ONLY 消费点）
        ↓
Action Guard 设计（另案）→ Runtime Action Enablement（另案）→ Production Enablement（HOLD）
```

仍保持：**不接 Action Guard、不阻断业务、不开启生产控制权、不改变 runtime action**；`Production Enablement = HOLD`。
