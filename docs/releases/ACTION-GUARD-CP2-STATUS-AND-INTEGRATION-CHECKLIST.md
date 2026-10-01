# ACTION GUARD CP2 · 状态口径与业务接入清单

依据：架构方 **MSG-20260930-12**（Gate 7 / 授权项② Action Guard CP2，VERDICT: REVISE）第 4、5、6 节。

本文件只做**口径与清单**，不改变任何实现语义。

---

## 1. 状态拆分（CHANGE B 要求，禁止合并成一格）

| 范围 | 当前状态 | 证据 / 说明 |
| --- | --- | --- |
| **CP2 基础模块**（决策函数 own-key、runtime guard、capability source、enforcement wrapper） | **PASS** | **MSG-20260930-13 / REVIEWED_HEAD `b219286`**（CHANGE A/B 均已关闭） |
| **② 业务强制覆盖**（生产危险动作真正接入 runtime guard） | **NOT COMPLETE** | 尚未有 service/route/job/HITL 调用点接入；不得以基础模块完成追认 |
| **真实 resolver / config / audit 端口接线** | **未验收** | capability source 目前通过注入端口工作；尚未接真实配置源与真实审计落地 |

> 明确作废的过强表述（CHANGE B）：不再声称「唯一入口」「已不可绕过」「忘记调用守卫在类型与测试层面都不可行」。
> 仓库中的静态扫描只是**有限静态约定检查**（单引号字面量 + 同文件字符串），仅作辅助，不作为覆盖验收证据。
>
> 状态变更（MSG-20260930-13 §3）：基础模块已由「修订待复核」更新为 **PASS**；② 业务强制覆盖与真实端口接线**维持** NOT COMPLETE / 未验收，不得追认完成。
>
> 授权项 ③（PRODUCTION CONTROL PLANE）已于 MSG-20260930-13 §6 获批继续：首个切片（运行模式分层 + 控制面闸门，默认 READ_ONLY）与接线切片（真实 Kill Switch / 审计 / 只读配置端口组合，配置读取失败回落 READ_ONLY）已落地；仍属 PROGRESS，需并入 ③ 的 Checkpoint 报告。

## 2. 后续接入验收条件（MSG-20260930-12 §5，逐条保留）

1. **审批不能仅凭非空 `approvalId` 放行**：服务端必须验证其租户、权限、动作、目标对象/证据版本、有效期、撤销与消费状态。
2. **不得直接信任请求体中的 `capabilities` / `hostApprovalGranted`**：能力快照必须由服务端可信源解析。
3. **同一真实业务入口必须验证零副作用**：DENY / REQUIRE_APPROVAL / 能力异常 / 审计异常时，业务数据库变更与外部适配器调用均为 **0**；ALLOW 时恰好执行一次。
4. **守卫前不得发生受保护副作用**：审计记录与业务零副作用分别验收。
5. **控制面保留**：全局禁用优先、租户与平台启用分层、默认 read-only。
6. **重试与队列执行重新核验**：不得沿用旧 ALLOW；需明确并测试 Kill Switch 缓存与撤销延迟。
7. **口径准确性**：审计端口不可用时拒绝仍可生效，但不得声称「每次都已持久化审计」；`runtime evaluate` 会尝试写审计，不是纯展示函数。

## 3. 业务接入清单（动作 → 入口 → 副作用边界 → 审批验证 → 集成测试）

> 状态一律先记 TODO；完成一项填一项，且每项都必须有「拒绝时零副作用 + 允许时恰好一次」的集成测试证据。

