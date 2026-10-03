# FINAL ACCEPTANCE & STOP PROTOCOL（CrossClaim AI 自治开发最终验收与停止协议）

- 生效：2026-10-03（宿主指令）；本文件为**权威协议**，后续自动化必须持续执行。
- 与 `.autopilot` 状态机、CONTINUOUS runner、GLOBAL BACKLOG DISPATCHER 合并执行。

## 一、禁止自证完成

Codex **不得**仅凭「代码已写、单测通过、heartbeat 正常、backlog 暂时为空、无新裁决」宣布项目完成。完成必须经三层验收。

## 二、Layer 1 — INTERNAL CODE COMPLETE（14 项，全部满足才可 TRUE）

1. `SAFE_CONTINUATION_QUEUE = 0`；2. 所有 Codex 可独立完成的 P0/P1/P2 内部缺口 CLOSED；3. 不存在 TODO / IN_PROGRESS / PARTIAL / READY_FOR_REVIEW / WAITING_FOR_VERDICT / 未处理 REVISE / 未处理 BLOCK；4. 最新 HEAD 全量 CI SUCCESS；5. 真实 PostgreSQL 回归全 PASS；6. Fresh DB：空库 migrations 全成功 + `prisma validate` / `generate` 成功；7. API typecheck PASS；8. Web typecheck/build PASS；9. 关键验收测试无 skipped；10. `git status` clean；11. 文档状态与代码一致；12. Schema / DB constraints / tenant triggers / append-only guards 静态与运行库双验证；13. 核心 negative path 全覆盖（cross-tenant / RBAC bypass / duplicate request / idempotency conflict / concurrent execution / timeout·ambiguous / tampered digest / missing evidence / invalid currency·amount / unauthorized write / provider unknown）；14. 不得以 mock-only 替代真实 PostgreSQL E2E。

## 三、Layer 2 — PRODUCT GOLDEN PATH COMPLETE

核心业务链 Golden Path E2E（Authorization → Data ingest → Opportunity → Qualification → Recoverable amount → Evidence package → Start recovery → Claim/Broker handoff → Status tracking → Settlement confirmed → RecoveryLedger → 15% FeeCalculation → BillingInvoice），按域验证 Platform / Logistics-Carrier / Customs / Independent-site；每域需 happy / negative / replay / concurrency / failure-recovery / cross-tenant / RBAC-bypass / 金额与账本一致性 全 PASS。禁止出现「service 有 HTTP 未接」「HTTP 有 frontend 未接」「UI 无真实 backend」「contract-only 无 persistence」「Schema 字段无 DB invariant」。

## 四、Layer 3 — REAL INTEGRATION / PRODUCTION（Codex 不得自行宣布完成）

Amazon / TikTok Shop / Walmart / Shopify 真实 OAuth、UPS / FedEx / DHL 真实 API·webhook、Customs Data / Filing / Broker 接入、Broker POA、生产凭据、真实客户数据、真实 Settlement / 到账、Payment Mandate、生产支付 provider·webhook·reconciliation、真实 success fee 扣费、正式生产部署、DNS·monitoring·alerting、法律·牌照·Broker 边界确认 —— 一律标记 `HOST_ACTION_REQUIRED` / `API_INTEGRATION_REQUIRED` / `REAL_DATA_REQUIRED` / `LEGAL_OR_LICENSE_REQUIRED`，不得假装 CLOSED。

## 五、每轮固定输出 4 个状态

`CODE_COMPLETE` · `INTEGRATION_COMPLETE` · `REAL_VALIDATION_COMPLETE` · `PRODUCTION_READY`（均为 YES/NO），并附 `OPEN_INTERNAL_ITEMS` / `HOST_ACTION_REQUIRED` / `API_INTEGRATION_REQUIRED` / `REAL_DATA_REQUIRED` / `LEGAL_OR_LICENSE_REQUIRED`。
计算器：`tools/autopilot/final-status.mjs`（写入 `STATE.final_status`，并在 `docs/releases/FINAL-ACCEPTANCE-REPORT.md` 中反映）。

