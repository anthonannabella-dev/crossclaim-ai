# SI/RSI INTERNAL AUTONOMOUS CODE REPAIR V1 —— PHASE 2 FINAL-R2 复审请求（CHANGE 1–3 完成）

审计编号（请在回复标题中沿用）：MSG-20261009-10
REVIEWED_HEAD = 58c71cc1（分支 feat/si-rsi-internal-code-repair-v1）
上一轮裁决：MSG-20261009-09 = PASS WITH REVISE（PHASE2_SAFE_SCOPE_ACCEPTED=YES；PHASE2_CLOSED=NO；
PHASE3_DESIGN_AUTHORIZED=YES_READ_ONLY；PHASE3_IMPLEMENTATION_AUTHORIZED=NO；NEXT_AUDIT=MSG-20261009-10）
durable 记录：本文件、docs/releases/SI-RSI-INTERNAL-CODE-REPAIR-V1.md（§2.5 三项 CHANGE）、
docs/releases/SI-RSI-INTERNAL-CODE-REPAIR-V1-PHASE2-TRUSTED-FACTS-CONTRACT.md（CHANGE 3 契约正文）

一、本轮送审范围
仅审上一轮指定的三项 P1 修订（CHANGE 1 / 2 / 3）。**未新增任何执行能力**、未新增运行时/调度器/控制器、
未实施 PHASE 3 代理、未改 Prisma schema 或迁移、未接真实 Provider、未修改封板 RC/main。

二、CHANGE 1（P1）GATE-5 脱敏负向验收 —— 验收名 GATE5_NEGATIVE
实现（apps/api/src/services/self-repair/fault-triage.ts）：
- 分流载荷解析新增**值域校验**：faultClass / requiredAction / replayDisposition / operationKind /
  idempotencyGuarantee / ownerGatedAction 必须落在既有封闭值域内；否则整条载荷 fail-closed
  （原因码 PAYLOAD_VALUE_NOT_CANONICAL）。
- 由此**结构性**阻断任意文本的夹带：被篡改成携带 token / API key / 邮箱 / 攻击文本的字段既不会被当作语义使用，
  也不可能经返回值外泄（对账说明文本原会拼接 `faultClass:operationKind`，值域校验后只可能由规范枚举拼接）。
- 登记字段仍为服务端固定三项（triageDecision / triageReason / triagedAt），只写枚举码与 ISO 时间。
- **未改动历史故障载荷的保留策略**（审计明确要求）：测试只观察登记边界，不重写既有字段。

证据（纯函数 + 真实 PostgreSQL）：
- 负向矩阵 6 例（六个字段逐一塞入 sk-DUMMYKEY-… / 邮箱 / <script> / /etc/passwd）⇒ 一律
  BLOCK_HUMAN_REVIEW + PAYLOAD_VALUE_NOT_CANONICAL，且 JSON.stringify(decision) 不含任何注入文本；
- 对账说明文本规范性：形如 ^[A-Z_]+:[A-Z_]+，不可能夹带自由文本；
- DB-S9（真实登记路径）：恶意载荷（含未知键 attackerExtraKey）⇒ 结论与返回值零泄露、登记三字段均为规范值、
  **历史字段与未知键保持原样**、零任务零租约；
- DB-S10：历史 summary 含敏感残留时，扫描返回值仍不夹带（登记边界不外泄）。

三、CHANGE 2（P1）并发登记与时间戳幂等语义 —— 验收名 GATE4_TRIAGE_REGISTRATION
实现（apps/api/src/services/self-repair/fault-triage-sweep.ts）：登记改为 **first-write-wins**
（更新语句追加 `AND NOT ("sourceRefs" ? 'triageDecision')`）：
- 重复扫描 ⇒ 不写、`triagedAt` 不漂移、既有决策不被覆盖；
- 并发扫描 ⇒ 行锁 + 条件重判下**只有一次**真正写入（其余进入幂等跳过计数）；
- 任何非 DIAGNOSED 状态（含并发转为 CLOSED）⇒ **绝对禁止登记**；
- `sourceRefs` 更新一律 jsonb **合并**（只增不改）⇒ 个别字段不被整对象覆盖，并发下不会丢失其它引用
  （含 PHASE 1 既有键与历史遗留的未知键）；
- 返回值新增可审计计数：registered（首次写入）/ alreadyRegistered（幂等跳过）/ skipped（被 kind/status 挡下）；
  0 行时只做**只读**定位，不猜不吞；
- 明确登记是**快照**（registrationIsSnapshotNotAuthorization）：可信事实若在「计算 → 写入」之间变化，
  已登记内容**不被改写**；运行时不得把该快照当作授权凭证。

