# KILL-SWITCH-CHANGE-ENTRY-IMPLEMENTATION-CHECKPOINT

> 类型：**IMPLEMENTATION CHECKPOINT**
> 依据：**MSG-20260929-60 Q2 = GO**（范围严格限定）、**MSG-20260929-61**（SCOPE: APPROVED / BOUNDARY: UNCHANGED）
> 分支：`gate/7-commercial-validation` @ **ba50932**（main = `bec1210`）
> 状态：`POST /admin/kill-switch` 已接线并通过 A–E 全部验收；**真实外部动作仍全部冻结**

---

## 1. 交付物（文件 + commit）

| 文件 | 变更 | 内容 |
|---|---|---|
| `apps/api/src/services/operations/kill-switch.ts` | 重写（读层保持兼容） | 变更入口：phase × target 校验 / 持久化幂等 / 双人确认 / 15 分钟窗口 / CAS 状态迁移 / `emergency=true` 审计 / CSRF 断言 / 限流 / 惰性过期收口；读层新增控制面状态（`controlState` / `pendingRequest` / `lastRequest`，仅 full 可见） |
| `apps/api/src/services/workflow/http-routes.ts` | +约 1.7 KB | `POST /admin/kill-switch` 接线：CSRF（同源 + `x-crossclaim-csrf: 1`）→ 限流 → 变更；`403 CSRF_REJECTED` / `429 RATE_LIMITED` 映射；方法闸门（仅 kill-switch 允许 POST，其余 Admin 面仍只读 GET） |
| `apps/api/src/__tests__/kill-switch-change-entry-db.test.ts` | 新增（22 用例） | 真实 HTTP + 真实 PostgreSQL 的 A–E 验收 |
| `apps/api/src/__tests__/kill-switch.test.ts` | 重写（14 用例） | 离线契约：fail-closed / 优先级 / 可见性 / 角色矩阵 / CSRF / note / 限流 / 幂等键哈希 |
| `apps/api/src/__tests__/kill-switch-http-db.test.ts` | 同步 | 只读端点用例 04：POST 由「405」改为「403 CSRF_REJECTED（无 CSRF 头）」；快照新增 `KillSwitchRequest` 计数 |
| `API.md` | 契约 | 新增 `POST /admin/kill-switch` 行（请求/响应/CSRF/幂等/权限/错误码） |

commit：**ba50932**（`feat(p1.3): Kill Switch 变更入口…`）；CI（HEAD `ba50932`，run `36599373325`）：三作业 **SUCCESS**。

## 2. 架构方 5 项重点审 —— 逐条对应

| 重点 | 实现 | 证据（用例） |
|---|---|---|
| ① POST 接线是否真的可达 | `POST /admin/kill-switch` 经 `WORKFLOW_PATH` 进入 `handleWorkflowRequest`；方法闸门对 `adminKillSwitch` 放行 `['GET','POST']` | E8（PUT → 405 / GET → 200）、A1（POST → 200 applied） |
| ② 幂等是否跨实例可靠 | 幂等键落 `KillSwitchRequest(organizationId, idempotencyKey)` **唯一约束**（非进程内 Map）；并发同键由 P2002 兜底 → 读既有记录返回首次结果 | A1 / A2 / A3 / C2（3 个并发同键 → 1 行 1 审计） |
| ③ 双人确认是否服务端强制 | 服务端校验角色（发起仅 OWNER、确认 OWNER/ADMIN）+ `confirmedBy !== requestedBy` | B1 / B2 / B3（同人闭环 → 403） |
| ④ AuditLog 是否不可缺失 | 状态变更与审计写入**同一事务**；过期收口在独立事务内 CAS 并逐条写审计；幂等重放不写第二条 | A1 / A2 / A3 / B4（expire 审计）/ C4（每个终态都有对应审计） |
| ⑤ 是否保持所有业务动作冻结 | 变更入口只写 `KillSwitchRequest` + `AuditLog` | E9（Claim / Settlement / RecoveryLedgerEntry / BillingInvoice / Payment 计数全为 0） |

## 3. A–E 验收（MSG-20260929-60 / -61 逐项）

**A 幂等**（同 `organizationId` + `idempotencyKey`）

- A1 拉闸同键第二次 → `replayed: true`、同一 `requestId`、**不产生第二条 AuditLog**、状态不变。
- A2 开启申请同键第二次 → 一条 Request（`PENDING_ENABLE`）、一条 AuditLog。
- A3 确认成功后确认重试 → 返回首次结果（`replayed: true`）、不写第二条确认审计。

**B 双人确认**

- B1 `OWNER A request` + `OWNER B confirm` → applied（`confirmedBy` = B）。
- B2 `OWNER A request` + `ADMIN B confirm` → applied（审计 `changes.confirmationBy` = B）。
- B3 `OWNER A request` + `OWNER A confirm` → **403 FORBIDDEN**（申请仍为 `PENDING_ENABLE`）。
- B4 超 15 分钟窗口 → **409**，申请惰性置 `EXPIRED` 且写 `phase='expire'` 的 SYSTEM 审计。

**C Race Condition（CAS 只有一个能收口）**

