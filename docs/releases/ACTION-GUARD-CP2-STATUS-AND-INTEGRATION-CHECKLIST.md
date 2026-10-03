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
| `appeal.submit` | `POST /cases/:id/appeal/submit`（http-routes + server WORKFLOW_PATH） | 平台外写（当前 HOLD；入口仅登记内部结果 `platformWriteExecuted=false` / `NEEDS_MANUAL`） | approvalId 服务端校验（租户/动作/对象/轮次/版本化提交快照摘要）+ 案件锁 → Appeal 行锁后重验主体/角色/审批生命周期 + 锁后重算快照比对 | HTTP 级 **13/13**（缺审批 / 动作不通用 / 重复 / 缺 guard / 锁期撤销 / 轮次歧义 / 空正文 / 审批后正文变化 / 独立审批人+执行人行锁期降权 / 并发恰一次 / 审计失败整笔回滚 / 错误绑定拒绝） | **已验收 PASS（MSG-20261001-16 / REVIEWED_HEAD 7d888cc；CI 36820104474）** |
| `platform.write` | 边界模块 + 账本设计 + 实施计划（未接线对外路由） | 平台外写（**HOLD**；transport 恒关） | Action Guard + 审批绑定快照 + 执行权账本 | 离线 fail-closed 17/17；Action Guard 22/22 | **PASS WITH REVISE（MSG-20261001-19 / REVIEWED_HEAD 61b95f1）→ 已获准进入 S1–S5 实现**；HTTP/adapter/transport/生产凭据/客户提交继续 HOLD |
| `commission.charge` | 待定（结算/佣金路径） | 资金动作（HOLD） | 同上 + 财务复核 | 待补 | TODO |
| `payment.capture` | 账单登记入口（HTTP 受保护入口） | 资金动作（HOLD） | Action Guard 审批绑定 + 锁内事实 CAS + 快照交错校验 | HTTP 级：拒绝零副作用 / 允许恰一次（含并发与等锁失效） | **已验收 PASS（MSG-20260930-24 / REVIEWED_REF 73115a3）** |
| `secret.rotate` | 待定（运维路径） | 凭据操作（HOST ONLY） | HOST APPROVAL | 待补 | TODO |
| `claim.prepare` | `POST /cases/:id/claim/prepare`（http-routes + server WORKFLOW_PATH） | 业务库写入（第 1 轮 Claim 草稿 `target`/`aiDraftText` + `claim.prepared` 审计同事务；不推进状态） | 能力闸门（`INTERNAL_WRITE` / `requires: []`，**无人工审批**）+ 案件锁 + Claim 行锁后最终主体/角色重验 | HTTP 级 **21/21**（含行锁等待期降权/停用/未变对照、并发创建、状态交错、更新路径审计失败回滚） | **已验收 PASS（MSG-20261001-10 / REVIEWED_REF d6d239b；CI 36811474236）** |
| `billing.draft` | `POST /cases/:id/billing/draft`（http-routes + server WORKFLOW_PATH） | 业务库写入（DRAFT `BillingInvoice` + `billing.drafted` 审计同事务；不推进收款/到账/扣划） | 能力闸门（`INTERNAL_WRITE` / `requires: []`，**无人工审批**）+ 案件锁 + 账单行锁 + 费用依据行锁后最终主体/角色重验 | HTTP 级 **21/21** | **已验收 PASS（MSG-20261001-13 / REVIEWED_REF d81a86f；CI 36814394218）** |
| `evidence.read` | `GET /cases/:id/evidence`（既有只读端点接入 Action Guard） | 无（只读） | 无（READ_ONLY 契约，无人工审批） | HTTP 级 6/6（缺 guard / 能力不可用 / 跨租户 404 / FINANCE·VIEWER 403 / 合法读取 / 无状态推进） | **已验收 PASS（MSG-20261001-14 / REVIEWED_REF 549dba8；CI 36815640605）** |

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
| 架构方裁决 | **PASS（MSG-20261001-13 / REVIEWED_REF d81a86f / CI 36814394218）** | billing.draft 工程批次收口（R27→R28→R29）；下一小批次 = evidence.read |
| 后续集成项（记录，不在本批） | 待立项 | 既有 `closure-service` / `commission-reconciliation` 自动起草路径未接入本次共用案件锁：当前只声明**本入口之间**的并发保障（MSG-20261001-11 §6） |