| 动作（catalog） | service / route / job / HITL 入口 | 副作用边界 | 审批验证 | 集成测试 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `claim.submit` | `POST /cases/:id/claim/submit`（http-routes + server WORKFLOW_PATH） | 平台外写（当前 HOLD，传输开关 false；入口恒返回 `NEEDS_MANUAL`） | approvalId 服务端校验（租户/动作/对象/有效期/消费）+ 锁后角色/主体重验 | HTTP 级 22/22（拒绝零副作用 / 并发恰一次 / 等锁失效 / 审计失败注入 / 审计留痕与原始错误保留） | **已验收 PASS（MSG-20261001-07 / REVIEWED_REF 28e0cd9；CI run 36805839845）** |
| `appeal.submit` | 待定（申诉路径） | 平台外写（HOLD） | 同上 | 待补 | TODO |
| `platform.write` | 待定（适配器写路径） | 平台外写（HOLD） | 同上 | 待补 | TODO |
| `commission.charge` | 待定（结算/佣金路径） | 资金动作（HOLD） | 同上 + 财务复核 | 待补 | TODO |
| `payment.capture` | 账单登记入口（HTTP 受保护入口） | 资金动作（HOLD） | Action Guard 审批绑定 + 锁内事实 CAS + 快照交错校验 | HTTP 级：拒绝零副作用 / 允许恰一次（含并发与等锁失效） | **已验收 PASS（MSG-20260930-24 / REVIEWED_REF 73115a3）** |
| `secret.rotate` | 待定（运维路径） | 凭据操作（HOST ONLY） | HOST APPROVAL | 待补 | TODO |
| `claim.prepare` | `POST /cases/:id/claim/prepare`（http-routes + server WORKFLOW_PATH） | 业务库写入（第 1 轮 Claim 草稿 `target`/`aiDraftText` + `claim.prepared` 审计同事务；不推进状态） | 能力闸门（`INTERNAL_WRITE` / `requires: []`，**无人工审批**）+ 案件锁 + Claim 行锁后最终主体/角色重验 | HTTP 级 **21/21**（含行锁等待期降权/停用/未变对照、并发创建、状态交错、更新路径审计失败回滚） | **已验收 PASS（MSG-20261001-10 / REVIEWED_REF d6d239b；CI 36811474236）** |
| `billing.draft` | `POST /cases/:id/billing/draft`（http-routes + server WORKFLOW_PATH） | 业务库写入（DRAFT `BillingInvoice` + `billing.drafted` 审计同事务；不推进收款/到账/扣划） | 能力闸门（`INTERNAL_WRITE` / `requires: []`，**无人工审批**）+ 案件锁 + 账单行锁 + 费用依据行锁后最终主体/角色重验 | HTTP 级 **21/21**（含幂等真实状态、VOID/WRITTEN_OFF→409、费用抢移拒绝、费用锁等待期金额+币种变化/非法/权限降级、同路径成功对照、invoiceRefAt 三方一致、非零支付字段保留、双费用集合排序） | **R29 送审中（MSG-20261001-12 CHANGE A + TEST 已收敛）** |
| `evidence.read` | 待定（只读） | 无 | 无 | 待补 | TODO |

> 追加记录（同属本清单口径，逐批次登记）：`payment.replay` = **验收 PASS**（MSG-20260930-28 / REVIEWED_REF 08fc45d；资金对象身份纳入快照与审批指纹、按 id 行锁恰一行）；`payment.retry_due`（冻结批次）= **验收 PASS**（MSG-20261001-01 / REVIEWED_REF 9a806eb / CI run 36726898061 / Issue #2 comment 5915049394）。三类受保护入口共用同一 Action Guard 审批边界，**支付域三类受保护内部入口当前工程范围已收口**（不等于真实扣款/生产启用/webhook 新授权/②全覆盖）；② 整体仍为 NOT COMPLETE。

### 3.1 代码引用抽查（2026-09-30）

> 仅为下一批次选题提供地图：**不是验收结论**，本小节**不改变第 3 节的状态列**。逐项验收一律以架构方逐批次裁决为准；行号为当次抽查结果。

| 动作 | 代码引用（证据） | 抽查结论 |
| --- | --- | --- |
| `commission.charge` | 入口 `/cases/:id/recovery-outcome`：`services/workflow/http-routes.ts:1212-1235`（缺 Action Guard 即 `ActionGuardNotConfiguredError` fail closed；经 `hitl-submission` 边界 + 审批指纹比对后才调用 `confirmRecoveryOutcome`） | 入口**已接线**（对应第 5 节「第一批 HITL 提交入口」） |
| `payment.capture` / `payment.replay` / `payment.retry_due` | 见上方追加记录 | 已验收 **PASS / PASS / PASS**（retry-due = MSG-20261001-01 / ref 9a806eb） |
| `claim.submit` / `appeal.submit` / `platform.write` | 目录：`services/action-guard/action-guard.ts:31-33`（均 `EXTERNAL_WRITE`，requires humanApproval + platformEnablement + productionGate）；能力映射：`capability-source.ts:35-37`；静态约定清单：`guard-enforcement.ts:163-165` | 只有目录/能力/静态清单，**未发现路由或服务接线**（与「平台外写 HOLD」一致） |
| `claim.prepare` / `billing.draft` | 目录：`action-guard.ts:29-30`（`INTERNAL_WRITE`，`requires: []`） | 入口接线与「能力闸门」接入**未核**（第 3 节仍为 TODO） |
| `evidence.read` | 目录：`action-guard.ts:28`（`READ_ONLY`，`requires: []`） | 只读动作、无审批要求；未见专门接线 |
| `secret.rotate` | 目录：`action-guard.ts:40`（`SECRET_ACCESS`，`requires: [hostApproval]`）；静态清单：`guard-enforcement.ts:170` | HOST ONLY，未接线 |