- C1 同 scope 两个 pending（不同键）→ 一个成功、一个 **409**（部分唯一索引兜底）。
- C2 同键 3 个并发 → 全部返回同一 `requestId`；1 行 Request、1 条审计。
- C3 `confirm vs expire` → 终态只能是 `APPLIED` 或 `EXPIRED`，不出现「既 APPLIED 又 EXPIRED」。
- C4 `disable vs pending enable confirm` → 无残留 `PENDING_ENABLE`；拉闸请求落 `APPLIED`；enable 申请为 `APPLIED`（confirm 赢）或 `CANCELLED`（disable 赢）；每个终态都有审计。

**D Emergency**

- D1 `reasonCode=SECURITY_INCIDENT` 拉闸 → 审计含 `emergency=true`、`reasonCode`、`actorUserId`、`scope`、`occurredAt`（时间戳）。
- D2 普通原因第 6 次 POST → **429 RATE_LIMITED**；`SECURITY_INCIDENT` 不受限（但仍写审计，**绕过限流 ≠ 绕过审计**）。

**E HTTP 安全**

- E1 未登录 → 401；E2 ADMIN 发起 / OPS / FINANCE / VIEWER → 403（且零写入）。
- E3 缺 `x-crossclaim-csrf` → 403 `CSRF_REJECTED`；E4 跨源 Origin / 无 Origin-Referer → 403。
- E5 `confirm + disabled` → 400；`confirm` 缺 `requestId` → 400；非 UUID 幂等键 → 400。
- E6 note 超 200 字符 → 400；note 含凭据样式 → 400 `SECRET_NOT_ACCEPTED`（错误体不回显 note 原文/堆栈）。
- E7 `requestId` 不存在 / 跨租户 → 404。
- E8 方法闸门：PUT → 405；GET → 200（只读面未受影响）。
- E9 业务事实冻结（见 §2 ⑤）。

## 4. 本地与 CI 证据

| 项 | 结果 |
|---|---|
| 全量测试（本地） | **109 files / 1028 tests 全绿** |
| 新增/改写用例 | 变更入口 22 + 离线 14 + 只读同步 5 |
| `tsc --noEmit` | PASS |
| API contract | `implemented=53 documented=54` / `API_CONTRACT_OK` |
| Audit coverage | `AUDIT_COVERAGE_OK` |
| CI（HEAD `ba50932`） | run `36599373325` 三作业 SUCCESS；日志含 `OK: 28 tenant triggers present`、`Test Files 109 passed (109)`、`Tests 1028 passed (1028)` |
| Schema | 本阶段 **未改 Schema**（沿用 MSG-20260929-59 批准的 `KillSwitchRequest`） |

## 5. 必须明示的语义决定与差异（3 处）

**5.1 读层 `value` 仍由配置层解析（未让 APPLIED 请求改写运行时取值）**

读层新增 `controlState` / `pendingRequest` / `lastRequest`（仅 full 可见，来源 `KillSwitchRequest`），使控制面状态与读层**同源**（回应 MSG-20260929-55 §11.6 的「双事实源」要求）。
但 `value` **仍然只由 tenant/global/default 配置层解析**：本轮**没有**把「APPLIED 的 enabled 请求」变成运行时 `enabled`。

原因：让数据库行改写运行时开关状态属于**安全语义变更**（会与 fail-closed 及宿主侧硬开关叠加），不在 MSG-20260929-60 的允许清单内，因此**不自行扩权**。
建议（待架构方裁决）：采用「租户控制面请求 → 覆盖 tenant/default 层；global（宿主硬开关）disabled 永远胜出」的合成规则。

**5.2 确认阶段的幂等由「requestId + 终态」保证**

`KillSwitchRequest` 只有一列 `idempotencyKey`（属 request 阶段）。确认请求的幂等键仅做格式校验，确认重试的幂等由「同一 `requestId` 且 `state=APPLIED` → 返回首次结果、不再写审计」保证（A3）。若架构方要求 confirm 也落独立幂等键，需要 **Schema Delta**（新增列或子表），请裁决。

**5.3 取消 pending 的审计为逐条留痕**

拉闸（`request + disabled`）会为每个被取消的 pending 写一条 `phase='cancel'` 审计，再写一条 `phase='request'` 的拉闸审计（含 `cancelledPendingRequestIds`）。

其余实现细节：限流为进程内计数（软控制，v1；幂等与状态均为持久化）；惰性过期收口在**独立事务**内完成（CAS 保护），避免随本次变更失败一起回滚 —— 该点由 B4 用例发现并修正。

## 6. 边界（本轮未越界）

- ❌ 未自动开启 Submission / 未自动关闭 Billing / 未修改 Claim、Settlement、Payment、Billing 既有记录（E9 断言）
- ❌ 未调用任何第三方平台、未开启真实外部动作、未放开真实 Claim 提交
- ❌ 未改 Prisma Schema、未新增迁移、未改动既有租户隔离
- ✅ 控制面仍为「开关」而非执行器；所有业务动作保持冻结

## 7. 待裁决

- **Q1**：读层 `value` 是否要反映 APPLIED 请求？（§5.1 给出了建议合成规则；涉及 fail-closed 语义，我未自行决定）
- **Q2**：confirm 是否需要独立持久化幂等键？（§5.2；若需要则属 Schema Delta）
- **Q3**：是否批准把 `e650872` / `ba50932`（含本报告提交）fast-forward 合并到 `main`？（MSG-20260929-61 已明确「文档提交可在下一次提交时一并申请」）