## 9. ② 下一小批次接入记录（evidence.read，MSG-20261001-13 §5）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 入口接线：GET /cases/:id/evidence | 已接入（送审中） | `services/workflow/http-routes.ts` 现有只读端点接入 `evidence.read` |
| 只读契约（无人工审批） | 已实现（送审中） | 缺 guard → 403 ACTION_GUARD_NOT_CONFIGURED；能力状态不可用 → 403 ACTION_GUARD_STATE_UNAVAILABLE；**不套用 INTERNAL_WRITE 的模式限制**（READ_ONLY 模式 + tenant/feature 未开启仍允许） |
| 租户/主体/归属检查 | 复用既有投影（送审中） | 跨租户 → 404 NOT_FOUND；FINANCE/VIEWER → 403 FORBIDDEN；拒绝响应不含证据内容、下载地址或存储引用 |
| 无状态推进 | 已实现（送审中） | 读取前后 Case/Claim/账单/到账事实不变；不触发平台或资金动作 |
| 专项测试 | 6/6（送审中） | `action-guard-evidence-read-http-db.test.ts`（真实 HTTP + PostgreSQL） |
| 架构方裁决 | **PASS（MSG-20261001-14 / REVIEWED_REF 549dba8 / CI 36815640605）** | 证据**元数据列表**入口批次收口；不含文件字节读取/签名下载地址签发/下载通道审计；下一小批次 = appeal.submit |


## 10. ② 下一小批次接入记录（appeal.submit，MSG-20261001-14 §5）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 入口接线：POST /cases/:id/appeal/submit | 已接入 | `services/workflow/http-routes.ts` + `server.ts` WORKFLOW_PATH；独立动作 `appeal.submit`（与 `claim.submit` 互不通用） |
| 审批绑定 | 已实现 | approvalId 校验租户/动作/对象/轮次 + `appeal-submission/v1` 版本化服务端提交快照摘要（`services/appeals/appeal-snapshot.ts`；审批创建与执行核验共用 `canonicalJson` + sha256） |
| 锁序与锁后重验 | 已实现 | 案件锁 → Appeal 行锁（显式 `round=2`）→ 重读 ACTIVE User / 有效 Membership / 实时角色 → 审批生命周期重验 → 锁后重算快照并比对 `basisReference` |
| 失败关闭 | 已实现 | 正文/关联对象/轮次任一变化 → 结构化拒绝且 Appeal 零推进、审批零消费；空正文 → 409 `APPEAL_BODY_REQUIRED`；多 `round=2` 候选 → 409；`round=3` → 404 |
| 事务与审计 | 已实现 | 状态推进 + `appeal.submitted` 审计（含 `snapshotVersion/snapshotDigest/bodyRule`）+ 审批消费同事务；审计失败整笔回滚 |
| 零外写口径 | 已实现 | 仅登记内部结果 `platformWriteExecuted=false` / `NEEDS_MANUAL`；专项中 `platformWrites` 已改为真实口径 `billingInvoices` |
| 专项测试 | **13/13 PASS** | `action-guard-appeal-submit-http-db.test.ts`（真实 HTTP + PostgreSQL） |
| 架构方裁决 | **PASS（MSG-20261001-16 / REVIEWED_HEAD 7d888cc / CI 36820104474）** | appeal.submit 批次收口；非阻塞边界：用例 06 仅证明消费侧拒绝能力（非完整撤销入口 E2E）、本 PASS 不授权真实平台写入；② 剩余 = `platform.write`（EXTERNAL_WRITE，继续 HOLD） |

## 11. ② 最后一项 `platform.write` 边界批次记录（MSG-20261001-16 NEXT）