### 3.2 ② 下一小批次范围（依据 MSG-20261001-01 §7，PROGRESS 登记）

**已收口（供对照）：** 第一批 = `POST /cases/:id/recovery-outcome` → `commission.charge`（MSG-20260930-21 = PASS）；第二批 = 支付域 `payment.capture`（MSG-24 = PASS）/ `payment.replay`（MSG-28 = PASS）/ `payment.retry_due`（**MSG-20261001-01 = PASS**）。webhook 依 MSG-20260930-22 §(3) 作为**独立边界**（验签 / 重放保护 / 幂等 / 租户-发票-金额币种匹配 / 审计），不纳入逐次人工审批批次。

**待覆盖（§3 清单剩余）：** `claim.submit`、`appeal.submit`、`platform.write`（均 `EXTERNAL_WRITE`）、`claim.prepare`、`billing.draft`（`INTERNAL_WRITE`）、`evidence.read`（`READ_ONLY`）、`secret.rotate`（`SECRET_ACCESS` / HOST ONLY）。

**选定下一小批次：`claim.submit`（提交路径 · HITL 人工闸门 · 平台外写保持 HOLD）。**

选择理由：

1. 它是产品核心动作，且已有明确的执行端约束：`services/adapters/ingest-bridge.ts` 的提交闸门**永不调用** `adapter.submitClaim()`，只返回 `NEEDS_MANUAL`；`adapters/registry.ts` 拒绝注册带写入面的适配器。因此本批次可完整接入 Action Guard，而**不触发任何真实外写**。
2. 与已 PASS 的第一批（HITL 提交入口）同构：复用 `hitl-submission` 边界 + 审批指纹 + `action_guard.approval_decision` 审计，改动面小、可验证性强。
3. `appeal.submit` / `platform.write` 更依赖 ④ PLATFORM ADAPTER PRODUCTION-SHAPE 的骨架与错误模型设计，宜在其后。

**拟改动面（待实现，未开工）：**

- 服务/路由：为 Claim 提交路径接入 `createHitlSubmissionBoundary({ action: 'claim.submit' })`；缺 Action Guard 即 `ActionGuardNotConfiguredError`（fail closed），未满足 capability（`submission` scope / platformEnablement / productionGate）或审批校验失败时**零业务与外写副作用**。
- 能力与审计：沿用 `capability-source` 的 `submission` scope 映射；落 `action_guard.approval_decision`（含 approvalId / 主体 / 目标 / operationId）。
- 外写边界：即使闸门放行，仍只返回 `NEEDS_MANUAL`（不调用任何平台写入面）；传输开关保持 false。

**验收计划（HTTP + 真实 PostgreSQL）：**

1. 未注入 Action Guard → 403 `ACTION_GUARD_REQUIREMENTS_NOT_MET`，零副作用；
2. 注入守卫但缺 `approvalId` → 409 `ACTION_GUARD_HUMAN_APPROVAL_REQUIRED`，零副作用；
3. 有 `approvalId` 但无对应审批事件 → 403 `ACTION_GUARD_APPROVAL_NOT_VERIFIED`，零副作用；
4. capability 未满足（submission scope 关闭 / 平台未启用 / Production Gate 未满足）→ 拒绝，零副作用；
5. 全部满足 + 操作级审批 → 恰一次业务写入 + 恰一次审批消费，且**不产生任何平台外写**（返回 `NEEDS_MANUAL`）；
6. 重复提交 → 幂等或 409 `APPROVAL_ALREADY_CONSUMED`（按既有第一批口径），无重复副作用。

