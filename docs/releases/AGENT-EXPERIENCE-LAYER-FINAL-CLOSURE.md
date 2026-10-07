# AGENT EXPERIENCE LAYER — FINAL CLOSURE

**程序**：AGENT EXPERIENCE LAYER + DURABLE AUTHORIZATION + GOAL ORCHESTRATION
**分支**：`gate/7-commercial-validation`
**生产权限**：NONE（本次 closure 不解锁任何 HOLD / FORBIDDEN 项）

---

## 1. 外部独立审计裁决（已落地）

| 项 | 值 |
| --- | --- |
| 裁决编号 | `MSG-20261007-02` |
| 裁决 | **PASS / CLOSED**（`FINAL3_REQUIRED = NO`、`CHANGES = 无阻断性 CHANGE`） |
| 审阅代码 HEAD | `78eeb2cc`（`LAST_CODE_CHANGE_HEAD = 3c426361`；C1 `25bf985b` · C2 `9d2d7c6b` · C3 `3c426361`） |
| 归档位置 | `AI-ARCHITECT-INBOX.md` § `[MSG-20261007-02]`（逐字，未改写） |
| 归档校验 | `FNV1A_MATCH ef621411`（浏览器抽取 = 原文文件）+ `FULL_COPY_OK`（原文 141 行 / 归档 141 行 / 缺失 0 / 多出 0） |
| 前序裁决 | `MSG-20261007-01` = PASS WITH REVISE / NOT CLOSED（三条 CHANGE，均已在 AEL FINAL2 闭合） |

**审计确认**：`C1`（Goal direct-runner 旁路已关闭，产品执行准入只剩 queue-based `goal-runtime-binding`）、
`C2`（`CONSUMED → SUCCEEDED` 确为 `WHERE ... status='CONSUMED'` 原子 CAS，非“读后写”；终态绑定不可改写；
`connectionId` / `resumeGoalId` 同租户血缘；DB 状态机触发器对齐）、
`C3`（核心三项非可绕过 gate 任何自动授权判定都必须有 server-owned 显式证明，缺失 / UNKNOWN → DENY；
action 派生的 required gate 同样进入显式证明集合）。

**非阻断建议（记录，不实施）**：把“产品代码不得 import `goal-runtime-adapter`”的静态扫描从
barrel + 目录约定扩展到 `apps/api/src/**`。审计明确说明这不阻断 PASS；若要实施，应作为**新的独立单元**并重新送审，
因此本次 closure 不做代码改动，以保证“受审 HEAD = 收口 HEAD”。

---

## 2. 交付单元（全部 CLOSED / PUSHED）

| 单元 | 内容 | HEAD |
| --- | --- | --- |
| P0 | Standing Authorization 持久化（追加式版本 / 撤销留痕 / scope 不可改写 / tenant·account scoped） | `0a710d8b` |
| P1 | Agent Goal Domain 薄层（contract / schema / compiler / validator / capability / planner / runtime adapter） | `406d0433` |
| P2 | Goal → 既有 ONE SI Runtime 接线（只经既有任务队列） | `e504f35a` |
| P3 | 最小 Goal 持久化（`AgentGoal` / `AgentGoalRun` = intent + projection，非业务 SSOT） | `05717294` |
| P4a / P4b | 目标 HTTP 入口 + 首页 Goal Console 与四张结果卡（禁跨币种求和） | `ba3e8cb0` / `999998b1` |
| P5 | Needs Your Attention（复用既有 TaskCenter，单一待办中心） | `7a0149d9` |
| P6 | Agent Run 页面 `/recoveries/runs/:id`（业务语言，零内部术语） | `8356549c` |
| P7 | 授权管理 UI `/authorizations`（状态全部来自后端；前端不生成 scopeDigest） | `d4194cf3` |
| P8 | Navigation Progressive Disclosure（一级 5 项 + More/Advanced，零 route 删除） | `e9ce6731` |
| P9 | `OAuthAuthorizationSession` + `ConnectionSyncState` 最小补强（不新增第二连接事实源） | `e9cc7dc9` + `299b008a` |
| FINAL | 全量回归 + 自包含验收包 | `a316749a` / 封包 `e5eaab01` |
| AEL FINAL2 / C1 | 关闭 Goal direct-runner 旁路（barrel 不再导出 adapter；adapter 降为 INTERNAL / TEST-ONLY；architecture-contract +3 断言） | `25bf985b` |
| AEL FINAL2 / C2 | OAuth 成功必须经一次性消费 + 原子 CAS + binding 冲突 + 同租户血缘 + DB 状态机 | `9d2d7c6b` |
| AEL FINAL2 / C3 | 非可绕过 gate 必须有显式满足证明，缺失 / UNKNOWN → DENY | `3c426361` |
| AEL FINAL2 报告 | 三条 CHANGE 的修订说明与证据 | `b0e9400f` |
| FINAL 复审送审 + 队列收口 | STATE 记录 exact HEAD 与复审请求 | `78eeb2cc` |
| 裁决归档 + 本 closure | `AI-ARCHITECT-INBOX.md` MSG-20261007-02 + 本文档 | closure 提交（见 `.autopilot/STATE.json`） |

