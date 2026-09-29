# EFFECTIVE-KILL-SWITCH-RESOLVER-IMPLEMENTATION-CHECKPOINT

> 类型：**IMPLEMENTATION CHECKPOINT**
> 依据：**MSG-20260929-65**（`RESULT: PASS` / Design FROZEN / `Implementation GO` + A/B/C 验收要求）
> 分支：`gate/7-commercial-validation` @ **c0e3524**（main = `3b85716`）
> 边界：**Implementation only** —— 未改 Schema、未改 runtime config、未自动开启/关闭任何 scope、未接入平台 API

---

## 1. 文件清单

| 文件 | 变更 | 内容 |
|---|---|---|
| `apps/api/src/services/operations/kill-switch-resolver.ts` | 新增 | `EffectiveKillSwitchResolver`：五层优先级 / 六值 `source` / **只读端口** / 进程内缓存（键 `organizationId+scope`，TTL 5s、上限 30s）/ fail-closed / observability 降级 stale |
| `apps/api/src/services/operations/kill-switch.ts` | 修改 | 读层接入生效值（`effective` 依赖注入）；导出 `parseKillSwitchValue`；`controlState` 对齐控制面规则；summary 视图保持最小暴露（仅 `scope`/`value`/`source`） |
| `apps/api/src/services/workflow/http-routes.ts` | 修改 | resolver 进程内单例（按 prisma 客户端缓存）；`GET /admin/kill-switch` 返回生效值；`POST` 成功后主动 `invalidate`（§12.3） |
| `apps/api/src/__tests__/kill-switch-resolver.test.ts` | 新增 | 16 行矩阵 + I3 投影 + **I1/I2 自动化验证**（19 例） |
| `apps/api/src/__tests__/kill-switch-resolver-db.test.ts` | 新增 | 真实 HTTP + 真实 PostgreSQL：生效值 / 租户隔离 / latest wins / 缓存失效（6 例） |
| `apps/api/src/__tests__/kill-switch-http-db.test.ts` | 修改 | 只读用例的 `source` 断言迁移到新词表（`default` → `environment-default`） |
| `API.md` | 修改 | `GET /admin/kill-switch` 契约：生效值投影 + 六值 `source` + `degraded`/`stale`/`evaluatedAt`，标注**破坏性变更** |

commit：**c0e3524**；CI（run `36602007570`）：三作业 **SUCCESS**。

## 2. 16 行验证矩阵（MSG-20260929-65 B —— 全部落测试）

| # | 场景（架构方给定） | 期望 | 用例（文件 :: 编号） | 结果 |
|---|---|---|---|---|
| 1 | global hard disabled + tenant enabled | disabled / global-hard-disabled | resolver :: 01 | ✅ |
| 2 | tenant disabled + global enabled | disabled / tenant-control | resolver :: 02 | ✅ |
| 3 | tenant enabled + default disabled | enabled / tenant-control | resolver :: 03 | ✅ |
| 4 | 无配置 business scope | disabled / environment-default | resolver :: 04 | ✅ |
| 5 | 无配置 observability | enabled / environment-default | resolver :: 05 | ✅ |
| 6 | pending enable | 不参与 | resolver :: 06/07/08 | ✅ |
| 7 | expired request | 不参与 | resolver :: 06/07/08 | ✅ |
| 8 | cancelled request | 不参与 | resolver :: 06/07/08 | ✅ |
| 9 | multiple applied | latest wins | resolver :: 09 + resolver-db :: 05 | ✅ |
| 10 | same timestamp | id tie breaker | resolver :: 10（顺序无关） | ✅ |
| 11 | unknown scope | disabled | resolver :: 11（fail-closed） | ✅ |
| 12 | unknown value | disabled | resolver :: 12（fail-closed） | ✅ |
| 13 | DB failure business | fail closed | resolver :: 13（disabled + fail-closed + degraded） | ✅ |
| 14 | DB failure observability | stale | resolver :: 14（lastKnown + degraded + stale + 上次评估时间） | ✅ |
| 15 | tenant isolation | no leakage | resolver :: 15 + resolver-db :: 04（真实库） | ✅ |
| 16 | cache invalidate | new result | resolver :: 16 + resolver-db :: 06（真实库） | ✅ |

补充用例：17（TTL 上限被夹到 30s）、18/19（I3 同层冲突 disabled 胜出）。

## 3. I1–I4 不变量自动化验证（MSG-20260929-65 A）

| 不变量 | 验证方式 | 证据 |
|---|---|---|
| **I1** Effective Value is never persisted | ① `prisma/schema.prisma` 的 `KillSwitchRequest` 块内**不得出现 `effective`**；② resolver 源码不得出现任何写操作（`create/createMany/update/updateMany/upsert/deleteMany`、`delete({where|data`、`data:{`、`$executeRaw`/`$queryRaw`） | `kill-switch-resolver.test.ts :: "I1 不落库…"` |
| **I2** Control Request cannot mutate Config Value | resolver 的读端口类型 `KillSwitchControlReadPort` **只声明 `findMany`**（类型层面无写路径）；源码不得写 `process.env[...]` 或 `config.global/tenant[...]` | `kill-switch-resolver.test.ts :: "I2 控制面不可改写配置…"` |
| **I3** Disabled dominates Enabled | 投影函数同层冲突用例（config enabled + control DISABLED → disabled；config disabled + control ENABLED → disabled） | `kill-switch-resolver.test.ts :: 18/19` |
| **I4** Resolver failure cannot enable protected actions | 抛错端口下：业务 5 scope 一律 `disabled`/`fail-closed`（矩阵 13）；未知 scope/非法值同样 disabled（矩阵 11/12）；observability 例外但 `stale=true`（矩阵 14） | resolver :: 13/14 + 11/12 |