## 六、最终验收报告

内部可执行工作耗尽时自动生成并维护 `docs/releases/FINAL-ACCEPTANCE-REPORT.md`（验收项 | 状态 | Commit | Test/E2E | CI Run | 备注），覆盖：P0 生死线、Platform、Logistics、Customs、Independent-site、Evidence Graph、Qualification、Settlement、RecoveryLedger、15% Fee/Billing、Action Guard、Tenant Isolation、RBAC、Idempotency、Concurrency、Failure Recovery、Fresh DB Migration、DB Constraints、Backend HTTP wiring、Frontend wiring、Full CI、Documentation sync、Security/Credential boundary、Production integrations。
生成器：`tools/autopilot/final-report.mjs`。

## 七、自动停止条件（唯一）

仅当 `INTERNAL_CODE_COMPLETE = TRUE` **且** `SAFE_CONTINUATION_QUEUE = 0` 时，允许自治内部开发进入停止态，并输出：`AUTONOMOUS_INTERNAL_WORK = EXHAUSTED` + 四类剩余清单。**禁止**因「无新裁决 / heartbeat 空转 / 当前无任务 / 等待 ChatGPT / 等待宿主」提前停止。

## 八、最终独立审计（不得省略）

即使 `INTERNAL_CODE_COMPLETE = TRUE`，也不得等价为「项目完成」。必须保留 `INDEPENDENT_FINAL_AUDIT_REQUIRED = TRUE`，由 ChatGPT 独立读取 Git HEAD / commits / migrations / schema / tests / CI / routes / frontend wiring / backlog / FINAL-ACCEPTANCE-REPORT 反查；独立审计完成前 `PRODUCTION_READY` 不得因 Codex 自证而设为 YES。

## 九、最终归档语义（FINAL ARCHIVAL SEMANTICS；MSG-20261003-145 裁定）

最终「内部代码完成」的判定**不依赖 Final Acceptance Tree 内部的 STATE 预知自身未来的 CI 结果**，
而由下列**三元事实**派生（外部不可变证据闭环）：

| 事实 | 来源 | 说明 |
|---|---|---|
| `FINAL_ACCEPTANCE_HEAD` | Git | 不可变提交（其 diff 只允许静态验收产物） |
| `CI_RUN` / `CI_CONCLUSION` | GitHub Actions | 该 HEAD 自身的全量 CI 结果 |
| `INDEPENDENT_ARCHITECT_AUDIT` | 架构方裁决 | 独立反查结论 |

**闭合条件（CHANGE FINAL-A，MSG-20261003-146）**：必须**同时**满足 `CI_CONCLUSION = SUCCESS` **且** `INDEPENDENT_ARCHITECT_AUDIT = PASS`；
审计仍为 `PENDING`/`REVISE` 时不得提前判 YES（此时 `AUTONOMOUS_INTERNAL_WORK = AWAITING_FINAL_AUDIT`）。

满足后派生：`CODE_COMPLETE=YES` / `INTERNAL_READY=YES` / `AUTONOMOUS_INTERNAL_WORK=EXHAUSTED`，
同时 `INTEGRATION_COMPLETE=NO` / `REAL_VALIDATION_COMPLETE=NO` / `PRODUCTION_READY=NO` 保持不变。

**禁止**：为了记录 verdict 而再次提交 STATE/报告，从而改变 Final Acceptance Tree（会造成 HEAD 漂移与无穷 CI 等待）。
CLOSED 记录应写在 GitHub Issue comment / release annotation / 本协议文档中，而不是新的提交。

计算器：`tools/autopilot/final-archival.mjs`（只读 Git/STATE/CI 结果并输出闭合记录，不修改 Final Acceptance Tree）。