裁决授权：只做接口 / 状态机 / 权限 / 幂等 / 审批绑定 / 模拟适配器 / fail-closed 测试；**不得启用任何真实平台写**。

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 接口（端口） | 已完成 | `services/platform-write/{types,snapshot,state-machine,ledger,simulated-adapter,index}.ts`；依赖注入 `guard / approvals / ledger / sink / capabilities / audit / now` |
| 动作名单一来源 | 已完成 | `PLATFORM_WRITE_ACTION` 定义在 `services/action-guard/approval-verifier.ts`，平台写模块仅再导出（有限静态约定检查通过） |
| 状态机 | 已完成 | `PENDING→IN_FLIGHT→SUCCEEDED/FAILED/RETRYABLE`；`RETRYABLE→DEAD_LETTER`（上限 3）；终态不可离开；非法迁移抛 `ILLEGAL_TRANSITION` |
| 权限 | 已完成（离线） | `EXTERNAL_WRITE` 门闸 + `writeEnabled`；决策非 ALLOW 即 BLOCKED，`sinkCalls=0` |
| 幂等 | 已完成 | 版本化快照 `platform-write-request/v1`（canonicalJson+sha256）→ `pw1-*` 幂等键；同键同摘要重放 `REPLAYED`，同键不同摘要 `IDEMPOTENCY_CONFLICT` |
| 审批绑定 | 已完成（只读核验） | 租户 / 动作 / 未消费 / 未过期 / `basisReference === snapshotDigest`；消费与落库留待后续增量 |
| 模拟适配器 | 已完成 | `createSimulatedPlatformWritePort`：`simulated: true` 字面量类型 + 运行时 `SIMULATED_SINK_REQUIRED`；无网络 / 无 env / 无凭据 |
| fail-closed 验收 | **17/17 PASS** | `apps/api/src/__tests__/platform-write.test.ts`（含静态探针：模块内无 `fetch(`/axios/`node:http`/env/凭据解析） |
| 类型与 Schema | PASS | `npx tsc --noEmit` PASS；`npx prisma validate` valid（**未改 Schema**） |
| 回归 | 22/22 PASS | `action-guard-enforcement` / `action-guard-catalog-integrity` / `action-guard` |
| 设计稿 | 已完成 | `docs/releases/ACTION-GUARD-PLATFORM-WRITE-DESIGN.md`（含非目标、后续需架构方裁决事项 4 条） |
| 待补（下一增量） | 未完成 | 对外 HTTP 入口接线 + 真实 HTTP + PostgreSQL fail-closed 验收；完成后才可 READY_FOR_REVIEW 送审 |

### 11.1 MSG-20261001-17 裁定落地（PASS WITH REVISE）

| CHANGE | 要求 | 本轮落地状态 |
| --- | --- | --- |
| A | 暂不接对外 HTTP 入口；先有持久化执行账本与原子性设计再单独申请接线 | **遵守**：未新增任何路由；模拟通道仅服务层/测试可达 |
| B | 提交 `PlatformWriteAttempt` 持久化账本 Design / Schema Delta Request（**不直接写 migration**） | 下一批次交付（已写入 STATE.next_action） |
| C | 审批消费与“获得执行权”形成数据库事务原子边界；定义 `UNKNOWN_PROVIDER_RESPONSE` 与 reconciliation/恢复语义 | 下一批次设计文档交付 |
| D | `PLATFORM_WRITE_TRANSPORT_ENABLED=true` 不单独构成真实写入授权；需独立 Production Enablement 裁决 | 已登记为硬边界（设计§9/§11 保持） |

> 并发不变量（CHANGE B 必须回答）：①同一幂等键最多一条有效执行链；②同一审批不得授权两个不同 snapshot；③崩溃/超时重试不得产生两个 `SUCCEEDED`。账本禁止保存 credential / token / secret 或非必要原始平台 payload。

### 11.2 CHANGE B/C/D 设计交付（R34 送审内容）

| 交付物 | 内容 | 状态 |
| --- | --- | --- |
| `docs/releases/PLATFORM-WRITE-ATTEMPT-LEDGER-DESIGN.md` | 现状对齐（内存账本 / 审批=AuditLog 事件 / 快照幂等键 / transport 恒关）；`PlatformWriteAttempt` 字段草案；三条并发不变量落地方式；**T1 数据库事务（重验审批 → 唯一 attempt → CAS IN_FLIGHT → 同事务写 approval_consumed）+ T2 事务外调用 + T3 结果收敛**；`UNKNOWN_PROVIDER_RESPONSE` 与对账/恢复语义；安全与最小化；索引与保留期；迁移回滚；验收清单 | 已交付 |
| `docs/releases/PLATFORM-WRITE-SCHEMA-DELTA-REQUEST.md` | 正式 Schema Delta Request（仅请求批准）：新枚举 `PlatformWriteAttemptStatus`（含 `UNKNOWN_PROVIDER_RESPONSE`）；新表 `PlatformWriteAttempt` 字段表；C1–C6 约束/索引（含 partial unique index 请求）；与既有模型关系（仅 `organizationId` FK，其余弱引用）；明确不含 migration/HTTP/transport；回滚方案；5 个待批问题 | 已交付 |