**边界：** 真实平台提交、真实 OAuth/凭据、`platform.write`/`appeal.submit` 与 ④ 适配器生产形态均不在本批次；生产 HOLD 全部保持。
**实施前置侦察（2026-10-01，只读）——`claim.submit` 落地缺口：**

| 事实 | 证据 |
| --- | --- |
| 目前**没有** Claim 提交的 HTTP 路由（`http-routes.ts` 无 claim 提交入口；`services/claims/*` 仅被测试引用） | `rg "claims/"` 命中仅 `__tests__/claim-tracking-*` |
| 但**跟踪侧写入原语已存在**：`recordSubmission()`（审计动作 `claim.submitted_by_human`）、`recordAcknowledgement()` / `setDeadline()` / `recordTerminal()` | `services/claims/tracking-service.ts:89/127/168/211` |
| **外写闸门已存在且恒为人工卡口**：`submitClaimThroughAdapter()` 直接返回 `NEEDS_MANUAL`，永不调用 `adapter.submitClaim()`；注册表拒绝带写入面的适配器 | `services/adapters/ingest-bridge.ts:214-226`、`adapters/registry.ts:70`、`adapters/types.ts:132` |
| 审批边界可复用：`createHitlSubmissionBoundary` + `createAppActionGuard`（第一批已 PASS 的同一套） | `services/action-guard/hitl-submission.ts`、`http-routes.ts`（recovery-outcome 接线） |

**因此实现面收敛为（下一步实施）：**① 新增受保护路由（提交 Claim 记录，触发 `claim.submit` 动作）；② 缺守卫 / 缺审批 / capability 未满足 → 精确拒绝且零副作用；③ 全部满足 → 经 `createHitlSubmissionBoundary` 放行后调用 `recordSubmission()` 写跟踪记录、并**返回 `NEEDS_MANUAL` 表明未发生任何平台外写**；④ 审计落 `action_guard.approval_decision`；⑤ 按 6 项计划补齐 HTTP + 真实 PostgreSQL 测试。
**实现落点（2026-10-01 复核，可直接照此编码）：**

| 步骤 | 精确位置 | 说明 |
| --- | --- | --- |
| 新增路由常量 | `services/workflow/http-routes.ts:141` 附近（现有 `CASE_CLAIM_PATH = /^\/cases\/([^/]+)\/claim$/` 旁） | 新增 `CASE_CLAIM_SUBMIT_PATH = /^\/cases\/([^/]+)\/claim\/submit$/`（`/cases/:id/claim` 现为 **GET 草稿**，不承载提交） |
| 注册匹配 | 同文件 `:335` 附近的 path 解析段；`:368` 的「未知路由」大条件 | 两处都要加入 `caseClaimSubmit`，否则新路由会被判为未匹配 |
| 处理分支 | 同文件 `:863`（`if (caseClaim) { … }` 之后） | 新分支内**先** `if (!deps.actionGuard) throw new ActionGuardNotConfiguredError('claim.submit')`（fail closed），再走 HITL 边界 |
| 复用范式 | 同文件 `:1201-1235`（`outcomePath` → `createHitlSubmissionBoundary` → `boundary.submit({ action, organizationId, actorUserId, targetRef, approvalId, payload })`） | 参数形态照抄：`action: 'claim.submit'`、`targetRef: caseId`、`payload` 传本次提交载荷（用于审批指纹比对）、`audit: createPrismaActionGuardAuditPort(deps.prisma)` |
| 放行后的副作用（唯一） | 调用 `services/claims/tracking-service.ts:89` 的 `recordSubmission()` 写跟踪记录，并返回 `{ status: 'NEEDS_MANUAL' }` | **不得**调用 `submitClaimThroughAdapter()` 之外的任何外写；`NEEDS_MANUAL` 即「未发生平台提交」的显式结果 |
| 拒绝路径 | 缺守卫 / 缺 approvalId / 审批不存在 / capability 未满足 | 与第一批一致：403 `ACTION_GUARD_REQUIREMENTS_NOT_MET` / 409 `ACTION_GUARD_HUMAN_APPROVAL_REQUIRED` / 403 `ACTION_GUARD_APPROVAL_NOT_VERIFIED`，且**零副作用** |
| 新增测试 | `apps/api/src/__tests__/action-guard-claim-submit-http-db.test.ts`（照 `action-guard-hitl-http-chain-db.test.ts` 结构） | 覆盖 §3.2 已登记的 6 项 HTTP + 真实 PostgreSQL 验收 |

