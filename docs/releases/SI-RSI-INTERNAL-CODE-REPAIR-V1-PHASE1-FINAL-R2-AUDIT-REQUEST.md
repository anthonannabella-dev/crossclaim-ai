# SI/RSI INTERNAL AUTONOMOUS CODE REPAIR V1 —— PHASE1-FINAL-R2 复审请求（CHANGE 1–4 完成）

审计编号（请在回复标题中沿用）：MSG-20261009-08
REVIEWED_HEAD = 0f90b148（分支 feat/si-rsi-internal-code-repair-v1）
上一轮裁决：MSG-20261009-07 = PASS WITH REVISE（PHASE0_CLOSED=YES；PHASE1_CLOSED=NO；PHASE2_IMPLEMENTATION_AUTHORIZED=NO）
durable 记录：本文件 与 docs/releases/SI-RSI-INTERNAL-CODE-REPAIR-V1.md（§1.5 逐项 CHANGE、§1.6 汇总）

一、本轮送审范围
仅审上一轮裁决指定的四项修订：CHANGE 1（P0）/ CHANGE 2（P0）/ CHANGE 3（P0）/ CHANGE 4（P1）。
不审范围：PHASE 2–7 未实施（未新增代码修复代理、未实施分流、未接 Judge、未做受控发布准备、未做学习、未做端到端 A–P）。

二、自上次送审（REVIEWED_HEAD 6a1bf54e）以来的改动
- 提交：18578936（CHANGE 1）→ c78935da（CHANGE 2）→ e0ae1be5（CHANGE 3）→ 0f90b148（CHANGE 4）。
- 改动文件：apps/api/src/services/self-repair/fault-classification.ts、apps/api/src/services/self-repair/fault-incident-intake.ts、
  apps/api/src/__tests__/internal-code-repair-phase1-classification.test.ts、
  apps/api/src/__tests__/internal-code-repair-phase1-incident-db.test.ts、docs/releases/SI-RSI-INTERNAL-CODE-REPAIR-V1.md。
- **未改 Prisma schema、未新增任何 migration**（你方要求：如需 schema 变更须先暂停并单独裁决 —— 本轮无需，故未触碰）。
- 未新增第二套 Runtime / Scheduler / Controller；未新增修复代理；未接真实 Provider。

三、CHANGE 1（P0）Incident 并发创建与去重原子性
实现：删除「先 findUnique 再 create、冲突后重读再 UPDATE」的路径，改为**单语句数据库级原子 upsert**：
INSERT INTO "AutonomyIncident" (...) VALUES (...) ON CONFLICT ("dedupeKey") DO UPDATE
SET sourceRefs = jsonb_set(sourceRefs, '{occurrenceCount}', 计数+1),
    status = CASE WHEN status = 'OPEN' THEN 'DIAGNOSED' ELSE status END,
    updatedAt = $now
WHERE kind = 'INTERNAL_FAULT' AND status IN ('OPEN','DIAGNOSED')
RETURNING id, status, occurrenceCount。
要点：① 冲突分支带 kind/status 前置条件 ⇒ **终态行与外来容器在 SQL 层就不可写**；② 返回 0 行时只做**只读**定位
（KIND_MISMATCH / INCIDENT_NOT_OPEN）或重试，不盲目重放；③ 「本次是否新建」由「返回行 id == 本请求预生成 id」判定
（不依赖 xmax 等实现细节）；④ 生命周期契约 OPEN→DIAGNOSED 在接线时 fail-fast 校验。
证据（真实 PostgreSQL，隔离库 crossclaim_p3r2_iso）：
- DB-P2：**20 路并发**同一故障 ⇒ 20 路全部被接纳、**仍 1 行**、occurrenceCount = 20、**恰好一次** created=true、incidentId 集合大小为 1；零任务零租约。
- DB-P7：混合创建/更新并发（1 个既有键 + 12 路旧键 + 8 路新键）⇒ 旧键计数 13 且无一次判新建、新键计数 8 且恰好一次新建、共 2 行、诊断载荷未串写。
- DB-P8：CLOSED 后 10 路并发 ⇒ 全部 INCIDENT_NOT_OPEN，状态仍 CLOSED、计数不变、未另建新行。
- DB-P9：外来容器（CUSTOMER_GOAL_QUEUE）占位 + 10 路并发 ⇒ 全部 KIND_MISMATCH，该行 id/kind/status/riskClass/sourceRefs **零改动**。