> 本轮**未**改 Prisma Schema、**未**写 migration、**未**接线 HTTP、**未**开启 transport、**未**消费审批、**未**调用真实平台。

### 11.3 MSG-20261001-18 裁定收入（账本/原子性设计）

| 项 | 结论 |
| --- | --- |
| ① I1 | **选项 A**：`(organizationId, idempotencyKey)` = 唯一逻辑执行链；`attemptNo` 仅同一链内计数 |
| ② partial unique index | **批准**（`SUCCEEDED` 唯一性），索引冲突转稳定业务错误 |
| ③ `approvalId` | 不批准无条件可空；服务层 + 测试锁死 `simulated=false && status>=IN_FLIGHT ⇒ 有效 approvalId` |
| ④ UNKNOWN | `UNKNOWN_PROVIDER_RESPONSE → RECONCILING → SUCCEEDED / FAILED_CONFIRMED / MANUAL_REVIEW`；1/5/15/60 分钟、24h 转人工；**绝不重发写请求** |
| ⑤ 保留期 | 24 个月默认（非不可变合规结论）；legal/dispute hold；append-only 加密归档；本阶段不实现清理 |
| CHANGE A | 区分逻辑执行链与执行/对账历史；只建 `PlatformWriteAttempt`；未来另设 append-only child model |
| CHANGE B | UNKNOWN 恢复所有权：SYSTEM 只读 reconciliation；人工需 OWNER/ADMIN + actor/reason 审计 |
| CHANGE C | 消费必须可并发验证；**现状报告**：`AuditLog` 无 approvalId 列、消费无数据库唯一约束（既有恰一次靠业务 CAS/锁）→ 方案 = `PlatformWriteAttempt.(organizationId, approvalId)` 唯一约束承担；**待架构方确认** |

交付物：`docs/releases/C-PLATFORM-WRITE-LEDGER-IMPLEMENTATION-PLAN.md`（R35 送审）；`PLATFORM-WRITE-ATTEMPT-LEDGER-DESIGN.md` §12 已收入裁定。

### 11.4 MSG-20261001-19 裁定收入（实现授权）

| 项 | 结论 |
| --- | --- |
| 总体拆法 | **批准**（唯一逻辑执行链 / T1-T2-T3 / R1 reconciliation / 数据库约束兜底 / UNKNOWN 不重发 / PG1–PG10） |
| 三态 | `RECONCILING` / `FAILED_CONFIRMED` / `MANUAL_REVIEW` **批准** |
| 迁移 | M1/M2/M3 三步**批准**（每步可部署可验证；不得使默认关闭路径失效） |
| CHANGE A | `PlatformWriteAttempt` 承担消费不变量获得认可（**不给 AuditLog 加列**）；约束须准确表达「一个非空 approvalId 最多绑定一个能取得真实执行权的逻辑 attempt」；禁止孤儿 attempt 吃掉审批 |
| CHANGE B | T1 = 真正原子授权点（六项同时成立，任一步失败整笔回滚；消费必须是事务事实） |
| CHANGE C | `FAILED_CONFIRMED` 仅表示可信证据确认未产生副作用或 provider 明确终态失败；timeout/404/次数耗尽/24h 到期 → `MANUAL_REVIEW` |
| NEXT | 允许 S1 Schema/M1 → S2 constraints/M2 → S3 service/M3 → S4 PG1–PG10+新增断言 → S5 全量回归/CI/送审 Implementation Checkpoint |

> 实现期间硬边界：NO HTTP WIRING · NO REAL PROVIDER ADAPTER · `PLATFORM_WRITE_TRANSPORT_ENABLED=false` · NO PRODUCTION CREDENTIALS · NO REAL EXTERNAL WRITE · NO CUSTOMER SUBMISSION。