> 备注：本批次**不需要 Schema/迁移**；`claim.submit` 的 capability 映射（`submission` scope）与 `GUARD_ENFORCED_ACTIONS` 清单已存在，无需新增。
## 4. 下一 Checkpoint 关系

- 允许继续 **③ PRODUCTION CONTROL PLANE**（真实配置、有效 Kill Switch 与审计依赖的组合入口，保持默认 read-only）。
- 仍需单独安排 **② 具体 service/route/job/HITL 接入及集成验收收口**；③ 完成不追认 ② 完成。
- 不得仅凭基础模块的 CI 绿灯开启高危能力；Production Enablement / 真实外写 / 资金 / 客户提交 / 生产凭据继续 HOLD。

## 5. ② 第一批接入记录（HITL 提交入口，MSG-20260930-16 §6）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 审批绑定校验端口 + wrapper 强制（不得仅凭 approvalId） | 已实现 | approval-verifier / guard-enforcement（Action Guard 16 套 107/107） |
| HITL 审批验证器（审计派生复核状态：租户/目标/状态绑定） | 已实现 | hitl-approval-verifier（真实 PostgreSQL 7/7） |
| HITL 提交边界（拒绝零副作用 / ALLOW 恰一次 / 重试重新核验） | 已实现 | hitl-submission（7 项） |
| 真实入口接线：POST /cases/:id/recovery-outcome | 已接入（HEAD 3a37d24，送审中） | http-routes + server.ts；HTTP 级验收 4/4（拒绝时资金写入全为 0；APPROVED+approvalId 恰一次） |
| 审批有效期/撤销/一次性消费（独立审批记录） | **待架构方裁决**（涉及 Schema 变更，未自行实现） | — |
| 其余受保护入口（申诉/平台写入等） | TODO | 见第 3 节清单 |

## 6. ② 第一批 R1（操作级审批，MSG-20260930-17 CHANGE A–D）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| CHANGE A 操作级审批绑定 | 已实现（送审中） | approvalId=审批事件 id；组织/目标/动作/审批人/执行人/载荷指纹校验；删除 NOT_REQUIRED 绕过 |
| CHANGE B 生命周期与原子消费 | 已实现（送审中） | 有效期/撤销/消费/轮次；advisory lock + 同事务消费；幂等重试返回既有结果 |
| CHANGE C 组合与并发验收 | 已实现（送审中） | 首次四类资金对象各恰为 1；4 路并发仅一次成功；HTTP 三类拒绝零资金写入 |
| CHANGE D 审计与口径 | 已实现（送审中） | action_guard.approval_decision（含 approvalId/主体/目标/operationId）；缺守卫 403 ACTION_GUARD_NOT_CONFIGURED；零业务/资金副作用口径 |
| 审批表（独立生命周期记录） | **待架构方裁决** | 若审计事件方案不足，改走最小 Schema Delta |
| 其余受保护入口 | TODO | 见第 3 节清单 |