四、CHANGE 2（P0）脱敏边界补强
实现：① 掩码面扩展：PEM 私钥块、JWT、Bearer/Basic（大小写与形态变体）、键值赋值形态（含 JSON 引号包裹如 "apiKey":"…"、
X-Api-Key:、Cookie:、private_key）、云厂商与常见前缀密钥（AKIA/ASIA、sk-/pk-/rk-/ghp-/github_pat）、
URL query 密钥（access_token/api_key/signature）、32+ 位长 hex、邮箱、POSIX 与 Windows 绝对路径。
② 编码绕过：对含 %XX 的文本**最多解码两轮后重新掩码**。
③ 丢弃优先于猜测：掩码后仍残留「值形态」证据或无法识别的长 token（UUID 形状除外）⇒ 整段替换为
[dropped-unverifiable-text]，不推测其安全。
④ 结构化白名单：新增 FAULT_SOURCE_REF_FIELDS（现 31 键）并由 whitelistSourceRefs() 在装配时**运行时过滤**，未列出的键不落库；
代码/阶段等短字段一旦无法判定安全则**置空**而非留存。
⑤ 可持久化长度上限：summary 300 / ref 200 / code 80 / module 120 / stage 60 / modelHint 200。
⑥ 引用收紧（**由本轮对抗测试发现并修复的真实夹带面**）：refs 是结构化标识符而非自由文本 ——
凡含任何「需要掩码的内容」（密钥/邮箱/路径/长 hex）或不符合 prefix:value 保守字符集者**整条丢弃**；
修复前旧实现会把整段错误报文（含空格与掩码片段）当 evidenceRef 落库。代价（**故意选定并登记**）：
含 40 位 SHA 的 head: 类引用会被一并丢弃 —— 已作为调用方契约（只传 id）登记。
⑦ 无日志：两个模块零日志输出（源码级用例断言无 console. / process.stdout）。
证据（纯函数）：对抗矩阵 11 例（URL query / header 形态 / 嵌套 JSON / PEM / 全大写 BEARER / URL 编码 /
多行堆栈+cause 链+DB 错误文本 / Linux 路径 / Windows 路径 / 邮箱 / 长数字）逐例断言**密钥原文在摘要与落库载荷中均不可见**；
掩码时留下可审计标记；无法判定的自由文本（单引号包值赋值、base64 形状长 token）⇒ 摘要为丢弃标记且故障分类不变；
落库键集合逐字等于白名单；全部可持久化字符串 ≤ 字段上限；自由文本引用（task: recovery with spaces、
evidence:Error: insert failed…、{"raw":"payload"}）全部不落库。
夹具卫生：初版夹具含 sk_live_… 形态字面量，**被 GitHub Push Protection 判定为 Stripe 密钥并拒绝推送**；
已全部替换为明显合成值（sk-DUMMYKEY-…）后重推 —— 夹具不含任何真实密钥。