## 4. source 迁移测试（MSG-20260929-64 R1）

| 层 | 现行 `resolveKillSwitch`（保留，未改语义） | 新 resolver |
|---|---|---|
| 无配置 | `source='default'` | `source='environment-default'` |
| 仅 global enabled | `source='global'` | `source='global-config'` |
| global disabled | `source='global'`（tenant 覆盖时可为 `tenant`） | `source='global-hard-disabled'`（硬开关可解释） |
| tenant 生效 | `source='tenant'` | `source='tenant-config'` / `source='tenant-control'` |
| 非法配置值 | `source='tenant'/'global'`（value=disabled） | `source='fail-closed'` |

证据：`kill-switch-resolver.test.ts`（01–05、12）逐条断言新词表；`kill-switch.test.ts` 01–05 仍断言 `resolveKillSwitch` 的旧语义（**未覆盖式修改**，符合 MSG-20260929-64 R1「不要直接覆盖」）；`kill-switch-http-db.test.ts :: 03` 已迁移到 `environment-default`；`API.md` 标注破坏性变更。
端到端证据：`kill-switch-resolver-db.test.ts :: 02`（双人确认 → 读层 `value=enabled` / `source=tenant-control`）、`:: 03`（紧急拉闸 → `disabled` / `tenant-control`）。

## 5. cache / invalidation 测试（MSG-20260929-65 B）

| 项 | 证据 |
|---|---|
| TTL 内命中缓存、不重复查询 | `resolver :: 16`（`queries===1`，`cacheHit===true`） |
| 写后主动失效 → 立即新结果 | `resolver :: 16` + `resolver-db :: 06`（`invalidate(org, scope)` → `enabled`、`cacheHit=false`） |
| TTL 过期自然失效（跨实例陈旧 ≤ TTL） | `resolver :: 16`（+5001ms → `cacheHit=false`）、`resolver-db :: 06`（TTL 内仍为旧值且可解释） |
| TTL 上限 30s 夹取 | `resolver :: 17` |
| 无 Redis/CDN/浏览器缓存 | 实现仅用进程内 `Map`；HTTP 响应保持 `cache-control: no-store` |

## 6. 测试与 CI

| 项 | 结果 |
|---|---|
| 全量测试（本地） | **111 files / 1053 tests 全绿**（新增 resolver 19 + resolver-db 6） |
| `prisma validate` | PASS（本阶段**未改 Schema**） |
| `tsc --noEmit` | PASS |
| API contract | `implemented=53 documented=54` / `API_CONTRACT_OK` |
| Audit coverage | `AUDIT_COVERAGE_OK` |
| CI（HEAD `c0e3524`，run `36602007570`） | 三作业 SUCCESS；日志含 `OK: 28 tenant triggers present`、`Test Files 111 passed (111)`、`Tests 1053 passed (1053)`、`API_CONTRACT_OK`、`AUDIT_COVERAGE_OK` |

## 7. 边界确认（MSG-20260929-65 C 禁止范围逐条）

| 禁止项 | 状态 |
|---|---|
| ❌ 修改 runtime config | 未修改（resolver 只读；配置写入路径不存在） |
| ❌ 自动开启任何 scope | 未实现（只有双人确认后的控制面记录影响**读投影**；无执行器） |
| ❌ 自动关闭任何 scope | 未实现（同上） |
| ❌ 接入平台 API | 未实现 |
| ❌ 改 Claim 流程 / Billing 流程 / Submission 流程 | 未触碰（无任何业务调用方消费 resolver；本轮仅提供解析器与读层投影） |
| ❌ Schema 变更 | 无（沿用已批准的 `KillSwitchRequest`） |

补充说明（供审查）：

1. **OPS 摘要视图**保持最小暴露（仅 `scope`/`value`/`source`），`degraded`/`stale`/`evaluatedAt` 只在 OWNER/ADMIN 全量视图返回 —— 延续 MSG-20260929-53/54 的既有裁定；若要求 OPS 也看降级标记，请裁决（属可见性变更）。
2. resolver 的读端口在**类型层面**只声明 `findMany`（I2 的强约束）；HTTP 层用 `WeakMap<prisma, resolver>` 保持进程内单例，使 §12.3 的缓存语义成立。
3. observability 在 DB 不可用且**无上次已知值**时返回环境默认（`degraded=true`、`stale=false`），且不阻塞监控。

## 8. 待裁决

- **Q1**：`c3c4ea4` / `c0e3524`（含本报告提交）是否批准 fast-forward 合并到 `main`？
- **Q2**：是否进入 **P2 Production Hardening**（backup/restore 验证 / secret rotation / deployment smoke / real-data validation），还是先接一批只读消费点（例如让 `submission`/`billing` 的 future check point 读取 resolver —— 属"接线"而非"启用"，需你确认边界）？