---

## 3. 回归证据（AEL FINAL2 收口，受审 HEAD `78eeb2cc`）

| 项 | 结果 |
| --- | --- |
| API 全量回归 | **4550 / 4551 passed** —— 唯一失败 = 既有 `recovery-si-phase2-e-db` P2E-DB5 并行隔离 flake（单跑 20/20 PASS），审计确认非 FINAL2 引入 |
| OAuth 会话 + 连接同步 | `oauth-session-connection-sync-db` **11/11**（真实 PostgreSQL） |
| Standing Authorization / Action Guard / Goal 定向回归 | **308/308** |
| OAuth 相关定向回归（connect 族） | **235/235** |
| `architecture-contract` | **170/170** |
| api `tsc --noEmit` | 0 |
| web `tsc --noEmit` | 0 |
| `prisma validate` / migrations | valid / 92 migrations 已应用 |
| append-only / controlled-mutation 触发器清单 | 73 OK（真实 PostgreSQL） |
| GitHub Actions | **NOT_OBSERVED**（本地与远端推送为唯一证据；不得写成 CI green） |

---

## 4. 最终返回值

```
AGENT_EXPERIENCE_LAYER              = PASS / CLOSED
STANDING_AUTHORIZATION_DURABLE      = PASS
GOAL_COMPILER                       = PASS
GOAL_RUNTIME_WIRING                 = PASS
GOAL_RUNTIME_SINGLE_ENTRY           = PASS / CLOSED
HOME_GOAL_CONSOLE                   = PASS
AGENT_RUN_UI                        = PASS
NEEDS_ATTENTION                     = PASS
AUTHORIZATION_UI                    = PASS
NAVIGATION_PROGRESSIVE_DISCLOSURE   = PASS
OAUTH_AUTHORIZATION_SESSION         = PASS
OAUTH_SUCCESS_STATE_MACHINE         = PASS / CLOSED
CONNECTION_SYNC_STATE               = PASS
NON_BYPASSABLE_GATE_FAIL_CLOSED     = PASS / CLOSED
ACTION_GUARD_SINGLE_CATALOG         = PASS
CAPABILITY_LOSS                     = 0
ONE_SI_RUNTIME                      = YES
SECOND_RUNTIME                      = 0
SECOND_SCHEDULER                    = 0
SECOND_GUARD                        = 0
FULL_REGRESSION                     = 4550/4551（1 = 既有 P2E-DB5 并行隔离 flake，单跑 20/20）
FINAL_AUDIT                         = PASS / CLOSED（MSG-20261007-02，FULL_COPY_OK）
PRODUCTION_READY                    = NO
```

**仍为 HOLD（不得解锁）**：REAL_PROVIDER_WRITE、CUSTOMS_FILING、PAYMENT、AUTO_COMMISSION_CHARGE、
PRODUCTION_CREDENTIALS、PRODUCTION_ENABLEMENT、REAL_MODEL_NETWORK、PAID_MODEL_CALLS、EXTERNAL_WRITE、
TRANSPORT、P2_F、P2_G。

**仍为 FORBIDDEN**：SECOND_RUNTIME、SECOND_SCHEDULER、SECOND_GUARD、SECOND_POLICY_ENGINE、
SECOND_CONTROL_PLANE、SECOND_MODEL_GATEWAY、SECOND_COST_LEDGER、SECOND_META_EVIDENCE_STORE、L5_RELAXATION。

高金额 HITL（> USD 1,000 → OWNER / ADMIN；≥ USD 10,000 → ADMIN）KEEP；Standing Authorization ≠ Broker POA；
Customs 15-gate readiness 不变；LLM 不决定权限 / eligibility / 金额；前端不重算业务判定。

---

## 5. 剩余宿主事项（不属于本次代码闭环）

1. 真实 provider 凭据 / 外部写 / 支付开通 / production enablement —— 属新的独立授权单元。
2. Linux/systemd 实机验证（SYSTEMD_RUNTIME_VALIDATION）。
3. `main` 推进方式（`--no-ff` / `--ff-only`）仍需宿主决定。

（本次 closure 之后，AEL 程序停止自动推进：`EXECUTION_ACTIVE=false`、`SAFE_CONTINUATION_QUEUE=[]`，
180s watchdog 已删除。）