五、CHANGE 3（P0）Incident 生命周期与租户边界
实现：① **显式身份规则**（FAULT_INCIDENT_IDENTITY_RULE）：
dedupeKey = INTERNAL_FAULT : faultClass : sourceModule : tenantScope : providerScope : 证据指纹。
租户维度参与身份 ⇒ 不同组织的同一错误签名**绝不合并**（避免跨租户信息混合）；无租户上下文记 global。
Provider 维度参与身份 ⇒ 同组织跨 Provider **不合并**（契约漂移/凭据过期/解析差异的根因与责任方不同）；无 Provider 记 noprovider。
落库与入键只用**不可逆引用**（org-<sha16> / provider-<sha16>），原始 id 永不入键、不落库。
② 新增租户范围读取 listForOrganization({ organizationId })：必须由**服务端可信租户上下文**提供原始组织 id，
内部推导引用后只返回该组织的故障 Incident；空/空白上下文 **fail-closed 返回空**（不是"返回全部"）；
导出 faultOrganizationRef() 供读取路径推导同一引用 —— 并显式登记：**哈希引用不是授权凭证**。
③ 生命周期：OPEN 聚合时按既有 rsi-lifecycle 合法跃迁转 DIAGNOSED；CLOSED / REJECTED / TASKED 一律拒绝且**不复活、不加计数**。
证据（真实 PostgreSQL）：
- DB-P10 生命周期矩阵：OPEN（计数 5）⇒ 聚合为 6 且转 DIAGNOSED；CLOSED/REJECTED/TASKED 三态各判 INCIDENT_NOT_OPEN 且状态与计数不变；回到 DIAGNOSED 继续聚合为 7。
- DB-P11 跨租户隔离：同签名不同组织 ⇒ 2 行不同键；租户视图只含本租户；global 故障不进入任何租户视图；视图内不含原始组织 id。
- DB-P12 哈希不是授权：用不可逆引用冒充租户 id ⇒ 查询 0 行；空/空白租户上下文 ⇒ fail-closed 0 行。
- DB-P13 Provider 身份：同组织跨 Provider ⇒ 2 行、各带自己的 provider 引用、组织引用一致。
- DB-P14 伪造无权限：即便伪造「客户任务前缀形状的 dedupeKey + 客户容器形状的 sourceRefs（含该组织 ACTIVE 长期授权）」
  仍被既有 claim() 以 kind 拒绝：领取 0 条、任务持久化 BLOCKED（lastErrorCode=CLAIM_DENY_UNTRUSTED_INCIDENT_KIND）、零租约；
  修复平面读取也不认该形状。

六、CHANGE 4（P1）分类优先级与自动重试保护
实现：核心理念「**故障可重试 ≠ 业务动作可安全重放**」。分类结果新增 replaySafety，并由它**推导** requiredAction
（不再沿用类别默认动作）。判定顺序即优先级：
① 安全/权限信号最优先 ⇒ FORBIDDEN（普通超时等规则的"可重试"不得覆盖它），并显式登记 escalatedBySecuritySignal；
② 需代码修复 / 明确不可重试的类别 ⇒ FORBIDDEN（保留类别自身修复路径：CODE_REPAIR_CANDIDATE / OWNER_ACTION / 人工）；
③ 未分类故障（如 UNKNOWN_ERROR）⇒ NEEDS_CLASSIFICATION，默认禁止自动恢复；
④ 确定性可重试故障再看动作维度：只读 ⇒ AUTO_RETRY_CANDIDATE；
  **外部写 ⇒ RECONCILE_FIRST（先对账，绝不因分类为超时/限流而重放）**；
  副作用已确认生效 ⇒ FORBIDDEN；操作类型未知 ⇒ RECONCILE_FIRST；
  仅「确认未生效 + 可信幂等」的可变操作 ⇒ AUTO_RETRY_CANDIDATE。