证据（真实 PostgreSQL）：
- DB-S6 重复扫描：第二次 registered=0 / alreadyRegistered=1；sourceRefs 深比较**逐字不变**（triagedAt 不漂移）；
- DB-S7 四路并发：合计 registered=1 / alreadyRegistered=3；三个 triage 键各出现一次；
- DB-S8 并发中转为 CLOSED：registered=0 / alreadyRegistered=0 / skipped=1；该行无 triage 字段且不抛错；
- DB-S11 可信事实变化后重扫：当前计算结论变为 BLOCK（保留在 decisions 中），但**已登记快照不被覆盖**
  （triageDecision 仍为 A 路径、triagedAt 仍为首次值）；
- DB-S12 jsonb 合并不丢字段：并发后 unrelatedRefA / nested / PHASE 1 faultClass 全部完整。

四、CHANGE 3（P1）可信事实来源契约 —— 契约正文 + 可执行断言
契约正文：docs/releases/SI-RSI-INTERNAL-CODE-REPAIR-V1-PHASE2-TRUSTED-FACTS-CONTRACT.md
可执行契约（fault-triage.ts）：
- TRUSTED_FACT_SOURCE_REQUIREMENTS：organizationIdResolved → TRUSTED_PERSISTED_IDENTITY；
  authorizationActive → SERVER_AUTHORIZATION_STATE；operationRecheck → TRUSTED_EXECUTION_CONTEXT（各自唯一允许来源）；
- FORBIDDEN_TRUSTED_FACT_SOURCES：REQUEST_PARAM / CLIENT_INPUT / MODEL_OUTPUT / UNKNOWN（未声明即不可信）；
- assertTrustedFactSources()：校验声明并返回违规字段清单（禁止来源 / 配对错位 / 未声明）；
- defineTrustedFactsResolver()：唯一推荐的解析器构造方式，违规声明在**创建期**抛 TrustedFactSourceContractError；
- createPrismaFaultTriageSweep({ trustedFactSources })：接线期再次校验，违规即抛错（生产适配器必须提供声明）；
- 快照语义写入契约：分流结论只是某一时刻的快照，运行时不得无条件信任，必须自行复核。

证据：契约负向矩阵（三个事实 × 禁止来源）、配对错位、未声明事实、构造期抛错、合法声明可正常解析、
源码级边界（不出现 req./request. 取值形态与 modelOutput、零日志）—— 共 11 用例 PASS。

五、门禁与当前证据状态（如实声明）
- PHASE 2 四套件（分流纯函数 / PG 往返 / PG 扫描 / 契约）：**56/56 PASS**（其中真实 PostgreSQL 17 用例）；
  `apps/api tsc --noEmit` **0 error**；全部在本轮 REVIEWED_HEAD 58c71cc1 上实测。
- **GATE-1 全量 API 回归的证据来自 3acfb195**（490/490 文件、4926/4926 用例、exit 0；证据文件
  tools/verification/self-repair/phase2-gate1-full-regression.json）。自 3acfb195 起的改动**仅限**
  apps/api/src/services/self-repair/*（分流/扫描/契约）与其测试文件，属新增模块内的修改；
  本轮**未**重跑全量回归（如需在 58c71cc1 上补跑，可另行执行，约 26 分钟）。
- 如实声明未验证：Linux/systemd 实机、真实浏览器验收、真实 Provider 与真实模型联调（HOLD）、生产环境、GitHub Actions。
- A 路径仍**只登记候选**，未与既有运行时入口建立消费通道（需要单独设计与复审）。

六、边界声明（未做清单）
未修改封板 release/rc-20261008-linux-deploy-v1 与 main；未新增第二套 runtime / scheduler / controller / 执行器；
未实施 PHASE 3 修复代理；未改 Prisma schema/migration；未做真实 Provider 调用 / 外部写 / 支付 / 报关 / 运输；
未写真实密钥；未执行生产部署或生产迁移；未改动历史故障载荷的保留策略。

七、请求裁决
请逐项判 PASS | REVISE | FAIL：
1. CHANGE1_GATE5_NEGATIVE_REDACTION
2. CHANGE2_REGISTRATION_CONCURRENCY_AND_IDEMPOTENCY
3. CHANGE3_TRUSTED_FACTS_SOURCE_CONTRACT
4. PHASE2_EVIDENCE_SUFFICIENCY（含「GATE-1 证据来自 3acfb195、本轮未重跑全量」是否可接受）
5. SCOPE_HONESTY
并给出：
FINAL VERDICT: PASS | PASS WITH REVISE | REVISE | BLOCK
REVIEWED_HEAD: <sha>
PHASE2_CLOSED: YES | NO
NEXT_AUTHORIZED: <你方明确授权的下一步范围>
CHANGES: <必须执行的修订>
RISKS: <剩余风险>
请在本会话直接回复（不要写入我的仓库，也不要尝试访问外部系统）。若上文不可读，回复「需要重发」。