## 7. ② 下一小批次接入记录（claim.prepare，MSG-20261001-07 §6）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 入口接线：POST /cases/:id/claim/prepare | 已接入（R24 送审中） | `services/workflow/http-routes.ts` + `server.ts` WORKFLOW_PATH（其余路径仍 404） |
| 能力闸门（INTERNAL_WRITE，无人工审批） | 已实现（R24 送审中） | `guard.assertAllowed({action:'claim.prepare'})`；缺 guard → 403 ACTION_GUARD_NOT_CONFIGURED；默认控制面 READ_ONLY → 403 |
| 内部准备写入（草稿 upsert） | 已实现（R24 送审中） | `services/claims/claim-preparation.ts`：`DRAFT`/round=1 创建或更新；已离开 DRAFT → 409 ILLEGAL_TRANSITION |
| 租户隔离与动作权限 | 已实现（R24 送审中） | 跨租户 → 404 NOT_FOUND；服务内 `assertPermission(role,'claimTrackingApprove')`（OWNER/ADMIN），FINANCE → 403 FORBIDDEN |
| 审计失败关闭 | 已实现（R24 送审中） | `claim.prepared` 与业务写入同事务客户端；库拒绝审计写入 → 整笔回滚 |
| 零外部副作用 | 已实现（R24 送审中） | 不引用适配器写入面、不产生资金对象、不推进 Claim（submittedAt/submittedBy/approved* 保持空）；`platformWriteExecuted=false` |
| 集成测试 | **21/21**（R26 已验收） | `action-guard-claim-prepare-http-db.test.ts`（真实 HTTP + PostgreSQL；含 MSG-08 CHANGE A/B：prepare/submit 竞争、并发创建、等锁期降权/停用/未变对照、更新路径审计失败回滚） |
| 架构方裁决 | **PASS（MSG-20261001-10 / REVIEWED_REF d6d239b / CI run 36811474236）** | claim.prepare 工程批次收口（R24→R25→R26；CHANGE A 竞争保护 + CHANGE B 行锁后最终重验）；② 整体仍 NOT COMPLETE |


> **MSG-20261001-08（R24 = REVISE）已实施**：准备事务改为「案件锁 `cc-recovery-case:<caseId>`（与提交服务同协议）→ 租户核对 → 锁后重读 ACTIVE 用户 + 有效 Membership + 当前角色并重验权限 → 既有 Claim 行锁 → 带租户/案件/round=1/status=DRAFT 条件的 CAS」；主体失效沿用稳定码 `APPROVAL_ACTOR_MISMATCH`。集成测试 12 → 18 项（R25 送审中）。


## 8. ② 下一小批次接入记录（billing.draft，MSG-20261001-10 §5）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 入口接线：POST /cases/:id/billing/draft | 已接入（R28 送审中） | `services/workflow/http-routes.ts` + `server.ts` WORKFLOW_PATH |
| 能力闸门（INTERNAL_WRITE，无人工审批） | 已实现（R28 送审中） | 缺 guard → 403 ACTION_GUARD_NOT_CONFIGURED；默认 READ_ONLY / billing Kill Switch 关闭 / feature 未开启 → 403 且零副作用 |
| 锁顺序与锁后重验 | 已实现（R28 送审中） | 案件锁 `cc-recovery-case:<caseId>` → 既有账单行锁 → 费用依据行锁 → 最终 ACTIVE 用户/有效 Membership/当前角色重验 → 生成执行时间 → 幂等/拒绝/写入 |
| 幂等与并发 | 已实现（R29 送审中） | 幂等返回**真实持久化状态**（DRAFT/ISSUED/PAID/PARTIALLY_PAID）+ `invoiceRefAt`（创建时显式 `createdAt: at`，单一持久化来源）/`checkedAt` 分离 + `basisFeeCalculationIds` 集合；并发仅生成一张账单 |
| VOID / WRITTEN_OFF 后策略 | 已实现（R28 送审中） | 结构化 409 `BILLING_REISSUE_REQUIRES_NEW_NUMBER`；不删除/不重用旧账单、不抢移费用关联、不触发唯一约束 500 |
| 费用依据可靠事实 | 已实现（R28 送审中） | 费用行锁后重读；禁止抢移已关联其他账单的费用；金额 > 0 与 3 位大写币种校验 |
| 事务与审计 | 已实现（R28 送审中） | `billing.drafted` 与写入同事务；审计失败整笔回滚 |
| 边界 | 已实现（R28 送审中） | 不推进收款/到账/扣划（`paymentCollectedByThisCall=false`），不创建 Payment/Settlement/Ledger，不触达平台 |
| 集成测试 | **21/21**（R29 送审中） | `action-guard-billing-draft-http-db.test.ts`（真实 HTTP + PostgreSQL） |
| 架构方裁决 | **待裁决（R27/R28 = REVISE 已收敛，送审 R29）** | Issue #2 comment 5924692602 / CI run 36814394218 / HEAD d81a86f |
| 后续集成项（记录，不在本批） | 待立项 | 既有 `closure-service` / `commission-reconciliation` 自动起草路径未接入本次共用案件锁：当前只声明**本入口之间**的并发保障（MSG-20261001-11 §6） |