不变量（双向断言）：requiredAction === 'AUTO_RECOVER' ⟺ replaySafety.autoRecoverAuthorized === true。
新增操作维度输入（调用方基于可信事实声明，**模型声明无效**）：operationKind / idempotencyGuarantee / effectConfirmed；
连同 replayDisposition / requiresReconciliation / autoRecoverAuthorized / escalatedBySecuritySignal 共 7 字段随 Incident 落库，下游分流无需二次推断。
403 **不**自动等同 TOKEN_EXPIRED（仍落 UNKNOWN_ERROR），因此也不会获得任何自动恢复许可。
证据（纯函数）：只读超时 ⇒ 自动重试候选；**外部写超时 ⇒ RECONCILE_FIRST 且 requiredAction=INVESTIGATE**；
副作用已生效 ⇒ FORBIDDEN；可变操作仅「确认未生效+可信幂等」可重试、幂等未知或副作用未知 ⇒ RECONCILE_FIRST；
操作类型未知 ⇒ RECONCILE_FIRST；权限信号 ⇒ 强制升级 HIGH + 人工 + 禁止重放；UNKNOWN_ERROR 与 403 ⇒ 禁止自动恢复；
重放语义随意图落库；规则登记（FAULT_REPLAY_SAFETY_RULE）逐条断言。

七、本机验收证据（本轮实测）
- 纯函数分类套件：61 用例 PASS（含 CHANGE 2 对抗矩阵 11 例、CHANGE 3 身份规则、CHANGE 4 重放矩阵与双向不变量）。
- 真实 PostgreSQL 套件：14 用例 PASS（CRUD/聚合/并发/容器隔离/生命周期矩阵/跨租户/哈希非授权/Provider 身份/伪造无权限/落库脱敏），
  隔离库 crossclaim_p3r2_iso（本任务自建；未触碰共享开发库）。
- 定向回归：internal-code-repair-phase1-classification + internal-code-repair-phase1-incident-db + rsi-schema-contract +
  si-rsi-phase1-authorization + si-rsi-phase1-durable-queue ⇒ **5 文件 / 98 tests 全绿**。
- 类型检查：apps/api tsc --noEmit ⇒ **0 error**。

八、如实声明的 NOT VERIFIED / 遗留
- **未跑全量回归**（你方 MSG-20261009-07 登记为 P1 债）—— 本轮只跑上述定向集合；全量回归待 PHASE 1 CLOSED 后的集成门禁。
- Linux/systemd、真实浏览器验收、真实 Provider 调用均未验证；REAL_MODEL_INTEGRATION = HOLD。
- 已知取舍（主动登记）：① 含 40 位 SHA 的 head: 类引用会被 ref 语法丢弃；② 极端情况下「形如 id 的裸 token」放进 ref 无法用确定性规则与 id 区分（调用方契约：只传 id）；
  ③ 无 schema 变更，故跨租户读取依赖服务端租户上下文，未在 DB 层加租户列（如需更强的 DB 级隔离需单独 schema 裁决）。

九、边界声明（未做清单）
未修改封板 release/rc-20261008-linux-deploy-v1 与 main；未新增第二套 runtime / scheduler / controller；
未新增代码修复代理、未实施 PHASE 2–7；未改 Prisma schema/migration；未做真实 Provider 调用 / 外部写 / 支付 / 报关 / 运输；
未写真实密钥；未执行生产部署或生产迁移。

十、请求裁决
请逐项判 PASS | REVISE | FAIL：
1. CHANGE1_INCIDENT_CONCURRENCY_ATOMICITY
2. CHANGE2_SANITIZATION_BOUNDARY
3. CHANGE3_LIFECYCLE_AND_TENANT_BOUNDARY
4. CHANGE4_REPLAY_SAFETY_SEMANTICS
5. PHASE1_EVIDENCE_SUFFICIENCY（含未跑全量回归是否可接受）
6. SCOPE_HONESTY
并给出：
FINAL VERDICT: PASS | PASS WITH REVISE | REVISE | BLOCK
REVIEWED_HEAD: <sha>
PHASE1_CLOSED: YES | NO
PHASE2_IMPLEMENTATION_AUTHORIZED: YES | NO
CHANGES: <必须执行的修订>
RISKS: <剩余风险>
请在本会话直接回复（不要写入我的仓库，也不要尝试访问外部系统）。若上文不可读，回复「需要重发」。
